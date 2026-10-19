"""Two server processes on one channel layer and one database."""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.collab.models import RoomConnection
from apps.collab.room import RoomRegistry
from apps.designs.models import Design

from .conftest import build_app
from .peer import Peer, settle
from .test_sync import add_object, first_object

pytestmark = pytest.mark.django_db


async def second_peer(env, app, user=None, token=None) -> Peer:
    user = user or env.owner
    cookie = await env.db(env.cookie_for, user)
    peer = Peer(app, env.design.pk, cookie=cookie)
    env.peers.append(peer)
    assert await peer.connect()
    if token:
        await peer.auth(token)
    await peer.sync()
    return peer


async def test_an_edit_on_one_process_reaches_a_client_on_the_other(env):
    registry_b, app_b = env.second_instance()
    one = await env.open(env.owner)
    two = await second_peer(env, app_b)
    await one.edit(lambda doc: first_object(one).__setitem__("left", 818))
    await two.until(lambda: two.document["pages"][0]["objects"][0]["left"] == 818)
    await two.edit(lambda doc: add_object(two, "from-b", left=2))
    await one.until(lambda: one.document["pages"][0]["objects"][-1]["id"] == "from-b")
    assert one.document == two.document
    assert len(env.registry.rooms) == 1 and len(registry_b.rooms) == 1


async def test_a_late_joiner_on_the_second_process_gets_everything(env):
    _other, app_b = env.second_instance()
    one = await env.open(env.owner)
    await one.edit(lambda doc: add_object(one, "early"))
    await one.barrier()
    two = await second_peer(env, app_b)
    assert two.document == one.document


async def test_concurrent_edits_on_both_processes_converge(env):
    _other, app_b = env.second_instance()
    one = await env.open(env.owner)
    two = await second_peer(env, app_b)
    for step in range(10):
        await one.edit(lambda doc, step=step: add_object(one, f"a{step}"))
        await two.edit(lambda doc, step=step: add_object(two, f"b{step}"))
        await one.edit(lambda doc, step=step: first_object(one).__setitem__("left", step))
        await two.edit(lambda doc, step=step: first_object(two).__setitem__("left", 100 + step))
    await settle(one, two, rounds=5)
    await one.barrier()
    await two.barrier()
    await settle(one, two, rounds=5)
    assert one.document == two.document
    assert len(one.document["pages"][0]["objects"]) == 3 + 20


async def test_awareness_crosses_processes_in_both_directions(env):
    _other, app_b = env.second_instance()
    one = await env.open(env.owner)
    two = await second_peer(env, app_b)
    await one.send_awareness(501, 1, {"cursor": {"x": 1}})
    await two.send_awareness(502, 1, {"cursor": {"x": 2}})
    await two.until(lambda: 501 in two.awareness)
    await one.until(lambda: 502 in one.awareness)
    assert two.awareness[501]["user"]["role"] == "owner"
    await one.disconnect()
    await two.until(lambda: two.awareness.get(501, 0) is None)


async def test_a_process_that_opens_later_learns_the_existing_awareness(env):
    _other, app_b = env.second_instance()
    one = await env.open(env.owner)
    await one.send_awareness(601, 1, {"cursor": {"x": 9}})
    await one.barrier()
    two = await second_peer(env, app_b)
    await two.until(lambda: 601 in two.awareness)
    assert two.awareness[601]["cursor"] == {"x": 9}


async def test_only_one_save_happens_per_change_across_processes(env, settings):
    settings.REALTIME_FLUSH_INTERVAL_SECONDS = 0.2
    _other, app_b = env.second_instance()
    one = await env.open(env.owner)
    two = await second_peer(env, app_b)
    await one.edit(lambda doc: first_object(one).__setitem__("left", 31))
    await two.until(lambda: two.document["pages"][0]["objects"][0]["left"] == 31)
    await asyncio.sleep(1.0)
    await settle(one, two)
    design = await env.db(lambda: Design.objects.get(pk=env.design.pk))
    assert design.document["pages"][0]["objects"][0]["left"] == 31
    assert design.revision == 2  # not once per process


async def test_the_design_is_saved_when_the_last_process_lets_go(env):
    registry_b, app_b = env.second_instance()
    one = await env.open(env.owner)
    two = await second_peer(env, app_b)
    await two.edit(lambda doc: first_object(two).__setitem__("left", 44))
    await one.until(lambda: one.document["pages"][0]["objects"][0]["left"] == 44)
    await one.disconnect()
    await two.barrier()
    await two.disconnect()
    for room in list(env.registry.rooms.values()) + list(registry_b.rooms.values()):
        await room.finish()
    design = await env.db(lambda: Design.objects.get(pk=env.design.pk))
    assert design.document["pages"][0]["objects"][0]["left"] == 44


async def test_connection_limits_count_connections_on_all_processes(env, settings):
    settings.REALTIME_MAX_CONNECTIONS_PER_DESIGN = 2
    _other, app_b = env.second_instance()
    await env.open(env.owner)
    await second_peer(env, app_b)
    cookie = await env.db(env.cookie_for, env.owner)
    refused = Peer(app_b, env.design.pk, cookie=cookie)
    env.peers.append(refused)
    await refused.connect()
    await refused.until(lambda: refused.close_code is not None)
    assert (refused.close_code, refused.close_reason) == (4429, "design_full")


async def test_a_lost_layer_message_is_healed_from_the_database(env, settings):
    settings.REALTIME_RECHECK_SECONDS = 0.1
    registry_b, app_b = env.second_instance()
    one = await env.open(env.owner)
    two = await second_peer(env, app_b)
    room_b = next(iter(registry_b.rooms.values()))
    original = room_b._remote
    dropped: list[str] = []

    async def lossy(message):
        if message.get("type") == "collab.update" and not dropped:
            dropped.append("x")
            return
        await original(message)

    room_b._remote = lossy
    await one.edit(lambda doc: first_object(one).__setitem__("left", 909))
    await two.until(lambda: two.document["pages"][0]["objects"][0]["left"] == 909, timeout=8)
    assert dropped and registry_b.counters["resyncs"] >= 1


async def test_without_a_shared_layer_a_second_process_is_refused(env):
    """Two processes with in-memory layers would each keep their own copy; the second one must not join."""
    await env.open(env.owner)
    stranger = RoomRegistry(instance=f"otherhost:{uuid.uuid4().hex[:6]}:abcd", layer=env.registry.layer)
    env.registries.append(stranger)
    app = build_app(stranger)
    cookie = await env.db(env.cookie_for, env.owner)
    peer = Peer(app, env.design.pk, cookie=cookie)
    env.peers.append(peer)
    await peer.connect()
    await peer.until(lambda: peer.close_code is not None)
    assert (peer.close_code, peer.close_reason) == (1013, "shared_layer_required")


async def test_stale_rows_of_a_dead_process_do_not_block_a_room(env):
    def dead_row():
        RoomConnection.objects.create(
            design=env.design,
            user=env.owner,
            instance="ghost:1:dead",
            role="owner",
            heartbeat_at=timezone.now() - timedelta(minutes=5),
        )

    await env.db(dead_row)
    peer = await env.open(env.owner)
    assert peer.ready is not None
