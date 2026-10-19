from __future__ import annotations

import os
from io import BytesIO

import pytest
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.core.files.uploadedfile import SimpleUploadedFile
from PIL import Image

from apps.accounts.models import User

from .conftest import ME, PASSWORD, login_as, png_upload

pytestmark = pytest.mark.django_db


def stored_image(user: User) -> Image.Image:
    with default_storage.open(user.avatar.name) as handle:
        image = Image.open(BytesIO(handle.read()))
        image.load()
    return image


# --- GET ------------------------------------------------------------------------------------------


def test_anonymous_me_is_null_not_401(client):
    res = client.get(ME)
    assert res.status_code == 200
    assert res.json() == {"user": None}


def test_me_returns_the_profile(auth_client, user):
    body = auth_client.get(ME).json()["user"]
    assert body["id"] == str(user.id)
    assert body["has_password"] is True
    assert body["google_linked"] is False
    assert body["name"] == "ada"
    assert body["created_at"].endswith("Z")


def test_me_for_google_only_account(client, make_user):
    google_user = make_user("g@example.com", None, google_sub="sub-1", is_email_verified=True)
    client.force_login(google_user)
    body = client.get(ME).json()["user"]
    assert (body["has_password"], body["google_linked"], body["is_email_verified"]) == (False, True, True)


# --- PATCH display_name ---------------------------------------------------------------------------


def test_patch_display_name(auth_client, user):
    res = auth_client.patch(ME, {"display_name": "  Ada   Lovelace "}, format="json")
    assert res.status_code == 200
    assert res.json()["user"]["display_name"] == "Ada Lovelace"
    user.refresh_from_db()
    assert user.display_name == "Ada Lovelace"


def test_patch_display_name_can_be_cleared(auth_client, user):
    user.display_name = "Ada"
    user.save()
    res = auth_client.patch(ME, {"display_name": ""}, format="json")
    assert res.status_code == 200
    assert res.json()["user"]["name"] == "ada"


def test_patch_display_name_too_long(auth_client):
    res = auth_client.patch(ME, {"display_name": "n" * 81}, format="json")
    assert res.status_code == 400
    assert res.json()["error"]["field_codes"]["display_name"] == ["max_length"]


def test_patch_cannot_change_protected_fields(auth_client, user):
    res = auth_client.patch(
        ME,
        {
            "email": "evil@example.com",
            "is_staff": True,
            "is_superuser": True,
            "is_email_verified": True,
            "google_sub": "x",
        },
        format="json",
    )
    assert res.status_code == 200
    user.refresh_from_db()
    assert user.email == "ada@example.com"
    assert (user.is_staff, user.is_superuser, user.is_email_verified, user.google_sub) == (
        False,
        False,
        False,
        None,
    )


def test_patch_requires_login(client):
    res = client.patch(ME, {"display_name": "x"}, format="json")
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "not_authenticated"


def test_patch_with_nothing_is_a_noop(auth_client):
    assert auth_client.patch(ME, {}, format="json").status_code == 200


# --- PATCH avatar ---------------------------------------------------------------------------------


def test_avatar_upload_is_cropped_to_512_square_webp(auth_client, user):
    res = auth_client.patch(ME, {"avatar": png_upload((300, 100))}, format="multipart")
    assert res.status_code == 200
    url = res.json()["user"]["avatar_url"]
    assert url.startswith("/media/avatars/") and url.endswith(".webp")
    user.refresh_from_db()
    image = stored_image(user)
    assert image.format == "WEBP"
    assert image.size == (512, 512)


def test_avatar_upload_keeps_transparency(auth_client, user):
    auth_client.patch(ME, {"avatar": png_upload((64, 64), mode="RGBA")}, format="multipart")
    user.refresh_from_db()
    assert "A" in stored_image(user).getbands()


def test_avatar_upload_with_display_name_in_one_request(auth_client, user):
    res = auth_client.patch(ME, {"display_name": "Ada", "avatar": png_upload((10, 10))}, format="multipart")
    assert res.status_code == 200
    body = res.json()["user"]
    assert body["display_name"] == "Ada" and body["avatar_url"]


