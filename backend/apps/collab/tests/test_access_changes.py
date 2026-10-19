"""Rights that disappear while connected: links, trash, accounts and sessions."""

from __future__ import annotations

import asyncio
from datetime import timedelta

import pytest
from django.test import Client
from django.utils import timezone

from apps.accounts.models import User
from apps.designs.models import Design
from apps.sharing.models import ShareLink

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def fast_rechecks(settings):
    settings.REALTIME_RECHECK_SECONDS = 0.1


async def guest(env, link, user=None):
    peer = await env.peer(user or env.other)
    assert await peer.connect()
    await peer.auth(link.token)
    await peer.sync()
    return peer


async def expect_closed(peer, code: int, reason: str) -> None:
    await peer.until(lambda: peer.close_code is not None, timeout=5)
    assert (peer.close_code, peer.close_reason) == (code, reason)


async def test_deleting_the_share_link_closes_its_connections_but_not_the_owners(env):
    link = await env.link("edit")
    owner = await env.open(env.owner)
    other = await guest(env, link)
    await env.db(link.delete)
    await expect_closed(other, 4403, "link_revoked")
    await owner.pump()
    assert owner.close_code is None


async def test_revoking_a_link_through_the_api_closes_its_connections_at_once(
    env, settings, django_capture_on_commit_callbacks
):
    settings.REALTIME_RECHECK_SECONDS = 60  # only the layer message can explain a prompt close
    link = await env.link("edit")
    other = await guest(env, link)

    def revoke():
        with django_capture_on_commit_callbacks(execute=True):
            link.delete()

    await env.db(revoke)
    await other.until(lambda: other.close_code is not None, timeout=2)
    assert (other.close_code, other.close_reason) == (4403, "link_revoked")


async def test_deactivating_the_link_closes_its_connections(env):
    link = await env.link("edit")
    other = await guest(env, link)
    await env.db(lambda: ShareLink.objects.filter(pk=link.pk).update(is_active=False))
    await expect_closed(other, 4403, "link_revoked")


async def test_an_expiring_link_closes_its_connections(env):
    link = await env.link("edit", expires_at=timezone.now() + timedelta(seconds=30))
    other = await guest(env, link)
    await env.db(
        lambda: ShareLink.objects.filter(pk=link.pk).update(expires_at=timezone.now() - timedelta(seconds=1))
    )
    await expect_closed(other, 4403, "link_expired")


async def test_changing_the_role_of_the_link_closes_its_connections(env):
    link = await env.link("edit")
    other = await guest(env, link)
    await env.db(lambda: ShareLink.objects.filter(pk=link.pk).update(role="view"))
    await expect_closed(other, 4403, "role_changed")


async def test_connections_through_another_link_stay_open_when_one_link_is_revoked(env):
    keep = await env.link("edit")
    drop = await env.link("edit")
    kept = await guest(env, keep)
    dropped = await guest(env, drop)
    await env.db(drop.delete)
    await expect_closed(dropped, 4403, "link_revoked")
    await kept.pump()
    assert kept.close_code is None


async def test_trashing_the_design_closes_everyone(env):
    link = await env.link("edit")
    owner = await env.open(env.owner)
    other = await guest(env, link)
    await env.db(lambda: Design.objects.filter(pk=env.design.pk).update(trashed_at=timezone.now()))
    await expect_closed(owner, 4404, "design_trashed")
    await expect_closed(other, 4404, "design_trashed")


async def test_deleting_the_design_closes_everyone(env):
    owner = await env.open(env.owner)
    await env.db(lambda: Design.objects.filter(pk=env.design.pk).delete())
    await expect_closed(owner, 4404, "design_deleted")


async def test_deactivating_a_user_closes_their_connections(env):
    link = await env.link("edit")
    owner = await env.open(env.owner)
    other = await guest(env, link)
    await env.db(lambda: User.objects.filter(pk=env.other.pk).update(is_active=False))
    await expect_closed(other, 4403, "account_disabled")
    await owner.pump()
    assert owner.close_code is None


async def test_logging_out_closes_the_connection(env):
    client = Client()
    await env.db(client.force_login, env.owner)
    cookie = f"sessionid={client.cookies['sessionid'].value}"
    from .peer import Peer

    peer = Peer(env.app, env.design.pk, cookie=cookie)
    env.peers.append(peer)
    assert await peer.connect()
    await peer.sync()
    await env.db(client.logout)
    await expect_closed(peer, 4401, "session_ended")


