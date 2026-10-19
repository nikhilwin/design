"""Readers that turn an upstream file layout into a list of named SVG documents.

Most packs are folders of `*.svg` files and need no reader (the pipeline walks the files itself). Icon sets
distributed as Iconify JSON (one `icons.json` with every icon's SVG body) are expanded here into the same
shape: one standalone `<svg>` per icon.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

SVG_HEAD = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"'
MAX_ICONS = 50_000


class ReaderError(ValueError):
    """The file is not in the shape the reader expects."""


@dataclass(frozen=True)
class SourceIcon:
    name: str
    svg: bytes
    #: Other names the icon is known by upstream (they become search tags).
    aliases: tuple[str, ...] = field(default_factory=tuple)


def _dimension(value: object, fallback: float) -> float:
    return (
        float(value)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0
        else fallback
    )


def _offset(value: object) -> float:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0.0


def read_iconify_json(data: bytes) -> list[SourceIcon]:
    """The visible icons of an Iconify JSON icon set, sorted by name, with their alias names."""
    try:
        raw = json.loads(data)
    except ValueError as exc:
        raise ReaderError("not valid JSON") from exc
    icons = raw.get("icons") if isinstance(raw, dict) else None
    if not isinstance(icons, dict) or not icons or len(icons) > MAX_ICONS:
        raise ReaderError("expected a non-empty 'icons' object")
    width, height = _dimension(raw.get("width"), 16), _dimension(raw.get("height"), 16)
    aliases: dict[str, list[str]] = {}
    for alias, entry in (raw.get("aliases") or {}).items():
        parent = entry.get("parent") if isinstance(entry, dict) else None
        if isinstance(parent, str) and parent in icons and isinstance(alias, str):
            aliases.setdefault(parent, []).append(alias)
    out: list[SourceIcon] = []
    for name in sorted(icons):
        icon = icons[name]
        if not isinstance(icon, dict) or icon.get("hidden") or not isinstance(icon.get("body"), str):
            continue
        w, h = _dimension(icon.get("width"), width), _dimension(icon.get("height"), height)
        left, top = _offset(icon.get("left", raw.get("left"))), _offset(icon.get("top", raw.get("top")))
        svg = f'{SVG_HEAD} viewBox="{left:g} {top:g} {w:g} {h:g}">{icon["body"]}</svg>'
        out.append(
            SourceIcon(name=name, svg=svg.encode("utf-8"), aliases=tuple(sorted(aliases.get(name, []))))
        )
    if not out:
        raise ReaderError("the icon set has no visible icons")
    return out
