import re

import pytest
from defusedxml import ElementTree as SafeET

from apps.exports.layout import (
    MARK_GAP_MM,
    MARK_LENGTH_MM,
    PX_PER_MM,
    SHEET_ALLOWANCE_PX,
    EmbeddedFont,
    PageGeometry,
    build_document_html,
    crop_marks_svg,
    fmt,
    font_face_css,
    prepare_page_svg,
)

from .helpers import svg_page


def sheet(px: float) -> str:
    """A page side as `@page` has it: one PDF point (4/3 px) larger than the page."""
    return fmt(px + SHEET_ALLOWANCE_PX)


def test_plain_geometry():
    geometry = PageGeometry.create(800, 600)
    assert (geometry.page_width, geometry.page_height) == (800, 600)
    assert (geometry.art_width, geometry.art_height) == (800, 600)
    assert not geometry.has_marks


def test_bleed_grows_the_page_on_every_side():
    geometry = PageGeometry.create(800, 600, bleed_mm=3)
    bleed = 3 * PX_PER_MM
    assert geometry.page_width == pytest.approx(800 + 2 * bleed)
    assert geometry.art_height == pytest.approx(600 + 2 * bleed)
    assert geometry.margin == pytest.approx(bleed)


def test_crop_marks_add_a_slug_outside_the_bleed():
    geometry = PageGeometry.create(800, 600, bleed_mm=3, crop_marks=True)
    slug = (MARK_GAP_MM + MARK_LENGTH_MM) * PX_PER_MM
    assert geometry.has_marks
    assert geometry.slug == pytest.approx(slug)
    assert geometry.page_width == pytest.approx(800 + 2 * (3 * PX_PER_MM + slug))
    assert geometry.art_width == pytest.approx(800 + 2 * 3 * PX_PER_MM)


def _marks(geometry):
    root = SafeET.fromstring(crop_marks_svg(geometry))
    path = next(el for el in root.iter() if el.tag.endswith("path"))
    return root, path.get("d")


def test_crop_marks_are_eight_lines_inside_the_page_and_outside_the_artwork():
    geometry = PageGeometry.create(500, 400, bleed_mm=3, crop_marks=True)
    root, d = _marks(geometry)
    assert float(root.get("width")) == pytest.approx(geometry.page_width, abs=1e-3)
    segments = re.findall(r"M([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)", d)
    assert len(segments) == 8
    art_left, art_top = geometry.slug, geometry.slug
    art_right, art_bottom = art_left + geometry.art_width, art_top + geometry.art_height
    for x1, y1, x2, y2 in (tuple(map(float, s)) for s in segments):
        for x, y in ((x1, y1), (x2, y2)):
            assert -1e-3 <= x <= geometry.page_width + 1e-3 and -1e-3 <= y <= geometry.page_height + 1e-3
            assert not (art_left < x < art_right and art_top < y < art_bottom)
        length = abs(x2 - x1) + abs(y2 - y1)
        assert length == pytest.approx(MARK_LENGTH_MM * PX_PER_MM, abs=1e-2)


def test_marks_line_up_with_the_trim_corners():
    geometry = PageGeometry.create(500, 400, bleed_mm=0, crop_marks=True)
    _, d = _marks(geometry)
    trim_left, trim_top = geometry.margin, geometry.margin
    first = re.search(r"M([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)", d)
    assert float(first.group(2)) == pytest.approx(trim_top, abs=1e-3)  # horizontal mark sits at the trim edge
    assert float(first.group(1)) == pytest.approx(trim_left - MARK_GAP_MM * PX_PER_MM, abs=1e-3)


def test_prepare_svg_sizes_to_the_artwork_box():
    geometry = PageGeometry.create(400, 300, bleed_mm=3)
    root = SafeET.fromstring(prepare_page_svg(svg_page(400, 300), geometry))
    assert float(root.get("width")) == pytest.approx(geometry.art_width, abs=1e-3)
    assert float(root.get("height")) == pytest.approx(geometry.art_height, abs=1e-3)
    assert root.get("viewBox") == "0 0 400 300"
    assert root.get("preserveAspectRatio") == "xMidYMid slice"


