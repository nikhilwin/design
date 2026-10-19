from __future__ import annotations

from unittest import mock

import pytest
from django.db import IntegrityError
from google.auth.exceptions import GoogleAuthError, TransportError

from apps.accounts import google, services
from apps.accounts.google import GoogleIdentity, GoogleSignInError
from apps.accounts.models import User

from .conftest import GOOGLE, ME, PASSWORD, REGISTER

pytestmark = pytest.mark.django_db

VERIFY = "apps.accounts.views.verify_google_credential"


def identity(**overrides) -> GoogleIdentity:
    return GoogleIdentity(
        **{"sub": "google-sub-1", "email": "ada@example.com", "name": "Ada Lovelace", **overrides}
    )


def sign_in(client, who: GoogleIdentity | Exception, credential: str = "id-token"):
    with mock.patch(VERIFY, side_effect=who if isinstance(who, Exception) else None, return_value=who):
        return client.post(GOOGLE, {"credential": credential}, format="json")


# --- endpoint -------------------------------------------------------------------------------------


def test_new_google_user_is_created_and_logged_in(client):
    res = sign_in(client, identity())
    assert res.status_code == 200
    body = res.json()
    assert body["created"] is True
    user = body["user"]
    assert (user["email"], user["display_name"]) == ("ada@example.com", "Ada Lovelace")
    assert (user["is_email_verified"], user["has_password"], user["google_linked"]) == (True, False, True)
    assert user["avatar_url"] is None
    assert client.get(ME).json()["user"]["id"] == user["id"]
    stored = User.objects.get()
    assert stored.google_sub == "google-sub-1" and not stored.has_usable_password()


def test_returning_google_user_is_found_by_sub_even_if_the_email_changed(client):
    sign_in(client, identity())
    res = sign_in(client, identity(email="renamed@example.com"))
    assert res.json()["created"] is False
    assert User.objects.count() == 1
    assert User.objects.get().email == "ada@example.com"


def test_google_links_to_an_existing_verified_account_and_keeps_its_password(client, make_user):
    existing = make_user("ada@example.com", is_email_verified=True)
    res = sign_in(client, identity(email="Ada@Example.com"))
    assert res.json()["created"] is False
    existing.refresh_from_db()
    assert existing.google_sub == "google-sub-1"
    assert existing.check_password(PASSWORD)
    assert User.objects.count() == 1
    assert res.json()["user"]["id"] == str(existing.id)


def test_linking_an_unverified_account_discards_its_password(client, make_user):
    """Pre-hijack defence: whoever registered an address before proving it must not keep a password."""
    squatter = make_user("ada@example.com", is_email_verified=False)
    res = sign_in(client, identity())
    assert res.status_code == 200
    squatter.refresh_from_db()
    assert squatter.is_email_verified is True
    assert not squatter.has_usable_password()
    assert not squatter.check_password(PASSWORD)


def test_linking_an_unverified_account_ends_the_squatters_sessions(client, make_user):
    from .conftest import login_as

    make_user("ada@example.com", is_email_verified=False)
    squatter_session = login_as("ada@example.com")
    sign_in(client, identity())
    assert squatter_session.get(ME).json() == {"user": None}


def test_google_rejects_an_email_linked_to_a_different_google_account(client, make_user):
    make_user("ada@example.com", google_sub="someone-else", is_email_verified=True)
    res = sign_in(client, identity())
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "google_account_mismatch"
    assert client.get(ME).json() == {"user": None}


def test_inactive_account_cannot_use_google(client, make_user):
    make_user("ada@example.com", google_sub="google-sub-1", is_active=False)
    res = sign_in(client, identity())
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "account_disabled"
    assert client.get(ME).json() == {"user": None}


def test_inactive_account_found_by_email_is_not_modified(client, make_user):
    inactive = make_user("ada@example.com", is_active=False)
    assert sign_in(client, identity()).status_code == 400
    inactive.refresh_from_db()
    assert inactive.google_sub is None and inactive.has_usable_password()


def test_invalid_credential_is_a_400(client):
    res = sign_in(client, GoogleSignInError("The Google credential is invalid or expired."))
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "invalid_google_token"
    assert not User.objects.exists()


