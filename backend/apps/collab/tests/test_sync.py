"""Live editing between connected clients."""

from __future__ import annotations

import json

import pytest
from pycrdt import Array, Map

from apps.collab import protocol, schema
from apps.collab.schema import KEY_OBJECT_ORDER, KEY_OBJECTS, ROOT_META, ROOT_PAGE_ORDER, ROOT_PAGES
from apps.designs.models import Design

from .peer import settle

pytestmark = pytest.mark.django_db


def page_map(peer, index: int = 0) -> Map:
    page_id = peer.doc.get(ROOT_PAGE_ORDER, type=Array)[index]
    return peer.doc.get(ROOT_PAGES, type=Map)[page_id]


def first_object(peer) -> Map:
    page = page_map(peer)
    return page[KEY_OBJECTS][page[KEY_OBJECT_ORDER][0]]


def add_object(peer, oid: str, **props) -> None:
    page = page_map(peer)
    page[KEY_OBJECTS][oid] = Map({"id": oid, "type": "rect", **props})
    page[KEY_OBJECT_ORDER].append(oid)


async def test_an_edit_reaches_the_other_client(env):
    link = await env.link("edit")
    alice = await env.open(env.owner)
    bob = await env.peer(env.other)
    await bob.connect()
    await bob.auth(link.token)
    await bob.sync()
    await alice.edit(lambda doc: first_object(alice).__setitem__("left", 321))
    await settle(bob, alice)
    assert bob.document["pages"][0]["objects"][0]["left"] == 321
    assert alice.document == bob.document


async def test_three_clients_converge_after_concurrent_edits(env):
    link = await env.link("edit")
    one = await env.open(env.owner)
    two = await env.peer(env.other)
    await two.connect()
    await two.auth(link.token)
    await two.sync()
    three = await env.peer(env.other)
    await three.connect()
    await three.auth(link.token)
    await three.sync()
    await one.edit(lambda doc: first_object(one).__setitem__("left", 1))
    await two.edit(lambda doc: first_object(two).__setitem__("left", 2))
    await three.edit(lambda doc: first_object(three).__setitem__("top", 3))
    await one.edit(lambda doc: add_object(one, "from-one"))
    await two.edit(lambda doc: add_object(two, "from-two"))
    await settle(one, two, three, rounds=4)
    assert one.document == two.document == three.document
    first = one.document["pages"][0]["objects"]
    assert first[0]["top"] == 3 and first[0]["left"] in (1, 2)
    assert {o["id"] for o in first[-2:]} == {"from-one", "from-two"}


async def test_concurrent_reorders_of_the_same_object_end_identical_everywhere(env):
    link = await env.link("edit")
    one = await env.open(env.owner)
    two = await env.peer(env.other)
    await two.connect()
    await two.auth(link.token)
    await two.sync()

    def move(peer, target: int):
        def change(doc):
            order = page_map(peer)[KEY_OBJECT_ORDER]
            moved = order[1]
            del order[1]
            order.insert(target, moved)

        return change

    await one.edit(move(one, 2))
    await two.edit(move(two, 0))
    await settle(one, two, rounds=4)
    assert one.document == two.document
    assert len(one.document["pages"][0]["objects"]) == 3


async def test_concurrent_add_and_delete_of_one_object(env):
    link = await env.link("edit")
    one = await env.open(env.owner)
    two = await env.peer(env.other)
    await two.connect()
    await two.auth(link.token)
    await two.sync()
    doomed = first_object(one)["id"]

    def delete(doc):
        page = page_map(one)
        del page[KEY_OBJECTS][doomed]
        del page[KEY_OBJECT_ORDER][0]

    await one.edit(delete)
    await two.edit(lambda doc: first_object(two).__setitem__("fill", "#00ff00"))
    await two.edit(lambda doc: add_object(two, "newcomer"))
    await settle(one, two, rounds=4)
    assert one.document == two.document
    ids = [o["id"] for o in one.document["pages"][0]["objects"]]
    assert doomed not in ids and "newcomer" in ids


async def test_a_late_joiner_receives_the_whole_current_state(env):
    one = await env.open(env.owner)
    await one.edit(lambda doc: add_object(one, "added-early", left=7))
    await settle(one)
    link = await env.link("view")
    late = await env.peer(env.other)
    await late.connect()
    await late.auth(link.token)
    await late.sync()
    assert late.document == one.document
    assert late.document["pages"][0]["objects"][-1]["id"] == "added-early"


