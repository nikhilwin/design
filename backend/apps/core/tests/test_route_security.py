"""Whole-API checks that do not belong to one app: CSRF on every unsafe route, and the object-level
authorization matrix across apps."""

from __future__ import annotations

import json
import uuid

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from drf_spectacular.generators import SchemaGenerator
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.assets.models import Asset
from apps.assets.tests.helpers import image_bytes
from apps.brand.models import BrandKit
from apps.designs.models import Design, DesignVersion, Folder
from apps.designs.tests.helpers import make_design
from apps.sharing.models import Comment, ShareLink

pytestmark = pytest.mark.django_db

PASSWORD = "plum-umbrella-ripple-47"
UNSAFE = ("post", "put", "patch", "delete")


def api_routes() -> list[tuple[str, str]]:
    """(method, path template) of every operation in the OpenAPI schema, i.e. of every route of the API."""
    schema = SchemaGenerator().get_schema(request=None, public=True)
    return [
        (method.upper(), path)
        for path, operations in schema["paths"].items()
        for method in operations
        if method in (*UNSAFE, "get")
    ]


def concrete(path: str) -> str:
    """Fill the `{placeholders}` of a path with well-formed values that name nothing."""
    out = path
    for name in ("token",):
        out = out.replace("{" + name + "}", "x" * 32)
    while "{" in out:
        start = out.index("{")
        out = out[:start] + str(uuid.uuid4()) + out[out.index("}") + 1 :]
    return out


def test_the_walk_finds_the_routes_it_is_meant_to_check():
    routes = api_routes()
    assert len(routes) > 50 and ("DELETE", "/api/v1/designs/trash/") in routes
    assert ("POST", "/api/v1/exports/pdf/") in routes and ("PATCH", "/api/v1/shared/{token}/") in routes


def test_every_unsafe_route_refuses_a_signed_in_browser_without_a_csrf_token():
    user = User.objects.create_user("csrf-walker@example.com", PASSWORD)
    browser = APIClient(enforce_csrf_checks=True)
    browser.force_login(user)
    leaks = []
    for method, template in api_routes():
        if method == "GET":
            continue
        response = browser.generic(method, concrete(template), "{}", content_type="application/json")
        body = response.json() if response["Content-Type"].startswith("application/json") else {}
        if (response.status_code, body.get("error", {}).get("code")) != (403, "csrf_failed"):
            leaks.append((method, template, response.status_code))
    assert leaks == []


def test_no_unsafe_route_works_for_an_anonymous_caller_without_a_token():
    anonymous = APIClient(enforce_csrf_checks=True)
    worked = []
    for method, template in api_routes():
        if method == "GET":
            continue
        response = anonymous.generic(method, concrete(template), "{}", content_type="application/json")
        if response.status_code < 400 or response.status_code >= 500:
            worked.append((method, template, response.status_code))
    assert worked == []


@pytest.fixture
def world(db):
    """Alice owns one of everything; Bob is somebody else."""
    alice = User.objects.create_user("alice-matrix@example.com", PASSWORD, display_name="Alice")
    bob = User.objects.create_user("bob-matrix@example.com", PASSWORD, display_name="Bob")
    design = make_design(alice, "Alice's design")
    owner_api = APIClient()
    owner_api.force_authenticate(alice)
    asset = owner_api.post(
        "/api/v1/assets/",
        {"file": SimpleUploadedFile("a.png", image_bytes(), content_type="image/png")},
        format="multipart",
    ).json()
    kit = BrandKit.objects.create(owner=alice, name="Kit")
    folder = Folder.objects.create(owner=alice, name="Folder")
    version = DesignVersion.objects.create(design=design, label="v", document=design.document)
    link = ShareLink.objects.create(design=design, role="edit", created_by=alice)
    comment = Comment.objects.create(design=design, author=alice, body="hello")
    return {
        "alice": alice,
        "bob": bob,
        "design": design,
        "asset": Asset.objects.get(pk=asset["id"]),
        "kit": kit,
        "folder": folder,
        "version": version,
        "link": link,
        "comment": comment,
    }


