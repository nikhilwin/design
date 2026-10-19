"""Who may connect, and as what."""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.collab.schema import KEY_OBJECTS, ROOT_PAGES
from apps.sharing.models import ShareLink

pytestmark = pytest.mark.django_db


async def closed_with(peer, code: int | None = None, reason: str | None = None) -> None:
    await peer.until(lambda: peer.close_code is not None)
    if code is not None:
        assert peer.close_code == code, (peer.close_code, peer.close_reason)
    if reason is not None:
        assert peer.close_reason == reason


async def test_anonymous_connections_are_closed_with_4401(env):
    peer = await env.peer(None)
    assert await peer.connect() is True  # accepted first, so the browser can read the close code
    await closed_with(peer, 4401, "not_authenticated")
    assert peer.ready is None


async def test_a_handshake_from_another_site_is_refused(env):
    peer = await env.peer(env.owner, origin=b"https://evil.example")
    assert await peer.connect() is False


async def test_a_handshake_without_an_origin_is_refused(env):
    peer = await env.peer(env.owner, origin=None)
    assert await peer.connect() is False


async def test_the_owner_needs_no_token(env):
    peer = await env.open(env.owner)
    assert peer.ready["role"] == "owner"


async def test_the_owner_may_send_an_auth_frame_anyway(env):
    peer = await env.open(env.owner)
    await peer.auth()
    await peer.pump()
    assert peer.close_code is None


async def test_another_user_without_a_token_is_closed_after_the_login_timeout(env, settings):
    settings.REALTIME_AUTH_TIMEOUT_SECONDS = 0.2
    peer = await env.peer(env.other)
    assert await peer.connect()
    await closed_with(peer, 4408, "auth_timeout")


async def test_binary_before_login_closes_the_connection(env):
    peer = await env.peer(env.other)
    await peer.connect()
    await peer.send_raw(b"\x00\x00\x01\x00")
    await closed_with(peer, 4400, "auth_required")


async def test_an_unknown_text_frame_before_login_closes_the_connection(env):
    peer = await env.peer(env.other)
    await peer.connect()
    await peer.send_json({"type": "hello"})
    await closed_with(peer, 4400, "auth_required")


async def test_invalid_json_before_login_closes_the_connection(env):
    peer = await env.peer(env.other)
    await peer.connect()
    await peer.ws.send_to(text_data="{not json")
    await closed_with(peer, 4400, "bad_auth")


async def test_a_token_of_the_wrong_type_is_a_bad_request(env):
    peer = await env.peer(env.other)
    await peer.connect()
    await peer.send_json({"type": "auth", "token": 5})
    await closed_with(peer, 4400, "bad_auth")


async def test_an_edit_link_gives_write_access(env):
    link = await env.link("edit")
    peer = await env.peer(env.other)
    await peer.connect()
    await peer.auth(link.token)
    await peer.sync()
    assert peer.ready["role"] == "edit" and peer.ready["canWrite"] is True


@pytest.mark.parametrize("role", ["comment", "view"])
async def test_comment_and_view_links_give_read_only_access(env, role):
    link = await env.link(role)
    peer = await env.peer(env.other)
    await peer.connect()
    await peer.auth(link.token)
    await peer.sync()
    assert peer.ready["role"] == role and peer.ready["canWrite"] is False
    assert len(peer.document["pages"]) == 2


async def test_an_unknown_token_is_forbidden(env):
    peer = await env.peer(env.other)
    await peer.connect()
    await peer.auth("x" * 32)
    await closed_with(peer, 4403, "forbidden")


async def test_a_malformed_token_is_forbidden(env):
    peer = await env.peer(env.other)
    await peer.connect()
    await peer.auth("short")
    await closed_with(peer, 4403, "forbidden")


async def test_a_token_without_the_auth_field_is_forbidden(env):
    peer = await env.peer(env.other)
    await peer.connect()
    await peer.auth()
    await closed_with(peer, 4400)


async def test_an_expired_token_is_forbidden(env):
    link = await env.link("edit", expires_at=timezone.now() - timedelta(minutes=1))
    peer = await env.peer(env.other)
    await peer.connect()
    await peer.auth(link.token)
    await closed_with(peer, 4403, "forbidden")


async def test_a_deactivated_token_is_forbidden(env):
    link = await env.link("edit", is_active=False)
    peer = await env.peer(env.other)
    await peer.connect()
    await peer.auth(link.token)
    await closed_with(peer, 4403, "forbidden")