async def test_meta_and_page_properties_sync(env):
    link = await env.link("edit")
    one = await env.open(env.owner)
    two = await env.peer(env.other)
    await two.connect()
    await two.auth(link.token)
    await two.sync()
    await one.edit(lambda doc: doc.get(ROOT_META, type=Map).__setitem__("width", 1234))
    await two.edit(lambda doc: page_map(two).__setitem__("name", "Renamed"))
    await settle(one, two, rounds=3)
    for peer in (one, two):
        assert peer.document["width"] == 1234 and peer.document["pages"][0]["name"] == "Renamed"


async def test_a_view_user_receives_edits_but_cannot_make_them(env):
    link = await env.link("view")
    owner = await env.open(env.owner)
    viewer = await env.peer(env.other)
    await viewer.connect()
    await viewer.auth(link.token)
    await viewer.sync()
    await owner.edit(lambda doc: first_object(owner).__setitem__("left", 9))
    await settle(viewer)
    assert viewer.document["pages"][0]["objects"][0]["left"] == 9
    await viewer.edit(lambda doc: first_object(viewer).__setitem__("left", 99999))
    await viewer.edit(lambda doc: first_object(viewer).__setitem__("top", 99999))
    await settle(owner, viewer)
    assert owner.document["pages"][0]["objects"][0]["left"] == 9
    assert owner.document["pages"][0]["objects"][0]["top"] != 99999
    assert viewer.denied == ["read_only"]  # told once, not per frame
    assert env.registry.counters["dropped_read_only"] == 3  # the handshake step 2 and both edits
    assert viewer.close_code is None


async def test_a_read_only_clients_step_two_is_dropped_too(env):
    link = await env.link("comment")
    owner = await env.open(env.owner)
    viewer = await env.peer(env.other)
    await viewer.connect()
    await viewer.auth(link.token)
    await viewer.sync()
    with viewer.doc.transaction():
        add_object(viewer, "sneaky")
    await viewer.send_raw(
        protocol.sync_frame(protocol.SYNC_STEP2, viewer.doc.get_update(owner.doc.get_state()))
    )
    await settle(owner, viewer)
    assert "sneaky" not in [o["id"] for o in owner.document["pages"][0]["objects"]]


async def test_awareness_is_relayed_with_the_servers_view_of_the_identity(env):
    link = await env.link("edit")
    owner = await env.open(env.owner)
    guest = await env.peer(env.other)
    await guest.connect()
    await guest.auth(link.token)
    await guest.sync()
    await settle(owner, guest)
    await guest.send_awareness(
        4242,
        1,
        {
            "cursor": {"x": 3, "y": 4},
            "user": {"name": "Olive Owner", "id": "someone-else", "color": "#123456"},
        },
    )
    await settle(owner)
    state = owner.awareness[4242]
    assert state["cursor"] == {"x": 3, "y": 4}
    assert state["user"]["name"] == "Sam Stranger"  # the server's, not the claimed one
    assert state["user"]["id"] == str(env.other.pk) and state["user"]["role"] == "edit"
    assert state["user"]["color"] == "#123456"


async def test_an_invalid_awareness_colour_is_replaced(env):
    owner = await env.open(env.owner)
    other = await env.open(env.owner)
    await owner.send_awareness(11, 1, {"user": {"color": "red; background: url(x)"}})
    await settle(other)
    assert (
        other.awareness[11]["user"]["color"].startswith("#")
        and len(other.awareness[11]["user"]["color"]) == 7
    )


async def test_viewers_awareness_is_relayed_too(env):
    link = await env.link("view")
    owner = await env.open(env.owner)
    viewer = await env.peer(env.other)
    await viewer.connect()
    await viewer.auth(link.token)
    await viewer.sync()
    await viewer.send_awareness(77, 1, {"cursor": None})
    await settle(owner)
    assert owner.awareness[77]["user"]["role"] == "view"


async def test_awareness_of_a_leaving_client_is_removed(env):
    one = await env.open(env.owner)
    two = await env.open(env.owner)
    await two.send_awareness(55, 1, {"cursor": {"x": 1}})
    await settle(one)
    assert one.awareness[55] is not None
    await two.disconnect()
    await settle(one, rounds=4)
    assert one.awareness[55] is None


async def test_a_new_client_receives_the_existing_awareness(env):
    one = await env.open(env.owner)
    await one.send_awareness(31, 1, {"cursor": {"x": 5}})
    await settle(one)
    two = await env.open(env.owner)
    await settle(two)
    assert two.awareness[31]["cursor"] == {"x": 5}


async def test_a_client_cannot_overwrite_another_clients_awareness(env):
    one = await env.open(env.owner)
    two = await env.open(env.owner)
    await one.send_awareness(9, 1, {"cursor": {"x": 1}})
    await settle(two)
    await two.send_awareness(9, 5, {"cursor": {"x": 666}})
    await settle(one, two)
    third = await env.open(env.owner)
    await settle(third)
    assert third.awareness[9]["cursor"] == {"x": 1}


