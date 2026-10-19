"""Hostile and broken situations: oversized documents, failing storage, stuck clients, reconnects."""

from __future__ import annotations

import asyncio

import pytest
from pycrdt import Map

from apps.collab import crdt, engine, room, store
from apps.collab.models import YUpdate
from apps.designs.models import Design

from .peer import Peer, settle
from .test_sync import add_object, first_object

pytestmark = pytest.mark.django_db


async def test_an_update_that_would_exceed_the_document_limit_is_refused(env, settings):
    settings.MAX_DESIGN_DOCUMENT_BYTES = 9000
    one = await env.open(env.owner)
    two = await env.open(env.owner)
    before = two.document
    await one.edit(lambda doc: first_object(one).__setitem__("blob", "x" * 20000))
    await one.until(lambda: one.close_code is not None)
    assert (one.close_code, one.close_reason) == (4413, "document_too_large")
    await settle(two)
    assert two.document == before and two.close_code is None
    assert await env.db(lambda: YUpdate.objects.filter(design=env.design).count()) == 0


async def test_a_writer_near_the_limit_cannot_force_a_measurement_per_keystroke(env, settings, monkeypatch):
    settings.MAX_DESIGN_DOCUMENT_BYTES = 5000
    measured = []
    original = engine._would_exceed

    def counting(*args):
        measured.append(1)
        return original(*args)

    monkeypatch.setattr(engine, "_would_exceed", counting)
    one = await env.open(env.owner)
    await one.edit(lambda doc: first_object(one).__setitem__("note", "y" * 1500))
    await one.barrier()
    for step in range(40):
        await one.edit(lambda doc, step=step: first_object(one).__setitem__("left", step))
    await one.barrier()
    assert one.close_code is None
    assert len(measured) <= 2  # the big edit, not the forty small ones


async def test_small_changes_are_accepted_near_the_limit_and_deleting_makes_room(env, settings):
    settings.MAX_DESIGN_DOCUMENT_BYTES = 6000
    one = await env.open(env.owner)
    await one.edit(lambda doc: first_object(one).__setitem__("note", "y" * 1500))
    await one.barrier()
    assert one.close_code is None
    await one.edit(lambda doc: first_object(one).__setitem__("note", "short"))
    await one.edit(lambda doc: first_object(one).__setitem__("other", "z" * 1500))
    await one.barrier()
    assert one.close_code is None
    assert one.document["pages"][0]["objects"][0]["note"] == "short"


async def test_a_failing_database_drops_the_room_without_relaying_the_update(env, monkeypatch):
    one = await env.open(env.owner)
    two = await env.open(env.owner)

    def broken(*args):
        raise RuntimeError("database is down")

    monkeypatch.setattr(store, "append_update", broken)
    await one.edit(lambda doc: first_object(one).__setitem__("left", 1))
    for peer in (one, two):
        await peer.until(lambda p=peer: p.close_code is not None)
        assert (peer.close_code, peer.close_reason) == (1011, "persist_failed")
    assert two.document["pages"][0]["objects"][0]["left"] != 1
    monkeypatch.undo()
    again = await env.open(env.owner)
    assert again.document["pages"][0]["objects"][0]["left"] != 1


async def test_an_engine_panic_drops_the_room(env, monkeypatch):
    one = await env.open(env.owner)

    def panic(*args):
        raise crdt.EngineFailure("boom")

    monkeypatch.setattr(engine, "apply_client_updates", panic)
    await one.edit(lambda doc: first_object(one).__setitem__("left", 1))
    await one.until(lambda: one.close_code is not None)
    assert (one.close_code, one.close_reason) == (1011, "internal_error")
    monkeypatch.undo()
    again = await env.open(env.owner)
    assert again.ready is not None


async def test_a_native_panic_becomes_an_engine_failure():
    class Panic(BaseException):
        pass

    def explode():
        raise Panic

    with pytest.raises(crdt.EngineFailure):
        await crdt.run(explode)


