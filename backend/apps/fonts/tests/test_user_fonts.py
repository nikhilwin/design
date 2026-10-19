import re
from pathlib import Path

import pytest
from django.core.files.storage import default_storage
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.fonts import uploads
from apps.fonts.models import FontFamily, FontVariant

from .factories import make_family
from .fontfiles import CYRILLIC, LATIN, make_font

pytestmark = pytest.mark.django_db

MINE = "/api/v1/fonts/mine/"


def upload(*fonts, name="font.ttf", **fields):
    files = [
        item
        if isinstance(item, SimpleUploadedFile)
        else SimpleUploadedFile(name, item, content_type="font/ttf")
        for item in fonts
    ]
    return {"files": files, **fields}


def post(client, *fonts, **fields):
    return client.post(MINE, upload(*fonts, **fields), format="multipart")


def stored_files() -> set[str]:
    root = Path(default_storage.location) / "fonts" / "user"
    return {str(p) for p in root.rglob("*") if p.is_file()} if root.exists() else set()


def test_endpoints_require_authentication(client):
    family = make_family()
    assert client.get(MINE).status_code == 401
    assert client.post(MINE, {}, format="multipart").status_code == 401
    assert client.delete(f"{MINE}{family.id}/").status_code == 401


def test_upload_a_valid_ttf_creates_a_user_family(auth_client, user):
    response = post(auth_client, make_font("Brand Sans", weight=700, chars=LATIN + CYRILLIC))

    assert response.status_code == 201, response.json()
    body = response.json()
    assert (body["family"], body["is_user_font"], body["is_variable"], body["popularity"]) == (
        "Brand Sans",
        True,
        False,
        9999,
    )
    assert body["category"] == "sans-serif" and body["scripts"] == ["cyrillic", "latin"]
    assert [(v["weight"], v["style"]) for v in body["variants"]] == [(700, "normal")]
    row = FontFamily.objects.get(pk=body["id"])
    assert row.owner == user and row.source == "upload" and row.license == "user-supplied"
    variant = row.variants.get()
    assert re.fullmatch(rf"fonts/user/{user.id}/[0-9a-f-]{{36}}\.ttf", variant.file.name)
    assert variant.format == "ttf" and variant.size == len(
        make_font("Brand Sans", weight=700, chars=LATIN + CYRILLIC)
    )
    assert body["variants"][0]["url"] == f"/media/{variant.file.name}"


@pytest.mark.parametrize(
    ("kwargs", "ext", "fmt"),
    [
        ({}, "ttf", "ttf"),
        ({"outlines": "cff"}, "otf", "otf"),
        ({"flavor": "woff"}, "woff", "woff"),
        ({"flavor": "woff2"}, "woff2", "woff2"),
    ],
)
def test_all_four_formats_are_accepted_and_stored_with_their_real_extension(auth_client, kwargs, ext, fmt):
    response = post(auth_client, make_font(**kwargs), name="whatever.bin")
    assert response.status_code == 201, response.json()
    variant = FontVariant.objects.get()
    assert variant.format == fmt and variant.file.name.endswith(f".{ext}")


def test_the_file_name_and_mime_type_are_ignored(auth_client):
    sneaky = SimpleUploadedFile("evil.html", make_font(), content_type="text/html")
    assert post(auth_client, sneaky).status_code == 201
    assert FontVariant.objects.get().file.name.endswith(".ttf")


@pytest.mark.parametrize(
    "payload",
    [
        b"definitely not a font",
        b"\x00\x01\x00\x00" + b"junk" * 50,
        b"wOF2" + b"\x00" * 100,
        b"OTTO",
        b"<svg onload=alert(1)>",
    ],
)
def test_garbage_is_rejected_even_with_a_font_extension(auth_client, payload):
    response = post(auth_client, payload, name="font.ttf")
    assert response.status_code == 400
    assert (
        response.json()["error"]["code"] == "validation_error"
        and "files" in response.json()["error"]["fields"]
    )
    assert not FontFamily.objects.exists() and not stored_files()


def test_truncated_real_font_is_rejected(auth_client):
    assert post(auth_client, make_font()[:200]).status_code == 400


def test_font_collections_are_rejected_with_a_clear_message(auth_client):
    response = post(auth_client, b"ttcf\x00\x01\x00\x00" + b"\x00" * 64)
    assert response.status_code == 400 and "collection" in str(response.json()).lower()


