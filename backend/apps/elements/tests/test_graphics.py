import re
import subprocess
import sys
import xml.etree.ElementTree as ET

import pytest

from apps.core.svg import sanitize_svg, svg_colors, svg_info
from apps.elements.generated import GRAPHICS_DIR, generated_files, load_graphics
from apps.elements.manifest import GeneratedSource, load_manifest
from apps.elements.sources import SourceError

NS = "{http://www.w3.org/2000/svg}"
graphics = load_graphics()
SET_IDS = list(graphics.SETS)
MINIMUM = {
    "backgrounds-patterns": 60,
    "frames-badges": 30,
    "dividers-borders": 36,
    "speech-bubbles": 30,
    "social-media": 30,
    "sale-promo": 36,
    "charts": 36,
    "doodle-accents": 48,
}
BRAND_WORDS = re.compile(
    r"facebook|instagram|twitter|tiktok|youtube|linkedin|whatsapp|snapchat|pinterest|telegram|reddit|"
    r"discord|twitch|spotify|netflix|google|apple|amazon|microsoft|meta\b|\bx logo|logo",
    re.I,
)


@pytest.fixture(scope="module")
def rendered():
    return {set_id: graphics.render(set_id) for set_id in SET_IDS}


def all_files(rendered):
    return [(set_id, path, svg) for set_id, files in rendered.items() for path, svg in files.items()]


def test_the_generator_sets_match_the_manifest_packs():
    manifest = load_manifest()
    generated = {p.source.set for p in manifest.packs if isinstance(p.source, GeneratedSource)}
    assert generated == set(SET_IDS) and all(manifest.get(set_id) for set_id in SET_IDS)


@pytest.mark.parametrize("set_id", SET_IDS)
def test_every_set_is_big_enough(rendered, set_id):
    assert len(rendered[set_id]) >= MINIMUM[set_id]


def test_the_original_graphics_add_up_to_hundreds_of_files(rendered):
    assert len(all_files(rendered)) >= 330


@pytest.mark.parametrize("set_id", SET_IDS)
def test_names_are_unique_and_lower_kebab_case(rendered, set_id):
    paths = list(rendered[set_id])
    assert len(set(paths)) == len(paths)
    for path in paths:
        folder, name = path.split("/")
        assert re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", folder) and re.fullmatch(
            r"[a-z0-9]+(-[a-z0-9]+)*\.svg", name
        )


def test_rendering_is_deterministic(rendered):
    for set_id in SET_IDS:
        assert graphics.render(set_id) == rendered[set_id]


def test_every_file_survives_the_sanitiser_unchanged_in_meaning(rendered):
    for set_id, path, svg in all_files(rendered):
        raw = svg.encode()
        clean = sanitize_svg(raw)
        before, after = ET.fromstring(raw), ET.fromstring(clean)
        assert len(list(before.iter())) == len(list(after.iter())), f"{set_id}/{path}: elements removed"
        for a, b in zip(before.iter(), after.iter(), strict=True):
            assert a.attrib == b.attrib, f"{set_id}/{path}: attributes changed"


def test_every_file_is_recolourable_and_uses_only_explicit_hex_colours(rendered):
    named = re.compile(r'(?:fill|stroke|stop-color)="(?!#|none|url\()([^"]*)"')
    for set_id, path, svg in all_files(rendered):
        assert svg_colors(sanitize_svg(svg.encode())), f"{set_id}/{path} has no colours"
        assert not named.findall(svg), f"{set_id}/{path} uses a non-hex colour"


def test_viewbox_title_and_intrinsic_size_are_consistent(rendered):
    for set_id, path, svg in all_files(rendered):
        root = ET.fromstring(svg)
        x, y, w, h = (float(v) for v in root.get("viewBox").split())
        assert (x, y) == (0, 0) and w > 0 and h > 0, f"{set_id}/{path}"
        info = svg_info(sanitize_svg(svg.encode()))
        assert (info.width, info.height) == (w, h), f"{set_id}/{path}"
        title = root.find(f"{NS}title")
        assert title is not None and title.text, f"{set_id}/{path}"


