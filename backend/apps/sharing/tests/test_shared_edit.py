import json

import pytest
from django.test import override_settings
from rest_framework.test import APIClient

from apps.designs.models import Design

from .conftest import PASSWORD, make_document

HEADER = "HTTP_X_SHARE_PASSWORD"


def shared_url(link):
    return f"/api/v1/shared/{link.token}/"


def save(client, link, document, base_revision=1, **extra):
    return client.patch(
        shared_url(link), {"document": document, "base_revision": base_revision}, format="json", **extra
    )


def test_edit_link_saves_and_bumps_revision(stranger_client, edit_link, design):
    document = make_document(pages=3, width=1200, height=900)
    response = save(stranger_client, edit_link, document)
    assert response.status_code == 200
    assert response.json()["revision"] == 2
    design.refresh_from_db()
    assert design.revision == 2
    assert design.document == document
    assert (design.width, design.height, design.page_count) == (1200, 900, 3)


def test_saved_document_is_visible_to_viewers(stranger_client, anon, edit_link):
    save(stranger_client, edit_link, make_document(pages=2))
    body = anon.get(shared_url(edit_link)).json()
    assert body["revision"] == 2
    assert len(body["document"]["pages"]) == 2


def test_stale_revision_conflicts(stranger_client, edit_link, design):
    assert save(stranger_client, edit_link, make_document(pages=2), base_revision=1).status_code == 200
    stale = save(stranger_client, edit_link, make_document(pages=5), base_revision=1)
    assert stale.status_code == 409
    body = stale.json()
    assert body["error"]["code"] == "revision_conflict"
    assert body["current"]["revision"] == 2
    assert "updated_at" in body["current"]
    design.refresh_from_db()
    assert design.page_count == 2 and design.revision == 2


def test_future_revision_conflicts_too(stranger_client, edit_link):
    assert save(stranger_client, edit_link, make_document(), base_revision=7).status_code == 409


def test_sequential_saves_keep_incrementing(stranger_client, edit_link, design):
    for expected in (2, 3, 4):
        assert (
            save(stranger_client, edit_link, make_document(), base_revision=expected - 1).json()["revision"]
            == expected
        )
    design.refresh_from_db()
    assert design.revision == 4


@pytest.mark.parametrize("role", ["view", "comment"])
def test_read_only_links_cannot_save(stranger_client, make_link, design, role):
    link = make_link(role)
    response = save(stranger_client, link, make_document(pages=4))
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "share_role_insufficient"
    design.refresh_from_db()
    assert design.revision == 1 and design.page_count == 1


def test_anonymous_cannot_save(anon, edit_link, design):
    assert save(anon, edit_link, make_document(pages=2)).status_code == 401
    design.refresh_from_db()
    assert design.revision == 1


def test_unknown_token_is_404_for_logged_in_users(stranger_client):
    class Dummy:
        token = "z" * 32

    assert save(stranger_client, Dummy, make_document()).status_code == 404


def test_expired_edit_link_cannot_save(stranger_client, make_link):
    from .conftest import past

    assert save(stranger_client, make_link("edit", expires_at=past()), make_document()).status_code == 404


def test_password_protected_edit_link(stranger_client, make_link, design):
    link = make_link("edit", password=PASSWORD)
    assert save(stranger_client, link, make_document(pages=2)).status_code == 401
    assert save(stranger_client, link, make_document(pages=2), **{HEADER: "wrong"}).status_code == 401
    assert save(stranger_client, link, make_document(pages=2), **{HEADER: PASSWORD}).status_code == 200


def test_owner_can_save_through_their_own_edit_link(owner_client, edit_link):
    assert save(owner_client, edit_link, make_document()).status_code == 200


def test_trashed_design_cannot_be_saved(stranger_client, edit_link, design):
    from django.utils import timezone

    design.trashed_at = timezone.now()
    design.save()
    assert save(stranger_client, edit_link, make_document()).status_code == 404


def test_csrf_is_enforced(stranger, edit_link, design):
    client = APIClient(enforce_csrf_checks=True)
    client.force_login(stranger)
    assert save(client, edit_link, make_document(pages=2)).status_code in (401, 403)
    design.refresh_from_db()
    assert design.revision == 1


