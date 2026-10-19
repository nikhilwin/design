"""Framing, awareness codec and the scanner that vets client updates before the CRDT engine sees them."""

from __future__ import annotations

import contextlib
import json
import random

import pytest
from pycrdt import Array, Doc, Map, Text

from apps.collab import protocol as p
from apps.collab.schema import KEY_OBJECT_ORDER, KEY_OBJECTS, ROOTS, document_to_ydoc, new_doc

from .helpers import sample_document

ROOTSET = frozenset(ROOTS)


def sv_of(doc: Doc) -> dict[int, int]:
    return p.decode_state_vector(doc.get_state())


def scan(update: bytes, target: Doc, **kwargs):
    return p.scan_update(update, sv_of(target), allowed_roots=ROOTSET, **kwargs)


def varuint(n: int) -> bytes:
    return p.write_varuint(n)


def crafted_any_update(depth: int, client: int = 7) -> bytes:
    value = bytes([117, 1]) * depth + bytes([126])
    item = bytes([0x08 | 0x20]) + varuint(1) + p.write_varstring("meta") + p.write_varstring("k") + varuint(1)
    return varuint(1) + varuint(1) + varuint(client) + varuint(0) + item + value + varuint(0)


# ---------------------------------------------------------------------------------------------
# Primitives and frames
# ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize("value", [0, 1, 127, 128, 300, 2**32, 2**53])
def test_varuint_round_trip(value):
    assert p.Reader(p.write_varuint(value)).varuint() == value


def test_varuint_rejects_overlong_and_truncated_input():
    with pytest.raises(p.ProtocolError):
        p.Reader(b"\xff" * 11).varuint()
    with pytest.raises(p.ProtocolError):
        p.Reader(b"\x80").varuint()
    with pytest.raises(p.ProtocolError):
        p.Reader(b"").uint8()


def test_varbytes_must_fit_in_the_buffer():
    with pytest.raises(p.ProtocolError):
        p.Reader(p.write_varuint(10) + b"abc").varbytes()


def test_sync_frames_round_trip_for_all_three_kinds():
    for kind in (p.SYNC_STEP1, p.SYNC_STEP2, p.SYNC_UPDATE):
        frame = p.parse_frame(p.sync_frame(kind, b"\x01\x02"))
        assert frame == p.SyncFrame(kind, b"\x01\x02")


def test_a_sync_frame_matches_the_y_websocket_layout():
    assert p.sync_frame(p.SYNC_STEP1, b"\x00") == bytes([0, 0, 1, 0])
    assert p.sync_frame(p.SYNC_UPDATE, b"ab") == bytes([0, 2, 2]) + b"ab"


def test_awareness_and_query_frames_parse():
    assert p.parse_frame(p.awareness_frame(b"xyz")) == p.AwarenessFrame(b"xyz")
    assert p.parse_frame(bytes([3])) == p.QueryAwarenessFrame()


@pytest.mark.parametrize(
    "frame",
    [
        b"",
        bytes([9]),
        bytes([0, 7, 0]),
        bytes([0, 0]),
        bytes([0, 0, 5, 1]),
        bytes([1, 1]),
        bytes([3, 0]),
        bytes([2, 0, 0]),
        bytes([0, 0, 0, 9]),
    ],
)
def test_malformed_frames_are_protocol_errors(frame):
    with pytest.raises(p.ProtocolError):
        p.parse_frame(frame)


def test_the_permission_denied_frame_has_the_auth_layout():
    frame = p.permission_denied_frame("read_only")
    reader = p.Reader(frame)
    assert (reader.varuint(), reader.varuint(), reader.varstring()) == (p.MESSAGE_AUTH, 0, "read_only")


def test_state_vector_decoding():
    doc = document_to_ydoc(sample_document(1, 1))
    vector = p.decode_state_vector(doc.get_state())
    assert vector == {doc.client_id: vector[doc.client_id]} and vector[doc.client_id] > 0
    assert p.decode_state_vector(Doc().get_state()) == {}


@pytest.mark.parametrize(
    "data", [b"", b"\x05", b"\x01\x01", b"\x00\x00", b"\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff"]
)
def test_bad_state_vectors_are_rejected(data):
    with pytest.raises(p.ProtocolError):
        p.decode_state_vector(data)


def test_awareness_round_trip_and_limits():
    entries = [p.AwarenessEntry(1, 2, '{"a":1}'), p.AwarenessEntry(3, 4, "null")]
    assert p.decode_awareness(p.encode_awareness(entries)) == entries
    with pytest.raises(p.ProtocolError):
        p.decode_awareness(p.encode_awareness([p.AwarenessEntry(1, 1, "x" * 3000)]))
    with pytest.raises(p.ProtocolError):
        p.decode_awareness(p.encode_awareness([p.AwarenessEntry(i, 1, "{}") for i in range(65)]))
    with pytest.raises(p.ProtocolError):
        p.decode_awareness(p.encode_awareness(entries) + b"\x00")


