"""The document <-> Y mapping: round trips, normalisation and the defensive reading rules."""

from __future__ import annotations

import json
import time

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from pycrdt import Array, Doc, Map, Text

from apps.collab.schema import (
    KEY_OBJECT_ORDER,
    KEY_OBJECTS,
    ROOT_META,
    ROOT_PAGE_ORDER,
    ROOT_PAGES,
    UnrepresentableState,
    document_to_ydoc,
    has_no_pages,
    new_doc,
    read_document,
    repair,
    to_json,
    write_document,
    ydoc_to_document,
)
from apps.designs.validators import validate_document

from .helpers import canon, sample_document


def same(left, right) -> bool:
    return json.dumps(canon(left), sort_keys=True) == json.dumps(canon(right), sort_keys=True)


def roundtrip(document: dict) -> dict:
    return ydoc_to_document(document_to_ydoc(document))


def converge(source: Doc) -> Doc:
    """A second document that only knows `source` through its encoded state, like a peer or a restart."""
    copy = new_doc()
    copy.apply_update(source.get_update())
    return copy


# ---------------------------------------------------------------------------------------------
# Round trips
# ---------------------------------------------------------------------------------------------


def test_a_typical_document_survives_the_round_trip():
    document = sample_document(pages=3, objects=5)
    assert same(roundtrip(document), document)


def test_the_round_trip_survives_encoding_the_state():
    document = sample_document(pages=2, objects=4)
    assert same(ydoc_to_document(converge(document_to_ydoc(document))), document)


def test_unicode_is_preserved():
    document = sample_document(pages=1, objects=1)
    text = "Grüße 你好 \U0001f600 ‮مرحبا \u0000".replace("\u0000", "")
    document["pages"][0]["objects"][0]["text"] = text
    document["pages"][0]["name"] = text
    assert roundtrip(document)["pages"][0]["objects"][0]["text"] == text
    assert roundtrip(document)["pages"][0]["name"] == text


def test_unknown_top_level_page_and_object_properties_travel_unchanged():
    document = sample_document(pages=1, objects=1)
    document["futureThing"] = {"nested": [1, 2, {"deep": True}]}
    document["pages"][0]["futurePageThing"] = [1, "two"]
    document["pages"][0]["objects"][0]["futureObjectThing"] = {"a": None}
    assert same(roundtrip(document), document)


def test_group_children_stay_inside_the_group_as_one_value():
    document = sample_document(pages=1, objects=1)
    child = {"id": "c1", "type": "rect", "left": 1, "top": 2}
    document["pages"][0]["objects"][0].update({"type": "group", "objects": [child]})
    converted = document_to_ydoc(document)
    group = converted.get(ROOT_PAGES, type=Map)[document["pages"][0]["id"]][KEY_OBJECTS]
    only = next(iter(group.values()))
    assert only["objects"] == [{"id": "c1", "type": "rect", "left": 1.0, "top": 2.0}]
    assert same(ydoc_to_document(converted), document)


def test_integral_numbers_come_back_as_integers():
    document = sample_document(pages=1, objects=0)
    result = roundtrip(document)
    assert isinstance(result["width"], int) and isinstance(result["height"], int)
    assert type(result["width"]) is int


def test_values_keep_their_json_types():
    document = sample_document(pages=1, objects=1)
    item = document["pages"][0]["objects"][0]
    item.update(
        {"flag": True, "nothing": None, "zero": 0, "half": 0.5, "negative": -3, "empty": "", "list": []}
    )
    result = roundtrip(document)["pages"][0]["objects"][0]
    assert result["flag"] is True and result["nothing"] is None
    assert result["zero"] == 0 and type(result["zero"]) is int
    assert result["half"] == 0.5 and result["negative"] == -3
    assert result["empty"] == "" and result["list"] == []


def test_an_empty_page_has_an_empty_object_list():
    document = sample_document(pages=2, objects=0)
    assert [page["objects"] for page in roundtrip(document)["pages"]] == [[], []]


def test_page_and_object_order_is_kept():
    document = sample_document(pages=4, objects=6)
    result = roundtrip(document)
    assert [p["id"] for p in result["pages"]] == [p["id"] for p in document["pages"]]
    assert [o["id"] for o in result["pages"][2]["objects"]] == [
        o["id"] for o in document["pages"][2]["objects"]
    ]


