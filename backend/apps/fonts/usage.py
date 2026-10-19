"""Which uploaded fonts a design's document renders text with.

A shared link is opened by people who do not own the uploaded fonts of the design's owner, so the shared
payload carries the owner's families that the document names (and nothing else of their font library).
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

from django.db.models.functions import Lower

from .models import FontFamily
from .serializers import with_variants

MAX_DEPTH = 32
MAX_NAMES = 64
MAX_NODES = 200_000


def primary_family(stack: Any) -> str:
    """First family of a CSS font stack (`"Foo Bar", sans-serif` -> `Foo Bar`), unquoted."""
    if not isinstance(stack, str):
        return ""
    return stack.split(",", 1)[0].strip().strip("\"'").strip()


def _objects(document: Any) -> Iterator[dict]:
    """Every object of every page, groups included, without recursion (documents are untrusted JSON)."""
    pages = document.get("pages") if isinstance(document, dict) else None
    if not isinstance(pages, list):
        return
    roots = [obj for page in pages if isinstance(page, dict) for obj in _list(page.get("objects"))]
    stack: list[tuple[Any, int]] = [(obj, 0) for obj in reversed(roots)]
    visited = 0
    while stack and visited < MAX_NODES:
        node, depth = stack.pop()
        if not isinstance(node, dict):
            continue
        visited += 1
        yield node
        if depth < MAX_DEPTH:
            stack.extend((child, depth + 1) for child in reversed(_list(node.get("objects"))))


def _list(value: Any) -> list:
    return value if isinstance(value, list) else []


def font_names_in_document(document: Any) -> list[str]:
    """Distinct family names used by text objects and their per-character styles (at most `MAX_NAMES`)."""
    names: dict[str, str] = {}

    def add(stack: Any) -> None:
        name = primary_family(stack)
        if name and len(name) <= 120 and len(names) < MAX_NAMES:
            names.setdefault(name.casefold(), name)

    for obj in _objects(document):
        add(obj.get("fontFamily"))
        for entry in _list(obj.get("styles")):
            style = entry.get("style") if isinstance(entry, dict) else None
            if isinstance(style, dict):
                add(style.get("fontFamily"))
    return list(names.values())


def uploaded_fonts_used_by(document: Any, owner) -> list[FontFamily]:
    """The `owner`'s uploaded families named in `document` (case-insensitive), with their files."""
    wanted = [name.casefold() for name in font_names_in_document(document)]
    if not wanted:
        return []
    return list(
        FontFamily.objects.filter(owner=owner)
        .annotate(folded=Lower("family"))
        .filter(folded__in=wanted)
        .prefetch_related(with_variants())
        .order_by("family", "id")
    )
