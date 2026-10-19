"""Size preset catalogues as JSON: `{"version": 1, "groups": [{slug, label, children?, presets?}, ...]}`.

The same shape `GET /api/v1/size-presets/` answers with, so a served catalogue can be saved, edited and
imported again. Parsing is separate from writing: the data migration writes the built-in catalogue with
historical models, the commands with the real ones.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .validators import (
    GROUP_SLUG,
    ICON_NAME,
    PRESET_SLUG,
    check_meta,
    check_size,
    normalize_aliases,
    normalize_tags,
)

FORMAT_VERSION = 1
BUILTIN_FILE = Path(__file__).resolve().parents[2] / "data" / "size_presets.json"
MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_DEPTH = 8
MAX_PRESETS = 5000

GROUP_KEYS = {"slug", "label", "icon", "order", "is_active", "children", "presets"}
PRESET_KEYS = {
    "slug",
    "label",
    "width",
    "height",
    "unit",
    "icon",
    "order",
    "is_active",
    "is_quick",
    "tags",
    "aliases",
    "meta",
}
# (file key, model field) an existing group keeps when the file leaves the key out.
GROUP_KEPT_FIELDS = (("icon", "icon"), ("order", "sort_order"))
# What the API adds to each preset; accepted (and ignored) so a served catalogue imports as it is.
DERIVED_PRESET_KEYS = {"width_px", "height_px"}

MODES = ("extend", "replace")


class PresetImportError(Exception):
    pass


@dataclass
class Catalogue:
    """Flat rows in file order: every group comes after its parent."""

    groups: list[dict] = field(default_factory=list)
    presets: list[dict] = field(default_factory=list)

    def merge(self, other: Catalogue) -> None:
        self.groups.extend(other.groups)
        self.presets.extend(other.presets)
        _check_unique(self)


@dataclass
class Report:
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    deactivated: int = 0

    def __str__(self) -> str:
        text = f"{self.created} created, {self.updated} updated, {self.unchanged} unchanged"
        return f"{text}, {self.deactivated} deactivated" if self.deactivated else text


def read_file(path: Path) -> Catalogue:
    if path.stat().st_size > MAX_FILE_BYTES:
        raise PresetImportError(f"{path}: the file is larger than {MAX_FILE_BYTES // (1024 * 1024)} MB.")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PresetImportError(f"{path}: not valid JSON ({exc}).")
    try:
        return parse(data)
    except PresetImportError as exc:
        raise PresetImportError(f"{path}: {exc}")


def builtin_catalogue() -> Catalogue:
    return read_file(BUILTIN_FILE)


def parse(data: Any) -> Catalogue:
    """Validate a catalogue document; `PresetImportError` names the first problem and where it is."""
    if not isinstance(data, dict) or not isinstance(data.get("groups"), list):
        raise PresetImportError('Expected an object with a "groups" list.')
    if data.get("version", FORMAT_VERSION) != FORMAT_VERSION:
        raise PresetImportError(f"Unsupported version {data.get('version')!r} (expected {FORMAT_VERSION}).")
    unknown = set(data) - {"version", "groups"}
    if unknown:
        raise PresetImportError(f"Unknown key(s): {', '.join(sorted(unknown))}.")
    catalogue = Catalogue()
    _parse_groups(data["groups"], parent=None, where="groups", depth=1, into=catalogue)
    _check_unique(catalogue)
    if len(catalogue.presets) > MAX_PRESETS:
        raise PresetImportError(f"At most {MAX_PRESETS} presets can be imported at once.")
    return catalogue


def _parse_groups(items: Any, *, parent: str | None, where: str, depth: int, into: Catalogue) -> None:
    if not isinstance(items, list):
        raise PresetImportError(f"{where} must be a list.")
    if depth > MAX_DEPTH:
        raise PresetImportError(f"{where}: groups can be nested at most {MAX_DEPTH} levels deep.")
    for index, item in enumerate(items):
        at = f"{where}[{index}]"
        if not isinstance(item, dict):
            raise PresetImportError(f"{at} must be an object.")
        _no_unknown_keys(item, GROUP_KEYS, at)
        slug = item.get("slug")
        if not isinstance(slug, str) or not GROUP_SLUG.fullmatch(slug):
            raise PresetImportError(f"{at}.slug must be 1 to 64 lower-case letters, digits and hyphens.")
        at = f"{at} ({slug})"
        into.groups.append(
            {
                "slug": slug,
                "parent": parent,
                "label": _label(item, at, 80),
                "icon": _icon(item, at),
                "sort_order": _order(item, index, at),
                "is_active": _flag(item, "is_active", True, at),
                # An existing group keeps the icon and order the file leaves out: a file that adds presets to
                # a built-in group ("social") should not reset how that group looks or where it sits.
                "unset": {field for key, field in GROUP_KEPT_FIELDS if key not in item},
            }
        )
        for p_index, preset in enumerate(_list(item, "presets", at)):
            into.presets.append(_parse_preset(preset, group=slug, index=p_index, where=f"{at}.presets"))
        _parse_groups(
            item.get("children", []), parent=slug, where=f"{at}.children", depth=depth + 1, into=into
        )


def _parse_preset(item: Any, *, group: str, index: int, where: str) -> dict:
    at = f"{where}[{index}]"
    if not isinstance(item, dict):
        raise PresetImportError(f"{at} must be an object.")
    _no_unknown_keys(item, PRESET_KEYS | DERIVED_PRESET_KEYS, at)
    slug = item.get("slug")
    if not isinstance(slug, str) or not PRESET_SLUG.fullmatch(slug):
        raise PresetImportError(f"{at}.slug must be 1 to 64 letters, digits, dots, hyphens or underscores.")
    at = f"{at} ({slug})"
    unit = item.get("unit", "px")
    try:
        width, height = check_size(item.get("width"), item.get("height"), unit)
        tags = normalize_tags(item.get("tags"))
        aliases = normalize_aliases(item.get("aliases"))
        meta = check_meta(item.get("meta"))
    except ValueError as exc:
        raise PresetImportError(f"{at}: {exc}")
    if slug in aliases:
        raise PresetImportError(f"{at}: an alias cannot repeat the preset's own slug.")
    return {
        "slug": slug,
        "group": group,
        "label": _label(item, at, 120),
        "width": width,
        "height": height,
        "unit": unit,
        "icon": _icon(item, at),
        "sort_order": _order(item, index, at),
        "is_active": _flag(item, "is_active", True, at),
        "is_quick": _flag(item, "is_quick", False, at),
        "tags": tags,
        "aliases": aliases,
        "meta": meta,
    }


def _no_unknown_keys(item: dict, allowed: set[str], at: str) -> None:
    unknown = set(item) - allowed
    if unknown:
        raise PresetImportError(f"{at}: unknown key(s) {', '.join(sorted(unknown))}.")


def _label(item: dict, at: str, limit: int) -> str:
    label = item.get("label")
    if not isinstance(label, str) or not label.strip() or len(label.strip()) > limit:
        raise PresetImportError(f"{at}.label must be text of 1 to {limit} characters.")
    return label.strip()


def _icon(item: dict, at: str) -> str:
    icon = item.get("icon", "")
    if not isinstance(icon, str) or not ICON_NAME.fullmatch(icon):
        raise PresetImportError(f"{at}.icon must be a Lucide icon name such as `file-text`.")
    return icon


def _order(item: dict, index: int, at: str) -> int:
    order = item.get("order", (index + 1) * 10)
    if isinstance(order, bool) or not isinstance(order, int) or not 0 <= order <= 1_000_000:
        raise PresetImportError(f"{at}.order must be a whole number from 0 to 1000000.")
    return order


def _flag(item: dict, key: str, default: bool, at: str) -> bool:
    value = item.get(key, default)
    if not isinstance(value, bool):
        raise PresetImportError(f"{at}.{key} must be true or false.")
    return value


def _list(item: dict, key: str, at: str) -> list:
    value = item.get(key, [])
    if not isinstance(value, list):
        raise PresetImportError(f"{at}.{key} must be a list.")
    return value


def _check_unique(catalogue: Catalogue) -> None:
    for kind, rows in (("group", catalogue.groups), ("preset", catalogue.presets)):
        seen: set[str] = set()
        for row in rows:
            if row["slug"] in seen:
                raise PresetImportError(f"The {kind} slug {row['slug']!r} appears more than once.")
            seen.add(row["slug"])


def write(
    catalogue: Catalogue, *, group_model, preset_model, mode: str = "extend", overwrite: bool = True
) -> Report:
    """Upsert `catalogue` by slug. Run it inside a transaction: a failed check leaves rows half-written.

    `overwrite=False` only adds what is missing (seeding keeps staff edits). `mode="replace"` deactivates
    every group and preset the catalogue does not name.
    """
    if mode not in MODES:
        raise PresetImportError(f"Unknown mode {mode!r}.")
    report = Report()
    groups: dict[str, Any] = {}
    for row in catalogue.groups:
        values = {key: value for key, value in row.items() if key not in ("slug", "parent", "unset")}
        values["parent"] = groups[row["parent"]] if row["parent"] else None
        groups[row["slug"]] = _upsert(group_model, row["slug"], values, overwrite, report, keep=row["unset"])
    for row in catalogue.presets:
        values = {key: value for key, value in row.items() if key != "slug"}
        values["group"] = groups[row["group"]]
        _upsert(preset_model, row["slug"], values, overwrite, report)
    if mode == "replace":
        for model, rows in ((preset_model, catalogue.presets), (group_model, catalogue.groups)):
            stale = model.objects.filter(is_active=True).exclude(slug__in=[row["slug"] for row in rows])
            report.deactivated += stale.update(is_active=False)
    clash = find_name_clash(preset_model)
    if clash:
        raise PresetImportError(clash)
    return report


def _upsert(model, slug: str, values: dict, overwrite: bool, report: Report, keep: set[str] = frozenset()):
    """Create the row, or update it (when `overwrite`) except for the fields in `keep`."""
    obj = model.objects.filter(slug=slug).first()
    if obj is None:
        report.created += 1
        return model.objects.create(slug=slug, **values)
    changed = [key for key, value in values.items() if key not in keep and getattr(obj, key) != value]
    if overwrite and changed:
        for key in changed:
            setattr(obj, key, values[key])
        obj.save()
        report.updated += 1
    else:
        report.unchanged += 1
    return obj


def find_name_clash(preset_model) -> str:
    """Why some slug or alias would mean two active presets, or "" when every name is unambiguous."""
    owner: dict[str, str] = {}
    for slug, aliases in preset_model.objects.filter(is_active=True).values_list("slug", "aliases"):
        for name in (slug, *(aliases or [])):
            if name in owner and owner[name] != slug:
                return (
                    f"{name!r} would mean both {owner[name]!r} and {slug!r}: slugs and aliases must differ."
                )
            owner[name] = slug
    return ""