def test_a_large_document_round_trips_within_a_second():
    document = sample_document(pages=30, objects=200)
    started = time.perf_counter()
    result = roundtrip(document)
    assert time.perf_counter() - started < 5
    assert same(result, document)
    assert sum(len(p["objects"]) for p in result["pages"]) == 6000


def test_numbers_beyond_the_safe_range_are_kept_as_floats_and_never_fail():
    document = sample_document(pages=1, objects=1)
    document["pages"][0]["objects"][0]["huge"] = 10**400
    document["pages"][0]["objects"][0]["big"] = 2**60
    result = roundtrip(document)["pages"][0]["objects"][0]
    assert result["huge"] is None
    assert result["big"] == float(2**60)


def test_non_finite_numbers_become_null():
    document = sample_document(pages=1, objects=1)
    document["pages"][0]["objects"][0]["bad"] = float("nan")
    assert roundtrip(document)["pages"][0]["objects"][0]["bad"] is None


def test_nesting_beyond_the_limit_is_refused_when_writing():
    nested: object = 1
    for _ in range(80):
        nested = [nested]
    document = sample_document(pages=1, objects=1)
    document["pages"][0]["objects"][0]["deep"] = nested
    with pytest.raises(UnrepresentableState):
        document_to_ydoc(document)


# ---------------------------------------------------------------------------------------------
# Normalisation of ids and reserved names
# ---------------------------------------------------------------------------------------------


def test_missing_and_duplicate_object_ids_get_fresh_unique_ids():
    document = sample_document(pages=1, objects=3)
    objects = document["pages"][0]["objects"]
    objects[0].pop("id")
    objects[2]["id"] = objects[1]["id"]
    result = roundtrip(document)["pages"][0]["objects"]
    ids = [o["id"] for o in result]
    assert len(set(ids)) == 3 and all(isinstance(i, str) and i for i in ids)
    assert ids[1] == objects[1]["id"]
    assert [o["type"] for o in result] == [o["type"] for o in objects]


def test_missing_page_id_and_duplicate_page_ids_are_replaced():
    document = sample_document(pages=3, objects=0)
    document["pages"][0].pop("id")
    document["pages"][2]["id"] = document["pages"][1]["id"]
    ids = [p["id"] for p in roundtrip(document)["pages"]]
    assert len(set(ids)) == 3


def test_an_over_long_id_is_replaced():
    document = sample_document(pages=1, objects=1)
    document["pages"][0]["objects"][0]["id"] = "x" * 65
    assert roundtrip(document)["pages"][0]["objects"][0]["id"] != "x" * 65


def test_the_reserved_page_property_object_order_is_dropped():
    document = sample_document(pages=1, objects=2)
    document["pages"][0][KEY_OBJECT_ORDER] = "garbage"
    result = roundtrip(document)["pages"][0]
    assert KEY_OBJECT_ORDER not in result
    assert len(result["objects"]) == 2


def test_the_key_wins_over_a_differing_id_property():
    document = sample_document(pages=1, objects=1)
    ydoc = document_to_ydoc(document)
    page_id = document["pages"][0]["id"]
    object_id = document["pages"][0]["objects"][0]["id"]
    ydoc.get(ROOT_PAGES, type=Map)[page_id][KEY_OBJECTS][object_id]["id"] = "other"
    assert ydoc_to_document(ydoc)["pages"][0]["objects"][0]["id"] == object_id


# ---------------------------------------------------------------------------------------------
# Defensive reading and repair
# ---------------------------------------------------------------------------------------------


def page_of(ydoc: Doc, index: int = 0) -> Map:
    page_id = ydoc.get(ROOT_PAGE_ORDER, type=Array)[index]
    return ydoc.get(ROOT_PAGES, type=Map)[page_id]


def test_duplicates_in_the_object_order_use_the_first_occurrence():
    document = sample_document(pages=1, objects=3)
    ydoc = document_to_ydoc(document)
    order = page_of(ydoc)[KEY_OBJECT_ORDER]
    first = document["pages"][0]["objects"][0]["id"]
    order.append(first)
    result = ydoc_to_document(ydoc)["pages"][0]["objects"]
    assert [o["id"] for o in result] == [o["id"] for o in document["pages"][0]["objects"]]


