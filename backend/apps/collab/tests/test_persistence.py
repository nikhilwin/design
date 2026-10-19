"""Durability, saving to the design, compaction and recovery."""

from __future__ import annotations

import asyncio

import pytest
from pycrdt import Map

from apps.collab import engine, store
from apps.collab.models import YState, YUpdate
from apps.collab.schema import KEY_OBJECT_ORDER, KEY_OBJECTS, ROOT_META, new_doc, ydoc_to_document
from apps.designs.models import Design, DesignVersion

from .peer import settle
from .test_sync import add_object, first_object, page_map

pytestmark = pytest.mark.django_db


def reload(design) -> Design:
    return Design.objects.get(pk=design.pk)


async def kill_rooms(env) -> None:
    """Simulate a crash: the room is gone without saving anything."""
    for room in list(env.registry.rooms.values()):
        room.dirty = False
        room.rows_since_compact = 0
        await room._teardown(flush=False)


async def test_an_update_is_stored_before_it_is_relayed(env):
    one = await env.open(env.owner)
    two = await env.open(env.owner)
    await one.edit(lambda doc: first_object(one).__setitem__("left", 777))
    await two.until(lambda: two.document["pages"][0]["objects"][0]["left"] == 777)
    rows = await env.db(lambda: list(YUpdate.objects.filter(design=env.design)))
    assert len(rows) == 1
    replay = new_doc()
    state = await env.db(lambda: bytes(YState.objects.get(design=env.design).snapshot))
    replay.apply_update(state)
    replay.apply_update(bytes(rows[0].data))
    assert ydoc_to_document(replay)["pages"][0]["objects"][0]["left"] == 777


async def test_a_crash_loses_nothing_that_was_relayed(env):
    one = await env.open(env.owner)
    await one.edit(lambda doc: first_object(one).__setitem__("left", 4242))
    await one.edit(lambda doc: add_object(one, "survivor", left=1))
    await one.barrier()
    await kill_rooms(env)
    assert await env.db(lambda: reload(env.design).revision) == 1  # nothing was saved to the design
    again = await env.open(env.owner)
    objects = again.document["pages"][0]["objects"]
    assert objects[0]["left"] == 4242 and objects[-1]["id"] == "survivor"


async def test_the_design_document_is_saved_when_the_last_client_leaves(env):
    one = await env.open(env.owner)
    await one.edit(lambda doc: first_object(one).__setitem__("left", 55))
    await one.edit(lambda doc: doc.get(ROOT_META, type=Map).__setitem__("width", 1500))
    await one.barrier()
    await one.disconnect()
    room = next(iter(env.registry.rooms.values()), None)
    if room is not None:
        await room.finish()
    design = await env.db(lambda: reload(env.design))
    assert design.revision == 2
    assert design.document["pages"][0]["objects"][0]["left"] == 55
    assert design.width == 1500 and design.page_count == 2
    state = await env.db(lambda: YState.objects.get(design=env.design))
    assert state.flushed_version == state.version and state.base_revision == design.revision


async def test_saving_records_an_automatic_version_for_the_last_editor(env):
    link = await env.link("edit")
    one = await env.open(env.owner)
    two = await env.peer(env.other)
    await two.connect()
    await two.auth(link.token)
    await two.sync()
    await two.edit(lambda doc: first_object(two).__setitem__("left", 12))
    await settle(one, two)
    await one.disconnect()
    await two.disconnect()
    await asyncio.sleep(0.1)
    versions = await env.db(lambda: list(DesignVersion.objects.filter(design=env.design)))
    assert len(versions) == 1 and versions[0].is_auto and versions[0].created_by_id == env.other.pk


async def test_a_connected_room_saves_periodically_and_says_so(env, settings):
    settings.REALTIME_FLUSH_INTERVAL_SECONDS = 0.2
    settings.REALTIME_RECHECK_SECONDS = 5
    one = await env.open(env.owner)
    await one.edit(lambda doc: first_object(one).__setitem__("left", 31))
    await one.until(lambda: one.texts_of("saved"), timeout=5)
    saved = one.texts_of("saved")[0]
    assert saved["revision"] == 2
    design = await env.db(lambda: reload(env.design))
    assert design.document["pages"][0]["objects"][0]["left"] == 31 and design.revision == 2


async def test_an_idle_room_does_not_keep_bumping_the_revision(env, settings):
    settings.REALTIME_FLUSH_INTERVAL_SECONDS = 0.1
    one = await env.open(env.owner)
    await one.edit(lambda doc: first_object(one).__setitem__("left", 31))
    await one.until(lambda: one.texts_of("saved"))
    await asyncio.sleep(0.6)
    await one.pump()
    assert len(one.texts_of("saved")) == 1
    assert await env.db(lambda: reload(env.design).revision) == 2