def test_font_without_a_family_name_is_rejected(auth_client):
    response = post(auth_client, make_font(family=None))
    assert response.status_code == 400 and "name" in str(response.json()["error"]["fields"]["files"]).lower()


def test_font_without_outlines_is_rejected(auth_client):
    assert post(auth_client, make_font(outlines="none")).status_code == 400


def test_empty_upload_and_missing_files_are_rejected(auth_client):
    assert post(auth_client, b"").status_code == 400
    response = auth_client.post(MINE, {}, format="multipart")
    assert response.status_code == 400 and "files" in response.json()["error"]["fields"]


def test_oversized_files_are_rejected(auth_client, monkeypatch):
    monkeypatch.setattr(uploads, "MAX_FILE_BYTES", 1000)
    response = post(auth_client, make_font(chars=LATIN + CYRILLIC))
    assert response.status_code == 400 and "10 MB" in str(response.json())
    assert not FontFamily.objects.exists()


def test_more_than_five_files_are_rejected(auth_client):
    fonts = [make_font(weight=100 * (i + 1)) for i in range(6)]
    assert post(auth_client, *fonts).status_code == 400
    assert not FontFamily.objects.exists()


def test_a_family_can_be_uploaded_in_one_request(auth_client):
    response = post(
        auth_client,
        make_font("Brand", weight=400),
        make_font("Brand", weight=700),
        make_font("Brand", weight=400, italic=True),
    )
    assert response.status_code == 201
    assert [(v["weight"], v["style"]) for v in response.json()["variants"]] == [
        (400, "normal"),
        (400, "italic"),
        (700, "normal"),
    ]
    assert FontFamily.objects.count() == 1 and FontVariant.objects.count() == 3


def test_files_from_different_families_need_an_explicit_family_name(auth_client):
    response = post(auth_client, make_font("One"), make_font("Two", weight=700))
    assert response.status_code == 400 and "different families" in str(response.json())
    ok = post(auth_client, make_font("One"), make_font("Two", weight=700), family="Combined")
    assert ok.status_code == 201 and ok.json()["family"] == "Combined"


def test_duplicate_weight_and_style_in_one_upload_is_rejected(auth_client):
    assert post(auth_client, make_font("Brand"), make_font("Brand")).status_code == 400
    assert not FontFamily.objects.exists()


def test_adding_files_to_an_existing_family_and_conflicts(auth_client, user):
    post(auth_client, make_font("Brand", weight=400))
    added = post(auth_client, make_font("Brand", weight=700))
    assert added.status_code == 201 and len(added.json()["variants"]) == 2
    assert FontFamily.objects.filter(owner=user).count() == 1

    before = stored_files()
    clash = post(auth_client, make_font("Brand", weight=700))
    assert clash.status_code == 409 and clash.json()["error"]["code"] == "variant_exists"
    assert stored_files() == before and FontVariant.objects.count() == 2


def test_a_name_that_matches_a_builtin_font_is_refused_unless_renamed(auth_client):
    make_family("Roboto")
    clash = post(auth_client, make_font("roboto"))
    assert clash.status_code == 409 and clash.json()["error"]["code"] == "font_name_taken"
    renamed = post(auth_client, make_font("roboto"), family="My Roboto")
    assert renamed.status_code == 201 and renamed.json()["family"] == "My Roboto"


def test_family_name_is_sanitised_before_it_can_reach_css_or_html(auth_client):
    response = post(auth_client, make_font('Evil"; } body { x: <script>alert(1)</script>'))
    assert response.status_code == 201
    name = response.json()["family"]
    assert not any(ch in name for ch in "\"'<>;{}\\/")
    assert name.startswith("Evil")


def test_family_override_is_sanitised_and_must_not_be_empty(auth_client):
    assert post(auth_client, make_font(), family='<>"').status_code == 400
    ok = post(auth_client, make_font(), family="  Fancy   <b>Name</b> ")
    assert ok.json()["family"] == "Fancy bNameb"


def test_category_defaults_from_the_font_and_can_be_overridden(auth_client):
    mono = post(auth_client, make_font("Typewriter", fixed_pitch=True))
    assert mono.json()["category"] == "monospace"
    forced = post(auth_client, make_font("Other"), category="handwriting")
    assert forced.json()["category"] == "handwriting"
    assert post(auth_client, make_font("Third"), category="comic").status_code == 400