async def test_an_older_awareness_clock_is_ignored(env):
    one = await env.open(env.owner)
    two = await env.open(env.owner)
    await one.send_awareness(9, 5, {"cursor": {"x": 5}})
    await one.send_awareness(9, 3, {"cursor": {"x": 3}})
    await settle(two)
    assert two.awareness[9]["cursor"] == {"x": 5}


async def test_too_many_awareness_ids_per_connection_are_ignored(env):
    one = await env.open(env.owner)
    two = await env.open(env.owner)
    for client in range(100, 110):
        await one.send_awareness(client, 1, {"n": client})
    await settle(two)
    assert len([c for c in two.awareness if 100 <= c < 110]) == 4


async def test_oversized_awareness_state_is_dropped(env):
    one = await env.open(env.owner)
    two = await env.open(env.owner)
    await one.send_awareness(
        8, 1, {"blob": "x" * 1990}
    )  # fits as sent, not once the server adds the identity
    await settle(two)
    assert 8 not in two.awareness
    assert env.registry.counters["awareness_dropped"] == 1


async def test_an_awareness_state_above_the_input_limit_closes_the_connection(env):
    one = await env.open(env.owner)
    await one.send_awareness(8, 1, {"blob": "x" * 5000})
    await one.until(lambda: one.close_code is not None)
    assert one.close_code == 4400


async def test_awareness_that_is_not_an_object_closes_the_connection(env):
    one = await env.open(env.owner)
    entry = protocol.AwarenessEntry(5, 1, "[1,2,3]")
    await one.send_raw(protocol.awareness_frame(protocol.encode_awareness([entry])))
    await one.until(lambda: one.close_code is not None)
    assert one.close_code == 4400


async def test_query_awareness_returns_the_table(env):
    one = await env.open(env.owner)
    two = await env.open(env.owner)
    await one.send_awareness(21, 1, {"cursor": {"x": 2}})
    await settle(two)
    two.awareness.clear()
    await two.send_raw(bytes([protocol.MESSAGE_QUERY_AWARENESS]))
    await settle(two)
    assert two.awareness[21]["cursor"] == {"x": 2}


async def test_ping_is_answered(env):
    one = await env.open(env.owner)
    await one.send_json({"type": "ping"})
    await one.until(lambda: one.texts_of("pong"))


async def test_unknown_text_frames_close_the_connection(env):
    one = await env.open(env.owner)
    await one.send_json({"type": "chat", "text": "hi"})
    await one.until(lambda: one.close_code is not None)
    assert one.close_code == 4400


async def test_malformed_binary_frames_close_the_connection(env):
    one = await env.open(env.owner)
    await one.send_raw(b"\x09\x09")
    await one.until(lambda: one.close_code is not None)
    assert (one.close_code, one.close_reason) == (4400, "bad_frame")


async def test_a_state_vector_that_is_garbage_closes_the_connection(env):
    one = await env.open(env.owner)
    await one.send_raw(protocol.sync_frame(protocol.SYNC_STEP1, b"\xff\xff"))
    await one.until(lambda: one.close_code is not None)
    assert one.close_code == 4400


async def test_a_corrupt_update_closes_only_the_sender(env):
    one = await env.open(env.owner)
    two = await env.open(env.owner)
    await one.send_raw(protocol.sync_frame(protocol.SYNC_UPDATE, b"\x01\x01\x01\x01\x01"))
    await one.until(lambda: one.close_code is not None)
    assert one.close_code == 4400
    await two.edit(lambda doc: first_object(two).__setitem__("left", 5))
    await settle(two)
    assert two.close_code is None


async def test_an_update_that_nests_values_too_deeply_is_rejected_before_the_engine_sees_it(env):
    one = await env.open(env.owner)
    two = await env.open(env.owner)
    before = two.document
    deep = bytes([117, 1]) * 100_000 + bytes([126])
    item = (
        bytes([0x08 | 0x20])
        + protocol.write_varuint(1)
        + protocol.write_varstring("meta")
        + protocol.write_varstring("k")
        + protocol.write_varuint(1)
    )
    update = (
        protocol.write_varuint(1)
        + protocol.write_varuint(1)
        + protocol.write_varuint(5)
        + protocol.write_varuint(0)
    )
    await one.send_raw(
        protocol.sync_frame(protocol.SYNC_UPDATE, update + item + deep + protocol.write_varuint(0))
    )
    await one.until(lambda: one.close_code is not None)
    assert (one.close_code, one.close_reason) == (4400, "bad_frame")
    await settle(two)
    assert two.document == before