def owner_scoped(world) -> list[tuple[str, str, dict | None]]:
    d, v, link, c = world["design"].pk, world["version"].pk, world["link"].pk, world["comment"].pk
    base = "/api/v1"
    return [
        ("GET", f"{base}/designs/{d}/", None),
        ("PATCH", f"{base}/designs/{d}/", {"title": "taken"}),
        ("DELETE", f"{base}/designs/{d}/", None),
        ("POST", f"{base}/designs/{d}/restore/", None),
        ("POST", f"{base}/designs/{d}/duplicate/", None),
        ("GET", f"{base}/designs/{d}/versions/", None),
        ("POST", f"{base}/designs/{d}/versions/", {"label": "x"}),
        ("GET", f"{base}/designs/{d}/versions/{v}/", None),
        ("POST", f"{base}/designs/{d}/versions/{v}/restore/", None),
        ("GET", f"{base}/designs/{d}/share-links/", None),
        ("POST", f"{base}/designs/{d}/share-links/", {"role": "edit"}),
        ("GET", f"{base}/designs/{d}/share-links/{link}/", None),
        ("PATCH", f"{base}/designs/{d}/share-links/{link}/", {"is_active": False}),
        ("DELETE", f"{base}/designs/{d}/share-links/{link}/", None),
        ("GET", f"{base}/designs/{d}/comments/", None),
        ("POST", f"{base}/designs/{d}/comments/", {"body": "mine now"}),
        ("PATCH", f"{base}/designs/{d}/comments/{c}/", {"resolved": True}),
        ("DELETE", f"{base}/designs/{d}/comments/{c}/", None),
        ("GET", f"{base}/assets/{world['asset'].pk}/", None),
        ("PATCH", f"{base}/assets/{world['asset'].pk}/", {"name": "x", "tags": []}),
        ("DELETE", f"{base}/assets/{world['asset'].pk}/", None),
        ("GET", f"{base}/brand-kits/{world['kit'].pk}/", None),
        ("PATCH", f"{base}/brand-kits/{world['kit'].pk}/", {"name": "x"}),
        ("DELETE", f"{base}/brand-kits/{world['kit'].pk}/", None),
        ("GET", f"{base}/folders/{world['folder'].pk}/", None),
        ("PATCH", f"{base}/folders/{world['folder'].pk}/", {"name": "x"}),
        ("DELETE", f"{base}/folders/{world['folder'].pk}/", None),
    ]


def test_somebody_else_gets_a_404_for_every_owner_scoped_object(world):
    bob = APIClient()
    bob.force_authenticate(world["bob"])
    answers = {
        (method, path): bob.generic(
            method,
            path,
            "" if body is None else json.dumps(body),
            content_type="application/json",
        ).status_code
        for method, path, body in owner_scoped(world)
    }
    assert {key: code for key, code in answers.items() if code != 404} == {}
    assert Design.objects.get(pk=world["design"].pk).trashed_at is None
    assert Design.objects.get(pk=world["design"].pk).title == "Alice's design"
    assert (
        Asset.objects.filter(pk=world["asset"].pk).exists()
        and BrandKit.objects.filter(pk=world["kit"].pk).exists()
    )
    assert ShareLink.objects.get(pk=world["link"].pk).is_active
    assert Comment.objects.filter(pk=world["comment"].pk, resolved=False).exists()


def test_an_anonymous_caller_gets_401_for_every_owner_scoped_object(world):
    anonymous = APIClient()
    answers = {
        (method, path): anonymous.generic(
            method,
            path,
            "" if body is None else json.dumps(body),
            content_type="application/json",
        ).status_code
        for method, path, body in owner_scoped(world)
    }
    assert {key: code for key, code in answers.items() if code != 401} == {}


def test_bulk_and_trash_only_touch_the_callers_own_designs(world):
    bob = APIClient()
    bob.force_authenticate(world["bob"])
    response = bob.post(
        "/api/v1/designs/bulk/", {"ids": [str(world["design"].pk)], "action": "trash"}, format="json"
    )
    assert response.status_code == 200 and response.json() == {"affected": 0}
    assert bob.delete("/api/v1/designs/trash/").status_code == 204
    assert Design.objects.filter(pk=world["design"].pk, trashed_at__isnull=True).exists()


def test_brand_kit_logos_must_be_the_callers_own_assets(world):
    bob = APIClient()
    bob.force_authenticate(world["bob"])
    response = bob.post(
        "/api/v1/brand-kits/", {"name": "Theft", "logo_ids": [str(world["asset"].pk)]}, format="json"
    )
    assert response.status_code == 400 and "logo_ids" in response.json()["error"]["fields"]


def test_a_folder_of_somebody_else_cannot_be_used_for_a_design(world):
    bob = APIClient()
    bob.force_authenticate(world["bob"])
    response = bob.post("/api/v1/designs/", {"title": "x", "folder": str(world["folder"].pk)}, format="json")
    assert response.status_code == 400


def test_staff_only_endpoints_refuse_ordinary_users(world):
    bob = APIClient()
    bob.force_authenticate(world["bob"])
    assert bob.get("/api/v1/collab/stats/").status_code == 403
    assert APIClient().get("/api/v1/collab/stats/").status_code == 401
