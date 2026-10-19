"""The same cross-process behaviour on a real Redis channel layer (set REDIS_TEST_URL to run these)."""

from __future__ import annotations

import os
import uuid

import pytest

from apps.collab.room import RoomRegistry

from .conftest import build_app
from .peer import Peer, settle
from .test_sync import add_object, first_object

REDIS_URL = os.environ.get("REDIS_TEST_URL", "")
pytestmark = [
    pytest.mark.django_db,
    pytest.mark.skipif(not REDIS_URL, reason="set REDIS_TEST_URL=redis://host:port/db to test against Redis"),
]


@pytest.fixture
def redis_env(env):
    from channels_redis.core import RedisChannelLayer

    layer = RedisChannelLayer(hosts=[REDIS_URL], prefix=f"doory-test-{uuid.uuid4().hex[:8]}", expiry=10)
    env.registry._layer = layer
    return env


async def joined(env, app, user=None) -> Peer:
    cookie = await env.db(env.cookie_for, user or env.owner)
    peer = Peer(app, env.design.pk, cookie=cookie)
    env.peers.append(peer)
    assert await peer.connect()
    await peer.sync()
    return peer


async def test_the_layer_is_recognised_as_shared(redis_env):
    assert redis_env.registry.shared_layer is True


async def test_edits_and_awareness_cross_processes_through_redis(redis_env):
    other_registry, other_app = redis_env.second_instance()
    one = await joined(redis_env, redis_env.app)
    two = await joined(redis_env, other_app)
    await one.edit(lambda doc: first_object(one).__setitem__("left", 818))
    await two.until(lambda: two.document["pages"][0]["objects"][0]["left"] == 818)
    await two.edit(lambda doc: add_object(two, "from-b", left=2))
    await one.until(lambda: one.document["pages"][0]["objects"][-1]["id"] == "from-b")
    await one.send_awareness(901, 1, {"cursor": {"x": 3}})
    await two.until(lambda: 901 in two.awareness)
    await settle(one, two)
    assert one.document == two.document
    assert other_registry.shared_layer is True


async def test_a_foreign_process_is_accepted_when_the_layer_is_shared(redis_env):
    foreign = RoomRegistry(instance=f"otherhost:7:{uuid.uuid4().hex[:6]}", layer=redis_env.registry.layer)
    redis_env.registries.append(foreign)
    one = await joined(redis_env, redis_env.app)
    two = await joined(redis_env, build_app(foreign))
    await one.edit(lambda doc: first_object(one).__setitem__("left", 5))
    await two.until(lambda: two.document["pages"][0]["objects"][0]["left"] == 5)


async def test_a_process_that_joins_late_learns_the_awareness_over_redis(redis_env):
    _, other_app = redis_env.second_instance()
    one = await joined(redis_env, redis_env.app)
    await one.send_awareness(902, 1, {"cursor": {"x": 9}})
    await one.barrier()
    two = await joined(redis_env, other_app)
    await two.until(lambda: 902 in two.awareness)
