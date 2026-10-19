import pytest
from rest_framework.test import APIClient

from apps.sharing.models import ShareLink
from apps.sharing.services import MAX_ACTIVE_LINKS_PER_DESIGN

from .conftest import future, past


@pytest.fixture
def list_url(design):
    return f"/api/v1/designs/{design.id}/share-links/"


def detail_url(design, link):
    return f"/api/v1/designs/{design.id}/share-links/{link.id}/"


def test_create_link_returns_contract_shape(owner_client, list_url, design):
    response = owner_client.post(list_url, {"role": "comment"}, format="json")
    assert response.status_code == 201
    body = response.json()
    assert set(body) == {
        "id",
        "token",
        "role",
        "url",
        "is_active",
        "expires_at",
        "has_password",
        "created_at",
    }
    assert body["role"] == "comment"
    assert body["is_active"] is True
    assert body["has_password"] is False
    assert body["url"].endswith(f"/s/{body['token']}")
    link = ShareLink.objects.get(pk=body["id"])
    assert link.design_id == design.id
    assert link.created_by == design.owner


def test_create_with_password_and_expiry(owner_client, list_url):
    expires = future(48).isoformat()
    response = owner_client.post(
        list_url, {"role": "view", "password": "letmein", "expires_at": expires}, format="json"
    )
    assert response.status_code == 201
    body = response.json()
    assert body["has_password"] is True
    assert "password" not in body
    link = ShareLink.objects.get(pk=body["id"])
    assert link.password_hash and "letmein" not in link.password_hash
    assert link.check_password("letmein")


def test_create_requires_role(owner_client, list_url):
    response = owner_client.post(list_url, {}, format="json")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "validation_error"
    assert "role" in response.json()["error"]["fields"]


def test_create_rejects_unknown_role(owner_client, list_url):
    assert owner_client.post(list_url, {"role": "admin"}, format="json").status_code == 400


def test_create_rejects_past_expiry(owner_client, list_url):
    response = owner_client.post(list_url, {"role": "view", "expires_at": past().isoformat()}, format="json")
    assert response.status_code == 400
    assert "expires_at" in response.json()["error"]["fields"]


@pytest.mark.parametrize("password", ["abc", "x" * 129, "pässword", "tab\tinside"])
def test_create_rejects_bad_passwords(owner_client, list_url, password):
    response = owner_client.post(list_url, {"role": "view", "password": password}, format="json")
    assert response.status_code == 400
    assert "password" in response.json()["error"]["fields"]


def test_empty_password_means_no_password(owner_client, list_url):
    body = owner_client.post(list_url, {"role": "view", "password": ""}, format="json").json()
    assert body["has_password"] is False


def test_mass_assignment_is_ignored(owner_client, list_url, stranger, design):
    response = owner_client.post(
        list_url,
        {"role": "view", "token": "attacker-chosen-token-value-0000", "design": "x", "access_count": 99,
         "created_by": str(stranger.id), "is_active": False},
        format="json",
    )  # fmt: skip
    assert response.status_code == 201
    link = ShareLink.objects.get(pk=response.json()["id"])
    assert link.token != "attacker-chosen-token-value-0000"
    assert link.access_count == 0
    assert link.created_by == design.owner
    assert link.is_active is True


def test_list_links_is_paginated_and_newest_first(owner_client, list_url, make_link):
    older, newer = make_link("view"), make_link("edit")
    body = owner_client.get(list_url).json()
    assert body["count"] == 2
    assert [item["id"] for item in body["results"]] == [str(newer.id), str(older.id)]
    assert {"count", "next", "previous", "results"} <= set(body)


def test_list_only_contains_links_of_this_design(owner_client, list_url, owner, make_link):
    from apps.designs.models import Design

    other = Design.objects.create(owner=owner, title="Other")
    ShareLink.objects.create(design=other, role="view")
    make_link("view")
    assert owner_client.get(list_url).json()["count"] == 1


def test_anonymous_gets_401(anon, list_url):
    assert anon.get(list_url).status_code == 401
    assert anon.post(list_url, {"role": "view"}, format="json").status_code == 401


def test_other_users_get_404(stranger_client, list_url, view_link, design):
    assert stranger_client.get(list_url).status_code == 404
    assert stranger_client.post(list_url, {"role": "view"}, format="json").status_code == 404
    assert stranger_client.get(detail_url(design, view_link)).status_code == 404
    assert (
        stranger_client.patch(detail_url(design, view_link), {"role": "edit"}, format="json").status_code
        == 404
    )
    assert stranger_client.delete(detail_url(design, view_link)).status_code == 404
    view_link.refresh_from_db()
    assert view_link.role == "view"


def test_unknown_design_is_404(owner_client):
    assert (
        owner_client.get("/api/v1/designs/6c1a2f2e-0000-4000-8000-000000000000/share-links/").status_code
        == 404
    )


