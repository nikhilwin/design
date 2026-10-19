"""Validate and describe font files by content. Never trusts the file name, extension or client MIME type."""

from __future__ import annotations

import json
import re
import subprocess
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path

PROBE_SCRIPT = Path(__file__).with_name("probe_worker.py")
PROBE_TIMEOUT_SECONDS = 20
MAX_FAMILY_CHARS = 100

_MAGIC = (
    (b"\x00\x01\x00\x00", "ttf"),
    (b"true", "ttf"),
    (b"OTTO", "otf"),
    (b"wOFF", "woff"),
    (b"wOF2", "woff2"),
)
_SAFE_PUNCTUATION = set(" -_.&+()")
KNOWN_CATEGORIES = {"sans-serif", "serif", "display", "handwriting", "monospace"}


class FontError(ValueError):
    """The file is not an acceptable font; the message is safe to show to the user."""


@dataclass(frozen=True)
class FontInfo:
    format: str
    family: str
    weight: int
    style: str
    is_variable: bool
    scripts: tuple[str, ...]
    category: str


def sniff_format(data: bytes) -> str:
    """Container format from the leading bytes: ttf, otf, woff or woff2."""
    head = data[:4]
    if head == b"ttcf":
        raise FontError("Font collections (.ttc/.otc) are not supported. Upload the individual fonts.")
    for magic, fmt in _MAGIC:
        if head == magic:
            return fmt
    raise FontError("The file is not a TTF, OTF, WOFF or WOFF2 font.")


def clean_family_name(raw: str | None) -> str:
    """Letters, combining marks, digits, spaces and `-_.&+()` only: safe to embed in CSS and UI."""
    text = unicodedata.normalize("NFC", raw or "")
    kept = "".join(ch for ch in text if unicodedata.category(ch)[0] in "LMN" or ch in _SAFE_PUNCTUATION)
    return re.sub(r"\s+", " ", kept).strip(" -_.")[:MAX_FAMILY_CHARS].strip()


def inspect_font(data: bytes) -> FontInfo:
    """Parse `data` in a resource-limited subprocess and return what the catalog stores about it."""
    fmt = sniff_format(data)
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, no shell, our own script
            [sys.executable, "-I", str(PROBE_SCRIPT)],
            input=data,
            capture_output=True,
            timeout=PROBE_TIMEOUT_SECONDS,
            check=False,
            env={},  # the parser of an untrusted file gets none of the application's secrets
        )
    except subprocess.TimeoutExpired as exc:
        raise FontError("The font took too long to read and was rejected.") from exc
    except OSError as exc:
        raise FontError("The font could not be checked right now. Try again later.") from exc
    try:
        result = json.loads(completed.stdout[:65536])
    except ValueError as exc:
        raise FontError("The file could not be parsed as a font.") from exc
    if not isinstance(result, dict):
        raise FontError("The file could not be parsed as a font.")
    if "error" in result:
        raise FontError(str(result["error"]))
    family = clean_family_name(result.get("family"))
    if not family:
        raise FontError("The font has no usable family name in its name table.")
    category = result.get("category")
    return FontInfo(
        format=fmt,
        family=family,
        weight=int(result["weight"]),
        style="italic" if result.get("italic") else "normal",
        is_variable=bool(result.get("is_variable")),
        scripts=tuple(s for s in result.get("scripts", []) if isinstance(s, str)),
        category=category if category in KNOWN_CATEGORIES else "sans-serif",
    )