def test_google_is_refused_when_not_configured(client, settings):
    settings.GOOGLE_CLIENT_ID = ""
    with mock.patch(VERIFY) as verifier:
        res = client.post(GOOGLE, {"credential": "x"}, format="json")
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "google_not_configured"
    verifier.assert_not_called()


@pytest.mark.parametrize("payload", [{}, {"credential": ""}, {"credential": "x" * 9000}])
def test_google_needs_a_credential(client, payload):
    res = client.post(GOOGLE, payload, format="json")
    assert res.status_code == 400
    assert "credential" in res.json()["error"]["fields"]


def test_google_display_name_is_sanitised_and_capped(client):
    res = sign_in(client, identity(name="  " + "N" * 200 + "\x00"))
    assert res.json()["user"]["display_name"] == "N" * 80


def test_google_sign_in_does_not_expose_hashes(client):
    assert "pbkdf2" not in sign_in(client, identity()).content.decode()


def test_concurrent_first_sign_in_retries_and_finds_the_winner(client, make_user):
    real = services._link_or_create
    calls = []

    def flaky(ident):
        calls.append(1)
        if len(calls) == 1:
            make_user("ada@example.com", None, google_sub="google-sub-1", is_email_verified=True)
            raise IntegrityError
        return real(ident)

    with mock.patch.object(services, "_link_or_create", side_effect=flaky):
        res = sign_in(client, identity())
    assert res.status_code == 200
    assert res.json()["created"] is False
    assert User.objects.count() == 1


def test_google_user_can_later_add_a_password_and_use_both(client):
    from .conftest import NEW_PASSWORD, PASSWORD_CHANGE

    sign_in(client, identity())
    assert client.post(PASSWORD_CHANGE, {"new_password": NEW_PASSWORD}, format="json").status_code == 204
    assert client.get(ME).json()["user"]["has_password"] is True


def test_google_registration_then_password_registration_conflicts(client):
    sign_in(client, identity())
    res = client.post(REGISTER, {"email": "ada@example.com", "password": PASSWORD}, format="json")
    assert res.status_code == 400
    assert res.json()["error"]["field_codes"]["email"] == ["email_taken"]


# --- verifier -------------------------------------------------------------------------------------

CLAIMS = {"sub": "123", "email": "Ada@Example.com", "email_verified": True, "name": "Ada"}


def verify(claims=None, *, error: Exception | None = None):
    with mock.patch.object(
        google.id_token, "verify_oauth2_token", side_effect=error, return_value=claims
    ) as patched:
        try:
            return google.verify_google_credential("token"), patched
        except GoogleSignInError as exc:
            return exc, patched


def test_verifier_passes_the_configured_audience(settings):
    result, patched = verify(CLAIMS)
    assert patched.call_args.args[0] == "token"
    assert patched.call_args.args[2] == settings.GOOGLE_CLIENT_ID
    assert result == GoogleIdentity(sub="123", email="ada@example.com", name="Ada")


@pytest.mark.parametrize("flag", [False, None, "false", 0])
def test_verifier_requires_a_verified_email(flag):
    result, _ = verify({**CLAIMS, "email_verified": flag})
    assert isinstance(result, GoogleSignInError)


def test_verifier_accepts_the_string_form_of_the_flag():
    result, _ = verify({**CLAIMS, "email_verified": "true"})
    assert isinstance(result, GoogleIdentity)


@pytest.mark.parametrize("claims", [{**CLAIMS, "sub": ""}, {**CLAIMS, "email": ""}, {"email_verified": True}])
def test_verifier_requires_sub_and_email(claims):
    result, _ = verify(claims)
    assert isinstance(result, GoogleSignInError)


@pytest.mark.parametrize(
    "error", [ValueError("bad audience"), GoogleAuthError("bad"), TransportError("down")]
)
def test_verifier_maps_library_errors(error):
    result, _ = verify(error=error)
    assert isinstance(result, GoogleSignInError)


def test_verifier_transport_has_a_short_timeout():
    transport = google._Transport()
    with mock.patch("google.auth.transport.requests.Request.__call__", return_value="ok") as parent:
        transport("https://example.test/certs")
    assert parent.call_args.args[-1] == google.REQUEST_TIMEOUT_SECONDS
