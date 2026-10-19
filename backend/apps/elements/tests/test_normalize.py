import xml.etree.ElementTree as ET

import pytest

from apps.core.svg import SvgError
from apps.elements.normalize import DEFAULT_COLOR, NormalizeSpec, normalize_svg, parse_color
from apps.elements.svgdata import process_svg

NS = "{http://www.w3.org/2000/svg}"
MONO = NormalizeSpec(mode="mono", size=24)
COLOUR = NormalizeSpec(mode="colour")


def svg(body: str, root: str = 'viewBox="0 0 24 24"') -> bytes:
    return f'<svg xmlns="http://www.w3.org/2000/svg" {root}>{body}</svg>'.encode()


def parse(data: bytes) -> ET.Element:
    return ET.fromstring(data)


def shapes(root: ET.Element) -> list[ET.Element]:
    return [el for el in root.iter() if el.tag in (f"{NS}path", f"{NS}circle", f"{NS}rect")]


# ---- icons ------------------------------------------------------------------------------------------------------


def test_stroke_icon_inherits_currentcolor_from_the_root_and_gets_explicit_attributes():
    raw = svg(
        '<path d="M1 1h22"/><circle cx="12" cy="12" r="4"/>',
        'viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" '
        'stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x"',
    )

    root = parse(normalize_svg(raw, MONO))

    assert (root.get("fill"), root.get("stroke"), root.get("class")) == (None, None, None)
    for shape in shapes(root):
        assert shape.get("fill") == "none"
        assert shape.get("stroke") == DEFAULT_COLOR
        assert (shape.get("stroke-width"), shape.get("stroke-linecap"), shape.get("stroke-linejoin")) == (
            "2",
            "round",
            "round",
        )


def test_filled_icon_gets_an_explicit_fill():
    root = parse(
        normalize_svg(svg('<path d="M0 0h24v24H0z"/>', 'viewBox="0 0 24 24" fill="currentColor"'), MONO)
    )
    (path,) = shapes(root)
    assert (path.get("fill"), path.get("stroke")) == (DEFAULT_COLOR, None)


def test_a_shape_without_any_paint_is_painted_black_by_default_so_it_becomes_recolourable():
    (path,) = shapes(parse(normalize_svg(svg('<path d="M0 0h24v24H0z"/>'), MONO)))
    assert path.get("fill") == DEFAULT_COLOR


def test_invisible_helper_shapes_are_dropped():
    raw = svg(
        '<path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M3 3h18" fill="none" stroke="#000"/>'
    )
    assert len(shapes(parse(normalize_svg(raw, MONO)))) == 1
    hidden = svg('<path d="M1 1h4" display="none"/><path d="M1 1h4" visibility="hidden"/><path d="M2 2h9"/>')
    assert len(shapes(parse(normalize_svg(hidden, MONO)))) == 1


def test_a_document_with_nothing_visible_is_refused():
    with pytest.raises(SvgError, match="no visible shapes"):
        normalize_svg(svg('<path d="M0 0" fill="none" stroke="none"/>'), MONO)


def test_icons_are_scaled_to_the_requested_size_whatever_grid_they_were_drawn_on():
    big = parse(normalize_svg(svg('<path d="M0 0h256v256z"/>', 'viewBox="0 0 256 256"'), MONO))
    assert (big.get("width"), big.get("height"), big.get("viewBox")) == ("24", "24", "0 0 256 256")
    offset = parse(
        normalize_svg(svg('<path d="M0 0h8v8z"/>', 'viewBox="0 -960 960 960" width="48" height="48"'), MONO)
    )
    assert (offset.get("width"), offset.get("height"), offset.get("viewBox")) == (
        "24",
        "24",
        "0 -960 960 960",
    )
    wide = parse(normalize_svg(svg('<path d="M0 0h8v8z"/>', 'viewBox="0 0 48 24"'), MONO))
    assert (wide.get("width"), wide.get("height")) == ("24", "12")


def test_size_comes_from_width_and_height_when_there_is_no_viewbox():
    root = parse(
        normalize_svg(
            b'<svg xmlns="http://www.w3.org/2000/svg" width="10px" height="20px"><path d="M0 0h5v5z"/></svg>',
            COLOUR,
        )
    )
    assert (root.get("viewBox"), root.get("width"), root.get("height")) == ("0 0 10 20", "10", "20")


