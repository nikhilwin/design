"""`manage.py collab_maintenance` and the production ASGI application."""

from __future__ import annotations

from io import StringIO

import pytest
from channels.testing import WebsocketCommunicator
from django.core.management import call_command
from django.utils import timezone

from apps.collab import store
from apps.collab.consumers import get_registry, reset_registry
from apps.collab.models import RoomConnection, YState, YUpdate
from apps.designs.models import Design

from .peer import Peer
from .test_persistence import kill_rooms
from .test_sync import first_object

pytestmark = pytest.mark.django_db


def run_command() -> str:
    out = StringIO()
    call_command("collab_maintenance", stdout=out, stderr=out)
    return out.getvalue()


async def test_the_command_saves_what_a_crash_left_behind(env):
    one = await env.open(env.owner)
    await one.edit(lambda doc: first_object(one).__setitem__("left", 1357))
    await one.barrier()
    await kill_rooms(env)
    await env.db(lambda: RoomConnection.objects.all().delete())
    design = await env.db(lambda: Design.objects.get(pk=env.design.pk))
    assert design.revision == 1
    output = await env.db(run_command)
    assert "saved 1" in output
    design = await env.db(lambda: Design.objects.get(pk=env.design.pk))
    assert design.revision == 2 and design.document["pages"][0]["objects"][0]["left"] == 1357
    assert "saved 0" in await env.db(run_command)


async def test_the_command_leaves_live_rooms_alone(env):
    one = await env.open(env.owner)
    await one.edit(lambda doc: first_object(one).__setitem__("left", 1))
    await one.barrier()
    output = await env.db(run_command)
    assert "saved 0, skipped 1" in output
    assert (await env.db(lambda: Design.objects.get(pk=env.design.pk))).revision == 1


async def test_the_command_compacts_long_update_logs(env, settings):
    settings.REALTIME_COMPACT_AFTER_UPDATES = 1000
    one = await env.open(env.owner)
    for step in range(6):
        await one.edit(lambda doc, step=step: first_object(one).__setitem__("left", step))
    await one.barrier()
    await one.disconnect()
    await kill_rooms(env)
    await env.db(lambda: RoomConnection.objects.all().delete())
    assert await env.db(lambda: YUpdate.objects.filter(design=env.design).count()) >= 1
    settings.REALTIME_COMPACT_AFTER_UPDATES = 1
    output = await env.db(run_command)
    assert "compacted 1" in output
    assert await env.db(lambda: YUpdate.objects.filter(design=env.design).count()) == 0
    again = await env.open(env.owner)
    assert again.document["pages"][0]["objects"][0]["left"] == 5


async def test_the_command_reports_a_document_it_cannot_save(env):
    one = await env.open(env.owner)
    await one.edit(lambda doc: first_object(one).__setitem__("src", "idb://local-only"))
    await one.barrier()
    await kill_rooms(env)
    await env.db(lambda: RoomConnection.objects.all().delete())
    output = await env.db(run_command)
    assert "failed 1" in output
    assert (await env.db(lambda: Design.objects.get(pk=env.design.pk))).revision == 1


async def test_the_command_removes_presence_rows_of_dead_processes(env):
    from datetime import timedelta

    def ghost():
        RoomConnection.objects.create(
            design=env.design,
            user=env.owner,
            instance="ghost:1:x",
            role="owner",
            heartbeat_at=timezone.now() - timedelta(hours=1),
        )

    await env.db(ghost)
    assert "removed 1" in await env.db(run_command)
    assert await env.db(lambda: RoomConnection.objects.count()) == 0


async def test_unflushed_designs_become_flushed_after_the_command(env):
    one = await env.open(env.owner)
    await one.edit(lambda doc: first_object(one).__setitem__("left", 2))
    await one.barrier()
    await kill_rooms(env)
    await env.db(lambda: RoomConnection.objects.all().delete())
    assert env.design.pk in await env.db(store.unflushed_designs)
    await env.db(run_command)
    assert env.design.pk not in await env.db(store.unflushed_designs)
    state = await env.db(lambda: YState.objects.get(design=env.design))
    assert state.flushed_version == state.version


async def test_the_production_application_serves_the_same_endpoint(env):
    """doory.asgi routes websockets through the origin check, the session stack and the consumer."""
    from doory.asgi import application

    reset_registry()
    cookie = await env.db(env.cookie_for, env.owner)
    peer = Peer(application, env.design.pk, cookie=cookie)
    env.peers.append(peer)
    env.registries.append(get_registry())
    assert await peer.connect()
    await peer.sync()
    assert peer.ready["role"] == "owner"
    assert peer.document["pages"][0]["objects"]


async def test_the_production_application_refuses_a_foreign_origin(env):
    from doory.asgi import application

    communicator = WebsocketCommunicator(
        application,
        f"/ws/designs/{env.design.pk}/",
        headers=[(b"origin", b"https://evil.example"), (b"host", b"localhost:5173")],
    )
    connected, _ = await communicator.connect()
    assert connected is False


async def test_the_production_application_has_no_route_for_other_paths(env):
    from doory.asgi import application

    communicator = WebsocketCommunicator(
        application,
        "/ws/elsewhere/",
        headers=[(b"origin", b"http://localhost:5173"), (b"host", b"localhost:5173")],
    )
    with pytest.raises(ValueError):
        await communicator.connect()
