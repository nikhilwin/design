from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from django.contrib.auth.tokens import PasswordResetTokenGenerator
from django.core import mail

from apps.accounts.models import User
from apps.accounts.tokens import email_verification_token_generator, encode_uid

from .conftest import (
    LOGIN,
    ME,
    NEW_PASSWORD,
    PASSWORD,
    PASSWORD_CHANGE,
    PASSWORD_RESET,
    PASSWORD_RESET_CONFIRM,
    last_email_params,
    login_as,
)

pytestmark = pytest.mark.django_db


def can_log_in(email: str, password: str) -> bool:
    from rest_framework.test import APIClient

    res = APIClient().post(LOGIN, {"email": email, "password": password}, format="json")
    return res.status_code == 200


# --- change ---------------------------------------------------------------------------------------


def test_change_password(auth_client, user):
    res = auth_client.post(
        PASSWORD_CHANGE, {"old_password": PASSWORD, "new_password": NEW_PASSWORD}, format="json"
    )
    assert res.status_code == 204
    assert can_log_in(user.email, NEW_PASSWORD)
    assert not can_log_in(user.email, PASSWORD)


def test_change_password_keeps_this_session_and_drops_the_others(auth_client, user):
    other_device = login_as(user.email)
    assert other_device.get(ME).json()["user"] is not None
    auth_client.post(PASSWORD_CHANGE, {"old_password": PASSWORD, "new_password": NEW_PASSWORD}, format="json")
    assert auth_client.get(ME).json()["user"]["email"] == user.email
    assert other_device.get(ME).json() == {"user": None}


@pytest.mark.parametrize("old", ["wrong-password-99", "", None])
def test_change_password_needs_the_current_password(auth_client, user, old):
    payload = {"new_password": NEW_PASSWORD}
    if old is not None:
        payload["old_password"] = old
    res = auth_client.post(PASSWORD_CHANGE, payload, format="json")
    assert res.status_code == 400
    assert res.json()["error"]["field_codes"]["old_password"] == ["invalid_password"]
    assert can_log_in(user.email, PASSWORD)


@pytest.mark.parametrize(
    ("new_password", "code"),
    [
        ("short1!", "password_too_short"),
        ("password", "password_too_common"),
        ("98765432101234", "password_entirely_numeric"),
        ("ada@example.com", "password_too_similar"),
    ],
)
def test_change_password_runs_the_validators(auth_client, user, new_password, code):
    res = auth_client.post(
        PASSWORD_CHANGE, {"old_password": PASSWORD, "new_password": new_password}, format="json"
    )
    assert res.status_code == 400
    assert code in res.json()["error"]["field_codes"]["new_password"]
    assert can_log_in(user.email, PASSWORD)


def test_password_less_account_can_set_a_first_password(client, make_user):
    google_user = make_user("g@example.com", None, google_sub="sub-1")
    client.force_login(google_user)
    res = client.post(PASSWORD_CHANGE, {"new_password": NEW_PASSWORD}, format="json")
    assert res.status_code == 204
    google_user.refresh_from_db()
    assert google_user.has_usable_password()
    assert client.get(ME).json()["user"]["has_password"] is True
    assert can_log_in("g@example.com", NEW_PASSWORD)


def test_change_password_requires_login(client):
    res = client.post(
        PASSWORD_CHANGE, {"old_password": PASSWORD, "new_password": NEW_PASSWORD}, format="json"
    )
    assert res.status_code == 401


def test_wrong_old_passwords_lock_the_account(auth_client, user):
    for _ in range(10):
        auth_client.post(
            PASSWORD_CHANGE,
            {"old_password": "wrong-password-99", "new_password": NEW_PASSWORD},
            format="json",
        )
    res = auth_client.post(
        PASSWORD_CHANGE, {"old_password": PASSWORD, "new_password": NEW_PASSWORD}, format="json"
    )
    assert res.status_code == 429
    assert can_log_in(user.email, PASSWORD) is False  # locked for login too: one shared counter


# --- reset request --------------------------------------------------------------------------------


def test_reset_request_emails_a_link(client, user, settings):
    settings.SITE_URL = "https://doory.example.org/"
    res = client.post(PASSWORD_RESET, {"email": "ada@example.com"}, format="json")
    assert res.status_code == 204
    assert res.content == b""
    assert len(mail.outbox) == 1
    message = mail.outbox[0]
    assert message.to == ["ada@example.com"]
    assert message.body.count("https://doory.example.org/reset-password?uid=") == 1
    params = last_email_params()
    assert params["uid"] == encode_uid(user)
    assert params["token"]


def test_reset_request_does_not_reveal_unknown_emails(client, user):
    known = client.post(PASSWORD_RESET, {"email": "ada@example.com"}, format="json")
    mail.outbox.clear()
    unknown = client.post(PASSWORD_RESET, {"email": "nobody@example.com"}, format="json")
    assert known.status_code == unknown.status_code == 204
    assert known.content == unknown.content == b""
    assert dict(known.headers).keys() == dict(unknown.headers).keys()
    assert mail.outbox == []


def test_reset_request_ignores_inactive_accounts(client, user):
    user.is_active = False
    user.save()
    assert client.post(PASSWORD_RESET, {"email": user.email}, format="json").status_code == 204
    assert mail.outbox == []


def test_reset_request_is_case_insensitive(client, user):
    client.post(PASSWORD_RESET, {"email": "ADA@Example.COM"}, format="json")
    assert len(mail.outbox) == 1