def test_replacing_an_avatar_deletes_the_old_file(auth_client, user, django_capture_on_commit_callbacks):
    with django_capture_on_commit_callbacks(execute=True):
        auth_client.patch(ME, {"avatar": png_upload()}, format="multipart")
    user.refresh_from_db()
    first = user.avatar.name
    assert default_storage.exists(first)
    with django_capture_on_commit_callbacks(execute=True):
        auth_client.patch(ME, {"avatar": png_upload((50, 80))}, format="multipart")
    user.refresh_from_db()
    assert user.avatar.name != first
    assert default_storage.exists(user.avatar.name)
    assert not default_storage.exists(first)


def test_remove_avatar(auth_client, user, django_capture_on_commit_callbacks):
    with django_capture_on_commit_callbacks(execute=True):
        auth_client.patch(ME, {"avatar": png_upload()}, format="multipart")
    user.refresh_from_db()
    name = user.avatar.name
    with django_capture_on_commit_callbacks(execute=True):
        res = auth_client.patch(ME, {"remove_avatar": True}, format="json")
    assert res.json()["user"]["avatar_url"] is None
    assert not default_storage.exists(name)


def test_avatar_filename_never_comes_from_the_client(auth_client, user):
    auth_client.patch(ME, {"avatar": png_upload(name="../../etc/passwd.png")}, format="multipart")
    user.refresh_from_db()
    assert os.path.dirname(user.avatar.name) == "avatars"
    assert "passwd" not in user.avatar.name


@pytest.mark.parametrize(
    "upload",
    [
        SimpleUploadedFile("a.png", b"this is not an image", content_type="image/png"),
        SimpleUploadedFile("a.png", b"\x89PNG\r\n\x1a\ntruncated", content_type="image/png"),
        SimpleUploadedFile("a.png", b"<svg xmlns='http://www.w3.org/2000/svg'/>", content_type="image/png"),
        SimpleUploadedFile("a.png", b"GIF89a", content_type="image/gif"),
    ],
    ids=["text", "truncated-png", "svg-with-png-name", "bare-gif-header"],
)
def test_avatar_rejects_non_images(auth_client, user, upload):
    res = auth_client.patch(ME, {"avatar": upload}, format="multipart")
    assert res.status_code == 400
    assert res.json()["error"]["field_codes"]["avatar"] == ["invalid_image"]
    user.refresh_from_db()
    assert not user.avatar


def test_avatar_rejects_empty_file(auth_client):
    res = auth_client.patch(ME, {"avatar": SimpleUploadedFile("a.png", b"")}, format="multipart")
    assert res.status_code == 400
    assert "avatar" in res.json()["error"]["fields"]


def test_avatar_rejects_oversize_files(auth_client, user, settings):
    settings.MAX_AVATAR_BYTES = 500
    res = auth_client.patch(ME, {"avatar": png_upload((200, 200))}, format="multipart")
    assert res.status_code == 400
    assert res.json()["error"]["fields"]["avatar"] == ["The file is too large."]
    user.refresh_from_db()
    assert not user.avatar


def test_avatar_rejects_images_with_too_many_pixels(auth_client, user, monkeypatch):
    monkeypatch.setattr("apps.accounts.services.AVATAR_MAX_PIXELS", 1_000)
    res = auth_client.patch(ME, {"avatar": png_upload((100, 100))}, format="multipart")
    assert res.status_code == 400
    assert res.json()["error"]["fields"]["avatar"] == ["The image dimensions are too large."]


def test_avatar_limit_is_five_megabytes_by_default(settings):
    assert settings.MAX_AVATAR_BYTES == 5 * 1024 * 1024


def test_avatar_as_plain_json_value_is_rejected(auth_client):
    res = auth_client.patch(ME, {"avatar": "http://169.254.169.254/latest"}, format="json")
    assert res.status_code == 400


def test_animated_gif_avatar_becomes_a_still_webp(auth_client, user):
    buf = BytesIO()
    frames = [Image.new("RGB", (40, 40), color) for color in ((255, 0, 0), (0, 0, 255))]
    frames[0].save(buf, "GIF", save_all=True, append_images=frames[1:], duration=50, loop=0)
    upload = SimpleUploadedFile("a.gif", buf.getvalue(), content_type="image/gif")
    assert auth_client.patch(ME, {"avatar": upload}, format="multipart").status_code == 200
    user.refresh_from_db()
    image = stored_image(user)
    assert image.format == "WEBP" and image.size == (512, 512) and getattr(image, "n_frames", 1) == 1