def test_artwork_keeps_its_own_size_when_no_size_is_requested():
    root = parse(
        normalize_svg(
            svg('<path d="M0 0h5v5z"/>', 'width="1024px" height="768px" viewBox="0 0 1024 768"'), COLOUR
        )
    )
    assert (root.get("width"), root.get("height")) == ("1024", "768")


@pytest.mark.parametrize(
    "root_attrs",
    ['width="x" height="y"', 'viewBox="0 0 0 0"', 'viewBox="a b c d"', ""],
)
def test_an_unusable_size_is_refused(root_attrs):
    with pytest.raises(SvgError, match="viewBox"):
        normalize_svg(svg('<path d="M0 0h5v5z"/>', root_attrs), MONO)


def test_duotone_opacity_and_group_transforms_survive():
    raw = svg(
        '<g transform="translate(2 2)"><path opacity="0.2" d="M0 0h9v9z"/><path d="M1 1h4"/></g>',
        'viewBox="0 0 24 24" fill="currentColor"',
    )
    root = parse(normalize_svg(raw, MONO))
    group = root.find(f"{NS}g")
    assert group.get("transform") == "translate(2 2)"
    assert [p.get("opacity") for p in group] == ["0.2", None]
    assert {p.get("fill") for p in group} == {DEFAULT_COLOR}


def test_mono_mode_paints_every_colour_with_the_single_colour():
    raw = svg(
        '<path d="M0 0h5v5z" fill="#123456"/><path d="M6 6h5v5z" fill="red"/><path d="M9 9h2v2z" fill="rgb(1,2,3)"/>'
    )
    assert {
        p.get("fill") for p in shapes(parse(normalize_svg(raw, NormalizeSpec(mode="mono", color="#112233"))))
    } == {"#112233"}


def test_the_normalised_icon_is_recolourable_through_the_catalogue_pipeline():
    processed = process_svg(
        normalize_svg(
            svg('<path d="M1 1h22"/>', 'viewBox="0 0 24 24" fill="none" stroke="currentColor"'), MONO
        )
    )
    assert processed.colors == [DEFAULT_COLOR] and processed.is_recolorable
    assert (processed.width, processed.height) == (24, 24)


def test_frame_adds_an_invisible_rectangle_the_size_of_the_viewbox():
    spec = NormalizeSpec(mode="mono", size=24, frame=True)
    raw = svg('<path d="M9 9h6"/>', 'viewBox="0 -960 960 960"')

    root = parse(normalize_svg(raw, spec))

    frame = root[0]
    assert frame.tag == f"{NS}rect"
    assert (frame.get("x"), frame.get("y"), frame.get("width"), frame.get("height"), frame.get("fill")) == (
        "0",
        "-960",
        "960",
        "960",
        "none",
    )
    assert normalize_svg(normalize_svg(raw, spec), spec) == normalize_svg(raw, spec)
    processed = process_svg(normalize_svg(raw, spec))
    assert processed.colors == [DEFAULT_COLOR] and (processed.width, processed.height) == (24, 24)
    assert len(root.findall(f"{NS}rect")) == 1 and len(shapes(parse(normalize_svg(raw, MONO)))) == 1


def test_normalising_twice_changes_nothing():
    raw = svg(
        '<g fill="none" stroke="currentColor" stroke-width="2"><path d="M1 1h22"/><circle cx="5" cy="5" r="2"/></g>'
    )
    once = normalize_svg(raw, MONO)
    assert normalize_svg(once, MONO) == once


# ---- colour artwork --------------------------------------------------------------------------------------------


def test_colour_mode_converts_named_rgb_and_hsl_colours_to_hex():
    raw = svg(
        '<path d="M0 0h5v5z" fill="white"/><path d="M1 1h5v5z" fill="rgb(255, 0, 0)"/><path d="M2 2h5v5z" fill="hsl(120, 100%, 25%)"/>'
    )
    assert [p.get("fill") for p in shapes(parse(normalize_svg(raw, COLOUR)))] == [
        "#ffffff",
        "#ff0000",
        "#008000",
    ]


def test_colour_mode_turns_alpha_colours_into_opacity():
    raw = svg(
        '<path d="M0 0h5v5z" fill="rgba(255,0,0,0.5)"/><path d="M1 1h5v5z" stroke="#ff000080" fill="none"/>'
    )
    first, second = shapes(parse(normalize_svg(raw, COLOUR)))
    assert (first.get("fill"), first.get("fill-opacity")) == ("#ff0000", "0.5")
    assert (second.get("stroke"), second.get("stroke-opacity")) == ("#ff0000", "0.5")