def test_reset_request_is_rate_limited_per_address(client, user):
    for _ in range(3):
        assert client.post(PASSWORD_RESET, {"email": user.email}, format="json").status_code == 204
    assert len(mail.outbox) == 1


def test_reset_request_validates_the_email_format(client):
    res = client.post(PASSWORD_RESET, {"email": "nope"}, format="json")
    assert res.status_code == 400


def test_google_only_accounts_can_use_reset_to_set_a_password(client, make_user):
    google_user = make_user("g@example.com", None, google_sub="sub-1", is_email_verified=True)
    client.post(PASSWORD_RESET, {"email": google_user.email}, format="json")
    res = client.post(
        PASSWORD_RESET_CONFIRM, {**last_email_params(), "new_password": NEW_PASSWORD}, format="json"
    )
    assert res.status_code == 204
    assert can_log_in("g@example.com", NEW_PASSWORD)


# --- reset confirm --------------------------------------------------------------------------------


def request_reset(client, email="ada@example.com") -> dict[str, str]:
    client.post(PASSWORD_RESET, {"email": email}, format="json")
    return last_email_params()


def confirm(client, params, new_password=NEW_PASSWORD):
    return client.post(PASSWORD_RESET_CONFIRM, {**params, "new_password": new_password}, format="json")


def test_full_reset_flow(client, user):
    params = request_reset(client)
    assert confirm(client, params).status_code == 204
    assert can_log_in(user.email, NEW_PASSWORD)
    assert not can_log_in(user.email, PASSWORD)


def test_reset_token_works_once(client, user):
    params = request_reset(client)
    assert confirm(client, params).status_code == 204
    again = confirm(client, params, "another-secret-phrase-31")
    assert again.status_code == 400
    assert again.json()["error"]["code"] == "invalid_token"
    assert can_log_in(user.email, NEW_PASSWORD)


def test_reset_token_expires_after_a_day(client, user, monkeypatch):
    params = request_reset(client)
    monkeypatch.setattr(
        PasswordResetTokenGenerator, "_now", lambda self: datetime.now() + timedelta(days=1, minutes=1)
    )
    res = confirm(client, params)
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "invalid_token"
    assert can_log_in(user.email, PASSWORD)


def test_reset_token_is_valid_just_inside_its_lifetime(client, user, monkeypatch):
    params = request_reset(client)
    monkeypatch.setattr(
        PasswordResetTokenGenerator, "_now", lambda self: datetime.now() + timedelta(hours=23)
    )
    assert confirm(client, params).status_code == 204


def test_reset_confirm_invalidates_every_existing_session(client, user):
    device = login_as(user.email)
    confirm(client, request_reset(client))
    assert device.get(ME).json() == {"user": None}


def test_reset_confirm_does_not_log_the_caller_in(client, user):
    confirm(client, request_reset(client))
    assert client.get(ME).json() == {"user": None}


def test_reset_confirm_marks_the_email_verified(client, user):
    assert user.is_email_verified is False
    confirm(client, request_reset(client))
    user.refresh_from_db()
    assert user.is_email_verified is True


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: {**p, "token": "bad-token"},
        lambda p: {**p, "token": p["token"][:-1] + ("a" if p["token"][-1] != "a" else "b")},
        lambda p: {**p, "uid": "!!!"},
        lambda p: {**p, "uid": "MDAwMDAwMDAtMDAwMC0wMDAwLTAwMDAtMDAwMDAwMDAwMDAw"},
        lambda p: {**p, "uid": ""},
    ],
    ids=["garbage-token", "tampered-token", "garbage-uid", "unknown-user", "empty-uid"],
)
def test_reset_confirm_rejects_bad_links_uniformly(client, user, mutate):
    params = mutate(request_reset(client))
    res = confirm(client, params)
    assert res.status_code == 400
    assert res.json()["error"]["code"] in {"invalid_token", "validation_error"}
    if res.json()["error"]["code"] == "invalid_token":
        assert res.json()["error"]["message"] == "This link is invalid or has expired."
    assert can_log_in(user.email, PASSWORD)


def test_a_token_for_another_user_is_rejected(client, user, make_user):
    other = make_user("grace@example.com")
    params = request_reset(client)
    res = confirm(client, {"uid": encode_uid(other), "token": params["token"]})
    assert res.status_code == 400
    assert can_log_in(other.email, PASSWORD)


def test_verification_tokens_are_not_reset_tokens(client, user):
    token = email_verification_token_generator.make_token(user)
    res = confirm(client, {"uid": encode_uid(user), "token": token})
    assert res.status_code == 400
    assert can_log_in(user.email, PASSWORD)


def test_reset_confirm_validates_the_new_password_and_keeps_the_link_alive(client, user):
    params = request_reset(client)
    weak = confirm(client, params, "password")
    assert weak.status_code == 400
    assert "password_too_common" in weak.json()["error"]["field_codes"]["new_password"]
    assert confirm(client, params).status_code == 204


def test_inactive_users_cannot_complete_a_reset(client, user):
    params = request_reset(client)
    user.is_active = False
    user.save()
    assert confirm(client, params).status_code == 400
    assert User.objects.get(pk=user.pk).check_password(PASSWORD)


def test_reset_token_dies_when_the_user_logs_in_afterwards(client, user):
    params = request_reset(client)
    login_as(user.email)
    assert confirm(client, params).status_code == 400