def test_awareness_state_must_be_an_object_or_null():
    assert p.parse_awareness_state("null") is None
    assert p.parse_awareness_state('{"a": 1}') == {"a": 1}
    for bad in ("[]", "5", '"x"', "{not json"):
        with pytest.raises(p.ProtocolError):
            p.parse_awareness_state(bad)


# ---------------------------------------------------------------------------------------------
# The update scanner accepts everything the real engine produces
# ---------------------------------------------------------------------------------------------


def test_the_scanner_accepts_a_full_document_update():
    source = document_to_ydoc(sample_document(3, 20))
    result = scan(source.get_update(), new_doc())
    assert result.has_items and result.structs > 0 and result.types > 0


def test_the_scanner_accepts_incremental_updates_in_order():
    source = document_to_ydoc(sample_document(2, 3))
    target = new_doc()
    target.apply_update(source.get_update())
    page_id = source.get("pageOrder", type=Array)[0]
    for step in range(30):
        before = source.get_state()
        with source.transaction():
            page = source.get("pages", type=Map)[page_id]
            if step % 3 == 0:
                oid = f"new-{step}"
                page[KEY_OBJECTS][oid] = Map({"id": oid, "type": "rect", "left": step})
                page[KEY_OBJECT_ORDER].append(oid)
            elif step % 3 == 1:
                first = next(iter(page[KEY_OBJECTS].keys()))
                page[KEY_OBJECTS][first]["left"] = step * 1.5
            else:
                del page[KEY_OBJECT_ORDER][0]
        update = source.get_update(before)
        scan(update, target)
        target.apply_update(update)
    assert target.get("pages", type=Map).to_py() == source.get("pages", type=Map).to_py()


def test_the_scanner_accepts_deletes_and_text_content():
    source = new_doc()
    target = new_doc()
    with source.transaction():
        source.get("pages", type=Map)["t"] = Map({"text": Text("hello wörld \U0001f600")})
    first = source.get_update()
    scan(first, target)
    target.apply_update(first)
    before = source.get_state()
    with source.transaction():
        source.get("pages", type=Map)["t"]["text"].insert(2, "XYZ")
        del source.get("pages", type=Map)["t"]["text"][0:1]
    delta = source.get_update(before)
    scan(delta, target)
    target.apply_update(delta)
    before = source.get_state()
    with source.transaction():
        del source.get("pages", type=Map)["t"]
    deletion = source.get_update(before)
    assert scan(deletion, target).has_deletes
    target.apply_update(deletion)


def test_a_reconnect_diff_from_a_peer_with_unsent_changes_is_accepted():
    server = document_to_ydoc(sample_document(1, 3))
    client = new_doc()
    client.apply_update(server.get_update())
    page_id = client.get("pageOrder", type=Array)[0]
    with client.transaction():
        client.get("pages", type=Map)[page_id][KEY_OBJECTS]["offline"] = Map({"id": "offline"})
        client.get("pages", type=Map)[page_id][KEY_OBJECT_ORDER].append("offline")
    scan(client.get_update(server.get_state()), server)


def test_applying_an_already_known_update_again_is_accepted():
    source = document_to_ydoc(sample_document(1, 2))
    update = source.get_update()
    target = new_doc()
    target.apply_update(update)
    scan(update, target)


def test_random_operation_sequences_always_pass_the_scanner():
    rng = random.Random(7)
    server, client = new_doc(), new_doc()
    page_id = "p1"
    with server.transaction():
        server.get("pageOrder", type=Array).append(page_id)
        server.get("pages", type=Map)[page_id] = Map(
            {"id": page_id, KEY_OBJECT_ORDER: Array(), KEY_OBJECTS: Map()}
        )
    client.apply_update(server.get_update())
    ids: list[str] = []
    for step in range(200):
        before = client.get_state()
        with client.transaction():
            page = client.get("pages", type=Map)[page_id]
            action = rng.choice(["add", "set", "delete", "move", "text"])
            if action == "add" or not ids:
                oid = f"o{step}"
                ids.append(oid)
                page[KEY_OBJECTS][oid] = Map({"id": oid, "label": "é" * rng.randint(0, 5), "n": rng.random()})
                page[KEY_OBJECT_ORDER].append(oid)
            elif action == "set":
                page[KEY_OBJECTS][rng.choice(ids)]["data"] = {"k": [1, "two", {"x": None}], "v": rng.random()}
            elif action == "delete":
                oid = ids.pop(rng.randrange(len(ids)))
                del page[KEY_OBJECTS][oid]
                order = page[KEY_OBJECT_ORDER].to_py()
                del page[KEY_OBJECT_ORDER][order.index(oid)]
            elif action == "move":
                order = page[KEY_OBJECT_ORDER]
                if len(order) > 1:
                    value = order[0]
                    del order[0]
                    order.insert(len(order), value)
            else:
                page[KEY_OBJECTS][rng.choice(ids)]["text"] = Text("abc" * rng.randint(1, 3))
        update = client.get_update(before)
        scan(update, server)
        server.apply_update(update)
    assert server.get("pages", type=Map).to_py() == client.get("pages", type=Map).to_py()


