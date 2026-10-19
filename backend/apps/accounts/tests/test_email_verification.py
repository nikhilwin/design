from __future__ import annotations

from unittest import mock

import pytest
from django.core import mail

from apps.accounts import emails
from apps.accounts.tokens import encode_uid, password_reset_token_generator

from .conftest import EMAIL_RESEND, EMAIL_VERIFY, ME, PASSWORD, REGISTER, last_email_params

pytestmark = pytest.mark.django_db


def register_and_get_link(client) -> tuple[dict[str, str], str]:
    res = client.post(REGISTER, {"email": "ada@example.com", "password": PASSWORD}, format="json")
    assert res.status_code == 201
    return last_email_params(), res.json()["user"]["id"]


def test_verification_flow(client):
    params, _ = register_and_get_link(client)
    assert client.get(ME).json()["user"]["is_email_verified"] is False
    res = client.post(EMAIL_VERIFY, params, format="json")
    assert res.status_code == 204
    assert client.get(ME).json()["user"]["is_email_verified"] is True


def test_verification_works_for_an_anonymous_visitor(client):
    from rest_framework.test import APIClient

    params, _ = register_and_get_link(client)
    assert APIClient().post(EMAIL_VERIFY, params, format="json").status_code == 204


def test_verification_token_is_single_use(client):
    params, _ = register_and_get_link(client)
    assert client.post(EMAIL_VERIFY, params, format="json").status_code == 204
    again = client.post(EMAIL_VERIFY, params, format="json")
    assert again.status_code == 400
    assert again.json()["error"]["code"] == "invalid_token"


@pytest.mark.parametrize("field", ["uid", "token"])
def test_verification_rejects_tampering(client, field):
    params, _ = register_and_get_link(client)
    params[field] = "tampered"
    res = client.post(EMAIL_VERIFY, params, format="json")
    assert res.status_code == 400
    assert client.get(ME).json()["user"]["is_email_verified"] is False


def test_verification_requires_both_fields(client):
    res = client.post(EMAIL_VERIFY, {"uid": "x"}, format="json")
    assert res.status_code == 400
    assert res.json()["error"]["field_codes"]["token"] == ["required"]


def test_reset_tokens_do_not_verify_email(client, user):
    token = password_reset_token_generator.make_token(user)
    assert (
        client.post(EMAIL_VERIFY, {"uid": encode_uid(user), "token": token}, format="json").status_code == 400
    )


def test_verification_token_is_bound_to_the_email_address(client):
    params, user_id = register_and_get_link(client)
    from apps.accounts.models import User

    User.objects.filter(pk=user_id).update(email="changed@example.com")
    assert client.post(EMAIL_VERIFY, params, format="json").status_code == 400


def test_verification_token_expires(client, monkeypatch):
    from datetime import datetime, timedelta

    from django.contrib.auth.tokens import PasswordResetTokenGenerator

    params, _ = register_and_get_link(client)
    monkeypatch.setattr(PasswordResetTokenGenerator, "_now", lambda self: datetime.now() + timedelta(days=2))
    assert client.post(EMAIL_VERIFY, params, format="json").status_code == 400


def test_inactive_user_cannot_verify(client):
    from apps.accounts.models import User

    params, user_id = register_and_get_link(client)
    User.objects.filter(pk=user_id).update(is_active=False)
    assert client.post(EMAIL_VERIFY, params, format="json").status_code == 400


# --- resend ---------------------------------------------------------------------------------------


def test_resend_sends_a_fresh_link(auth_client, user):
    res = auth_client.post(EMAIL_RESEND)
    assert res.status_code == 204
    assert len(mail.outbox) == 1
    assert auth_client.post(EMAIL_VERIFY, last_email_params(), format="json").status_code == 204


def test_resend_has_a_cooldown(auth_client):
    assert auth_client.post(EMAIL_RESEND).status_code == 204
    res = auth_client.post(EMAIL_RESEND)
    assert res.status_code == 429
    assert res.json()["error"]["retry_after"] >= 1
    assert len(mail.outbox) == 1


def test_resend_is_a_noop_when_already_verified(client, make_user):
    verified = make_user("v@example.com", is_email_verified=True)
    client.force_login(verified)
    assert client.post(EMAIL_RESEND).status_code == 204
    assert mail.outbox == []


def test_resend_requires_login(client):
    assert client.post(EMAIL_RESEND).status_code == 401


# --- email content --------------------------------------------------------------------------------


def test_verification_email_is_multipart_and_branded(client, settings):
    settings.SITE_URL = "https://doory.example.org"
    register_and_get_link(client)
    message = mail.outbox[0]
    html, mimetype = message.alternatives[0]
    assert mimetype == "text/html"
    assert "https://doory.example.org/verify-email?uid=" in message.body
    assert "Verify email address" in html
    assert "#2b1c17" in html  # brand ink (the button)
    assert "<script" not in html
    assert message.from_email == settings.DEFAULT_FROM_EMAIL


def test_email_html_escapes_the_display_name(client):
    client.post(
        REGISTER,
        {"email": "x@example.com", "password": PASSWORD, "display_name": "<img src=x onerror=alert(1)>"},
        format="json",
    )
    html = mail.outbox[0].alternatives[0][0]
    assert "<img src=x" not in html
    assert "&lt;img src=x" in html


def test_reset_email_subject_and_copy(client, user):
    from .conftest import PASSWORD_RESET

    client.post(PASSWORD_RESET, {"email": user.email}, format="json")
    message = mail.outbox[0]
    assert message.subject == "Reset your Doory password"
    assert "Choose a new password" in message.alternatives[0][0]
    assert "/reset-password?uid=" in message.body


def test_async_sending_hands_the_message_to_the_pool(settings, user):
    settings.EMAIL_SEND_ASYNC = True
    with mock.patch.object(emails, "_executor") as executor:
        emails.send_verification_email(user)
    executor.submit.assert_called_once()
    assert mail.outbox == []
    deliver, message = executor.submit.call_args.args
    deliver(message)
    assert len(mail.outbox) == 1


def test_delivery_failures_are_swallowed_and_logged(user, caplog):
    with mock.patch("django.core.mail.EmailMultiAlternatives.send", side_effect=OSError("down")):
        emails.send_password_reset_email(user)
    assert "Could not send" in caplog.text