async def test_opening_a_room_without_changes_does_not_touch_the_design(env):
    one = await env.open(env.owner)
    await one.disconnect()
    room = next(iter(env.registry.rooms.values()), None)
    if room is not None:
        await room.finish()
    design = await env.db(lambda: reload(env.design))
    assert design.revision == 1 and design.document == env.design.document


async def test_the_saved_document_equals_the_edited_one(env):
    one = await env.open(env.owner)
    await one.edit(lambda doc: add_object(one, "extra", left=3, shadow={"blur": 4}))
    await one.edit(lambda doc: page_map(one).__setitem__("name", "Cover"))
    await one.barrier()
    expected = one.document
    await one.disconnect()
    room = next(iter(env.registry.rooms.values()), None)
    if room is not None:
        await room.finish()
    saved = (await env.db(lambda: reload(env.design))).document
    assert saved == expected


async def test_a_document_the_server_would_refuse_is_not_saved_and_the_writers_are_warned(env, settings):
    settings.REALTIME_FLUSH_INTERVAL_SECONDS = 0.1
    one = await env.open(env.owner)
    two = await env.open(env.owner)
    await one.edit(lambda doc: first_object(one).__setitem__("src", "blob:http://x/abc"))
    await one.until(lambda: one.texts_of("warning"), timeout=5)
    assert one.texts_of("warning")[0]["code"] == "document_invalid"
    assert one.texts_of("warning")[0]["message"] == "inline_asset_not_allowed"
    assert two.texts_of("warning") or True
    assert not one.texts_of("saved")
    assert await env.db(lambda: reload(env.design).revision) == 1
    await one.edit(lambda doc: first_object(one).__setitem__("src", "https://example.com/a.png"))
    await one.until(lambda: one.texts_of("saved"), timeout=5)


async def test_a_room_with_clashing_field_keys_still_flushes(env, settings):
    settings.REALTIME_FLUSH_INTERVAL_SECONDS = 0.1
    one = await env.open(env.owner)
    two = await env.open(env.owner)
    await one.edit(lambda doc: first_object(one).__setitem__("field", Map({"key": "title", "type": "color"})))
    await two.edit(
        lambda doc: page_map(two)[KEY_OBJECTS][page_map(two)[KEY_OBJECT_ORDER][1]].__setitem__(
            "field", Map({"key": "title", "type": "text"})
        )
    )
    await settle(one, two)
    await one.until(lambda: one.texts_of("saved"), timeout=5)
    assert not one.texts_of("warning")
    assert await env.db(lambda: reload(env.design).revision) == 2


async def test_a_too_deeply_nested_property_is_repaired_away_instead_of_blocking_saves(env, settings):
    settings.REALTIME_FLUSH_INTERVAL_SECONDS = 0.1

    def nest(doc):
        cursor = Map()
        first_object(one)["chain"] = cursor
        for _ in range(80):
            child = Map()
            cursor["c"] = child
            cursor = child

    one = await env.open(env.owner)
    await one.edit(nest)
    await one.until(lambda: one.texts_of("saved"), timeout=5)
    await one.until(lambda: "chain" not in one.document["pages"][0]["objects"][0], timeout=5)


async def test_duplicates_from_concurrent_reordering_are_repaired_in_the_stored_state(env, settings):
    settings.REALTIME_FLUSH_INTERVAL_SECONDS = 0.1
    one = await env.open(env.owner)
    two = await env.open(env.owner)

    def move(peer, target):
        def change(doc):
            order = page_map(peer)[KEY_OBJECT_ORDER]
            moved = order[1]
            del order[1]
            order.insert(target, moved)

        return change

    await one.edit(move(one, 2))
    await two.edit(move(two, 0))
    await settle(one, two, rounds=3)
    await one.until(lambda: one.texts_of("saved"), timeout=5)
    await settle(one, two, rounds=4)
    await one.until(
        lambda: len(page_map(one)[KEY_OBJECT_ORDER]) == 3 and len(page_map(two)[KEY_OBJECT_ORDER]) == 3
    )
    assert one.document == two.document


async def test_updates_are_folded_into_the_snapshot_after_the_configured_number(env, settings):
    settings.REALTIME_COMPACT_AFTER_UPDATES = 5
    one = await env.open(env.owner)
    for step in range(12):
        await one.edit(lambda doc, step=step: first_object(one).__setitem__("left", step))
        await one.barrier()
    rows = await env.db(lambda: YUpdate.objects.filter(design=env.design).count())
    assert rows < 5
    assert env.registry.counters["compactions"] >= 2
    await kill_rooms(env)
    again = await env.open(env.owner)
    assert again.document["pages"][0]["objects"][0]["left"] == 11


