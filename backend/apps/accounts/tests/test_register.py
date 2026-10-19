from __future__ import annotations

from unittest import mock

import pytest
from django.core import mail
from django.db import IntegrityError

from apps.accounts.models import User

from .conftest import ME, PASSWORD, REGISTER, login_as

pytestmark = pytest.mark.django_db

USER_KEYS = {
    "id",
    "email",
    "display_name",
    "name",
    "avatar_url",
    "is_email_verified",
    "has_password",
    "google_linked",
    "created_at",
}


def register(client, **overrides):
    payload = {"email": "ada@example.com", "password": PASSWORD, "display_name": "Ada Lovelace", **overrides}
    return client.post(REGISTER, payload, format="json")


def test_register_creates_user_and_logs_in(client):
    res = register(client)
    assert res.status_code == 201
    user = res.json()["user"]
    assert set(user) == USER_KEYS
    assert user["email"] == "ada@example.com"
    assert user["display_name"] == "Ada Lovelace"
    assert user["name"] == "Ada Lovelace"
    assert user["has_password"] is True
    assert user["google_linked"] is False
    assert user["is_email_verified"] is False
    assert user["avatar_url"] is None
    assert client.get(ME).json()["user"]["id"] == user["id"]
    assert "sessionid" in res.cookies


def test_register_never_leaks_secrets(client):
    body = register(client).content.decode()
    assert "password" not in body.replace("has_password", "")
    assert "pbkdf2" not in body and "md5$" not in body


def test_register_stores_hashed_password(client):
    register(client)
    stored = User.objects.get(email="ada@example.com")
    assert stored.password != PASSWORD
    assert stored.check_password(PASSWORD)


def test_register_normalises_email(client):
    res = register(client, email="  Ada.Lovelace@Example.COM ")
    assert res.status_code == 201
    assert res.json()["user"]["email"] == "ada.lovelace@example.com"
    assert User.objects.get().email == "ada.lovelace@example.com"


def test_register_without_display_name_falls_back_to_email_prefix(client):
    res = client.post(REGISTER, {"email": "grace@example.com", "password": PASSWORD}, format="json")
    assert res.status_code == 201
    assert res.json()["user"]["display_name"] == ""
    assert res.json()["user"]["name"] == "grace"


def test_register_cleans_display_name(client):
    res = register(client, display_name="  Ada \n\t  Lovelace\x07 ")
    assert res.json()["user"]["display_name"] == "Ada Lovelace"


@pytest.mark.parametrize(
    ("overrides", "field", "code"),
    [
        ({"email": ""}, "email", "blank"),
        ({"email": "not-an-email"}, "email", "invalid"),
        ({"email": "a" * 250 + "@example.com"}, "email", "max_length"),
        ({"password": ""}, "password", "blank"),
        ({"password": "short1!"}, "password", "password_too_short"),
        ({"password": "password"}, "password", "password_too_common"),
        ({"password": "1234567890123"}, "password", "password_entirely_numeric"),
        ({"password": "ada@example.com"}, "password", "password_too_similar"),
        ({"password": "x" * 129}, "password", "max_length"),
        ({"display_name": "n" * 81}, "display_name", "max_length"),
        ({"display_name": "nul\x00l"}, "display_name", "null_characters_not_allowed"),
    ],
)
def test_register_validation_matrix(client, overrides, field, code):
    res = register(client, **overrides)
    assert res.status_code == 400
    error = res.json()["error"]
    assert error["code"] == "validation_error"
    assert field in error["fields"]
    assert code in error["field_codes"][field]
    assert not User.objects.exists()


@pytest.mark.parametrize("missing", ["email", "password"])
def test_register_requires_email_and_password(client, missing):
    payload = {"email": "ada@example.com", "password": PASSWORD}
    del payload[missing]
    res = client.post(REGISTER, payload, format="json")
    assert res.status_code == 400
    assert res.json()["error"]["field_codes"][missing] == ["required"]


def test_register_duplicate_email_is_case_insensitive(client, make_user):
    make_user("Ada@Example.com")
    res = register(client, email="ADA@example.COM")
    assert res.status_code == 400
    assert res.json()["error"]["field_codes"]["email"] == ["email_taken"]
    assert User.objects.count() == 1


def test_register_race_on_unique_email_is_reported_as_taken(client):
    with mock.patch.object(User.objects, "create_user", side_effect=IntegrityError):
        res = register(client)
    assert res.status_code == 400
    assert res.json()["error"]["field_codes"]["email"] == ["email_taken"]


def test_register_ignores_privileged_fields(client):
    res = register(client, is_staff=True, is_superuser=True, is_email_verified=True, google_sub="x", id="1")
    assert res.status_code == 201
    stored = User.objects.get()
    assert (stored.is_staff, stored.is_superuser, stored.is_email_verified, stored.google_sub) == (
        False,
        False,
        False,
        None,
    )


def test_register_accepts_form_encoding(client):
    res = client.post(REGISTER, {"email": "form@example.com", "password": PASSWORD})
    assert res.status_code == 201


def test_register_rejects_malformed_json(client):
    res = client.post(REGISTER, "{nope", content_type="application/json")
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "parse_error"


def test_register_sends_one_verification_email(client):
    register(client)
    assert len(mail.outbox) == 1
    message = mail.outbox[0]
    assert message.to == ["ada@example.com"]
    assert "Verify" in message.subject


def test_register_survives_a_mail_outage(client):
    with mock.patch("django.core.mail.EmailMultiAlternatives.send", side_effect=OSError("smtp down")):
        res = register(client)
    assert res.status_code == 201
    assert User.objects.filter(email="ada@example.com").exists()


def test_register_while_signed_in_switches_session(client, make_user):
    make_user("first@example.com")
    first = login_as("first@example.com")
    res = register(first, email="second@example.com")
    assert res.status_code == 201
    assert first.get(ME).json()["user"]["email"] == "second@example.com"


def test_registered_user_can_log_in_again(client):
    register(client)
    other = login_as("ada@example.com")
    assert other.get(ME).json()["user"]["email"] == "ada@example.com"