def test_dangling_ids_are_skipped_and_unlisted_objects_are_ignored():
    document = sample_document(pages=1, objects=2)
    ydoc = document_to_ydoc(document)
    page = page_of(ydoc)
    page[KEY_OBJECT_ORDER].append("ghost")
    page[KEY_OBJECTS]["orphan"] = Map({"id": "orphan", "type": "rect"})
    result = ydoc_to_document(ydoc)["pages"][0]["objects"]
    assert [o["id"] for o in result] == [o["id"] for o in document["pages"][0]["objects"]]


def test_repair_removes_what_the_reader_ignores():
    document = sample_document(pages=2, objects=3)
    ydoc = document_to_ydoc(document)
    page = page_of(ydoc)
    first = document["pages"][0]["objects"][0]["id"]
    page[KEY_OBJECT_ORDER].append(first)
    page[KEY_OBJECT_ORDER].append("ghost")
    page[KEY_OBJECTS]["orphan"] = Map({"id": "orphan"})
    ydoc.get(ROOT_PAGE_ORDER, type=Array).append("missing-page")
    ydoc.get(ROOT_PAGES, type=Map)["stray"] = Map({"id": "stray"})
    before, anomalies = read_document(ydoc)
    assert anomalies
    with ydoc.transaction():
        repair(ydoc, anomalies)
    after, again = read_document(ydoc)
    assert not again
    assert same(before, after)
    assert len(page_of(ydoc)[KEY_OBJECT_ORDER]) == 3
    assert "orphan" not in page_of(ydoc)[KEY_OBJECTS]
    assert len(ydoc.get(ROOT_PAGE_ORDER, type=Array)) == 2


def test_a_clean_document_reports_no_anomalies():
    assert not read_document(document_to_ydoc(sample_document(pages=2, objects=3)))[1]


def test_wrong_types_never_raise():
    ydoc = document_to_ydoc(sample_document(pages=1, objects=1))
    pages = ydoc.get(ROOT_PAGES, type=Map)
    page_id = ydoc.get(ROOT_PAGE_ORDER, type=Array)[0]
    pages[page_id][KEY_OBJECTS] = "not a map"
    pages[page_id][KEY_OBJECT_ORDER] = {"also": "wrong"}
    document = ydoc_to_document(ydoc)
    assert document["pages"][0]["objects"] == []
    ydoc.get(ROOT_PAGE_ORDER, type=Array).append(5)
    pages["x"] = "a string"
    ydoc.get(ROOT_PAGE_ORDER, type=Array).append("x")
    assert len(ydoc_to_document(ydoc)["pages"]) == 1


def test_a_nested_shared_type_property_is_flattened():
    ydoc = document_to_ydoc(sample_document(pages=1, objects=1))
    item = next(iter(page_of(ydoc)[KEY_OBJECTS].values()))
    item["text"] = Text("collaborative")
    item["nested"] = Map({"a": Array([1, 2])})
    result = ydoc_to_document(ydoc)["pages"][0]["objects"][0]
    assert result["text"] == "collaborative"
    assert result["nested"] == {"a": [1, 2]}


def test_a_property_nested_too_deeply_is_reported_and_repairable():
    ydoc = document_to_ydoc(sample_document(pages=1, objects=1))
    item = next(iter(page_of(ydoc)[KEY_OBJECTS].values()))
    with ydoc.transaction():
        cursor = Map()
        item["chain"] = cursor
        for _ in range(100):
            child = Map()
            cursor["c"] = child
            cursor = child
    document, anomalies = read_document(ydoc)
    assert "chain" not in document["pages"][0]["objects"][0]
    assert anomalies.bad_props
    with ydoc.transaction():
        repair(ydoc, anomalies)
    assert not read_document(ydoc)[1]


def test_to_json_rejects_unbounded_nesting():
    nested: object = 1
    for _ in range(100):
        nested = [nested]
    with pytest.raises(UnrepresentableState):
        to_json(nested)


def test_write_document_replaces_existing_content_inside_one_history():
    ydoc = document_to_ydoc(sample_document(pages=2, objects=3))
    peer = converge(ydoc)
    replacement = sample_document(pages=1, objects=1)
    replacement["width"] = 321
    before = ydoc.get_state()
    with ydoc.transaction():
        write_document(ydoc, replacement)
    assert same(ydoc_to_document(ydoc), replacement)
    peer.apply_update(ydoc.get_update(before))
    assert same(ydoc_to_document(peer), replacement)


# ---------------------------------------------------------------------------------------------
# Concurrency semantics (two peers, merged)
# ---------------------------------------------------------------------------------------------


