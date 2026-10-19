from __future__ import annotations

import pytest
from django.contrib.auth import authenticate
from django.urls import reverse

from apps.accounts.lockout import PasswordAttemptGuard

from .conftest import PASSWORD

pytestmark = pytest.mark.django_db

WRONG = "wrong-guess-1234"


def test_authenticate_returns_the_user_for_valid_credentials(user):
    assert authenticate(username=user.email, password=PASSWORD) == user
    assert authenticate(email=user.email, password=PASSWORD) == user


@pytest.mark.parametrize(
    ("username", "password"), [(None, PASSWORD), ("", PASSWORD), ("a@example.com", None)]
)
def test_authenticate_ignores_incomplete_credentials(user, username, password):
    assert authenticate(username=username, password=password) is None


def test_failures_are_counted_and_success_resets(user, settings):
    settings.AUTH_LOCKOUT_MAX_ATTEMPTS = 3
    for _ in range(2):
        assert authenticate(username=user.email, password=WRONG) is None
    assert authenticate(username=user.email, password=PASSWORD) == user
    for _ in range(2):
        authenticate(username=user.email, password=WRONG)
    assert authenticate(username=user.email, password=PASSWORD) == user


def test_a_locked_account_refuses_even_the_right_password(user, settings):
    settings.AUTH_LOCKOUT_MAX_ATTEMPTS = 3
    for _ in range(3):
        authenticate(username=user.email, password=WRONG)
    assert authenticate(username=user.email, password=PASSWORD) is None
    PasswordAttemptGuard(user.email).reset()
    assert authenticate(username=user.email, password=PASSWORD) == user


def test_unknown_accounts_are_counted_too(db, settings):
    settings.AUTH_LOCKOUT_MAX_ATTEMPTS = 2
    for _ in range(2):
        authenticate(username="ghost@example.com", password=WRONG)
    with pytest.raises(Exception, match="Too many"):
        PasswordAttemptGuard("ghost@example.com").check()


def test_the_admin_login_is_locked_after_repeated_failures(client, make_user):
    make_user("root@example.com", is_staff=True, is_superuser=True)
    url = reverse("admin:login")
    for _ in range(10):
        assert client.post(url, {"username": "root@example.com", "password": WRONG}).status_code == 200
    res = client.post(url, {"username": "root@example.com", "password": PASSWORD})
    assert res.status_code == 200  # the login form again, not a redirect into the admin
    assert "_auth_user_id" not in client.session


def test_force_login_still_works_with_the_guarded_backend(client, user):
    client.force_login(user)
    assert client.get("/api/v1/auth/me/").json()["user"]["email"] == user.email