def test_files_stay_small_and_free_of_features_the_editor_cannot_use(rendered):
    banned = (
        "<text",
        "font-family",
        "<filter",
        "<pattern",
        "feTurbulence",
        "<image",
        "<script",
        "<style",
        "href",
    )
    for set_id, path, svg in all_files(rendered):
        assert len(svg) < 120_000, f"{set_id}/{path} is {len(svg)} bytes"
        for token in banned:
            assert token not in svg, f"{set_id}/{path} contains {token}"


def test_path_data_and_numbers_are_well_formed(rendered):
    command = re.compile(r"^[MLCQAHVTSZ]")
    for set_id, path, svg in all_files(rendered):
        assert not re.search(r"\b(nan|inf)\b", svg), f"{set_id}/{path}"
        for el in ET.fromstring(svg).iter(f"{NS}path"):
            assert command.match(el.get("d")), f"{set_id}/{path}"
        assert not re.search(r"\d\.\d{3,}", svg), f"{set_id}/{path} has unrounded numbers"


def test_no_graphic_is_named_after_or_imitates_a_brand(rendered):
    for set_id, path, _svg in all_files(rendered):
        assert not BRAND_WORDS.search(path), f"{set_id}/{path}"
    social = " ".join(rendered["social-media"])
    assert "like-heart" in social and "comment-bubble" in social and "share-nodes" in social


def test_colours_stay_plain_hex_so_recolouring_never_meets_rgba_values(rendered):
    for set_id, path, svg in all_files(rendered):
        assert "fill-opacity" not in svg and "stroke-opacity" not in svg, f"{set_id}/{path}"


def test_lines_declare_no_fill_so_the_editor_does_not_add_a_black_one(rendered):
    for set_id, path, svg in all_files(rendered):
        for el in ET.fromstring(svg).iter(f"{NS}line"):
            assert el.get("fill") == "none", f"{set_id}/{path}"


def test_gradients_are_defined_inside_the_file_that_uses_them(rendered):
    for set_id, path, svg in all_files(rendered):
        root = ET.fromstring(svg)
        defined = {el.get("id") for el in root.iter() if el.get("id")}
        used = set(re.findall(r"url\(#([^)]+)\)", svg))
        assert used <= defined, f"{set_id}/{path} references {used - defined}"


def test_patterns_are_square_backgrounds_with_a_background_layer(rendered):
    for path, svg in rendered["backgrounds-patterns"].items():
        root = ET.fromstring(svg)
        assert (root.get("width"), root.get("height")) == ("600", "600"), path
        first = next(el for el in root if el.tag != f"{NS}title")
        assert first.tag in (f"{NS}rect", f"{NS}defs"), path


def test_pattern_families_cover_what_was_asked_for(rendered):
    folders = {p.split("/")[0] for p in rendered["backgrounds-patterns"]}
    assert {
        "dots",
        "stripes",
        "checks",
        "waves",
        "topographic",
        "confetti",
        "memphis",
        "blobs",
        "gradients",
    } <= folders


def test_motifs_stay_inside_the_canvas(rendered):
    for path, svg in rendered["backgrounds-patterns"].items():
        root = ET.fromstring(svg)
        clipped = root.find(f"{NS}g[@clip-path]") is not None
        for poly in root.iter(f"{NS}polygon"):
            for pair in poly.get("points").split():
                x, y = (float(v) for v in pair.split(","))
                assert -0.01 <= x <= 600.01 and -0.01 <= y <= 600.01, f"{path}: {pair}"
        for circ in root.iter(f"{NS}circle"):
            if clipped or circ.get("fill", "").startswith("url("):
                continue  # clipped motifs and soft gradient glows may run past the edge on purpose
            cx, cy, r = (float(circ.get(k)) for k in ("cx", "cy", "r"))
            assert cx - r >= -0.01 and cy - r >= -0.01 and cx + r <= 600.01 and cy + r <= 600.01, (
                f"{path}: circle"
            )


def test_clip_polygon_cuts_shapes_to_the_canvas():
    from doory_graphics.patterns import clip_polygon

    inside = [(10, 10), (100, 10), (100, 100)]
    assert clip_polygon(inside) == inside
    cut = clip_polygon([(-50, -50), (650, -50), (650, 650), (-50, 650)])
    assert sorted(cut) == [(0, 0), (0, 600), (600, 0), (600, 600)]
    assert clip_polygon([(700, 700), (800, 700), (800, 800)]) == []


