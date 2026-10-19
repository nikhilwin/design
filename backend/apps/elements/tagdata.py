"""Search tags from the tag data the upstream packs ship (and from icon-set JSON files).

Each parser turns one upstream file into `{element key: [tag, …]}` where the key is the icon's name as it
appears in the file name (without any style suffix the manifest strips). The parsers are deliberately
strict about the shape they expect and lenient about everything else: a file in an unknown shape raises
`TagDataError`, and the pipeline then imports the pack with name-derived tags only (and says so).
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Any

from .search import clean_tags


class TagDataError(ValueError):
    """The tag file is not in the format the manifest says it is."""


def _json(data: bytes) -> Any:
    try:
        return json.loads(data)
    except ValueError as exc:
        raise TagDataError("not valid JSON") from exc


def _words(value: object) -> list[str]:
    return [str(value)] if isinstance(value, (str, int, float)) and not isinstance(value, bool) else []


def parse_json_map(data: bytes) -> dict[str, list[str]]:
    """`{"name": ["tag", …], …}` (Lucide's `tags.json`)."""
    raw = _json(data)
    if not isinstance(raw, dict):
        raise TagDataError("expected an object mapping icon names to tag lists")
    return {
        name: clean_tags(tag for item in tags for tag in _words(item))
        for name, tags in raw.items()
        if isinstance(name, str) and isinstance(tags, list)
    }


def parse_tabler(data: bytes) -> dict[str, list[str]]:
    """Tabler's `icons.json`: `{"name": {"category": "Shapes", "tags": [...], …}, …}`."""
    raw = _json(data)
    if not isinstance(raw, dict):
        raise TagDataError("expected an object keyed by icon name")
    out: dict[str, list[str]] = {}
    for name, entry in raw.items():
        if not isinstance(entry, dict):
            continue
        tags = entry.get("tags")
        candidates = [t for item in (tags if isinstance(tags, list) else []) for t in _words(item)]
        candidates += _words(entry.get("category"))
        out[name] = clean_tags(candidates)
    return out


def parse_iconify_categories(data: bytes) -> dict[str, list[str]]:
    """The `metadata.json` of an Iconify JSON package: `{"categories": {"Category": ["name", …]}}`."""
    raw = _json(data)
    categories = raw.get("categories") if isinstance(raw, dict) else None
    if not isinstance(categories, dict):
        raise TagDataError("expected a 'categories' object")
    out: dict[str, list[str]] = {}
    for category, names in categories.items():
        if isinstance(category, str) and isinstance(names, list):
            for name in names:
                if isinstance(name, str):
                    out.setdefault(name, []).append(category)
    return {name: clean_tags(tags) for name, tags in out.items()}


_PHOSPHOR_ENUM = re.compile(r"(\w+) = /\* @__PURE__ \*/ \(\((\w+)\) => \((.*?)\)\)\(\1 \|\| \{\}\)", re.S)
_PHOSPHOR_MEMBER = re.compile(r'\w+\.(\w+) = "([^"]*)"')
_PHOSPHOR_ICON = re.compile(
    r'\{\s*name:\s*"(?P<name>[^"]+)",\s*pascal_name:\s*"[^"]*",\s*'
    r'(?:alias:\s*\{\s*name:\s*"(?P<alias>[^"]+)"[^}]*\},\s*)?'
    r"categories:\s*\[(?P<categories>[^\]]*)\],[^\[\]]*?"
    r"tags:\s*\[(?P<tags>[^\]]*)\]",
    re.S,
)
_STRING = re.compile(r'"((?:[^"\\]|\\.)*)"')


def parse_phosphor(data: bytes) -> dict[str, list[str]]:
    """The icon table inside `@phosphor-icons/core`'s `dist/index.mjs` (a generated JavaScript module)."""
    try:
        source = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise TagDataError("not UTF-8 text") from exc
    enums = {
        variable: dict(_PHOSPHOR_MEMBER.findall(body)) for variable, _, body in _PHOSPHOR_ENUM.findall(source)
    }
    out: dict[str, list[str]] = {}
    for match in _PHOSPHOR_ICON.finditer(source):
        tags = [json.loads(f'"{raw}"') for raw in _STRING.findall(match["tags"])]
        categories = []
        for reference in match["categories"].split(","):
            variable, _, member = reference.strip().partition(".")
            if value := enums.get(variable, {}).get(member):
                categories.append(value)
        alias = [match["alias"].replace("-", " ")] if match["alias"] else []
        out[match["name"]] = clean_tags([*tags, *categories, *alias])
    if not out:
        raise TagDataError("no icons found")
    return out


PARSERS: dict[str, Callable[[bytes], dict[str, list[str]]]] = {
    "json-map": parse_json_map,
    "tabler": parse_tabler,
    "iconify-categories": parse_iconify_categories,
    "phosphor-js": parse_phosphor,
}


def parse_tags(format_: str, data: bytes) -> dict[str, list[str]]:
    if format_ == "none":
        return {}
    return PARSERS[format_](data)