def test_inline_style_becomes_attributes_and_wins_over_them():
    raw = svg(
        '<path d="M0 0h5v5z" fill="#111111" style="fill:#e11d48; stroke : #00f ;stroke-width:3;unknown:1"/>'
    )
    (path,) = shapes(parse(normalize_svg(raw, COLOUR)))
    assert (path.get("fill"), path.get("stroke"), path.get("stroke-width"), path.get("style")) == (
        "#e11d48",
        "#0000ff",
        "3",
        None,
    )


def test_gradient_references_and_stop_colours_are_kept_and_normalised():
    raw = svg(
        '<defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="rgb(0,0,255)"/>'
        '</linearGradient></defs><rect width="9" height="9" fill="url(#g)"/>'
    )
    root = parse(normalize_svg(raw, COLOUR))
    assert [s.get("stop-color") for s in root.iter(f"{NS}stop")] == ["#ff0000", "#0000ff"]
    assert root.find(f"{NS}defs/{NS}linearGradient").get("id") == "g"
    assert root.find(f"{NS}rect").get("fill") == "url(#g)"


def test_unreferenced_ids_titles_and_whitespace_are_removed_but_referenced_ids_stay():
    raw = svg(
        '\n  <title>Hi</title>\n  <desc>x</desc>\n  <defs><clipPath id="c"><rect width="5" height="5"/></clipPath></defs>\n'
        '  <g id="layer"><path id="p" d="M0 0h9v9z" clip-path="url(#c)"/></g>\n'
    )
    out = normalize_svg(raw, COLOUR).decode()
    assert "title" not in out and "desc" not in out and 'id="layer"' not in out and 'id="p"' not in out
    assert 'id="c"' in out and "\n" not in out


def test_text_content_keeps_its_spaces():
    raw = svg('<text x="1" y="9">a b</text>')
    assert ">a b</text>" in normalize_svg(raw, COLOUR).decode()


def test_documents_that_use_symbols_keep_their_structure():
    raw = svg(
        '<defs><path id="a" d="M0 0h5v5z"/></defs><use href="#a" fill="currentColor"/><use href="#a" fill="red"/>',
        'viewBox="0 0 24 24" fill="blue"',
    )
    root = parse(normalize_svg(raw, MONO))
    assert root.get("fill") == "blue"
    assert [u.get("fill") for u in root.findall(f"{NS}use")] == [DEFAULT_COLOR, "red"]


def test_clip_paths_and_masks_are_not_repainted():
    raw = svg('<clipPath id="c"><path d="M0 0h5v5z"/></clipPath><path d="M1 1h9v9z" clip-path="url(#c)"/>')
    root = parse(normalize_svg(raw, MONO))
    assert root.find(f"{NS}clipPath/{NS}path").get("fill") is None


# ---- bad input --------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "payload",
    [
        b"",
        b"not xml",
        b"<html/>",
        b'<svg><path d="M0 0"/></svg>',
        b'<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"/>',
        b"x" * (5 * 1024 * 1024 + 1),
    ],
)
def test_unusable_input_is_refused(payload):
    with pytest.raises(SvgError):
        normalize_svg(payload, MONO)


def test_hostile_markup_does_not_survive_the_catalogue_pipeline_after_normalising():
    raw = svg(
        '<script>alert(1)</script><path d="M0 0h9v9z" onclick="x()" fill="red"/><foreignObject><div/></foreignObject>'
    )
    processed = process_svg(normalize_svg(raw, COLOUR))
    text = processed.data.decode()
    assert "script" not in text and "onclick" not in text and "foreignObject" not in text


# ---- parse_color ----------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("#fff", ("#ffffff", None)),
        ("#E11D48", ("#e11d48", None)),
        ("#e11d48", ("#e11d48", None)),
        ("black", ("#000000", None)),
        ("RED", ("#ff0000", None)),
        ("rgb(0, 128, 255)", ("#0080ff", None)),
        ("rgb(100%, 0%, 0%)", ("#ff0000", None)),
        ("#ff000080", ("#ff0000", 128 / 255)),
        ("url(#g)", None),
        ("inherit", None),
        ("notacolour", None),
        ("", None),
        ("expression(alert(1))", None),
    ],
)
def test_parse_color(value, expected):
    assert parse_color(value) == expected