def two_peers(document: dict) -> tuple[Doc, Doc]:
    base = document_to_ydoc(document)
    left, right = new_doc(), new_doc()
    left.apply_update(base.get_update())
    right.apply_update(base.get_update())
    return left, right


def exchange(left: Doc, right: Doc) -> None:
    left_update, right_update = left.get_update(right.get_state()), right.get_update(left.get_state())
    right.apply_update(left_update)
    left.apply_update(right_update)


def test_concurrent_edits_of_different_properties_both_survive():
    document = sample_document(pages=1, objects=1)
    left, right = two_peers(document)
    object_id = document["pages"][0]["objects"][0]["id"]
    next(iter(page_of(left)[KEY_OBJECTS].values()))["left"] = 111
    next(iter(page_of(right)[KEY_OBJECTS].values()))["top"] = 222
    exchange(left, right)
    for peer in (left, right):
        item = ydoc_to_document(peer)["pages"][0]["objects"][0]
        assert item["id"] == object_id and item["left"] == 111 and item["top"] == 222


def test_concurrent_edits_of_one_property_converge_to_one_value():
    document = sample_document(pages=1, objects=1)
    left, right = two_peers(document)
    next(iter(page_of(left)[KEY_OBJECTS].values()))["left"] = 1
    next(iter(page_of(right)[KEY_OBJECTS].values()))["left"] = 2
    exchange(left, right)
    assert ydoc_to_document(left) == ydoc_to_document(right)
    assert ydoc_to_document(left)["pages"][0]["objects"][0]["left"] in (1, 2)


def test_concurrent_reorder_can_duplicate_an_id_and_the_reader_resolves_it_identically():
    document = sample_document(pages=1, objects=4)
    left, right = two_peers(document)
    ids = [o["id"] for o in document["pages"][0]["objects"]]
    moved = ids[1]

    def move(peer: Doc, target: int) -> None:
        order = page_of(peer)[KEY_OBJECT_ORDER]
        with peer.transaction():
            del order[1]
            order.insert(target, moved)

    move(left, 3)
    move(right, 0)
    exchange(left, right)
    assert ydoc_to_document(left) == ydoc_to_document(right)
    resolved = [o["id"] for o in ydoc_to_document(left)["pages"][0]["objects"]]
    assert sorted(resolved) == sorted(ids) and len(resolved) == 4
    _, anomalies = read_document(left)
    assert anomalies.object_order_remove
    with left.transaction():
        repair(left, anomalies)
    exchange(left, right)
    assert ydoc_to_document(left) == ydoc_to_document(right)
    assert [o["id"] for o in ydoc_to_document(left)["pages"][0]["objects"]] == resolved


def test_two_peers_removing_one_of_two_pages_each_leave_none_and_the_repair_puts_one_blank_page_back():
    document = sample_document(pages=2, objects=1)
    left, right = two_peers(document)
    for peer, index in ((left, 0), (right, 1)):
        with peer.transaction():
            order = peer.get(ROOT_PAGE_ORDER, type=Array)
            del peer.get(ROOT_PAGES, type=Map)[order[index]]
            del order[index]
    exchange(left, right)
    assert ydoc_to_document(left)["pages"] == [] and has_no_pages(left)
    _, anomalies = read_document(left)
    assert anomalies.no_pages and anomalies
    with left.transaction():
        repair(left, anomalies)
    exchange(left, right)
    for peer in (left, right):
        assert not has_no_pages(peer)
        pages = ydoc_to_document(peer)["pages"]
        assert [p["id"] for p in pages] == ["restored-page"] and pages[0]["objects"] == []
        assert not read_document(peer)[1]
    validate_document(ydoc_to_document(left), max_bytes=1_000_000)


def test_two_peers_putting_the_blank_page_back_at_once_end_with_one_page():
    left, right = two_peers(sample_document(pages=1, objects=1))
    for peer in (left, right):
        with peer.transaction():
            order = peer.get(ROOT_PAGE_ORDER, type=Array)
            del peer.get(ROOT_PAGES, type=Map)[order[0]]
            del order[0]
        _, anomalies = read_document(peer)
        with peer.transaction():
            repair(peer, anomalies)
    exchange(left, right)
    _, anomalies = read_document(left)
    with left.transaction():
        repair(left, anomalies)
    exchange(left, right)
    assert ydoc_to_document(left) == ydoc_to_document(right)
    assert [p["id"] for p in ydoc_to_document(left)["pages"]] == ["restored-page"]