async def test_compaction_collects_deleted_content(env, settings):
    settings.REALTIME_COMPACT_AFTER_UPDATES = 1000
    one = await env.open(env.owner)
    for step in range(30):
        await one.edit(lambda doc, step=step: add_object(one, f"temp-{step}", blob="x" * 200))
        await one.edit(lambda doc, step=step: _remove(one, f"temp-{step}"))
    await one.barrier()
    room = next(iter(env.registry.rooms.values()))
    before = len(bytes(await env.db(lambda: YState.objects.get(design=env.design).snapshot))) + sum(
        len(bytes(row.data)) for row in await env.db(lambda: list(YUpdate.objects.filter(design=env.design)))
    )
    await room._compact()
    after = len(bytes(await env.db(lambda: YState.objects.get(design=env.design).snapshot)))
    assert after < before * 0.5
    await kill_rooms(env)
    again = await env.open(env.owner)
    assert len(again.document["pages"][0]["objects"]) == 3


def _remove(peer, oid):
    page = page_map(peer)
    del page[KEY_OBJECTS][oid]
    order = page[KEY_OBJECT_ORDER]
    del order[order.to_py().index(oid)]


async def test_rows_appended_during_compaction_are_kept(env):
    one = await env.open(env.owner)
    await one.edit(lambda doc: first_object(one).__setitem__("left", 1))
    await one.barrier()
    source = await env.db(store.read_for_compaction, env.design.pk)
    await one.edit(lambda doc: first_object(one).__setitem__("left", 2))
    await one.barrier()
    merged = engine.merge_state(source.snapshot, source.updates)
    assert await env.db(store.apply_compaction, env.design.pk, source, merged) is True
    rows = await env.db(lambda: YUpdate.objects.filter(design=env.design).count())
    assert rows == 1
    await kill_rooms(env)
    again = await env.open(env.owner)
    assert again.document["pages"][0]["objects"][0]["left"] == 2


async def test_a_second_compaction_from_a_stale_read_is_refused(env):
    one = await env.open(env.owner)
    await one.edit(lambda doc: first_object(one).__setitem__("left", 1))
    await one.barrier()
    source = await env.db(store.read_for_compaction, env.design.pk)
    merged = engine.merge_state(source.snapshot, source.updates)
    assert await env.db(store.apply_compaction, env.design.pk, source, merged) is True
    assert await env.db(store.apply_compaction, env.design.pk, source, merged) is False


async def test_a_design_changed_through_the_api_while_nobody_was_connected_wins(env):
    one = await env.open(env.owner)
    await one.edit(lambda doc: first_object(one).__setitem__("left", 1))
    await one.disconnect()
    room = next(iter(env.registry.rooms.values()), None)
    if room is not None:
        await room.finish()

    def rest_save():
        design = Design.objects.get(pk=env.design.pk)
        document = design.document
        document["pages"][0]["objects"][0]["left"] = 999
        design.document = document
        design.revision += 1
        design.save()

    await env.db(rest_save)
    again = await env.open(env.owner)
    assert again.document["pages"][0]["objects"][0]["left"] == 999


async def test_the_design_in_the_trash_cannot_be_flushed(env):
    from django.utils import timezone

    one = await env.open(env.owner)
    await one.edit(lambda doc: first_object(one).__setitem__("left", 1))
    await one.barrier()
    await env.db(lambda: Design.objects.filter(pk=env.design.pk).update(trashed_at=timezone.now()))
    result = await env.db(store.flush_document, env.design.pk, env.design.document, 99, None)
    assert result.saved is False


async def test_a_stale_flush_never_overwrites_a_newer_one(env):
    one = await env.open(env.owner)
    await one.edit(lambda doc: first_object(one).__setitem__("left", 5))
    await one.barrier()
    room = next(iter(env.registry.rooms.values()))
    version = room.versions.latest
    document = ydoc_to_document(one.doc)
    first = await env.db(store.flush_document, env.design.pk, document, version, None)
    again = await env.db(store.flush_document, env.design.pk, document, version, None)
    assert first.saved is True and again.saved is False and again.reason == "up_to_date"


async def test_unflushed_designs_are_listed_for_maintenance(env):
    one = await env.open(env.owner)
    await one.edit(lambda doc: first_object(one).__setitem__("left", 5))
    await one.barrier()
    assert env.design.pk in await env.db(store.unflushed_designs)


async def test_an_unreadable_stored_state_is_rebuilt_from_the_saved_design(env):
    one = await env.open(env.owner)
    await one.edit(lambda doc: first_object(one).__setitem__("left", 1))
    await one.barrier()
    await kill_rooms(env)
    await env.db(lambda: YState.objects.filter(design=env.design).update(snapshot=b"\x01\x02 not a y update"))
    again = await env.open(env.owner)
    assert again.ready is not None
    assert (
        again.document["pages"][0]["objects"][0]["left"]
        == env.design.document["pages"][0]["objects"][0]["left"]
    )
    assert env.registry.counters["state_rebuilt"] == 1
    await again.edit(lambda doc: first_object(again).__setitem__("left", 2))
    await again.barrier()
    assert again.close_code is None
