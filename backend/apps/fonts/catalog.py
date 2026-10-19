"""Static catalog data shipped with Doory: the curated popular-font list and CSS unicode ranges."""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

from .models import FontCategory

DATA_DIR = Path(settings.BASE_DIR) / "data"
POPULAR_FONTS_PATH = DATA_DIR / "popular_fonts.json"
UNICODE_RANGES_PATH = DATA_DIR / "unicode_ranges.json"


#: Families the editor uses without being asked: the default heading and body fonts
#: (frontend/src/editor/engine/objects/factories.ts) and the faces of the Text tool's font pairings
#: (frontend/src/editor/drawers/pairings.ts). `sync_fonts --popular N` always installs them, so a new
#: heading never falls back to the browser's font because its family ranks below N.
EDITOR_FONTS = (
    "Plus Jakarta Sans",
    "Inter",
    "Playfair Display",
    "DM Sans",
    "Montserrat",
    "Open Sans",
    "Lora",
    "Lato",
    "Pacifico",
    "Poppins",
    "Bebas Neue",
    "Roboto",
    "Cormorant Garamond",
)

#: Fonts for the main scripts a Latin font does not cover, so a default install sets Arabic, Hebrew, Bangla,
#: Hindi and Thai in a real typeface, not the browser's fallback. `sync_fonts --popular N` always adds them.
SCRIPT_FONTS = (
    "Cairo",
    "Noto Sans Arabic",
    "Amiri",
    "Heebo",
    "Noto Sans Hebrew",
    "Hind Siliguri",
    "Noto Sans Bengali",
    "Noto Sans Devanagari",
    "Noto Sans Thai",
)


@dataclass(frozen=True)
class CuratedFont:
    id: str
    family: str
    category: str
    scripts: tuple[str, ...]
    popularity: int


def _load(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ImproperlyConfigured(f"Cannot read {path}: {exc}") from exc


@lru_cache(maxsize=1)
def curated_fonts() -> tuple[CuratedFont, ...]:
    """The curated list, ordered by popularity rank (1 = most popular)."""
    rows = _load(POPULAR_FONTS_PATH)
    fonts = []
    for row in rows:
        try:
            font = CuratedFont(
                id=str(row["id"]),
                family=str(row["family"]),
                category=str(row["category"]),
                scripts=tuple(str(s) for s in row["scripts"]),
                popularity=int(row["popularity"]),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise ImproperlyConfigured(f"Malformed entry in {POPULAR_FONTS_PATH.name}: {row!r}") from exc
        if font.category not in FontCategory.values:
            raise ImproperlyConfigured(f"{font.id}: unknown category {font.category!r}")
        fonts.append(font)
    return tuple(sorted(fonts, key=lambda f: f.popularity))


def curated_by_id() -> dict[str, CuratedFont]:
    return {font.id: font for font in curated_fonts()}


@lru_cache(maxsize=1)
def unicode_ranges() -> dict[str, str]:
    """CSS `unicode-range` per subset name (empty for subsets without a known range)."""
    data = _load(UNICODE_RANGES_PATH)
    return {str(k): str(v) for k, v in data.items()}
