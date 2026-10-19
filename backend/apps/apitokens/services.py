"""Personal access tokens: minting, checking and revoking.

A token reads `doory_<prefix>_<secret>`. The prefix finds the row, the SHA-256 of the whole token is compared
in constant time. The secret has 256 bits of entropy, so a plain hash is enough (no slow password hash).

Each token is also bound to the owner's password as it was when the token was made (like Django's session
auth hash): any path that sets, changes or drops the password (the account views, a Google sign-in taking over
an unverified account, the admin site, `manage.py changepassword`, a shell) leaves the token unusable.
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import timedelta

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Q, QuerySet
from django.utils import timezone
from django.utils.crypto import constant_time_compare, salted_hmac

from apps.assets.exceptions import LimitReached

from .models import ApiToken

TOKEN_PREFIX = "doory"  # noqa: S105  (a marker that lets secret scanners spot tokens, not a secret)
PREFIX_BYTES = 6
SECRET_BYTES = 32
LAST_USED_RESOLUTION = timedelta(minutes=1)  # `last_used_at` is written at most once a minute per token


@dataclass(frozen=True)
class IssuedToken:
    token: ApiToken
    plaintext: str


def _digest(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def password_digest(password: str, secret: str | None = None) -> str:
    """What a token remembers of its owner's password hash: an HMAC of it, never the hash itself."""
    return salted_hmac(
        "apitokens.password_state", password or "", secret=secret, algorithm="sha256"
    ).hexdigest()


def _accepted_digests(password: str) -> list[str]:
    """The current digest of `password`, then the ones made under `SECRET_KEY_FALLBACKS`, so rotating the
    secret key (with the old one kept as a fallback) does not strand every token, as Django's session hash."""
    return [password_digest(password)] + [
        password_digest(password, secret) for secret in settings.SECRET_KEY_FALLBACKS
    ]


def live_tokens(owner) -> QuerySet[ApiToken]:
    """`owner`'s tokens that still work: neither revoked, expired, nor made under another password."""
    return ApiToken.objects.filter(
        Q(expires_at__isnull=True) | Q(expires_at__gt=timezone.now()),
        owner=owner,
        revoked_at__isnull=True,
        password_digest__in=_accepted_digests(owner.password),
    )


def _split(plaintext: str) -> str | None:
    """The prefix of a well-formed token; None for anything else."""
    parts = plaintext.split("_", 2)  # the secret itself may contain underscores
    if len(parts) != 3 or parts[0] != TOKEN_PREFIX or not parts[1] or not parts[2]:
        return None
    return parts[1]


def issue_token(owner, *, name: str, scopes: list[str], expires_in_days: int) -> IssuedToken:
    with transaction.atomic():
        # Same count-then-insert guard as designs and assets: lock the owner row first.
        get_user_model().objects.select_for_update().filter(pk=owner.pk).first()
        live = live_tokens(owner).count()
        if live >= settings.MAX_API_TOKENS_PER_USER:
            raise LimitReached(f"You can keep at most {settings.MAX_API_TOKENS_PER_USER} API tokens.")
        prefix = secrets.token_hex(PREFIX_BYTES)
        plaintext = f"{TOKEN_PREFIX}_{prefix}_{secrets.token_urlsafe(SECRET_BYTES)}"
        expires_at = timezone.now() + timedelta(days=expires_in_days)
        token = ApiToken.objects.create(
            owner=owner,
            name=name,
            prefix=prefix,
            secret_hash=_digest(plaintext),
            scopes=sorted(set(scopes)),
            expires_at=expires_at,
            password_digest=password_digest(owner.password),
        )
    return IssuedToken(token, plaintext)


def authenticate(plaintext: str) -> ApiToken | None:
    """The live token `plaintext` stands for, with its owner loaded; None when it is unknown or unusable."""
    prefix = _split(plaintext.strip())
    if prefix is None:
        return None
    token = ApiToken.objects.select_related("owner").filter(prefix=prefix).first()
    if token is None or not constant_time_compare(token.secret_hash, _digest(plaintext.strip())):
        return None
    now = timezone.now()
    if token.revoked_at is not None or (token.expires_at is not None and token.expires_at <= now):
        return None
    if not token.owner.is_active:
        return None
    accepted = _accepted_digests(token.owner.password)
    matches = [constant_time_compare(token.password_digest, digest) for digest in accepted]
    if not any(matches):
        return None  # the password was changed, reset or dropped since the token was made
    if not matches[0]:  # made under a fallback key: move it to the current one
        ApiToken.objects.filter(pk=token.pk).update(password_digest=accepted[0])
        token.password_digest = accepted[0]
    if token.last_used_at is None or now - token.last_used_at >= LAST_USED_RESOLUTION:
        ApiToken.objects.filter(pk=token.pk).update(last_used_at=now)
        token.last_used_at = now
    return token


def revoke(token: ApiToken) -> None:
    if token.revoked_at is None:
        token.revoked_at = timezone.now()
        token.save(update_fields=["revoked_at", "updated_at"])


def rebind(owner, old_password: str) -> None:
    """Carry `owner`'s tokens over when Django re-hashes an unchanged password (a hasher upgrade on login)."""
    ApiToken.objects.filter(owner=owner, password_digest__in=_accepted_digests(old_password)).update(
        password_digest=password_digest(owner.password)
    )


def revoke_all(owner) -> int:
    """Revoke every unrevoked token of `owner`; the number revoked. A password change already makes them
    unusable (see the module docstring); this also takes them off the list and records when."""
    now = timezone.now()
    return ApiToken.objects.filter(owner=owner, revoked_at__isnull=True).update(
        revoked_at=now, updated_at=now
    )
