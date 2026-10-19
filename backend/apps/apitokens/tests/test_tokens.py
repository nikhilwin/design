from datetime import timedelta

import pytest
from django.contrib.auth.hashers import PBKDF2PasswordHasher
from django.core.management import call_command
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.apitokens import services
from apps.apitokens.models import ApiToken
from apps.apitokens.scopes import DEFAULT_SCOPES, DESIGNS_READ

from .conftest import PASSWORD

URL = "/api/v1/auth/tokens/"


def issue(owner, **kwargs):
    kwargs.setdefault("name", "Claude")
    kwargs.setdefault("scopes", list(DEFAULT_SCOPES))
    kwargs.setdefault("expires_in_days", 30)
    return services.issue_token(owner, **kwargs)


# ---------------------------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------------------------


def test_an_issued_token_authenticates_and_only_its_hash_is_stored(user):
    issued = issue(user)
    assert issued.plaintext.startswith(f"doory_{issued.token.prefix}_")
    stored = ApiToken.objects.get(pk=issued.token.pk)
    assert issued.plaintext not in (stored.secret_hash, stored.prefix)
    found = services.authenticate(issued.plaintext)
    assert found is not None and found.pk == issued.token.pk and found.owner == user
    assert found.last_used_at is not None


@pytest.mark.parametrize(
    "mangle",
    [
        lambda t: t + "x",
        lambda t: t[:-1],
        lambda t: t.replace("doory_", "other_", 1),
        lambda t: "doory__",
        lambda t: "",
        lambda t: "not a token",
    ],
)
def test_a_wrong_or_malformed_token_is_refused(user, mangle):
    issued = issue(user)
    assert services.authenticate(mangle(issued.plaintext)) is None


def test_a_token_with_another_tokens_prefix_is_refused(user):
    first, second = issue(user), issue(user)
    forged = f"doory_{first.token.prefix}_{second.plaintext.split('_', 2)[2]}"
    assert services.authenticate(forged) is None


def test_revoked_expired_and_inactive_tokens_are_refused(user):
    revoked = issue(user)
    services.revoke(revoked.token)
    assert services.authenticate(revoked.plaintext) is None

    expired = issue(user, expires_in_days=1)
    ApiToken.objects.filter(pk=expired.token.pk).update(expires_at=timezone.now() - timedelta(seconds=1))
    assert services.authenticate(expired.plaintext) is None

    live = issue(user)
    user.is_active = False
    user.save(update_fields=["is_active"])
    assert services.authenticate(live.plaintext) is None


def test_last_used_is_written_at_most_once_a_minute(user, django_assert_num_queries):
    issued = issue(user)
    services.authenticate(issued.plaintext)
    with django_assert_num_queries(1):  # the lookup only, no update
        services.authenticate(issued.plaintext)


@override_settings(MAX_API_TOKENS_PER_USER=2)
def test_the_number_of_live_tokens_is_limited(user):
    first = issue(user)
    issue(user)
    with pytest.raises(Exception, match="at most 2"):
        issue(user)
    services.revoke(first.token)
    second = issue(user)  # a revoked token frees its slot
    ApiToken.objects.filter(pk=second.token.pk).update(expires_at=timezone.now() - timedelta(seconds=1))
    issue(user)  # and so does an expired one


# ---------------------------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------------------------


def test_creating_a_token_shows_it_once(api, user):
    response = api.post(
        URL, {"password": PASSWORD, "name": "  Claude   Desktop ", "expires_in_days": 30}, format="json"
    )
    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Claude Desktop"
    assert sorted(body["scopes"]) == sorted(DEFAULT_SCOPES)
    assert body["expires_at"] is not None
    assert services.authenticate(body["token"]).owner == user
    listed = api.get(URL).json()
    assert [row["id"] for row in listed] == [body["id"]]
    assert "token" not in listed[0] and "secret_hash" not in listed[0]


def test_scopes_are_checked(api):
    assert (
        api.post(URL, {"password": PASSWORD, "name": "x", "scopes": ["admin:all"]}, format="json").status_code
        == 400
    )
    assert api.post(URL, {"password": PASSWORD, "name": "x", "scopes": []}, format="json").status_code == 400
    response = api.post(URL, {"password": PASSWORD, "name": "x", "scopes": [DESIGNS_READ]}, format="json")
    assert response.json()["scopes"] == [DESIGNS_READ]


