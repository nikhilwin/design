"""Import SVG files into element packs (used by `import_elements`, `seed_elements` and the admin)."""

from __future__ import annotations

import os
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from django.core.files.base import ContentFile
from django.db import transaction
from django.utils.text import slugify

from apps.core.svg import MAX_BYTES, SvgError

from .models import Element, ElementKind, ElementPack
from .svgdata import ProcessedSvg, process_svg

MAX_TAGS = 20
_WORD = re.compile(r"[^\W\d_]{2,}", re.UNICODE)

CREATED, UPDATED, UNCHANGED = "created", "updated", "unchanged"


@dataclass
class ImportSummary:
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    skipped: list[tuple[str, str]] = field(default_factory=list)

    def record(self, outcome: str) -> None:
        setattr(self, outcome, getattr(self, outcome) + 1)

    def __str__(self) -> str:
        return (
            f"{self.created} created, {self.updated} updated, {self.unchanged} unchanged, "
            f"{len(self.skipped)} skipped"
        )


def element_name(stem: str) -> str:
    """`arrow-right_2` -> `Arrow Right 2`."""
    words = re.split(r"[-_\s]+", stem.strip())
    return " ".join(word[:1].upper() + word[1:] for word in words if word)[:120] or "Element"


def element_tags(directories: tuple[str, ...], name: str) -> list[str]:
    """Tags from the folder names above a file and from the words of its name."""
    tags: dict[str, None] = {}
    for directory in directories:
        for word in _WORD.findall(directory.lower()):
            tags[word] = None
    for word in _WORD.findall(name.lower()):
        tags[word] = None
    return list(tags)[:MAX_TAGS]


def element_key(relative: Path) -> str:
    """Stable id of a file inside a pack: its relative path without extension, each part slugified."""
    parts = [slugify(part, allow_unicode=True) for part in relative.with_suffix("").parts]
    if not parts or not all(parts):
        raise ValueError("the file name has no usable letters or digits")
    key = "/".join(parts)
    if len(key) > Element._meta.get_field("key").max_length:
        raise ValueError("the path is too long")
    return key


def _svg_files(root: Path) -> list[Path]:
    """`*.svg` files below `root`, sorted; symbolic links (to files or folders) are never followed."""
    found = []
    for folder, subfolders, names in os.walk(root, followlinks=False):
        subfolders[:] = [d for d in subfolders if not (Path(folder) / d).is_symlink()]
        found += [
            Path(folder) / n
            for n in names
            if n.lower().endswith(".svg") and not (Path(folder) / n).is_symlink()
        ]
    return sorted(found)


def _stored_bytes(element: Element) -> bytes | None:
    try:
        with element.svg.storage.open(element.svg.name, "rb") as handle:
            return handle.read()
    except OSError:
        return None


@transaction.atomic
def import_svg(
    pack: ElementPack,
    *,
    key: str,
    name: str,
    tags: list[str],
    data: bytes | ProcessedSvg,
    kind: str | None = None,
    sort_order: int = 0,
) -> str:
    """Create or update the element `key` of `pack` from SVG bytes. Returns CREATED, UPDATED or UNCHANGED.

    Raises `SvgError` if the SVG is unsafe or invalid. An existing element keeps its name, tags, kind,
    sort order and publication state; only its artwork is refreshed, and only when it changed.
    """
    processed = data if isinstance(data, ProcessedSvg) else process_svg(data)
    element = pack.elements.filter(key=key).first()
    if element is None:
        element = Element(
            pack=pack,
            key=key,
            name=name,
            kind=kind or pack.kind,
            tags=tags,
            sort_order=sort_order,
            svg=ContentFile(processed.data, name=f"{key.rsplit('/', 1)[-1]}.svg"),
        )
        element.save()
        return CREATED
    if _stored_bytes(element) == processed.data:
        return UNCHANGED
    element.svg = ContentFile(processed.data, name=f"{key.rsplit('/', 1)[-1]}.svg")
    element.save()
    return UPDATED


def import_directory(
    pack: ElementPack,
    directory: Path,
    *,
    kind: str | None = None,
    progress: Callable[[str, str], None] | None = None,
) -> ImportSummary:
    """Recursively import every `*.svg` below `directory`. Invalid files are skipped, never fatal."""
    root = directory.resolve()
    summary = ImportSummary()
    for order, path in enumerate(_svg_files(root)):
        relative = path.relative_to(root)
        label = relative.as_posix()
        try:
            if not path.is_file():
                raise ValueError("not a regular file")
            if path.stat().st_size > MAX_BYTES:
                raise ValueError("the file is larger than 5 MB")
            key = element_key(relative)
            name = element_name(path.stem)
            outcome = import_svg(
                pack,
                key=key,
                name=name,
                tags=element_tags(relative.parent.parts, name),
                data=path.read_bytes(),
                kind=kind,
                sort_order=order * 10,
            )
        except (SvgError, ValueError, OSError) as exc:
            summary.skipped.append((label, str(exc)))
            if progress:
                progress("skipped", f"{label}: {exc}")
            continue
        summary.record(outcome)
        if progress:
            progress(outcome, label)
    return summary


def ensure_pack(
    slug: str,
    *,
    name: str | None = None,
    kind: str | None = None,
    license: str | None = None,
    source_url: str | None = None,
    description: str | None = None,
    sort_order: int | None = None,
    license_url: str | None = None,
    attribution: str | None = None,
) -> tuple[ElementPack, bool]:
    """Get or create a pack. Values that are given are applied; omitted ones leave an existing pack alone."""
    if kind is not None and kind not in ElementKind.values:
        raise ValueError(f"kind must be one of: {', '.join(ElementKind.values)}.")
    pack = ElementPack.objects.filter(slug=slug).first()
    created = pack is None
    if pack is None:
        if not license:
            raise ValueError("A licence (SPDX identifier) is required to create a new pack.")
        pack = ElementPack(slug=slug, name=name or element_name(slug), license=license)
    for attr, value in (
        ("name", name),
        ("kind", kind),
        ("license", license),
        ("source_url", source_url),
        ("description", description),
        ("sort_order", sort_order),
        ("license_url", license_url),
        ("attribution", attribution),
    ):
        if value is not None:
            setattr(pack, attr, value)
    pack.full_clean(exclude=["thumbnail"])
    pack.save()
    return pack, created