def test_without_bleed_the_artwork_is_fitted_not_cropped():
    root = SafeET.fromstring(prepare_page_svg(svg_page(400, 300), PageGeometry.create(400, 300)))
    assert root.get("preserveAspectRatio") == "xMidYMid meet"


def test_missing_view_box_is_derived_from_width_and_height():
    svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100"/></svg>'
    root = SafeET.fromstring(prepare_page_svg(svg, PageGeometry.create(400, 200)))
    assert root.get("viewBox") == "0 0 200 100"


@pytest.mark.parametrize(
    "view_box", ['viewBox="0 0 0 0"', 'viewBox="nonsense"', 'viewBox="0 0 10"', 'viewBox="0 0 -5 5"']
)
def test_unusable_view_boxes_are_replaced(view_box):
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" {view_box}><rect/></svg>'.encode()
    )
    root = SafeET.fromstring(prepare_page_svg(svg, PageGeometry.create(400, 200)))
    assert root.get("viewBox") == "0 0 200 100"


def test_svg_without_any_size_falls_back_to_the_trim_size():
    svg = b'<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/></svg>'
    root = SafeET.fromstring(prepare_page_svg(svg, PageGeometry.create(640, 480)))
    assert root.get("viewBox") == "0 0 640 480"


def test_root_offsets_are_dropped():
    svg = (
        b'<svg xmlns="http://www.w3.org/2000/svg" x="50" y="50" width="10" height="10" viewBox="0 0 10 10"/>'
    )
    root = SafeET.fromstring(prepare_page_svg(svg, PageGeometry.create(10, 10)))
    assert root.get("x") is None and root.get("y") is None


def test_document_has_one_fixed_size_section_per_page():
    geometry = PageGeometry.create(400, 300)
    svgs = [prepare_page_svg(svg_page(), geometry) for _ in range(3)]
    document = build_document_html(svgs, geometry, "Deck")
    assert document.count('<section class="page ') == 3
    assert document.count('<template shadowrootmode="open">') == 3
    assert f"@page{{size:{sheet(400)}px {sheet(300)}px;margin:0}}" in document
    assert "<title>Deck</title>" in document
    assert document.startswith("<!doctype html>")


def test_each_page_lives_in_its_own_shadow_root():
    geometry = PageGeometry.create(400, 300)
    document = build_document_html([prepare_page_svg(svg_page(ident="same"), geometry)] * 2, geometry)
    for chunk in document.split('<template shadowrootmode="open">')[1:]:
        assert chunk.index("<svg") < chunk.index("</template>")
        assert chunk.count('id="same"') == 1


def test_marks_only_when_requested():
    plain = PageGeometry.create(400, 300)
    marked = PageGeometry.create(400, 300, crop_marks=True)
    assert 'class="marks"' not in build_document_html([prepare_page_svg(svg_page(), plain)], plain)
    assert build_document_html([prepare_page_svg(svg_page(), marked)], marked).count('class="marks"') == 1


def test_title_is_escaped():
    geometry = PageGeometry.create(10, 10)
    document = build_document_html([], geometry, '</title><script>alert("x")</script>')
    assert "<script" not in document
    assert "&lt;/title&gt;" in document


def test_document_never_contains_scripts_or_remote_urls():
    geometry = PageGeometry.create(400, 300)
    document = build_document_html([prepare_page_svg(svg_page(), geometry)], geometry, "t")
    assert "<script" not in document.lower()
    assert "http://" not in document.replace("http://www.w3.org/2000/svg", "")
    assert "https://" not in document


def test_font_face_rules_embed_data_urls():
    css = font_face_css([EmbeddedFont("Doory Sans", 700, "italic", "font/woff2", b"abc")])
    assert css == (
        '@font-face{font-family:"Doory Sans";font-weight:700;font-style:italic;'
        'src:url("data:font/woff2;base64,YWJj")}'
    )


def test_font_family_cannot_break_out_of_the_rule():
    css = font_face_css([EmbeddedFont('a"}</style><script>x</script>', 400, "normal", "font/ttf", b"x")])
    assert css.count("@font-face") == 1
    assert "<" not in css and ">" not in css
    assert 'font-family:"astylescriptxscript"' in css


