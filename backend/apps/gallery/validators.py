"""Structural check for template documents.

Templates are curated by staff, but they are copied verbatim into users' designs, so they must satisfy the
same invariants the designs API enforces. This is a deliberately small, dependency-free check: it validates
the envelope (version, size, pages) and scans the whole tree for inline/ephemeral asset references. It does
not interpret individual canvas objects.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from django.conf import settings

MAX_PAGES = 100
MAX_OBJECTS_PER_PAGE = 5000
MAX_DIMENSION = 20_000
MAX_TREE_DEPTH = 64
MAX_DATA_URI_CHARS = 64 * 1024
MAX_TAGS = 20
MAX_TAG_LENGTH = 40


class TemplateDocumentError(ValueError):
    """Raised when a template document violates the document format contract."""


@dataclass(frozen=True)
class DocumentSummary:
    width: int
    height: int
    page_count: int
    preset: str


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _scan_strings(root: Any) -> None:
    """Iteratively walk the JSON tree (no recursion bombs) rejecting ephemeral or oversized asset refs."""
    stack: list[tuple[Any, int]] = [(root, 0)]
    while stack:
        node, depth = stack.pop()
        if depth > MAX_TREE_DEPTH:
            raise TemplateDocumentError("The document is nested too deeply.")
        if isinstance(node, dict):
            stack.extend((value, depth + 1) for value in node.values())
        elif isinstance(node, list):
            stack.extend((value, depth + 1) for value in node)
        elif isinstance(node, str):
            head = node[:16].lstrip().lower()
            if head.startswith(("blob:", "idb://")):
                raise TemplateDocumentError("The document references a local-only asset (blob: or idb://).")
            if head.startswith("data:") and len(node) > MAX_DATA_URI_CHARS:
                raise TemplateDocumentError("The document embeds an inline asset larger than 64 KB.")


def validate_template_document(document: Any) -> DocumentSummary:
    """Validate `document` and return the facts the `Template` row mirrors (size, page count, preset)."""
    if not isinstance(document, dict):
        raise TemplateDocumentError("The document must be a JSON object.")
    version = document.get("schemaVersion")
    if not _is_int(version) or version < 1:
        raise TemplateDocumentError("schemaVersion must be an integer of at least 1.")
    width, height = document.get("width"), document.get("height")
    for label, value in (("width", width), ("height", height)):
        if not _is_int(value) or not 1 <= value <= MAX_DIMENSION:
            raise TemplateDocumentError(f"{label} must be an integer between 1 and {MAX_DIMENSION}.")
    pages = document.get("pages")
    if not isinstance(pages, list) or not 1 <= len(pages) <= MAX_PAGES:
        raise TemplateDocumentError(f"pages must be a list of 1 to {MAX_PAGES} pages.")
    for index, page in enumerate(pages, start=1):
        if not isinstance(page, dict):
            raise TemplateDocumentError(f"Page {index} must be an object.")
        page_id = page.get("id")
        if not isinstance(page_id, str) or not page_id:
            raise TemplateDocumentError(f"Page {index} needs a string id.")
        objects = page.get("objects")
        if not isinstance(objects, list) or len(objects) > MAX_OBJECTS_PER_PAGE:
            raise TemplateDocumentError(
                f"Page {index} objects must be a list of at most {MAX_OBJECTS_PER_PAGE}."
            )
        if not all(isinstance(obj, dict) for obj in objects):
            raise TemplateDocumentError(f"Page {index} contains an object that is not a JSON object.")
    try:
        encoded_size = len(json.dumps(document, separators=(",", ":")).encode("utf-8"))
    except (TypeError, ValueError) as exc:
        raise TemplateDocumentError("The document is not valid JSON data.") from exc
    if encoded_size > settings.MAX_DESIGN_DOCUMENT_BYTES:
        raise TemplateDocumentError("The document is too large.")
    _scan_strings(document)

    meta = document.get("meta")
    preset = meta.get("presetId") if isinstance(meta, dict) else ""
    return DocumentSummary(
        width=width,
        height=height,
        page_count=len(pages),
        preset=preset[:64] if isinstance(preset, str) else "",
    )


def normalize_tags(raw: Any) -> list[str]:
    """Lower-case, trimmed, de-duplicated tags; `ValueError` unless given a list of short strings."""
    if raw in (None, ""):
        return []
    if isinstance(raw, str):
        raw = raw.split(",")
    if not isinstance(raw, (list, tuple)) or not all(isinstance(tag, str) for tag in raw):
        raise ValueError("Tags must be a list of strings.")
    tags: dict[str, None] = {}
    for tag in raw:
        cleaned = " ".join(tag.split()).lower()
        if not cleaned:
            continue
        if len(cleaned) > MAX_TAG_LENGTH:
            raise ValueError(f"A tag is longer than {MAX_TAG_LENGTH} characters.")
        tags[cleaned] = None
    if len(tags) > MAX_TAGS:
        raise ValueError(f"Use at most {MAX_TAGS} tags.")
    return list(tags)
