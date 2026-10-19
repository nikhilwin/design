"""REST interplay: 409 use_realtime, titles, version restore."""

from __future__ import annotations

import copy

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.designs.models import Design, DesignVersion

from .peer import settle
from .test_sync import first_object

pytestmark = pytest.mark.django_db


def api_for(user) -> APIClient:
    client = APIClient()
    client.force_login(user)
    return client


def edited(design: Design, left: int) -> dict:
    document = copy.deepcopy(design.document)
    document["pages"][0]["objects"][0]["left"] = left
    return document


async def patch_design(env, user, body: dict, design: Design | None = None):
    target = design or env.design
    return await env.db(lambda: api_for(user).patch(f"/api/v1/designs/{target.pk}/", body, format="json"))


async def test_saving_a_document_over_rest_while_a_room_is_live_answers_409(env):
    peer = await env.open(env.owner)
    response = await patch_design(env, env.owner, {"document": edited(env.design, 1), "base_revision": 1})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "use_realtime"
    assert (await env.db(lambda: Design.objects.get(pk=env.design.pk))).revision == 1
    assert peer.document["pages"][0]["objects"][0]["left"] != 1


async def test_saving_over_rest_works_again_after_everyone_left(env):
    peer = await env.open(env.owner)
    await peer.disconnect()
    room = next(iter(env.registry.rooms.values()), None)
    if room is not None:
        await room.finish()
    design = await env.db(lambda: Design.objects.get(pk=env.design.pk))
    response = await patch_design(
        env, env.owner, {"document": edited(design, 2), "base_revision": design.revision}
    )
    assert response.status_code == 200 and response.json()["revision"] == design.revision + 1


async def test_a_title_change_works_while_live_and_reaches_the_room_at_once(
    env, settings, django_capture_on_commit_callbacks
):
    settings.REALTIME_RECHECK_SECONDS = 60  # only the layer message can explain a prompt update

    def rename():
        with django_capture_on_commit_callbacks(execute=True):
            return api_for(env.owner).patch(
                f"/api/v1/designs/{env.design.pk}/", {"title": "A better title"}, format="json"
            )

    peer = await env.open(env.owner)
    response = await env.db(rename)
    assert response.status_code == 200
    await peer.until(lambda: peer.texts_of("title"), timeout=2)
    assert peer.texts_of("title")[-1]["title"] == "A better title"


async def test_a_title_change_is_noticed_without_the_layer_message_too(env, settings):
    settings.REALTIME_RECHECK_SECONDS = 0.1
    peer = await env.open(env.owner)
    await env.db(lambda: Design.objects.filter(pk=env.design.pk).update(title="Quietly renamed"))
    await peer.until(lambda: peer.texts_of("title"), timeout=5)
    assert peer.texts_of("title")[-1]["title"] == "Quietly renamed"


async def test_starring_and_moving_still_work_while_live(env):
    await env.open(env.owner)
    response = await patch_design(env, env.owner, {"starred": True})
    assert response.status_code == 200 and response.json()["starred"] is True


async def test_a_body_that_is_not_json_falls_through_to_the_endpoint(env):
    await env.open(env.owner)
    response = await env.db(
        lambda: api_for(env.owner).generic(
            "PATCH", f"/api/v1/designs/{env.design.pk}/", '{"document": ', content_type="application/json"
        )
    )
    assert response.status_code == 400


async def test_an_anonymous_caller_learns_nothing_about_live_rooms(env):
    await env.open(env.owner)
    response = await env.db(
        lambda: APIClient().patch(
            f"/api/v1/designs/{env.design.pk}/", {"document": {}, "base_revision": 1}, format="json"
        )
    )
    assert response.status_code in (401, 403)
    assert response.json()["error"]["code"] != "use_realtime"


async def test_another_user_learns_nothing_about_live_rooms(env):
    await env.open(env.owner)
    response = await patch_design(env, env.other, {"document": edited(env.design, 3), "base_revision": 1})
    assert response.status_code == 404


async def test_an_edit_link_save_while_live_answers_409(env):
    link = await env.link("edit")
    await env.open(env.owner)
    response = await env.db(
        lambda: api_for(env.other).patch(
            f"/api/v1/shared/{link.token}/",
            {"document": edited(env.design, 4), "base_revision": 1},
            format="json",
        )
    )
    assert response.status_code == 409 and response.json()["error"]["code"] == "use_realtime"