@pytest.mark.parametrize(
    "document",
    [
        "a string",
        [],
        {},
        {"schemaVersion": 2, "width": 10, "height": 10, "pages": [{"id": "a", "objects": []}]},
        {"schemaVersion": True, "width": 10, "height": 10, "pages": [{"id": "a", "objects": []}]},
        {"schemaVersion": 1, "width": 0, "height": 10, "pages": [{"id": "a", "objects": []}]},
        {"schemaVersion": 1, "width": 10, "height": 20001, "pages": [{"id": "a", "objects": []}]},
        {"schemaVersion": 1, "width": 10.5, "height": 10, "pages": [{"id": "a", "objects": []}]},
        {"schemaVersion": 1, "width": 10, "height": 10, "pages": []},
        {"schemaVersion": 1, "width": 10, "height": 10, "pages": "nope"},
        {"schemaVersion": 1, "width": 10, "height": 10, "pages": [{"objects": []}]},
        {"schemaVersion": 1, "width": 10, "height": 10, "pages": [{"id": "a", "objects": "x"}]},
        {"schemaVersion": 1, "width": 10, "height": 10, "pages": [5]},
    ],
)
def test_malformed_documents_are_rejected(stranger_client, edit_link, design, document):
    response = save(stranger_client, edit_link, document)
    assert response.status_code == 400
    design.refresh_from_db()
    assert design.revision == 1


def test_too_many_pages_are_rejected(stranger_client, edit_link):
    response = save(stranger_client, edit_link, make_document(pages=101))
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_document"


@pytest.mark.parametrize("source", ["blob:https://example.test/1234", "idb://abc", "  BLOB:x"])
def test_local_only_image_sources_are_rejected(stranger_client, edit_link, source):
    document = make_document()
    document["pages"][0]["objects"] = [{"id": "o1", "type": "image", "src": source}]
    response = save(stranger_client, edit_link, document)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "inline_asset_not_allowed"


def test_oversized_inline_data_urls_are_rejected(stranger_client, edit_link):
    document = make_document()
    document["pages"][0]["objects"] = [
        {"id": "o1", "type": "image", "src": "data:image/png;base64," + "A" * 70_000}
    ]
    assert save(stranger_client, edit_link, document).json()["error"]["code"] == "inline_asset_not_allowed"


def test_small_inline_data_urls_are_allowed(stranger_client, edit_link):
    document = make_document()
    document["pages"][0]["objects"] = [{"id": "o1", "type": "image", "src": "data:image/png;base64,AAAA"}]
    assert save(stranger_client, edit_link, document).status_code == 200


def test_deeply_nested_documents_are_rejected(stranger_client, edit_link):
    node: dict = {"id": "leaf", "type": "rect"}
    for _ in range(80):
        node = {"id": "g", "type": "group", "objects": [node]}
    document = make_document()
    document["pages"][0]["objects"] = [node]
    assert save(stranger_client, edit_link, document).status_code == 400


def test_recursion_bomb_does_not_crash_the_server(stranger_client, edit_link):
    body = '{"base_revision": 1, "document": ' + "[" * 20000 + "]" * 20000 + "}"
    response = stranger_client.patch(shared_url(edit_link), body, content_type="application/json")
    assert response.status_code == 400


@override_settings(MAX_DESIGN_DOCUMENT_BYTES=2000)
def test_document_size_limit(stranger_client, edit_link):
    document = make_document()
    document["pages"][0]["objects"] = [{"id": "o", "type": "textbox", "text": "x" * 3000}]
    response = save(stranger_client, edit_link, document)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "document_too_large"


@override_settings(MAX_DESIGN_DOCUMENT_BYTES=2000)
def test_gigantic_bodies_are_refused_before_parsing(stranger_client, edit_link):
    payload = json.dumps({"base_revision": 1, "document": {"pad": "x" * 100_000}})
    response = stranger_client.patch(shared_url(edit_link), payload, content_type="application/json")
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"


def test_base_revision_is_required(stranger_client, edit_link):
    response = stranger_client.patch(shared_url(edit_link), {"document": make_document()}, format="json")
    assert response.status_code == 400
    assert "base_revision" in response.json()["error"]["fields"]


@pytest.mark.parametrize("revision", [0, -1, "abc", None, 1.5])
def test_base_revision_must_be_a_positive_integer(stranger_client, edit_link, revision):
    response = save(stranger_client, edit_link, make_document(), base_revision=revision)
    assert response.status_code == 400


def test_other_design_fields_cannot_be_changed(stranger_client, edit_link, design, owner):
    stranger_client.patch(
        shared_url(edit_link),
        {"document": make_document(), "base_revision": 1, "title": "Hacked", "owner": "x", "folder": None},
        format="json",
    )
    design.refresh_from_db()
    assert design.title == "Summer poster" and design.owner == owner


def test_failed_saves_leave_other_designs_alone(stranger_client, edit_link, owner):
    other = Design.objects.create(owner=owner, title="Other", document=make_document())
    save(stranger_client, edit_link, make_document(pages=3))
    other.refresh_from_db()
    assert other.revision == 1 and other.page_count == 1
