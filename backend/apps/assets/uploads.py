"""Helpers for safely accepting uploaded files."""

from __future__ import annotations

import unicodedata

from .exceptions import FileTooLarge

_ENVELOPE_BYTES = 1024 * 1024
# Bidi overrides/isolates, zero-width space, marks and BOM can spoof a name; ZWJ/ZWNJ stay (emoji, Indic).
_INVISIBLE = frozenset(
    chr(code) for code in (*range(0x202A, 0x202F), *range(0x2066, 0x206A), 0x200B, 0x200E, 0x200F, 0xFEFF)
)


MAX_NAME_LENGTH = 255
MAX_TAGS = 20
MAX_TAG_LENGTH = 40


def reject_oversize_request(request, limit: int) -> None:
    """Fail fast on a declared body size before any of it is buffered (multipart overhead allowed)."""
    try:
        declared = int(request.META.get("CONTENT_LENGTH") or 0)
    except ValueError:
        declared = 0
    if declared > limit + _ENVELOPE_BYTES:
        raise FileTooLarge()


def strip_unsafe_chars(text: str) -> str:
    return "".join(ch for ch in text if unicodedata.category(ch) != "Cc" and ch not in _INVISIBLE)


def clean_name(raw: str, fallback: str = "Untitled") -> str:
    """A display name: no path, no control / bidi-override characters, collapsed whitespace, <= 255 chars."""
    name = unicodedata.normalize("NFC", raw.replace("\\", "/").rsplit("/", 1)[-1])
    name = " ".join(strip_unsafe_chars(name).split()).strip(" .")
    return name[:MAX_NAME_LENGTH].rstrip() or fallback


def clean_tags(values: list[str]) -> list[str]:
    """Lower-cased, whitespace-collapsed, de-duplicated tags with empty ones dropped."""
    tags: list[str] = []
    for value in values:
        tag = " ".join(strip_unsafe_chars(value).split()).lower()
        if tag and tag not in tags:
            tags.append(tag)
    return tags
