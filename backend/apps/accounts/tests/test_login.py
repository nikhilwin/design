from __future__ import annotations

import time
import types

import pytest
from django.core.cache import cache
from rest_framework.throttling import SimpleRateThrottle

from apps.accounts import lockout

from .conftest import (
    GOOGLE,
    LOGIN,
    LOGOUT,
    ME,
    PASSWORD,
    PASSWORD_RESET,
    REGISTER,
    login_as,
)

pytestmark = pytest.mark.django_db


def attempt(client, email="ada@example.com", password=PASSWORD):
    return client.post(LOGIN, {"email": email, "password": password}, format="json")


def test_login_success(client, user):
    res = attempt(client)
    assert res.status_code == 200
    assert res.json()["user"]["email"] == "ada@example.com"
    assert client.get(ME).json()["user"]["id"] == str(user.id)
    user.refresh_from_db()
    assert user.last_login is not None


def test_login_is_case_insensitive_and_trims(client, user):
    assert attempt(client, email="  ADA@Example.com ").status_code == 200


def test_login_rotates_the_session_key(client, user):
    session = client.session
    session["anonymous"] = "seed"
    session.save()
    before = client.session.session_key
    assert attempt(client).status_code == 200
    assert client.session.session_key != before


def test_login_failure_is_generic_for_unknown_email_and_wrong_password(client, user):
    wrong_password = attempt(client, password="not-the-password-1")
    unknown_email = attempt(client, email="nobody@example.com")
    assert wrong_password.status_code == unknown_email.status_code == 400
    assert wrong_password.json() == unknown_email.json()
    assert wrong_password.json()["error"]["code"] == "invalid_credentials"
    assert client.get(ME).json()["user"] is None


def test_inactive_user_cannot_log_in_and_gets_the_generic_error(client, user):
    user.is_active = False
    user.save()
    res = attempt(client)
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "invalid_credentials"


def test_deactivating_a_user_ends_their_existing_session(auth_client, user):
    user.is_active = False
    user.save()
    assert auth_client.get(ME).json()["user"] is None


def test_login_validates_input(client):
    res = client.post(LOGIN, {"email": "bad", "password": ""}, format="json")
    assert res.status_code == 400
    assert set(res.json()["error"]["fields"]) == {"email", "password"}


def test_login_rejects_get(client):
    assert client.get(LOGIN).status_code == 405
    assert client.get(LOGIN).json()["error"]["code"] == "method_not_allowed"


def test_logout_flushes_the_session(auth_client):
    assert auth_client.post(LOGOUT).status_code == 204
    assert auth_client.get(ME).json() == {"user": None}


def test_logout_requires_login(client):
    res = client.post(LOGOUT)
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "not_authenticated"


def test_old_session_cookie_is_dead_after_logout(auth_client, user):
    stolen = auth_client.cookies["sessionid"].value
    auth_client.post(LOGOUT)
    from rest_framework.test import APIClient

    replay = APIClient()
    replay.cookies["sessionid"] = stolen
    assert replay.get(ME).json() == {"user": None}


# --- per-account lockout -------------------------------------------------------------------------


def test_account_locks_after_ten_failures_even_for_the_right_password(client, user):
    for _ in range(10):
        assert attempt(client, password="wrong-guess-1234").status_code == 400
    res = attempt(client)
    assert res.status_code == 429
    error = res.json()["error"]
    assert error["code"] == "throttled"
    assert 1 <= error["retry_after"] <= 15 * 60
    assert int(res["Retry-After"]) == error["retry_after"]
    assert client.get(ME).json()["user"] is None


def test_lockout_is_per_account(client, user, make_user):
    make_user("grace@example.com")
    for _ in range(10):
        attempt(client, password="wrong-guess-1234")
    assert attempt(client).status_code == 429
    assert attempt(client, email="grace@example.com").status_code == 200


def test_lockout_also_covers_unknown_emails(client):
    for _ in range(10):
        attempt(client, email="ghost@example.com", password="whatever-1234")
    assert attempt(client, email="ghost@example.com").status_code == 429