# ---------------------------------------------------------------------------------------------
# ... and rejects what would hurt the engine
# ---------------------------------------------------------------------------------------------


def test_deeply_nested_values_are_rejected_before_they_reach_the_engine():
    assert scan(crafted_any_update(10), new_doc()).has_items
    with pytest.raises(p.ProtocolError, match="nested"):
        scan(crafted_any_update(500), new_doc())
    with pytest.raises(p.ProtocolError, match="nested"):
        scan(crafted_any_update(200_000), new_doc())


def test_nesting_at_exactly_the_limit_passes_and_one_deeper_fails():
    assert scan(crafted_any_update(31), new_doc()).has_items
    with pytest.raises(p.ProtocolError):
        scan(crafted_any_update(33), new_doc())


def test_unknown_root_types_are_rejected():
    stray = Doc()
    with stray.transaction():
        stray.get("somethingElse", type=Map)["a"] = 1
    with pytest.raises(p.ProtocolError, match="root"):
        scan(stray.get_update(), new_doc())


def test_xml_types_and_subdocuments_are_rejected():
    fragment = Doc()
    from pycrdt import XmlElement, XmlFragment

    with fragment.transaction():
        root = fragment.get("pages", type=XmlFragment)
        root.children.append(XmlElement("p"))
    with pytest.raises(p.ProtocolError):
        scan(fragment.get_update(), new_doc())


def test_an_update_that_builds_on_missing_history_is_rejected():
    source = document_to_ydoc(sample_document(1, 2))
    page_id = source.get("pageOrder", type=Array)[0]
    before = source.get_state()
    with source.transaction():
        source.get("pages", type=Map)[page_id][KEY_OBJECT_ORDER].append("later")
    delta = source.get_update(before)
    with pytest.raises(p.ProtocolError, match="history"):
        scan(delta, new_doc())


def test_an_update_with_a_gap_in_a_clients_clock_is_rejected():
    source = new_doc()
    with source.transaction():
        source.get("meta", type=Map)["a"] = 1
    first_state = source.get_state()
    with source.transaction():
        source.get("meta", type=Map)["b"] = 2
    second = source.get_update(first_state)
    with pytest.raises(p.ProtocolError, match="gap"):
        scan(second, new_doc())


def test_a_forged_origin_is_rejected():
    forged = (
        varuint(1)
        + varuint(1)
        + varuint(99)
        + varuint(0)
        + bytes([0x80 | 0x20 | 8])
        + varuint(55)
        + varuint(5)
        + varuint(1)
        + bytes([126])
        + varuint(0)
    )
    with pytest.raises(p.ProtocolError, match="history"):
        scan(forged, new_doc())


def test_a_delete_of_unknown_history_is_rejected():
    forged = varuint(0) + varuint(1) + varuint(5) + varuint(1) + varuint(3) + varuint(2)
    with pytest.raises(p.ProtocolError, match="deletes"):
        scan(forged, new_doc())


def test_skip_structs_are_rejected():
    skip = varuint(1) + varuint(1) + varuint(9) + varuint(0) + bytes([10]) + varuint(2) + varuint(0)
    with pytest.raises(p.ProtocolError):
        scan(skip, new_doc())


@pytest.mark.parametrize("size", [1, 2, 5, 20])
def test_truncated_updates_are_rejected(size):
    update = document_to_ydoc(sample_document(1, 2)).get_update()
    with pytest.raises(p.ProtocolError):
        scan(update[:size], new_doc())


def test_trailing_garbage_is_rejected():
    update = document_to_ydoc(sample_document(1, 1)).get_update()
    with pytest.raises(p.ProtocolError):
        scan(update + b"\x00", new_doc())


def test_every_prefix_and_random_corruption_either_passes_or_raises_protocol_error():
    update = document_to_ydoc(sample_document(2, 3)).get_update()
    rng = random.Random(3)
    for cut in range(0, len(update), 7):
        with contextlib.suppress(p.ProtocolError):
            scan(update[:cut], new_doc())
    for _ in range(300):
        mutated = bytearray(update)
        for _ in range(rng.randint(1, 4)):
            mutated[rng.randrange(len(mutated))] = rng.randrange(256)
        with contextlib.suppress(p.ProtocolError):
            scan(bytes(mutated), new_doc())


def test_the_scan_reports_what_the_update_reaches():
    source = document_to_ydoc(sample_document(1, 1))
    result = scan(source.get_update(), new_doc())
    assert result.extents[source.client_id] == sv_of(source)[source.client_id]


def test_json_content_in_updates_is_counted():
    payload = json.dumps({"a": 1})
    item = (
        bytes([0x02 | 0x20])
        + varuint(1)
        + p.write_varstring("meta")
        + p.write_varstring("k")
        + varuint(1)
        + p.write_varstring(payload)
    )
    update = varuint(1) + varuint(1) + varuint(4) + varuint(0) + item + varuint(0)
    assert scan(update, new_doc()).structs == 1
