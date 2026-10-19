"""Abuse of the text and awareness channels and of the login step."""

from __future__ import annotations

import json

import pytest

from apps.collab import protocol

from .peer import settle

pytestmark = pytest.mark.django_db


def nested(depth: int) -> str:
    return "[" * depth + "]" * depth


async def test_deeply_nested_awareness_closes_only_the_sender(env):
    one = await env.open(env.owner)
    two = await env.open(env.owner)
    entry = protocol.AwarenessEntry(5, 1, nested(1500))
    await one.send_raw(protocol.awareness_frame(protocol.encode_awareness([entry])))
    await one.until(lambda: one.close_code is not None)
    assert (one.close_code, one.close_reason) == (4400, "bad_frame")
    await settle(two)
    assert two.close_code is None
    await two.send_awareness(6, 1, {"still": "working"})
    await two.barrier()
    assert two.close_code is None


async def test_nested_awareness_just_inside_the_limits_is_accepted_or_dropped_cleanly(env):
    one = await env.open(env.owner)
    two = await env.open(env.owner)
    entry = protocol.AwarenessEntry(5, 1, json.dumps({"deep": json.loads(nested(200))}))
    await one.send_raw(protocol.awareness_frame(protocol.encode_awareness([entry])))
    await one.barrier()
    assert one.close_code is None and two.close_code is None


async def test_a_nested_login_frame_is_refused(env):
    peer = await env.peer(env.other)
    await peer.connect()
    await peer.ws.send_to(text_data=nested(500))
    await peer.until(lambda: peer.close_code is not None)
    assert (peer.close_code, peer.close_reason) == (4400, "auth_required")


async def test_a_deeply_nested_text_frame_closes_the_connection(env, settings):
    settings.REALTIME_MAX_FRAME_BYTES = 200_000
    one = await env.open(env.owner)
    await one.ws.send_to(text_data=nested(100_000))
    await one.until(lambda: one.close_code is not None)
    assert (one.close_code, one.close_reason) == (4400, "bad_frame")


async def test_new_connections_per_minute_are_limited_per_account(env, settings):
    settings.REALTIME_CONNECTS_PER_MINUTE = 3
    for _ in range(3):
        peer = await env.open(env.owner)
        await peer.disconnect()
    refused = await env.peer(env.owner)
    await refused.connect()
    await refused.until(lambda: refused.close_code is not None)
    assert (refused.close_code, refused.close_reason) == (4429, "rate_limited")


async def test_logins_in_progress_are_limited_per_account(env, settings):
    settings.REALTIME_MAX_CONNECTIONS_PER_USER = 2
    waiting = []
    for count in (1, 2):
        peer = await env.peer(env.other)
        assert await peer.connect()
        await peer.until(lambda count=count: env.registry.pending[env.other.pk] == count)
        waiting.append(peer)
    third = await env.peer(env.other)
    await third.connect()
    await third.until(lambda: third.close_code is not None)
    assert (third.close_code, third.close_reason) == (4429, "too_many_connections")
    await waiting[0].disconnect()
    link = await env.link("view")
    again = await env.peer(env.other)
    await again.connect()
    await again.auth(link.token)
    await again.sync()
    assert again.ready["role"] == "view"
    assert env.registry.pending[env.other.pk] == 1  # the second waiting peer is still counted


async def test_pending_logins_are_released_when_the_login_succeeds_or_fails(env):
    link = await env.link("view")
    good = await env.peer(env.other)
    await good.connect()
    await good.until(lambda: env.registry.pending[env.other.pk] == 1)
    await good.auth(link.token)
    await good.sync()
    assert env.registry.pending[env.other.pk] == 0
    bad = await env.peer(env.other)
    await bad.connect()
    await bad.auth("q" * 32)
    await bad.until(lambda: bad.close_code is not None)
    assert env.registry.pending[env.other.pk] == 0