async def test_ordinary_errors_pass_through_the_engine_thread():
    def broken():
        raise ValueError("plain")

    with pytest.raises(ValueError):
        await crdt.run(broken)


async def test_engine_threads_have_a_large_stack_and_a_deep_chain_can_be_deleted():
    def build_and_delete(depth: int) -> int:
        from apps.collab.schema import new_doc

        doc = new_doc()
        root = doc.get("meta", type=Map)
        with doc.transaction():
            chain = Map()
            root["k"] = chain
            cursor = chain
            for _ in range(depth):
                child = Map()
                cursor["c"] = child
                cursor = child
        replica = new_doc()
        replica.apply_update(doc.get_update())
        del replica.get("meta", type=Map)["k"]
        return len(replica.get_update())

    assert await crdt.run(build_and_delete, 150_000) > 0


async def test_a_stuck_client_is_dropped_instead_of_stalling_the_room(env, monkeypatch):
    monkeypatch.setattr(room, "OUTBOX_LIMIT", 3)
    stuck = await env.open(env.owner)
    healthy = await env.open(env.owner)
    live_room = next(iter(env.registry.rooms.values()))
    victim = next(
        m for m in live_room.members.values() if m.user_id == env.owner.pk and m.outbox.maxsize == 3
    )
    gate = asyncio.Event()
    closed: list[tuple[int, str]] = []

    class Stuck:
        async def send_bytes(self, data):
            await gate.wait()

        async def send_text(self, text):
            await gate.wait()

        async def close(self, code, reason):
            closed.append((code, reason))

    victim.transport = Stuck()
    for step in range(30):
        await healthy.edit(lambda doc, step=step: first_object(healthy).__setitem__("left", step))
    await healthy.barrier()
    await asyncio.sleep(0.2)
    assert closed and closed[0] == (1013, "slow_consumer")
    assert healthy.close_code is None and healthy.document["pages"][0]["objects"][0]["left"] == 29
    gate.set()
    assert stuck is not healthy


async def test_offline_changes_are_merged_when_the_client_reconnects(env):
    first = await env.open(env.owner)
    other = await env.open(env.owner)
    await first.disconnect()
    first.doc.get("meta", type=Map)  # the document the browser kept
    with first.doc.transaction():
        add_object(first, "made-offline", left=5)
        first_object(first)["left"] = 12345
    await other.edit(lambda doc: add_object(other, "made-online", left=6))
    await other.barrier()
    returning = await env.peer(env.owner)
    returning.doc = first.doc
    assert await returning.connect()
    await returning.sync()
    await returning.barrier()
    await other.until(
        lambda: other.document["pages"][0]["objects"][-1]["id"] in ("made-offline", "made-online")
    )
    await settle(other, returning, rounds=4)
    ids = [o["id"] for o in other.document["pages"][0]["objects"]]
    assert "made-offline" in ids and "made-online" in ids
    assert other.document == returning.document
    assert other.document["pages"][0]["objects"][0]["left"] == 12345


async def test_the_same_update_delivered_twice_is_harmless(env):
    one = await env.open(env.owner)
    two = await env.open(env.owner)
    update = await one.edit(lambda doc: first_object(one).__setitem__("left", 3))
    from apps.collab import protocol

    await one.send_raw(protocol.sync_frame(protocol.SYNC_UPDATE, update))
    await one.barrier()
    await settle(two)
    assert two.document["pages"][0]["objects"][0]["left"] == 3 and one.close_code is None
    assert await env.db(lambda: YUpdate.objects.filter(design=env.design).count()) <= 2