def test_nine_failures_then_success_resets_the_counter(client, user):
    for _ in range(9):
        attempt(client, password="wrong-guess-1234")
    assert attempt(client).status_code == 200
    for _ in range(9):
        assert attempt(client, password="wrong-guess-1234").status_code == 400
    assert attempt(client).status_code == 200


def test_lockout_ends_when_the_window_passes(client, user, monkeypatch):
    for _ in range(10):
        attempt(client, password="wrong-guess-1234")
    assert attempt(client).status_code == 429
    later = time.time() + 16 * 60
    monkeypatch.setattr(lockout, "time", types.SimpleNamespace(time=lambda: later))
    assert attempt(client).status_code == 200


def test_lockout_limits_come_from_settings(client, user, settings):
    settings.AUTH_LOCKOUT_MAX_ATTEMPTS = 2
    attempt(client, password="wrong-guess-1234")
    attempt(client, password="wrong-guess-1234")
    assert attempt(client).status_code == 429


def test_lockout_never_stores_the_raw_email(client, user):
    attempt(client, email="Ada@Example.com", password="wrong-guess-1234")
    keys = [str(key) for key in cache._cache]
    assert any("auth:failures" in key for key in keys)
    assert not any("ada" in key.lower() or "example" in key.lower() for key in keys)


def test_lockout_key_ignores_case_and_whitespace():
    assert lockout.email_fingerprint(" Ada@Example.com", "lockout") == lockout.email_fingerprint(
        "ada@example.com", "lockout"
    )
    assert lockout.email_fingerprint("ada@example.com", "lockout") != lockout.email_fingerprint(
        "ada@example.com", "reset"
    )


def test_password_reset_clears_a_lockout(client, user):
    from django.core import mail

    from .conftest import PASSWORD_RESET_CONFIRM, last_email_params

    for _ in range(10):
        attempt(client, password="wrong-guess-1234")
    assert attempt(client).status_code == 429
    client.post(PASSWORD_RESET, {"email": user.email}, format="json")
    assert len(mail.outbox) == 1
    new_password = "orchid-copper-valley-63"
    res = client.post(
        PASSWORD_RESET_CONFIRM, {**last_email_params(), "new_password": new_password}, format="json"
    )
    assert res.status_code == 204
    assert attempt(client, password=new_password).status_code == 200


# --- per-IP throttling ---------------------------------------------------------------------------


@pytest.fixture
def tight_auth_throttle(monkeypatch):
    monkeypatch.setattr(
        SimpleRateThrottle,
        "THROTTLE_RATES",
        {"auth": "3/min", "anon": "1000/min", "user": "1000/min", "upload": "1000/min"},
    )


@pytest.mark.parametrize(
    ("url", "payload"),
    [
        (LOGIN, {"email": "x@example.com", "password": "wrong-guess-1234"}),
        (REGISTER, {"email": "bad", "password": "x"}),
        (PASSWORD_RESET, {"email": "x@example.com"}),
        (GOOGLE, {"credential": "abc"}),
    ],
)
def test_auth_endpoints_are_throttled_per_ip(client, tight_auth_throttle, url, payload):
    for _ in range(3):
        assert client.post(url, payload, format="json").status_code != 429
    res = client.post(url, payload, format="json")
    assert res.status_code == 429
    assert res.json()["error"]["code"] == "throttled"
    assert res.json()["error"]["retry_after"] >= 1


def test_throttle_buckets_are_per_client_address(client, tight_auth_throttle):
    payload = {"email": "x@example.com", "password": "wrong-guess-1234"}
    for _ in range(4):
        client.post(LOGIN, payload, format="json", REMOTE_ADDR="198.51.100.1")
    assert client.post(LOGIN, payload, format="json", REMOTE_ADDR="198.51.100.1").status_code == 429
    assert client.post(LOGIN, payload, format="json", REMOTE_ADDR="198.51.100.2").status_code == 400


def test_other_users_sessions_are_independent(user, make_user):
    make_user("grace@example.com")
    first, second = login_as(user.email), login_as("grace@example.com")
    assert first.get(ME).json()["user"]["email"] == "ada@example.com"
    assert second.get(ME).json()["user"]["email"] == "grace@example.com"
