"""Per-account guard against password guessing, on top of the per-IP `auth` throttle.

After `AUTH_LOCKOUT_MAX_ATTEMPTS` failed password checks for one account inside
`AUTH_LOCKOUT_WINDOW_SECONDS`, further attempts are refused with HTTP 429 until the window passes.
State lives in the cache under a keyed hash of the email — the address itself is never stored.
Run a cache shared by all workers (see `CACHE_URL`) so the counter is global.
"""

from __future__ import annotations

import time

from django.conf import settings
from django.core.cache import cache
from django.utils.crypto import salted_hmac
from rest_framework.exceptions import Throttled


def email_fingerprint(email: str, purpose: str) -> str:
    """Stable, non-reversible cache-key component for `email` (scoped by `purpose`)."""
    return salted_hmac(f"doory.accounts.{purpose}", email.strip().lower()).hexdigest()


class PasswordAttemptGuard:
    def __init__(self, email: str):
        self._key = f"auth:failures:{email_fingerprint(email, 'lockout')}"

    def _state(self) -> dict[str, float] | None:
        """The live failure window, or `None` when there is none (or it has already ended)."""
        state = cache.get(self._key)
        if isinstance(state, dict) and state["expires_at"] > time.time():
            return state
        return None

    def check(self) -> None:
        """Raise `Throttled` (429) when the account is currently locked."""
        state = self._state()
        if state and state["count"] >= settings.AUTH_LOCKOUT_MAX_ATTEMPTS:
            raise Throttled(
                wait=max(1.0, state["expires_at"] - time.time()),
                detail="Too many failed attempts. Try again later.",
            )

    def record_failure(self) -> None:
        now = time.time()
        state = self._state() or {"count": 0, "expires_at": now + settings.AUTH_LOCKOUT_WINDOW_SECONDS}
        state["count"] += 1
        cache.set(self._key, state, timeout=max(1, int(state["expires_at"] - now) + 1))

    def reset(self) -> None:
        cache.delete(self._key)


def claim_email_slot(email: str, purpose: str) -> bool:
    """True when no email for `purpose` went to `email` within the cooldown (and claims the slot)."""
    key = f"auth:cooldown:{purpose}:{email_fingerprint(email, purpose)}"
    return cache.add(key, 1, timeout=settings.AUTH_EMAIL_COOLDOWN_SECONDS)