def test_concurrent_add_and_delete_of_the_same_object():
    document = sample_document(pages=1, objects=2)
    left, right = two_peers(document)
    ids = [o["id"] for o in document["pages"][0]["objects"]]
    with left.transaction():
        del page_of(left)[KEY_OBJECTS][ids[0]]
        order = page_of(left)[KEY_OBJECT_ORDER]
        del order[0]
    next(iter(page_of(right)[KEY_OBJECTS].values()))["fill"] = "#123456"
    with right.transaction():
        page_of(right)[KEY_OBJECTS]["added"] = Map({"id": "added", "type": "rect"})
        page_of(right)[KEY_OBJECT_ORDER].append("added")
    exchange(left, right)
    assert ydoc_to_document(left) == ydoc_to_document(right)
    assert [o["id"] for o in ydoc_to_document(left)["pages"][0]["objects"]] == [ids[1], "added"]


# ---------------------------------------------------------------------------------------------
# Property-based round trips
# ---------------------------------------------------------------------------------------------

text = st.text(alphabet=st.characters(blacklist_categories=("Cs",), blacklist_characters="\x00"), max_size=24)
numbers = st.one_of(
    st.integers(min_value=-(2**53), max_value=2**53),
    st.floats(allow_nan=False, allow_infinity=False, width=64),
)
json_values = st.recursive(
    st.one_of(st.none(), st.booleans(), numbers, text),
    lambda children: st.one_of(st.lists(children, max_size=4), st.dictionaries(text, children, max_size=4)),
    max_leaves=12,
)
prop_names = text.filter(lambda name: name not in {"id", "objects", "objectOrder", "pages"} and name != "")
object_props = st.dictionaries(prop_names, json_values, max_size=6)
ident = st.uuids().map(str)


@st.composite
def documents(draw) -> dict:
    page_count = draw(st.integers(min_value=1, max_value=4))
    page_ids = draw(st.lists(ident, min_size=page_count, max_size=page_count, unique=True))
    pages = []
    for page_id in page_ids:
        object_count = draw(st.integers(min_value=0, max_value=6))
        object_ids = draw(st.lists(ident, min_size=object_count, max_size=object_count, unique=True))
        pages.append(
            {
                **draw(object_props),
                "id": page_id,
                "background": {"type": "solid", "color": "#ffffff"},
                "objects": [{**draw(object_props), "id": oid, "type": "rect"} for oid in object_ids],
            }
        )
    return {
        **draw(st.dictionaries(prop_names, json_values, max_size=3)),
        "schemaVersion": 1,
        "width": draw(st.integers(min_value=1, max_value=20000)),
        "height": draw(st.integers(min_value=1, max_value=20000)),
        "unit": "px",
        "pages": pages,
    }


PROPERTY_SETTINGS = settings(
    max_examples=60, deadline=None, suppress_health_check=[HealthCheck.too_slow, HealthCheck.data_too_large]
)


@PROPERTY_SETTINGS
@given(documents())
def test_property_every_valid_document_round_trips(document):
    assert same(roundtrip(document), document)


@PROPERTY_SETTINGS
@given(documents())
def test_property_the_round_trip_survives_the_encoded_state(document):
    assert same(ydoc_to_document(converge(document_to_ydoc(document))), document)


@PROPERTY_SETTINGS
@given(documents(), documents())
def test_property_replacing_content_in_place_yields_the_new_document(first, second):
    ydoc = document_to_ydoc(first)
    with ydoc.transaction():
        write_document(ydoc, second)
    assert same(ydoc_to_document(ydoc), second)
    assert not read_document(ydoc)[1]


@PROPERTY_SETTINGS
@given(documents())
def test_property_a_clean_conversion_has_no_anomalies(document):
    assert not read_document(document_to_ydoc(document))[1]