def test_creating_for_trashed_design_is_400(owner_client, list_url, design):
    from django.utils import timezone

    design.trashed_at = timezone.now()
    design.save()
    response = owner_client.post(list_url, {"role": "view"}, format="json")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "design_trashed"


def test_active_link_limit(owner_client, list_url, make_link):
    for _ in range(MAX_ACTIVE_LINKS_PER_DESIGN):
        make_link("view")
    response = owner_client.post(list_url, {"role": "view"}, format="json")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "share_link_limit"


def test_expired_and_disabled_links_do_not_count_towards_the_limit(owner_client, list_url, make_link):
    for _ in range(MAX_ACTIVE_LINKS_PER_DESIGN - 1):
        make_link("view")
    make_link("view", expires_at=past())
    make_link("view", is_active=False)
    assert owner_client.post(list_url, {"role": "view"}, format="json").status_code == 201


@pytest.mark.parametrize("revive", [{"is_active": True}, {"expires_at": "future"}])
def test_reviving_a_link_counts_towards_the_limit(owner_client, design, make_link, revive):
    for _ in range(MAX_ACTIVE_LINKS_PER_DESIGN):
        make_link("view")
    dormant = (
        make_link("view", is_active=False) if "is_active" in revive else make_link("view", expires_at=past())
    )
    body = {"expires_at": future(5).isoformat()} if "expires_at" in revive else revive
    response = owner_client.patch(detail_url(design, dormant), body, format="json")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "share_link_limit"
    dormant.refresh_from_db()
    assert (dormant.is_active, dormant.is_expired()) != (True, False)  # nothing was saved


def test_an_active_link_can_still_be_changed_at_the_limit(owner_client, design, make_link):
    links = [make_link("view") for _ in range(MAX_ACTIVE_LINKS_PER_DESIGN)]
    response = owner_client.patch(detail_url(design, links[0]), {"role": "edit"}, format="json")
    assert response.status_code == 200


def test_patch_changes_role_and_expiry(owner_client, design, view_link):
    response = owner_client.patch(
        detail_url(design, view_link), {"role": "edit", "expires_at": future(5).isoformat()}, format="json"
    )
    assert response.status_code == 200
    view_link.refresh_from_db()
    assert view_link.role == "edit"
    assert view_link.expires_at is not None


def test_patch_can_disable_and_reenable(owner_client, design, view_link):
    url = detail_url(design, view_link)
    assert owner_client.patch(url, {"is_active": False}, format="json").json()["is_active"] is False
    assert owner_client.patch(url, {"is_active": True}, format="json").json()["is_active"] is True


def test_patch_sets_changes_and_removes_password(owner_client, design, make_link):
    link = make_link("view", password="first pass")
    url = detail_url(design, link)
    assert owner_client.patch(url, {"password": "second pass"}, format="json").json()["has_password"] is True
    link.refresh_from_db()
    assert link.check_password("second pass") and not link.check_password("first pass")
    assert owner_client.patch(url, {"password": None}, format="json").json()["has_password"] is False
    link.refresh_from_db()
    assert not link.has_password


def test_patch_without_password_key_keeps_it(owner_client, design, make_link):
    link = make_link("view", password="keep me")
    owner_client.patch(detail_url(design, link), {"role": "comment"}, format="json")
    link.refresh_from_db()
    assert link.check_password("keep me")


def test_patch_cannot_change_token_or_design(owner_client, design, view_link):
    token = view_link.token
    owner_client.patch(detail_url(design, view_link), {"token": "x" * 32, "access_count": 5}, format="json")
    view_link.refresh_from_db()
    assert view_link.token == token and view_link.access_count == 0


def test_patch_keeps_an_already_expired_date_untouched(owner_client, design, make_link):
    link = make_link("view", expires_at=past())
    response = owner_client.patch(
        detail_url(design, link),
        {"expires_at": link.expires_at.isoformat(), "role": "comment"},
        format="json",
    )
    assert response.status_code == 200


def test_delete_revokes_link(owner_client, design, view_link, anon):
    assert anon.get(f"/api/v1/shared/{view_link.token}/").status_code == 200
    assert owner_client.delete(detail_url(design, view_link)).status_code == 204
    assert not ShareLink.objects.filter(pk=view_link.pk).exists()
    assert anon.get(f"/api/v1/shared/{view_link.token}/").status_code == 404


def test_detail_get(owner_client, design, view_link):
    assert owner_client.get(detail_url(design, view_link)).json()["token"] == view_link.token


def test_link_of_another_design_is_not_reachable(owner_client, owner, design, view_link):
    from apps.designs.models import Design

    other = Design.objects.create(owner=owner, title="Other")
    assert owner_client.get(detail_url(other, view_link)).status_code == 404


def test_csrf_is_enforced_for_session_users(owner, list_url):
    client = APIClient(enforce_csrf_checks=True)
    client.force_login(owner)
    response = client.post(list_url, {"role": "view"}, format="json")
    assert response.status_code in (401, 403)
    assert not ShareLink.objects.exists()