def test_a_blank_name_is_refused(api):
    assert api.post(URL, {"password": PASSWORD, "name": "   "}, format="json").status_code == 400


def test_revoking_hides_the_token_and_stops_it(api, user):
    issued = issue(user)
    assert api.delete(f"{URL}{issued.token.pk}/").status_code == 204
    assert api.get(URL).json() == []
    assert services.authenticate(issued.plaintext) is None
    assert api.delete(f"{URL}{issued.token.pk}/").status_code == 404


def test_other_peoples_tokens_are_invisible(api, other):
    theirs = issue(other)
    assert api.get(URL).json() == []
    assert api.delete(f"{URL}{theirs.token.pk}/").status_code == 404
    assert services.authenticate(theirs.plaintext) is not None


def test_scope_catalogue_is_listed(api):
    ids = [row["id"] for row in api.get(f"{URL}scopes/").json()]
    assert DESIGNS_READ in ids


def test_a_token_cannot_manage_tokens(user):
    issued = issue(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {issued.plaintext}")
    assert client.get(URL).status_code == 401
    assert client.post(URL, {"password": PASSWORD, "name": "more"}, format="json").status_code == 401


def test_creating_a_token_needs_the_csrf_token(user):
    client = APIClient(enforce_csrf_checks=True)
    assert client.login(email=user.email, password=PASSWORD)
    assert client.post(URL, {"password": PASSWORD, "name": "x"}, format="json").status_code == 403
    client.get("/api/v1/auth/csrf/")
    csrf = client.cookies["csrftoken"].value
    assert (
        client.post(
            URL, {"password": PASSWORD, "name": "x"}, format="json", HTTP_X_CSRFTOKEN=csrf
        ).status_code
        == 201
    )


def test_anonymous_callers_are_refused():
    assert APIClient().get(URL).status_code == 401


def test_a_token_expires_by_default(api):
    body = api.post(URL, {"password": PASSWORD, "name": "x"}, format="json").json()
    expires = timezone.datetime.fromisoformat(body["expires_at"])
    assert timedelta(days=89) < expires - timezone.now() <= timedelta(days=90)


def test_a_token_without_expiry_is_refused(api):
    assert (
        api.post(URL, {"password": PASSWORD, "name": "x", "expires_in_days": None}, format="json").status_code
        == 400
    )


def test_creating_a_token_needs_the_password(api):
    assert api.post(URL, {"name": "x"}, format="json").status_code == 400
    response = api.post(URL, {"name": "x", "password": "wrong"}, format="json")
    assert response.status_code == 400 and response.json()["error"]["field_codes"]["password"] == [
        "invalid_password"
    ]
    assert ApiToken.objects.count() == 0


def test_an_account_without_a_password_confirms_with_its_email(db):
    from apps.accounts.models import User

    user = User.objects.create_user(email="google@example.com", password=None, is_email_verified=True)
    client = APIClient()
    client.force_authenticate(user)
    assert client.post(URL, {"name": "x"}, format="json").status_code == 400
    assert (
        client.post(URL, {"name": "x", "confirm_email": "Google@example.com"}, format="json").status_code
        == 201
    )


def test_changing_the_password_revokes_every_token(user):
    first, second = issue(user), issue(user)
    client = APIClient()
    assert client.login(email=user.email, password=PASSWORD)
    response = client.post(
        "/api/v1/auth/password/change/",
        {"old_password": PASSWORD, "new_password": "another-horse-staple-2"},
        format="json",
    )
    assert response.status_code == 204
    assert services.authenticate(first.plaintext) is None
    assert services.authenticate(second.plaintext) is None


def test_resetting_the_password_revokes_every_token(user, other):
    from apps.accounts.tokens import encode_uid, password_reset_token_generator

    mine, theirs = issue(user), issue(other)
    response = APIClient().post(
        "/api/v1/auth/password/reset/confirm/",
        {
            "uid": encode_uid(user),
            "token": password_reset_token_generator.make_token(user),
            "new_password": "another-horse-staple-2",
        },
        format="json",
    )
    assert response.status_code == 204
    assert services.authenticate(mine.plaintext) is None
    assert services.authenticate(theirs.plaintext) is not None


def test_expired_tokens_are_not_listed(api, user):
    live, expired = issue(user), issue(user)
    ApiToken.objects.filter(pk=expired.token.pk).update(expires_at=timezone.now() - timedelta(seconds=1))
    assert [row["id"] for row in api.get(URL).json()] == [str(live.token.pk)]
    assert api.delete(f"{URL}{expired.token.pk}/").status_code == 404


def test_an_unverified_account_cannot_create_a_token_where_email_is_sent(api, user):
    user.is_email_verified = False
    user.save(update_fields=["is_email_verified"])
    with override_settings(EMAIL_BACKEND="django.core.mail.backends.smtp.EmailBackend"):
        response = api.post(URL, {"password": PASSWORD, "name": "x"}, format="json")
    assert response.status_code == 403 and response.json()["error"]["code"] == "email_not_verified"
    assert ApiToken.objects.count() == 0
    # Without email delivery nobody could ever verify, so the check is skipped there.
    assert api.post(URL, {"password": PASSWORD, "name": "x"}, format="json").status_code == 201


def test_any_password_change_stops_every_token(user):
    """Not only the account views: the admin site, `changepassword` and a shell all go through
    `set_password`, and the tokens are bound to the password itself."""
    issued = issue(user)
    user.set_password("another-horse-staple-2")
    user.save(update_fields=["password"])
    assert services.authenticate(issued.plaintext) is None
    assert ApiToken.objects.get(pk=issued.token.pk).revoked_at is None  # unusable without being touched


def test_the_admin_password_form_stops_every_token(user):
    from unfold.forms import AdminPasswordChangeForm

    issued = issue(user)
    form = AdminPasswordChangeForm(
        user, {"password1": "another-horse-staple-2", "password2": "another-horse-staple-2"}
    )
    assert form.is_valid(), form.errors
    form.save()
    assert services.authenticate(issued.plaintext) is None


def test_changepassword_command_stops_every_token(user, monkeypatch):
    issued = issue(user)
    monkeypatch.setattr("getpass.getpass", lambda prompt="": "another-horse-staple-2")
    call_command("changepassword", user.email, stdout=None)
    assert services.authenticate(issued.plaintext) is None


def test_google_taking_over_an_unverified_account_stops_its_tokens(db):
    from apps.accounts.google import GoogleIdentity
    from apps.accounts.models import User
    from apps.accounts.services import sign_in_with_google

    squatter = User.objects.create_user(email="victim@gmail.com", password=PASSWORD, is_email_verified=True)
    issued = issue(squatter)
    User.objects.filter(pk=squatter.pk).update(
        is_email_verified=False
    )  # made before verification was required

    user, created = sign_in_with_google(GoogleIdentity(sub="g-1", email="victim@gmail.com", name="Victim"))
    assert not created and user.pk == squatter.pk
    assert services.authenticate(issued.plaintext) is None
    assert ApiToken.objects.get(pk=issued.token.pk).revoked_at is not None


class FastPBKDF2(PBKDF2PasswordHasher):
    iterations = 1


@override_settings(
    PASSWORD_HASHERS=[
        "apps.apitokens.tests.test_tokens.FastPBKDF2",
        "django.contrib.auth.hashers.MD5PasswordHasher",
    ]
)
def test_rehashing_an_unchanged_password_keeps_the_tokens(user):
    issued = issue(user)
    old_hash = user.password
    assert user.check_password(PASSWORD)  # MD5 is no longer preferred: Django re-hashes on the spot
    user.refresh_from_db()
    assert user.password != old_hash
    assert services.authenticate(issued.plaintext) is not None


def test_rotating_the_secret_key_keeps_tokens_while_the_old_key_is_a_fallback(user, settings):
    issued = issue(user)
    old_key = settings.SECRET_KEY
    with override_settings(SECRET_KEY="a-brand-new-key-" * 4, SECRET_KEY_FALLBACKS=[old_key]):
        assert services.live_tokens(user).filter(pk=issued.token.pk).exists()
        assert services.authenticate(issued.plaintext) is not None
        moved = ApiToken.objects.get(pk=issued.token.pk).password_digest
        assert moved == services.password_digest(user.password)  # moved to the new key on first use
    with override_settings(SECRET_KEY="a-brand-new-key-" * 4, SECRET_KEY_FALLBACKS=[]):
        assert services.authenticate(issued.plaintext) is not None  # survives dropping the fallback
    with override_settings(SECRET_KEY="yet-another-key-" * 4, SECRET_KEY_FALLBACKS=[]):
        assert services.authenticate(issued.plaintext) is None  # an unknown key still fails closed