# --- DELETE ---------------------------------------------------------------------------------------


def test_delete_account_with_password(auth_client, user):
    res = auth_client.delete(ME, {"password": PASSWORD}, format="json")
    assert res.status_code == 204
    assert not User.objects.filter(pk=user.pk).exists()
    assert auth_client.get(ME).json() == {"user": None}


def test_delete_cascades_to_owned_data(auth_client, user):
    from apps.designs.models import Design, Folder

    folder = Folder.objects.create(owner=user, name="Work")
    Design.objects.create(owner=user, title="Poster", folder=folder)
    other = User.objects.create_user("other@example.com", PASSWORD)
    Design.objects.create(owner=other, title="Keep me")
    assert auth_client.delete(ME, {"password": PASSWORD}, format="json").status_code == 204
    assert list(Design.objects.values_list("title", flat=True)) == ["Keep me"]
    assert not Folder.objects.exists()


def test_delete_removes_the_avatar_file(auth_client, user, django_capture_on_commit_callbacks):
    with django_capture_on_commit_callbacks(execute=True):
        auth_client.patch(ME, {"avatar": png_upload()}, format="multipart")
    user.refresh_from_db()
    name = user.avatar.name
    assert default_storage.exists(name)
    with django_capture_on_commit_callbacks(execute=True):
        assert auth_client.delete(ME, {"password": PASSWORD}, format="json").status_code == 204
    assert not default_storage.exists(name)


@pytest.mark.parametrize("body", [{"password": "wrong-password-99"}, {}, {"password": ""}])
def test_delete_requires_the_current_password(auth_client, user, body):
    res = auth_client.delete(ME, body, format="json")
    assert res.status_code == 400
    assert res.json()["error"]["field_codes"]["password"] == ["invalid_password"]
    assert User.objects.filter(pk=user.pk).exists()
    assert auth_client.get(ME).json()["user"] is not None


def test_failed_delete_attempts_count_towards_the_lockout(auth_client, user):
    for _ in range(10):
        auth_client.delete(ME, {"password": "wrong-password-99"}, format="json")
    res = auth_client.delete(ME, {"password": PASSWORD}, format="json")
    assert res.status_code == 429
    assert User.objects.filter(pk=user.pk).exists()


def test_delete_requires_login(client):
    assert client.delete(ME, {"password": PASSWORD}, format="json").status_code == 401


def test_google_only_account_confirms_with_its_email(client, make_user):
    google_user = make_user("g@example.com", None, google_sub="sub-1")
    client.force_login(google_user)
    bad = client.delete(ME, {"confirm_email": "someone@else.com"}, format="json")
    assert bad.status_code == 400
    assert bad.json()["error"]["field_codes"]["confirm_email"] == ["confirm_email_mismatch"]
    assert client.delete(ME, {"password": "anything"}, format="json").status_code == 400
    ok = client.delete(ME, {"confirm_email": " G@Example.com "}, format="json")
    assert ok.status_code == 204
    assert not User.objects.filter(email="g@example.com").exists()


def test_last_superuser_cannot_delete_themselves(client, make_user):
    admin = make_user("root@example.com", is_superuser=True, is_staff=True)
    client.force_login(admin)
    res = client.delete(ME, {"password": PASSWORD}, format="json")
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "last_superuser"
    assert User.objects.filter(pk=admin.pk).exists()


def test_superuser_can_delete_themselves_when_another_exists(make_user):
    make_user("root@example.com", is_superuser=True, is_staff=True)
    make_user("root2@example.com", is_superuser=True, is_staff=True)
    assert login_as("root@example.com").delete(ME, {"password": PASSWORD}, format="json").status_code == 204


def test_delete_does_not_touch_other_users(auth_client, user, make_user):
    make_user("keep@example.com")
    auth_client.delete(ME, {"password": PASSWORD}, format="json")
    assert User.objects.filter(email="keep@example.com").exists()


def test_stray_file_in_storage_does_not_break_delete(auth_client, user):
    user.avatar.save("orphan.webp", ContentFile(b"x"), save=True)
    default_storage.delete(user.avatar.name)  # the file is already gone
    assert auth_client.delete(ME, {"password": PASSWORD}, format="json").status_code == 204