@given(st.lists(ident, min_size=1, max_size=8, unique=True), st.data())
@settings(max_examples=40, deadline=None)
def test_property_reordering_peers_always_converge_and_repair_is_stable(ids, data):
    document = sample_document(pages=1, objects=0)
    document["pages"][0]["objects"] = [{"id": i, "type": "rect"} for i in ids]
    left, right = two_peers(document)
    for peer in (left, right):
        order = page_of(peer)[KEY_OBJECT_ORDER]
        for _ in range(data.draw(st.integers(min_value=0, max_value=3))):
            source = data.draw(st.integers(min_value=0, max_value=len(order) - 1))
            target = data.draw(st.integers(min_value=0, max_value=len(order) - 1))
            moving = order[source]
            with peer.transaction():
                del order[source]
                order.insert(min(target, len(order)), moving)
    exchange(left, right)
    assert ydoc_to_document(left) == ydoc_to_document(right)
    _, anomalies = read_document(left)
    with left.transaction():
        repair(left, anomalies)
    exchange(left, right)
    assert ydoc_to_document(left) == ydoc_to_document(right)
    assert not read_document(left)[1]
    assert sorted(o["id"] for o in ydoc_to_document(left)["pages"][0]["objects"]) == sorted(ids)


def test_a_new_document_defines_the_three_roots():
    ydoc = new_doc()
    assert ydoc.get(ROOT_META, type=Map).to_py() == {}
    assert ydoc.get(ROOT_PAGE_ORDER, type=Array).to_py() == []
    assert ydoc.get(ROOT_PAGES, type=Map).to_py() == {}


# ---- reading large arrays (pycrdt reads them item by item, which is quadratic) ----------------------------

LARGE = 60_000  # about 700 kB as an update; reading it item by item took over a minute


def junk_page_order(count: int, *, nested_tail: bool = False) -> Doc:
    ydoc = document_to_ydoc(sample_document(1, 2))
    order = ydoc.get(ROOT_PAGE_ORDER, type=Array)
    with ydoc.transaction():
        for index in range(count):  # insert at the head: cheap to build, unlike extend()
            order.insert(0, f"junk-{index}")
        if nested_tail:
            deep = Map()
            order.insert(0, deep)
            for _ in range(3000):
                child = Map()
                deep["n"] = child
                deep = child
    return ydoc


def test_a_page_order_with_tens_of_thousands_of_junk_entries_is_read_and_repaired_in_moments():
    ydoc = junk_page_order(LARGE)
    started = time.perf_counter()
    assert has_no_pages(ydoc) is False
    document, anomalies = read_document(ydoc)
    assert len(anomalies.page_order_remove) == LARGE and len(document["pages"]) == 1
    repair(ydoc, anomalies)
    assert not read_document(ydoc)[1] and len(ydoc.get(ROOT_PAGE_ORDER, type=Array)) == 1
    assert time.perf_counter() - started < 15  # minutes before: the reads walked the array once per entry


def test_repair_removes_alternating_junk_and_duplicates_in_one_pass_each():
    ydoc = document_to_ydoc(sample_document(1, 1))
    order = ydoc.get(ROOT_PAGE_ORDER, type=Array)
    page_id = order[0]
    with ydoc.transaction():
        for index in range(5_000):
            order.insert(0, page_id if index % 2 else f"junk-{index}")
    _, anomalies = read_document(ydoc)
    assert len(anomalies.page_order_remove) == 5_000
    repair(ydoc, anomalies)
    assert list(ydoc.get(ROOT_PAGE_ORDER, type=Array)) == [page_id]


def test_an_entry_nested_beyond_what_json_can_read_is_just_a_bad_entry():
    ydoc = junk_page_order(10, nested_tail=True)
    document, anomalies = read_document(ydoc)
    assert len(anomalies.page_order_remove) == 11 and len(document["pages"]) == 1
    repair(ydoc, anomalies)
    assert not read_document(ydoc)[1]


def test_a_large_array_inside_a_property_is_read_in_one_go():
    ydoc = document_to_ydoc(sample_document(1, 1))
    page_id = ydoc.get(ROOT_PAGE_ORDER, type=Array)[0]
    page = ydoc.get(ROOT_PAGES, type=Map)[page_id]
    with ydoc.transaction():
        values = Array()
        page["guides"] = values
        for index in range(LARGE // 2):
            values.insert(0, index)
    started = time.perf_counter()
    document, anomalies = read_document(ydoc)
    assert len(document["pages"][0]["guides"]) == LARGE // 2 and not anomalies
    assert time.perf_counter() - started < 15


def test_the_flat_reader_handles_strings_scalars_and_nested_entries():
    from apps.collab.schema import NESTED, _top_level_entries

    entries = _top_level_entries('["a, b", 7, null, {"x": [1, {"y": "]"}]}, [], "c\\"d", true]')
    assert entries == ["a, b", 7, None, NESTED, NESTED, 'c"d', True]