async def test_an_update_to_an_unknown_root_is_rejected(env):
    from pycrdt import Doc

    one = await env.open(env.owner)
    stray = Doc()
    with stray.transaction():
        stray.get("extra", type=Map)["a"] = 1
    await one.send_raw(protocol.sync_frame(protocol.SYNC_UPDATE, stray.get_update()))
    await one.until(lambda: one.close_code is not None)
    assert one.close_code == 4400


async def test_an_oversized_frame_closes_the_connection(env, settings):
    settings.REALTIME_MAX_FRAME_BYTES = 2048
    one = await env.open(env.owner)
    await one.send_raw(protocol.sync_frame(protocol.SYNC_UPDATE, b"\x00" * 4096))
    await one.until(lambda: one.close_code is not None)
    assert (one.close_code, one.close_reason) == (4413, "frame_too_large")


async def test_flooding_closes_the_connection_with_4429(env, settings):
    settings.REALTIME_RATE_MESSAGES_PER_SECOND = 5
    settings.REALTIME_RATE_BURST = 10
    one = await env.open(env.owner)
    for _ in range(40):
        await one.send_json({"type": "ping"})
    await one.until(lambda: one.close_code is not None)
    assert (one.close_code, one.close_reason) == (4429, "rate_limited")
    assert env.registry.counters["rate_limited"] == 1


async def test_the_byte_rate_is_limited_separately(env, settings):
    settings.REALTIME_RATE_BYTES_PER_SECOND = 1000
    settings.REALTIME_RATE_BYTES_BURST = 3000
    settings.REALTIME_MAX_FRAME_BYTES = 2000
    one = await env.open(env.owner)
    for _ in range(4):
        await one.send_json({"type": "ping", "padding": "x" * 1500})
    await one.until(lambda: one.close_code is not None)
    assert one.close_code == 4429


async def test_an_idle_connection_is_closed(env, settings):
    settings.REALTIME_IDLE_TIMEOUT_SECONDS = 0.3
    settings.REALTIME_RECHECK_SECONDS = 0.1
    one = await env.open(env.owner)
    await one.until(lambda: one.close_code is not None, timeout=4)
    assert (one.close_code, one.close_reason) == (4408, "idle")


async def test_a_ping_keeps_a_connection_alive(env, settings):
    settings.REALTIME_IDLE_TIMEOUT_SECONDS = 0.5
    settings.REALTIME_RECHECK_SECONDS = 0.1
    one = await env.open(env.owner)
    for _ in range(8):
        await one.send_json({"type": "ping"})
        await one.pump(quiet=0.1)
    assert one.close_code is None
    assert json.dumps(one.texts_of("pong"))


def remove_page(peer, index: int) -> None:
    pages = peer.doc.get(ROOT_PAGES, type=Map)
    order = peer.doc.get(ROOT_PAGE_ORDER, type=Array)
    page_id = order[index]
    del pages[page_id]
    del order[index]


async def test_when_two_people_remove_the_last_two_pages_at_once_a_blank_page_is_put_back(env):
    """Each saw two pages and removed one, so together they left none: the server restores one, everybody converges."""
    link = await env.link("edit")
    one = await env.open(env.owner)
    two = await env.peer(env.other)
    await two.connect()
    await two.auth(link.token)
    await two.sync()
    await one.edit(lambda doc: remove_page(one, 0))
    await two.edit(lambda doc: remove_page(two, 1))
    await settle(one, two, rounds=5)
    pages = one.document["pages"]
    assert [p["id"] for p in pages] == ["restored-page"] and pages[0]["objects"] == []
    assert one.document == two.document
    await one.send_json({"type": "flush"})
    await one.until(lambda: one.texts_of("saved"))
    saved = await env.db(lambda: Design.objects.get(pk=env.design.pk))
    assert [p["id"] for p in saved.document["pages"]] == ["restored-page"] and saved.page_count == 1
    assert saved.document["pages"][0]["background"] == {"type": "solid", "color": "#ffffff"}


async def test_a_state_without_pages_is_repaired_when_the_server_tries_to_save_it(env, settings, monkeypatch):
    """The check after each update is the first line of defence; saving notices the same state and repairs it too."""
    settings.REALTIME_FLUSH_INTERVAL_SECONDS = 0.1
    monkeypatch.setattr(schema, "has_no_pages", lambda doc: False)
    one = await env.open(env.owner)
    await one.edit(lambda doc: (remove_page(one, 0), remove_page(one, 0)))
    await one.until(lambda: one.texts_of("saved"), timeout=5)
    await settle(one, rounds=3)
    assert [p["id"] for p in one.document["pages"]] == ["restored-page"]
    assert env.registry.counters["repairs"] >= 1