def test_family_cap_per_user(auth_client, monkeypatch):
    monkeypatch.setattr(uploads, "MAX_FAMILIES_PER_USER", 2)
    assert post(auth_client, make_font("One")).status_code == 201
    assert post(auth_client, make_font("Two")).status_code == 201
    limited = post(auth_client, make_font("Three"))
    assert limited.status_code == 403 and limited.json()["error"]["code"] == "font_limit_reached"
    assert post(auth_client, make_font("One", weight=700)).status_code == 201  # extending a family is fine


def test_storage_cap_per_user(auth_client, monkeypatch):
    size = len(make_font("One"))
    monkeypatch.setattr(uploads, "MAX_BYTES_PER_USER", size + 10)
    assert post(auth_client, make_font("One")).status_code == 201
    over = post(auth_client, make_font("Two"))
    assert over.status_code == 403 and over.json()["error"]["code"] == "font_storage_limit"


def test_a_failure_while_storing_leaves_no_files_or_rows(auth_client, monkeypatch):
    original = FontVariant.save
    calls = []

    def flaky(self, *args, **kwargs):
        calls.append(1)
        if len(calls) == 2:
            raise RuntimeError("disk on fire")
        return original(self, *args, **kwargs)

    monkeypatch.setattr(FontVariant, "save", flaky)
    auth_client.raise_request_exception = False
    response = post(auth_client, make_font("Brand", weight=400), make_font("Brand", weight=700))

    assert response.status_code == 500
    assert not FontFamily.objects.exists() and not FontVariant.objects.exists() and not stored_files()


def test_list_shows_only_my_fonts(auth_client, user):
    other = User.objects.create_user(email="other@example.com", password="pw-12345-abc")
    make_family("Mine", owner=user, slug="mine")
    make_family("Theirs", owner=other, slug="theirs")
    make_family("System")

    response = auth_client.get(MINE)
    assert response.status_code == 200
    assert [row["family"] for row in response.data["results"]] == ["Mine"]
    assert response.data["results"][0]["is_user_font"] is True


def test_two_users_may_use_the_same_family_name(auth_client):
    other = APIClient()
    other.force_authenticate(User.objects.create_user(email="other@example.com", password="pw-12345-abc"))
    assert post(auth_client, make_font("Shared Name")).status_code == 201
    assert post(other, make_font("Shared Name")).status_code == 201
    assert FontFamily.objects.count() == 2


def test_user_fonts_never_appear_in_the_public_list(auth_client, client):
    post(auth_client, make_font("Secret Brand Font"))
    assert client.get("/api/v1/fonts/").data["count"] == 0


def test_delete_removes_the_family_and_its_files(auth_client):
    body = post(auth_client, make_font("Brand", weight=400), make_font("Brand", weight=700)).json()
    assert len(stored_files()) == 2

    response = auth_client.delete(f"{MINE}{body['id']}/")

    assert response.status_code == 204
    assert not FontFamily.objects.exists() and not stored_files()


def test_other_users_fonts_cannot_be_deleted_or_discovered(auth_client):
    other = User.objects.create_user(email="other@example.com", password="pw-12345-abc")
    theirs = make_family("Theirs", owner=other, slug="theirs")
    system = make_family("System")

    assert auth_client.delete(f"{MINE}{theirs.id}/").status_code == 404
    assert auth_client.delete(f"{MINE}{system.id}/").status_code == 404
    assert auth_client.delete(f"{MINE}00000000-0000-0000-0000-000000000000/").status_code == 404
    assert FontFamily.objects.count() == 2


def test_upload_is_rate_limited(auth_client, monkeypatch):
    from apps.fonts.views import FontUploadThrottle

    monkeypatch.setattr(FontUploadThrottle, "THROTTLE_RATES", {"upload": "2/min"})
    statuses = [post(auth_client, make_font(f"Font {i}")).status_code for i in range(3)]
    assert statuses == [201, 201, 429]
    assert auth_client.get(MINE).status_code == 200  # reads are not throttled by the upload scope


def test_deleting_a_family_whose_file_is_already_gone_does_not_fail(auth_client):
    post(auth_client, make_font("Brand"))
    variant = FontVariant.objects.get()
    variant.file.storage.delete(variant.file.name)

    variant.family.delete()

    assert not FontFamily.objects.exists()