async def test_a_token_of_another_design_is_forbidden(env, owner):
    from apps.designs.models import Design

    elsewhere = await env.db(
        lambda: Design.objects.create(owner=owner, title="Other", document=env.design.document)
    )
    link = await env.db(lambda: ShareLink.objects.create(design=elsewhere, role="edit"))
    peer = await env.peer(env.other)
    await peer.connect()
    await peer.auth(link.token)
    await closed_with(peer, 4403, "forbidden")


async def test_unknown_design_and_forbidden_design_look_the_same_to_a_stranger(env):
    known = await env.peer(env.other)
    unknown = await env.peer(env.other, design=type("D", (), {"pk": uuid.uuid4()})())
    for peer in (known, unknown):
        await peer.connect()
        await peer.auth("y" * 32)
        await closed_with(peer)
    assert (
        (known.close_code, known.close_reason)
        == (unknown.close_code, unknown.close_reason)
        == (4403, "forbidden")
    )


async def test_the_owner_of_a_trashed_design_gets_4404(env):
    await env.db(lambda: type(env.design).objects.filter(pk=env.design.pk).update(trashed_at=timezone.now()))
    peer = await env.peer(env.owner)
    await peer.connect()
    await closed_with(peer, 4404, "design_trashed")


async def test_a_link_to_a_trashed_design_looks_like_any_bad_token(env):
    link = await env.link("edit")
    await env.db(lambda: type(env.design).objects.filter(pk=env.design.pk).update(trashed_at=timezone.now()))
    peer = await env.peer(env.other)
    await peer.connect()
    await peer.auth(link.token)
    await closed_with(peer, 4403, "forbidden")


async def test_a_password_protected_link_asks_for_the_password(env):
    def make():
        link = ShareLink(design=env.design, role="edit")
        link.set_password("open sesame")
        link.save()
        return link

    link = await env.db(make)
    peer = await env.peer(env.other)
    await peer.connect()
    await peer.auth(link.token)
    await peer.until(lambda: peer.texts_of("error"))
    assert peer.texts_of("error")[0]["code"] == "password_required"
    assert peer.close_code is None
    await peer.auth(link.token, "wrong password")
    await peer.until(lambda: len(peer.texts_of("error")) == 2)
    await peer.auth(link.token, "open sesame")
    await peer.sync()
    assert peer.ready["role"] == "edit"


async def test_password_guessing_is_limited_and_then_locked(env, settings):
    def make():
        link = ShareLink(design=env.design, role="edit")
        link.set_password("open sesame")
        link.save()
        return link

    link = await env.db(make)
    closed = None
    for _ in range(12):
        peer = await env.peer(env.other)
        await peer.connect()
        await peer.auth(link.token, "nope nope")
        await peer.until(lambda p=peer: p.texts or p.close_code)
        await peer.pump()
        if peer.close_code == 4429:
            closed = peer
            break
        await peer.disconnect()
    assert closed is not None, "the lockout of apps.sharing never kicked in"
    assert closed.close_reason == "password_locked"
    locked = [t for t in closed.texts if t.get("code") == "throttled"]
    assert locked and locked[0]["retry_after"] > 0
    # even the right password is refused while locked
    peer = await env.peer(env.other)
    await peer.connect()
    await peer.auth(link.token, "open sesame")
    await closed_with(peer, 4429, "password_locked")


async def test_five_wrong_passwords_on_one_connection_close_it(env):
    def make():
        link = ShareLink(design=env.design, role="edit")
        link.set_password("open sesame")
        link.save()
        return link

    link = await env.db(make)
    peer = await env.peer(env.other)
    await peer.connect()
    for attempt in range(5):
        await peer.auth(link.token, f"wrong {attempt} password")
        await peer.pump()
    await closed_with(peer, 4403, "forbidden")


async def test_the_owner_role_wins_over_a_token(env):
    link = await env.link("view")
    peer = await env.peer(env.owner)
    await peer.connect()
    await peer.auth(link.token)
    await peer.sync()
    assert peer.ready["role"] == "owner"


async def test_a_link_user_sees_the_current_design_title_and_revision(env):
    link = await env.link("view")
    peer = await env.peer(env.other)
    await peer.connect()
    await peer.auth(link.token)
    await peer.sync()
    assert peer.ready["title"] == "Summer poster" and peer.ready["revision"] == 1
    assert ROOT_PAGES and KEY_OBJECTS