async def test_an_edit_link_save_works_when_nobody_is_connected(env):
    link = await env.link("edit")
    response = await env.db(
        lambda: api_for(env.other).patch(
            f"/api/v1/shared/{link.token}/",
            {"document": edited(env.design, 4), "base_revision": 1},
            format="json",
        )
    )
    assert response.status_code == 200


async def test_a_view_link_still_gets_its_own_error_while_live(env):
    link = await env.link("view")
    await env.open(env.owner)
    response = await env.db(
        lambda: api_for(env.other).patch(
            f"/api/v1/shared/{link.token}/",
            {"document": edited(env.design, 4), "base_revision": 1},
            format="json",
        )
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "share_role_insufficient"


async def test_a_password_protected_edit_link_does_not_leak_through_the_guard(env):
    from apps.sharing.models import ShareLink

    def make():
        link = ShareLink(design=env.design, role="edit")
        link.set_password("open sesame")
        link.save()
        return link

    link = await env.db(make)
    await env.open(env.owner)
    wrong = await env.db(
        lambda: api_for(env.other).patch(
            f"/api/v1/shared/{link.token}/",
            {"document": edited(env.design, 4), "base_revision": 1},
            format="json",
            HTTP_X_SHARE_PASSWORD="nope nope",
        )
    )
    assert wrong.status_code == 401
    right = await env.db(
        lambda: api_for(env.other).patch(
            f"/api/v1/shared/{link.token}/",
            {"document": edited(env.design, 4), "base_revision": 1},
            format="json",
            HTTP_X_SHARE_PASSWORD="open sesame",
        )
    )
    assert right.status_code == 409


async def test_an_unknown_share_token_is_not_a_409(env):
    await env.open(env.owner)
    response = await env.db(
        lambda: api_for(env.other).patch(
            f"/api/v1/shared/{'z' * 32}/",
            {"document": edited(env.design, 4), "base_revision": 1},
            format="json",
        )
    )
    assert response.status_code == 404


async def test_the_guard_can_be_switched_off_with_the_feature(env, settings):
    await env.open(env.owner)
    settings.REALTIME_ENABLED = False
    response = await patch_design(env, env.owner, {"document": edited(env.design, 5), "base_revision": 1})
    assert response.status_code == 200


async def test_restoring_a_version_while_live_replaces_the_state_for_everyone(
    env, settings, django_capture_on_commit_callbacks
):
    settings.REALTIME_RECHECK_SECONDS = 60  # only the layer message can explain a prompt update
    link = await env.link("edit")
    owner = await env.open(env.owner)
    guest = await env.peer(env.other)
    await guest.connect()
    await guest.auth(link.token)
    await guest.sync()
    version = await env.db(
        lambda: DesignVersion.objects.create(
            design=env.design, document=edited(env.design, 424), label="Good"
        )
    )
    await owner.edit(lambda doc: first_object(owner).__setitem__("left", 1))
    await settle(owner, guest)

    def restore():
        with django_capture_on_commit_callbacks(execute=True):
            return api_for(env.owner).post(f"/api/v1/designs/{env.design.pk}/versions/{version.pk}/restore/")

    response = await env.db(restore)
    assert response.status_code == 200
    for peer in (owner, guest):
        await peer.until(lambda p=peer: p.texts_of("replaced"), timeout=3)
        await peer.until(lambda p=peer: p.document["pages"][0]["objects"][0]["left"] == 424, timeout=3)
    assert owner.texts_of("replaced")[0]["reason"] == "version_restored"
    assert owner.document == guest.document
    # the same history carries on: edits after the restore still merge and save
    await guest.edit(lambda doc: first_object(guest).__setitem__("top", 77))
    await settle(owner, guest)
    assert owner.document["pages"][0]["objects"][0]["top"] == 77
    await owner.send_json({"type": "flush"})
    await owner.until(lambda: owner.texts_of("saved"), timeout=5)
    saved = await env.db(lambda: Design.objects.get(pk=env.design.pk))
    assert saved.document["pages"][0]["objects"][0]["left"] == 424
    assert saved.document["pages"][0]["objects"][0]["top"] == 77


async def test_a_restore_is_noticed_even_when_no_message_reaches_the_room(env, settings):
    settings.REALTIME_RECHECK_SECONDS = 0.1
    owner = await env.open(env.owner)
    replacement = edited(env.design, 808)

    def restore_quietly():
        Design.objects.filter(pk=env.design.pk).update(
            document=replacement, revision=5, updated_at=timezone.now()
        )

    await env.db(restore_quietly)
    await owner.until(lambda: owner.texts_of("replaced"), timeout=5)
    assert owner.document["pages"][0]["objects"][0]["left"] == 808
    assert owner.texts_of("replaced")[0]["revision"] == 5


async def test_only_one_process_performs_a_replacement(env, settings):
    settings.REALTIME_RECHECK_SECONDS = 0.1
    second_registry, second_app = env.second_instance()
    one = await env.open(env.owner)
    two = await env.peer(env.owner)
    two.ws = type(two.ws)(second_app, f"/ws/designs/{env.design.pk}/", headers=two.ws.scope["headers"])
    assert await two.connect()
    await two.sync()
    await env.db(
        lambda: Design.objects.filter(pk=env.design.pk).update(document=edited(env.design, 606), revision=3)
    )
    await one.until(lambda: one.texts_of("replaced"), timeout=5)
    await two.until(
        lambda: two.texts_of("replaced") or two.document["pages"][0]["objects"][0]["left"] == 606, timeout=5
    )
    await settle(one, two, rounds=4)
    assert one.document == two.document
    assert len(one.document["pages"]) == 2 and len(one.document["pages"][0]["objects"]) == 3
    assert env.registry.counters["replaced"] + second_registry.counters["replaced"] == 1


async def test_the_flush_frame_saves_now_and_answers_saved(env):
    owner = await env.open(env.owner)
    await owner.edit(lambda doc: first_object(owner).__setitem__("left", 66))
    await settle(owner)
    await owner.send_json({"type": "flush"})
    await owner.until(lambda: owner.texts_of("saved"), timeout=5)
    assert (await env.db(lambda: Design.objects.get(pk=env.design.pk))).document["pages"][0]["objects"][0][
        "left"
    ] == 66


async def test_the_flush_frame_without_changes_just_reports_the_revision(env):
    owner = await env.open(env.owner)
    await owner.send_json({"type": "flush"})
    await owner.until(lambda: owner.texts_of("saved"), timeout=5)
    assert owner.texts_of("saved")[0]["revision"] == 1


async def test_a_read_only_user_cannot_force_a_flush(env):
    link = await env.link("view")
    viewer = await env.peer(env.other)
    await viewer.connect()
    await viewer.auth(link.token)
    await viewer.sync()
    await viewer.send_json({"type": "flush"})
    await viewer.pump()
    assert not viewer.texts_of("saved") and viewer.close_code is None


async def protected_link(env, password: str = "secret-pw"):
    link = await env.link("edit")

    def protect():
        link.set_password(password)
        link.save()

    await env.db(protect)
    return link


def save_through_link(env, link, password: str | None):
    headers = {"HTTP_X_SHARE_PASSWORD": password} if password is not None else {}
    return api_for(env.other).patch(
        f"/api/v1/shared/{link.token}/",
        {"document": edited(env.design, 5), "base_revision": 1},
        format="json",
        **headers,
    )


async def test_a_protected_edit_link_answers_409_only_for_its_password(env):
    link = await protected_link(env)
    await env.open(env.owner)
    right = await env.db(lambda: save_through_link(env, link, "secret-pw"))
    wrong = await env.db(lambda: save_through_link(env, link, "wrong-pw"))
    none = await env.db(lambda: save_through_link(env, link, None))
    assert right.status_code == 409 and right.json()["error"]["code"] == "use_realtime"
    assert wrong.status_code == 401 and none.status_code == 401
    assert wrong.json()["error"]["code"] == "password_required"


async def test_the_live_room_check_is_not_a_way_round_the_password_guess_limits(env):
    """Once the REST guess window is used up, even the right password must not be told apart by a 409."""
    link = await protected_link(env)
    await env.open(env.owner)
    for _ in range(10):
        assert (await env.db(lambda: save_through_link(env, link, "wrong-pw"))).status_code == 401
    locked = await env.db(lambda: save_through_link(env, link, "secret-pw"))
    assert locked.status_code == 429
    assert locked.json()["error"]["code"] != "use_realtime"
