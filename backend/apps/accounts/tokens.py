"""Signed, expiring, single-use tokens for password reset and email verification.

Both are Django `PasswordResetTokenGenerator`s: the token is an HMAC over user state, so it needs no
database table, expires after `settings.PASSWORD_RESET_TIMEOUT`, and stops working as soon as the
state it covers changes (a used reset token dies when the password hash changes; a used verification
token dies when `is_email_verified` flips).
"""

from __future__ import annotations

from django.contrib.auth.tokens import PasswordResetTokenGenerator, default_token_generator
from django.core.exceptions import ValidationError
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_decode, urlsafe_base64_encode

from .models import User

password_reset_token_generator = default_token_generator


class EmailVerificationTokenGenerator(PasswordResetTokenGenerator):
    """Verification tokens: separate salt (never valid as reset tokens) bound to email + verified flag."""

    key_salt = "apps.accounts.tokens.EmailVerificationTokenGenerator"

    def _make_hash_value(self, user, timestamp):
        return f"{user.pk}{user.email}{user.is_email_verified}{timestamp}"


email_verification_token_generator = EmailVerificationTokenGenerator()


def encode_uid(user: User) -> str:
    return urlsafe_base64_encode(force_bytes(user.pk))


def decode_uid(uid: str) -> User | None:
    """Resolve an active user from an encoded uid; `None` for anything malformed or unknown."""
    try:
        pk = urlsafe_base64_decode(uid).decode()
        return User.objects.get(pk=pk, is_active=True)
    except (ValueError, ValidationError, User.DoesNotExist):
        return None
