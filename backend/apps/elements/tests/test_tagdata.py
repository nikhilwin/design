import json

import pytest

from apps.elements.readers import ReaderError, read_iconify_json
from apps.elements.tagdata import (
    TagDataError,
    parse_iconify_categories,
    parse_json_map,
    parse_phosphor,
    parse_tabler,
    parse_tags,
)

PHOSPHOR = b"""
var t = /* @__PURE__ */ ((i) => (i.REGULAR = "regular", i.BOLD = "bold", i))(t || {}), e = /* @__PURE__ */ ((i) => (i.ARROWS = "arrows", i.FINANCE = "finances", i.HEALTH = "health & wellness", i))(e || {}), a = /* @__PURE__ */ ((i) => (i.WEATHER = "weather & nature", i))(a || {});
const n = [
  {
    name: "acorn",
    pascal_name: "Acorn",
    categories: [e.FINANCE, e.HEALTH],
    figma_category: a.WEATHER,
    tags: [
      "*new*",
      "savings",
      "nut \\"quoted\\""
    ],
    codepoint: 60314,
    published_in: 2.1,
    updated_in: 2.1
  },
  {
    name: "heart-straight",
    pascal_name: "HeartStraight",
    alias: { name: "heart-x", pascal_name: "HeartX" },
    categories: [e.ARROWS],
    figma_category: a.WEATHER,
    tags: ["love", "like"],
    codepoint: 1,
    published_in: 1.0,
    updated_in: 1.0
  }
];
"""


def test_json_map_reads_lucide_style_tag_files():
    tags = parse_json_map(b'{"house": ["Home", "building", "*x*", 7], "bad": "nope", "empty": []}')
    assert tags == {"house": ["home", "building", "7"], "empty": []}


def test_tabler_tags_include_the_category_and_survive_numbers():
    data = json.dumps(
        {"heart": {"category": "Shapes", "tags": ["Love", 2]}, "x": 1, "y": {"tags": "oops"}}
    ).encode()
    assert parse_tabler(data) == {"heart": ["love", "2", "shapes"], "y": []}


def test_phosphor_tags_come_from_the_generated_module_with_categories_and_aliases():
    tags = parse_phosphor(PHOSPHOR)
    assert tags["acorn"] == ["savings", 'nut "quoted"', "finances", "health & wellness"]
    assert tags["heart-straight"] == ["love", "like", "arrows", "heart x"]


def test_phosphor_without_icons_or_not_text_is_an_error():
    with pytest.raises(TagDataError, match="no icons"):
        parse_phosphor(b"export default {}")
    with pytest.raises(TagDataError, match="UTF-8"):
        parse_phosphor(b"\xff\xfe\x00")


def test_iconify_categories_become_tags_of_each_member():
    data = json.dumps({"categories": {"Animals": ["cat", "dog"], "Pets": ["cat"]}}).encode()
    assert parse_iconify_categories(data) == {"cat": ["animals", "pets"], "dog": ["animals"]}
    with pytest.raises(TagDataError, match="categories"):
        parse_iconify_categories(b"{}")


@pytest.mark.parametrize("parser", [parse_json_map, parse_tabler, parse_iconify_categories])
def test_parsers_reject_files_that_are_not_json(parser):
    with pytest.raises(TagDataError, match="JSON"):
        parser(b"not json")


def test_parse_tags_dispatches_on_the_format_and_none_means_no_tags():
    assert parse_tags("none", b"anything") == {}
    assert parse_tags("json-map", b'{"a": ["b"]}') == {"a": ["b"]}


# ---- Iconify JSON reader --------------------------------------------------------------------------------------


def icon_set(**changes):
    data = {
        "prefix": "demo",
        "width": 128,
        "height": 128,
        "icons": {
            "grin": {"body": '<path fill="#fc0" d="M0 0h9v9z"/>'},
            "wide": {"body": '<path d="M0 0h9v9z"/>', "width": 64, "height": 32},
            "inner": {"body": "<path/>", "hidden": True},
            "link": {"body": '<use xlink:href="#a"/>'},
        },
        "aliases": {"smile": {"parent": "grin"}, "ghost": {"parent": "inner"}, "orphan": {"parent": "nope"}},
    }
    data.update(changes)
    return json.dumps(data).encode()


def test_iconify_reader_expands_each_visible_icon_into_a_standalone_svg():
    icons = read_iconify_json(icon_set())

    assert [i.name for i in icons] == ["grin", "link", "wide"]
    grin = icons[0]
    assert b'viewBox="0 0 128 128"' in grin.svg and b"xmlns:xlink=" in grin.svg and b'fill="#fc0"' in grin.svg
    assert grin.aliases == ("smile",)
    assert b'viewBox="0 0 64 32"' in icons[2].svg


def test_iconify_reader_honours_offsets_and_default_sizes():
    data = json.dumps({"icons": {"a": {"body": "<path/>", "left": -2, "top": 3}}}).encode()
    assert b'viewBox="-2 3 16 16"' in read_iconify_json(data)[0].svg


@pytest.mark.parametrize(
    "payload",
    [
        b"nope",
        b"[]",
        json.dumps({"icons": {}}).encode(),
        json.dumps({"icons": {"a": {"hidden": True, "body": "x"}}}).encode(),
    ],
)
def test_iconify_reader_rejects_unusable_files(payload):
    with pytest.raises(ReaderError):
        read_iconify_json(payload)
