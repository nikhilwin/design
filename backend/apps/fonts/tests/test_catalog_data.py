import json
import re

from apps.fonts.catalog import (
    POPULAR_FONTS_PATH,
    UNICODE_RANGES_PATH,
    curated_by_id,
    curated_fonts,
    unicode_ranges,
)
from apps.fonts.models import FontCategory
from apps.fonts.sources import is_valid_font_id


def test_the_curated_list_is_large_valid_and_ranked():
    fonts = curated_fonts()
    assert len(fonts) >= 150
    assert [f.popularity for f in fonts] == list(range(1, len(fonts) + 1))
    assert len({f.id for f in fonts}) == len(fonts) and len({f.family.lower() for f in fonts}) == len(fonts)
    for font in fonts:
        assert is_valid_font_id(font.id), font.id
        assert font.category in FontCategory.values and font.scripts, font.id


def test_the_curated_list_covers_the_scripts_the_editor_needs():
    scripts = {s for f in curated_fonts() for s in f.scripts}
    assert {"latin", "latin-ext", "cyrillic", "greek", "devanagari", "bengali", "arabic", "hebrew"} <= scripts
    assert {"japanese", "korean", "chinese-simplified"} <= scripts


def test_the_curated_list_has_every_category_and_the_classics():
    by_id = curated_by_id()
    assert {f.category for f in by_id.values()} == set(FontCategory.values)
    for font_id in (
        "roboto",
        "open-sans",
        "inter",
        "playfair-display",
        "noto-sans-bengali",
        "noto-sans-arabic",
        "noto-sans-jp",
    ):
        assert font_id in by_id, font_id


def test_the_raw_files_are_plain_json_without_surprises():
    rows = json.loads(POPULAR_FONTS_PATH.read_text(encoding="utf-8"))
    assert all(set(row) == {"family", "id", "category", "scripts", "popularity"} for row in rows)
    assert all(isinstance(row["scripts"], list) and row["scripts"] for row in rows)
    ranges = json.loads(UNICODE_RANGES_PATH.read_text(encoding="utf-8"))
    assert all(re.fullmatch(r"U\+[0-9A-F?-]+(?:,U\+[0-9A-F?-]+)*", value) for value in ranges.values())


def test_unicode_ranges_cover_the_common_subsets():
    ranges = unicode_ranges()
    for subset in (
        "latin",
        "latin-ext",
        "cyrillic",
        "greek",
        "devanagari",
        "bengali",
        "arabic",
        "hebrew",
        "thai",
        "vietnamese",
    ):
        assert ranges[subset].startswith("U+"), subset