def test_the_generator_scripts_write_every_file(tmp_path):
    script = GRAPHICS_DIR.parent / "generate_graphics.py"
    result = subprocess.run(
        [sys.executable, str(script), str(tmp_path)], capture_output=True, text=True, check=True
    )
    written = list(tmp_path.rglob("*.svg"))
    assert "Wrote" in result.stdout and len(written) >= 330
    assert (tmp_path / "charts" / "bars" / "bar-vertical.svg").is_file()
    assert subprocess.run([sys.executable, str(script)], capture_output=True, text=True).returncode == 2


def test_generated_files_returns_bytes_and_rejects_unknown_sets():
    files = generated_files(GeneratedSource("graphics", "charts"))
    assert "bars/bar-vertical.svg" in files and isinstance(next(iter(files.values())), bytes)
    with pytest.raises(SourceError, match="no set called"):
        generated_files(GeneratedSource("graphics", "nope"))


# ---- helpers ----------------------------------------------------------------------------------------------------


def test_rng_is_deterministic_and_stays_in_range():
    from doory_graphics.kit import Rng

    a, b = Rng(7), Rng(7)
    assert [a.random() for _ in range(5)] == [b.random() for _ in range(5)]
    rng = Rng(3)
    assert all(0 <= rng.random() < 1 for _ in range(200))
    assert all(5 <= rng.integer(5, 9) <= 9 for _ in range(200))
    assert all(-2 <= rng.uniform(-2, 2) <= 2 for _ in range(200))
    assert Rng(1).random() != Rng(2).random()
    assert Rng(5).choice("abc") in "abc"


def test_smooth_needs_two_points_and_closes_loops():
    from doory_graphics.kit import smooth

    with pytest.raises(ValueError):
        smooth([(0, 0)])
    assert smooth([(0, 0), (10, 10), (20, 0)]).startswith("M0 0 C")
    assert smooth([(0, 0), (10, 10), (20, 0)], closed=True).endswith("Z")


def test_the_collector_refuses_duplicate_names():
    from doory_graphics.kit import Collector

    add = Collector("demo")
    add("folder", "name", "<g/>", 10, 10)
    with pytest.raises(ValueError, match="duplicate"):
        add("folder", "name", "<g/>", 10, 10)


def test_attribute_helper_formats_numbers_and_drops_empty_values():
    from doory_graphics.kit import attrs

    assert (
        attrs(x=1.0, y=2.5, fill="#fff", stroke_width=3, rx=None, title="")
        == ' x="1" y="2.5" fill="#fff" stroke-width="3"'
    )
    assert attrs(label='a"b<c') == ' label="a&quot;b&lt;c"'


# ---- lettering ------------------------------------------------------------------------------------------------------


def test_lettering_draws_words_as_one_stroked_path():
    from doory_graphics.lettering import GLYPHS, text_width, word

    svg = word("SALE 50%", 100, 50, 40, "#e11d48", 5)
    root = ET.fromstring(f'<svg xmlns="http://www.w3.org/2000/svg">{svg}</svg>')
    (path,) = list(root)
    assert path.get("fill") == "none" and path.get("stroke") == "#e11d48" and path.get("stroke-width") == "5"
    assert path.get("d").startswith("M") and path.get("transform") is None
    assert text_width("SALE", 40) < text_width("SALE SALE", 40)
    assert text_width("", 40) == 0
    assert set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789%!?$+-.") <= set(GLYPHS)


def test_lettering_can_be_rotated_and_refuses_unknown_characters():
    from doory_graphics.lettering import word

    assert 'transform="rotate(-45 70 70)"' in word("NEW", 70, 70, 20, "#e11d48", rotate=-45)
    with pytest.raises(ValueError, match="no lettering"):
        word("café", 0, 0, 10, "#fff")


def test_lettering_is_centred_on_the_requested_point():
    from doory_graphics.lettering import text_width, word

    for cx in (100, 260):
        first_x = float(re.search(r'd="M ?(-?[\d.]+)', word("HH", cx, 50, 24, "#e11d48")).group(1))
        assert first_x == pytest.approx(cx - text_width("HH", 24) / 2, abs=0.01)