async def test_changing_the_password_closes_the_other_sessions_connections(env):
    def change():
        user = User.objects.get(pk=env.owner.pk)
        user.set_password("a brand new password 123")
        user.save()

    peer = await env.open(env.owner)
    await env.db(change)
    await expect_closed(peer, 4401, "session_ended")


async def test_a_second_session_of_the_same_user_is_not_affected_by_the_first_ending(env):
    first_client, second_client = Client(), Client()
    await env.db(first_client.force_login, env.owner)
    await env.db(second_client.force_login, env.owner)
    from .peer import Peer

    peers = []
    for client in (first_client, second_client):
        peer = Peer(env.app, env.design.pk, cookie=f"sessionid={client.cookies['sessionid'].value}")
        env.peers.append(peer)
        assert await peer.connect()
        await peer.sync()
        peers.append(peer)
    await env.db(first_client.logout)
    await expect_closed(peers[0], 4401, "session_ended")
    await peers[1].pump()
    assert peers[1].close_code is None


async def test_the_poll_catches_a_revocation_that_no_message_announced(env):
    """A link removed through a bulk delete sends no signal; the next re-check closes the connection."""
    link = await env.link("edit")
    other = await guest(env, link)
    await env.db(lambda: ShareLink.objects.filter(pk=link.pk)._raw_delete(ShareLink.objects.db))
    await expect_closed(other, 4403, "link_revoked")


async def test_a_revoked_connection_is_removed_from_the_presence_table(env):
    from apps.collab.models import RoomConnection

    link = await env.link("edit")
    other = await guest(env, link)
    assert await env.db(lambda: RoomConnection.objects.filter(design=env.design).count()) == 1
    await env.db(link.delete)
    await expect_closed(other, 4403, "link_revoked")
    await other.disconnect()
    assert await env.db(lambda: RoomConnection.objects.filter(design=env.design).count()) == 0


async def test_connection_limit_per_design(env, settings):
    settings.REALTIME_MAX_CONNECTIONS_PER_DESIGN = 2
    first = await env.open(env.owner)
    second = await env.open(env.owner)
    third = await env.peer(env.owner)
    assert await third.connect()
    await third.until(lambda: third.close_code is not None)
    assert (third.close_code, third.close_reason) == (4429, "design_full")
    await first.disconnect()
    fourth = await env.open(env.owner)
    assert fourth.ready is not None and second.close_code is None


async def test_connection_limit_per_user(env, settings):
    settings.REALTIME_MAX_CONNECTIONS_PER_USER = 2
    link = await env.link("edit")
    await env.open(env.owner)
    await env.open(env.owner)
    other_one = await guest(env, link)
    assert other_one.ready is not None  # the limit is per account, not per design
    third = await env.peer(env.owner)
    assert await third.connect()
    await third.until(lambda: third.close_code is not None)
    assert (third.close_code, third.close_reason) == (4429, "too_many_connections")


async def test_a_refused_connection_leaves_no_presence_row(env, settings):
    from apps.collab.models import RoomConnection

    settings.REALTIME_MAX_CONNECTIONS_PER_DESIGN = 1
    await env.open(env.owner)
    refused = await env.peer(env.owner)
    await refused.connect()
    await refused.until(lambda: refused.close_code is not None)
    assert await env.db(lambda: RoomConnection.objects.filter(design=env.design).count()) == 1


async def test_rotating_the_secret_key_does_not_close_connected_sessions(env, settings):
    client = Client()
    await env.db(client.force_login, env.owner)
    cookie = f"sessionid={client.cookies['sessionid'].value}"
    from .peer import Peer

    peer = Peer(env.app, env.design.pk, cookie=cookie)
    env.peers.append(peer)
    assert await peer.connect()
    await peer.sync()
    old_key = settings.SECRET_KEY
    settings.SECRET_KEY = "a-new-secret-key-after-rotation-0123456789abcdefghij"
    settings.SECRET_KEY_FALLBACKS = [old_key]
    await asyncio.sleep(0.6)  # several re-checks
    await peer.pump()
    assert peer.close_code is None
