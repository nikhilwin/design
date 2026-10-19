"""`schema.write_changes`: a document change written as the smallest set of Y operations."""

from __future__ import annotations

import copy

from pycrdt import Array

from apps.collab import schema
from apps.collab.schema import ROOT_PAGE_ORDER, json_equal, longest_increasing, new_doc, sync_order

from .helpers import sample_document


def write(ydoc, prev, nxt) -> bytes:
    before = ydoc.get_state()
    with ydoc.transaction():
        schema.write_changes(ydoc, prev, nxt)
    return ydoc.get_update(before)


def peer_of(ydoc):
    copy_ = new_doc()
    copy_.apply_update(ydoc.get_update())
    return copy_


def test_the_result_is_the_wanted_document():
    ydoc = schema.document_to_ydoc(sample_document(pages=3, objects=4))
    prev = schema.ydoc_to_document(ydoc)
    nxt = copy.deepcopy(prev)
    nxt["pages"][0]["objects"][0]["left"] = 999
    nxt["pages"][0]["objects"].insert(1, {"id": "new", "type": "rect", "left": 1})
    del nxt["pages"][1]["objects"][2]
    nxt["pages"][2]["objects"].reverse()
    nxt["pages"].insert(0, nxt["pages"].pop())
    nxt["pages"][1]["notes"] = "hello"
    nxt["meta"] = {"presetId": "a4"}
    write(ydoc, prev, nxt)
    assert json_equal(schema.ydoc_to_document(ydoc), nxt)
    assert json_equal(schema.ydoc_to_document(peer_of(ydoc)), nxt)


def test_a_property_change_is_a_small_update():
    ydoc = schema.document_to_ydoc(sample_document(pages=5, objects=40))
    prev = schema.ydoc_to_document(ydoc)
    nxt = copy.deepcopy(prev)
    nxt["pages"][3]["objects"][7]["fill"] = "#00ff00"
    assert len(write(ydoc, prev, nxt)) < 200 < len(ydoc.get_update()) / 50


def test_changes_others_made_meanwhile_survive():
    ydoc = schema.document_to_ydoc(sample_document(objects=2))
    prev = schema.ydoc_to_document(ydoc)  # what the API edit started from
    other = peer_of(ydoc)
    theirs = schema.ydoc_to_document(other)
    theirs["pages"][0]["objects"][0]["top"] = 55
    write(other, schema.ydoc_to_document(other), theirs)  # somebody moves the first object…
    ydoc.apply_update(other.get_update(ydoc.get_state()))
    nxt = copy.deepcopy(prev)
    nxt["pages"][0]["objects"][1]["fill"] = "#123456"  # …while the API recolours the second one
    write(ydoc, prev, nxt)
    objects = schema.ydoc_to_document(ydoc)["pages"][0]["objects"]
    assert objects[0]["top"] == 55 and objects[1]["fill"] == "#123456"


def test_json_equal_tells_booleans_from_numbers():
    assert json_equal({"a": [1, 2.0]}, {"a": [1.0, 2]})
    assert not json_equal(True, 1) and not json_equal(0, False)
    assert not json_equal({"a": 1}, {"a": 1, "b": None})


def test_sync_order_moves_only_what_must_move():
    ydoc = new_doc()
    order = ydoc.get(ROOT_PAGE_ORDER, type=Array)
    order.extend(["a", "b", "c", "d", "x"])  # x: added by somebody else, unknown to the writer
    with ydoc.transaction():
        sync_order(order, ["b", "c", "a", "e"], known={"a", "b", "c", "d"})
    assert schema.array_values(order) == ["b", "c", "a", "e", "x"]
    assert longest_increasing([3, 1, 2, 5, 4]) == [1, 2, 4]