# ---- pages of different sizes ---------------------------------------------------------------


def test_mixed_sizes_get_named_pages_and_classes():
    small, large = PageGeometry.create(400, 300), PageGeometry.create(800, 600)
    document = build_document_html(
        [prepare_page_svg(svg_page(), g) for g in (small, large, small)], [small, large, small], "Kit"
    )
    assert (
        f"@page{{size:{sheet(400)}px {sheet(300)}px;margin:0}}" in document
    )  # the default is the first page
    assert f"@page p0{{size:{sheet(400)}px {sheet(300)}px;margin:0}}" in document
    assert f"@page p1{{size:{sheet(800)}px {sheet(600)}px;margin:0}}" in document
    assert ".p0{page:p0;width:400px;height:300px}" in document
    assert ".p1{page:p1;width:800px;height:600px}" in document
    classes = re.findall(r'<section class="page (p\d)">', document)
    assert classes == ["p0", "p1", "p0"]


def test_pages_of_one_size_share_a_class_and_use_no_named_page():
    geometry = PageGeometry.create(400, 300)
    document = build_document_html([prepare_page_svg(svg_page(), geometry)] * 3, [geometry] * 3)
    assert "@page p" not in document and "page:p0" not in document
    assert re.findall(r'<section class="page (p\d)">', document) == ["p0"] * 3


def test_each_size_has_its_own_slug_and_marks():
    plain = PageGeometry.create(400, 300, bleed_mm=2, crop_marks=True)
    other = PageGeometry.create(100, 100, bleed_mm=2, crop_marks=True)
    document = build_document_html([prepare_page_svg(svg_page(), g) for g in (plain, other)], [plain, other])
    assert document.count('class="marks"') == 2
    assert f'width="{fmt(plain.page_width)}" height="{fmt(plain.page_height)}"' in document
    assert f'width="{fmt(other.page_width)}" height="{fmt(other.page_height)}"' in document
    assert (
        f".p1 .art{{left:{fmt(other.slug)}px;top:{fmt(other.slug)}px;width:{fmt(other.art_width)}px"
        in document
    )


def test_marks_follow_the_geometry_of_their_page():
    marked, unmarked = PageGeometry.create(400, 300, crop_marks=True), PageGeometry.create(400, 300)
    document = build_document_html(
        [prepare_page_svg(svg_page(), g) for g in (marked, unmarked)], [marked, unmarked]
    )
    assert document.count('class="marks"') == 1


def test_a_geometry_list_must_match_the_pages():
    geometry = PageGeometry.create(400, 300)
    with pytest.raises(ValueError):
        build_document_html([prepare_page_svg(svg_page(), geometry)] * 2, [geometry])
    with pytest.raises(ValueError):
        build_document_html([], [])


def test_the_document_language_is_escaped():
    geometry = PageGeometry.create(10, 10)
    assert '<html lang="de-CH">' in build_document_html([], geometry, lang="de-CH")
    assert "<script" not in build_document_html([], geometry, lang='"><script>')


def test_a_viewbox_that_already_contains_the_bleed_is_not_scaled():
    """The editor sends the trim box grown by the bleed as the viewBox: 1:1, so the layout is exactly as designed."""
    geometry = PageGeometry.create(400, 300, bleed_mm=3)
    b = geometry.bleed
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{400 + 2 * b}" height="{300 + 2 * b}" '
        f'viewBox="{-b} {-b} {400 + 2 * b} {300 + 2 * b}"><rect width="400" height="300"/></svg>'
    ).encode()
    root = SafeET.fromstring(prepare_page_svg(svg, geometry))
    vx, vy, vw, vh = (float(v) for v in root.get("viewBox").split())
    assert (vw, vh) == (pytest.approx(geometry.art_width), pytest.approx(geometry.art_height))
    assert float(root.get("width")) / vw == pytest.approx(1, abs=1e-6)
    assert float(root.get("height")) / vh == pytest.approx(1, abs=1e-6)
    assert (vx, vy) == (pytest.approx(-b), pytest.approx(-b))