async def test_a_writer_cannot_make_the_server_hold_updates_for_history_it_lacks(env, caplog):
    from pycrdt import Doc

    from apps.collab import protocol

    one = await env.open(env.owner)
    forged = Doc(client_id=31337)
    with forged.transaction():
        forged.get("meta", type=Map)["a"] = 1
    mark = forged.get_state()
    with forged.transaction():
        forged.get("meta", type=Map)["b"] = 2
    await one.send_raw(protocol.sync_frame(protocol.SYNC_UPDATE, forged.get_update(mark)))
    await one.until(lambda: one.close_code is not None)
    assert (one.close_code, one.close_reason) == (4400, "bad_frame")
    # The log says why, without any content of the update.
    rejected = [r.getMessage() for r in caplog.records if r.getMessage().startswith("reject ")]
    assert len(rejected) == 1 and "reason=bad_frame" in rejected[0] and "gap in its history" in rejected[0]


async def test_the_registry_counts_what_happens(env):
    await env.open(env.owner)
    assert len(env.registry.rooms) == 1 and env.registry.counters["connects"] == 1


async def test_shutdown_closes_connections_with_a_restart_code_and_saves(env):
    one = await env.open(env.owner)
    await one.edit(lambda doc: first_object(one).__setitem__("left", 2468))
    await one.barrier()
    await env.registry.shutdown()
    await one.until(lambda: one.close_code is not None)
    assert (one.close_code, one.close_reason) == (1012, "server_restart")
    assert (await env.db(lambda: Design.objects.get(pk=env.design.pk))).document["pages"][0]["objects"][0][
        "left"
    ] == 2468


async def test_fifty_clients_with_two_hundred_operations_each(env, settings):
    import time

    settings.REALTIME_MAX_CONNECTIONS_PER_DESIGN = 60
    settings.REALTIME_MAX_CONNECTIONS_PER_USER = 60
    settings.REALTIME_CONNECTS_PER_MINUTE = 1000
    settings.REALTIME_RATE_BURST = 10_000
    settings.REALTIME_RATE_MESSAGES_PER_SECOND = 10_000
    settings.REALTIME_RATE_BYTES_BURST = 100 * 1024 * 1024
    settings.REALTIME_RATE_BYTES_PER_SECOND = 100 * 1024 * 1024
    settings.REALTIME_COMPACT_AFTER_UPDATES = 500
    clients = 50
    operations = 200
    cookie = await env.db(env.cookie_for, env.owner)
    peers = []
    for _ in range(clients):
        peer = Peer(env.app, env.design.pk, cookie=cookie)
        env.peers.append(peer)
        assert await peer.connect()
        peers.append(peer)
    for peer in peers:
        await peer.sync()
    object_ids = [o["id"] for o in env.design.document["pages"][0]["objects"]]
    started = time.monotonic()
    for step in range(operations):
        for index, peer in enumerate(peers):
            if step % 20 == 0:
                oid = f"c{index}-s{step}"
                await peer.edit(lambda doc, peer=peer, oid=oid, step=step: add_object(peer, oid, left=step))
            else:
                target = object_ids[(index + step) % len(object_ids)]
                await peer.edit(
                    lambda doc, peer=peer, target=target, step=step, index=index: _poke(
                        peer, target, index, step
                    )
                )
        # keep the peers' queues from growing without bound
        for peer in peers:
            while not peer.ws.output_queue.empty():
                await peer.handle(peer.ws.output_queue.get_nowait())
    for peer in peers[:5]:
        await peer.barrier(timeout=120)
    elapsed = time.monotonic() - started
    assert elapsed < 120, f"{clients * operations} operations took {elapsed:.0f}s"
    for peer in peers[:6]:
        await peer.pump(quiet=0.3, limit=30)
    reference = peers[0].document
    for peer in peers[1:6]:
        assert peer.document == reference
    assert len(reference["pages"][0]["objects"]) == 3 + clients * (operations // 20)
    room_state = next(iter(env.registry.rooms.values()))
    assert room_state.inbox.empty()
    assert env.registry.counters["rate_limited"] == 0


def _poke(peer, target: str, index: int, step: int) -> None:
    from .test_sync import page_map

    page_map(peer)["objects"][target][f"p{index % 7}"] = step
