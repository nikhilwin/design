"""Fonts for a print job: read from this server's own media storage and inlined into the page.

The browser never fetches a font over the network. The client names fonts by their `/media/` URL (as
listed in the font catalog); the server resolves that to a storage name, checks it really is a font file and
embeds the bytes.
"""

from __future__ import annotations

import posixpath
from collections.abc import Sequence
from urllib.parse import unquote, urlsplit

from django.conf import settings
from django.core.exceptions import SuspiciousOperation
from django.core.files.storage import default_storage

from .exceptions import InvalidExport
from .layout import EmbeddedFont
from .policy import normalize_origin

MAX_FONTS = 32
MAX_FONT_BYTES = 8 * 1024 * 1024
MAX_TOTAL_FONT_BYTES = 24 * 1024 * 1024

_SIGNATURES: tuple[tuple[bytes, str], ...] = (
    (b"wOF2", "font/woff2"),
    (b"wOFF", "font/woff"),
    (b"OTTO", "font/otf"),
    (b"\x00\x01\x00\x00", "font/ttf"),
    (b"true", "font/ttf"),
)


def font_mime(head: bytes) -> str | None:
    for signature, mime in _SIGNATURES:
        if head.startswith(signature):
            return mime
    return None


def media_storage_name(url: str, allowed_origins: Sequence[str]) -> str:
    """Map a `/media/...` URL (relative, or absolute on an allowed origin) to a storage name."""
    parts = urlsplit(url)
    if parts.scheme or parts.netloc:
        origin = normalize_origin(f"{parts.scheme}://{parts.netloc}")
        if origin is None or origin not in {normalize_origin(o) for o in allowed_origins}:
            raise InvalidExport("invalid_font", "Fonts must be served from this site's media storage.")
    media_path = urlsplit(settings.MEDIA_URL).path
    path = unquote(parts.path)
    if not path.startswith(media_path):
        raise InvalidExport("invalid_font", "Fonts must be served from this site's media storage.")
    name = path[len(media_path) :]
    if (
        not name
        or "\\" in name
        or "\x00" in name
        or posixpath.normpath(name) != name
        or name.startswith(("/", ".."))
    ):
        raise InvalidExport("invalid_font", "Invalid font path.")
    return name


def load_fonts(specs: Sequence[dict], allowed_origins: Sequence[str]) -> list[EmbeddedFont]:
    if len(specs) > MAX_FONTS:
        raise InvalidExport("invalid_font", f"At most {MAX_FONTS} font files can be embedded.")
    fonts: list[EmbeddedFont] = []
    total = 0
    cache: dict[str, tuple[bytes, str]] = {}
    for spec in specs:
        name = media_storage_name(spec["url"], allowed_origins)
        if name not in cache:
            cache[name] = _read_font(name)
            total += len(cache[name][0])
            if total > MAX_TOTAL_FONT_BYTES:
                raise InvalidExport("invalid_font", "The selected fonts are too large to embed.")
        data, mime = cache[name]
        fonts.append(EmbeddedFont(spec["family"], spec["weight"], spec["style"], mime, data))
    return fonts


def _read_font(name: str) -> tuple[bytes, str]:
    try:
        with default_storage.open(name, "rb") as handle:
            data = handle.read(MAX_FONT_BYTES + 1)
    except (OSError, SuspiciousOperation, ValueError):
        raise InvalidExport("invalid_font", "A requested font file does not exist.")
    if len(data) > MAX_FONT_BYTES:
        raise InvalidExport("invalid_font", "A requested font file is too large.")
    mime = font_mime(data[:4])
    if mime is None:
        raise InvalidExport("invalid_font", "A requested font file is not a font.")
    return data, mime
