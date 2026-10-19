"""Every unsafe auth endpoint must reject requests without a valid CSRF token — anonymous ones included."""

from __future__ import annotations

import pytest

from .conftest import (
    CSRF,
    EMAIL_RESEND,
    EMAIL_VERIFY,
    GOOGLE,
    LOGIN,
    LOGOUT,
    ME,
    PASSWORD,
    PASSWORD_CHANGE,
    PASSWORD_RESET,
    PASSWORD_RESET_CONFIRM,
    REGISTER,
)

pytestmark = pytest.mark.django_db

ANONYMOUS_POSTS = [
    (REGISTER, {"email": "new@example.com", "password": PASSWORD}),
    (LOGIN, {"email": "ada@example.com", "password": PASSWORD}),
    (PASSWORD_RESET, {"email": "ada@example.com"}),
    (PASSWORD_RESET_CONFIRM, {"uid": "x", "token": "y", "new_password": PASSWORD}),
    (EMAIL_VERIFY, {"uid": "x", "token": "y"}),
    (GOOGLE, {"credential": "x"}),
]

AUTHENTICATED_UNSAFE = [
    ("post", LOGOUT, None),
    ("post", PASSWORD_CHANGE, {"old_password": PASSWORD, "new_password": "granite-lantern-meadow-82"}),
    ("post", EMAIL_RESEND, None),
    ("patch", ME, {"display_name": "Mallory"}),
    ("delete", ME, {"password": PASSWORD}),
]


def csrf_headers(client) -> dict[str, str]:
    assert client.get(CSRF).status_code == 204
    return {"HTTP_X_CSRFTOKEN": client.cookies["csrftoken"].value}


def test_csrf_endpoint_sets_cookie(client):
    res = client.get(CSRF)
    assert res.status_code == 204
    assert res.content == b""
    assert len(res.cookies["csrftoken"].value) >= 32
    assert res.cookies["csrftoken"]["samesite"] == "Lax"
    assert not res.cookies["csrftoken"]["httponly"]  # the SPA must be able to read it


@pytest.mark.parametrize(("url", "payload"), ANONYMOUS_POSTS)
def test_anonymous_post_without_token_is_rejected(csrf_client, user, url, payload):
    res = csrf_client.post(url, payload, format="json")
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "csrf_failed"


@pytest.mark.parametrize(("url", "payload"), ANONYMOUS_POSTS)
def test_anonymous_post_with_wrong_token_is_rejected(csrf_client, user, url, payload):
    csrf_client.get(CSRF)
    res = csrf_client.post(url, payload, format="json", HTTP_X_CSRFTOKEN="not-the-token")
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "csrf_failed"


def test_login_works_with_a_valid_token(csrf_client, user):
    headers = csrf_headers(csrf_client)
    res = csrf_client.post(LOGIN, {"email": user.email, "password": PASSWORD}, format="json", **headers)
    assert res.status_code == 200


def test_register_works_with_a_valid_token(csrf_client):
    headers = csrf_headers(csrf_client)
    res = csrf_client.post(
        REGISTER, {"email": "new@example.com", "password": PASSWORD}, format="json", **headers
    )
    assert res.status_code == 201


def test_token_is_rotated_on_login(csrf_client, user):
    headers = csrf_headers(csrf_client)
    before = csrf_client.cookies["csrftoken"].value
    res = csrf_client.post(LOGIN, {"email": user.email, "password": PASSWORD}, format="json", **headers)
    assert res.cookies["csrftoken"].value != before


@pytest.mark.parametrize(("method", "url", "payload"), AUTHENTICATED_UNSAFE)
def test_authenticated_unsafe_requests_need_the_token(csrf_client, user, method, url, payload):
    csrf_client.force_login(user)
    res = getattr(csrf_client, method)(url, payload, format="json")
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "csrf_failed"
    user.refresh_from_db()
    assert user.is_active and user.display_name == ""


def test_authenticated_request_with_token_passes(csrf_client, user):
    csrf_client.force_login(user)
    headers = csrf_headers(csrf_client)
    assert csrf_client.patch(ME, {"display_name": "Ada"}, format="json", **headers).status_code == 200


@pytest.mark.parametrize("url", [ME, CSRF])
def test_safe_methods_never_need_a_token(csrf_client, url):
    assert csrf_client.get(url).status_code in (200, 204)
