"""Per-connection rate limiting."""

from __future__ import annotations

import time
from collections.abc import Callable

from django.conf import settings
from django.core.cache import cache


class TokenBucket:
    """Two token buckets, one counting messages and one counting bytes; a frame must fit in both."""

    def __init__(
        self,
        messages_per_second: float,
        message_burst: float,
        bytes_per_second: float,
        byte_burst: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._rates = (messages_per_second, bytes_per_second)
        self._capacity = (message_burst, byte_burst)
        self._tokens = [message_burst, byte_burst]
        self._clock = clock
        self._stamp = clock()

    @classmethod
    def from_settings(cls) -> TokenBucket:
        return cls(
            settings.REALTIME_RATE_MESSAGES_PER_SECOND,
            settings.REALTIME_RATE_BURST,
            settings.REALTIME_RATE_BYTES_PER_SECOND,
            settings.REALTIME_RATE_BYTES_BURST,
        )

    def allow(self, size: int) -> bool:
        """Take one message of `size` bytes; False (and nothing taken) when either bucket is short."""
        now = self._clock()
        elapsed, self._stamp = now - self._stamp, now
        for index in (0, 1):
            self._tokens[index] = min(
                self._capacity[index], self._tokens[index] + elapsed * self._rates[index]
            )
        if self._tokens[0] < 1 or self._tokens[1] < size:
            return False
        self._tokens[0] -= 1
        self._tokens[1] -= size
        return True


def block_user(user_id: object) -> None:
    """Refuse the account's new live connections for `REALTIME_BLOCK_SECONDS` (shared cache)."""
    cache.set(f"collab-blocked:{user_id}", 1, settings.REALTIME_BLOCK_SECONDS)


def allow_connection_attempt(user_id: object) -> bool:
    """At most `REALTIME_CONNECTS_PER_MINUTE` new connections per account and minute (shared cache).

    An account that sent an update the engine needed seconds for (`block_user`) gets none for a while.
    """
    if cache.get(f"collab-blocked:{user_id}"):
        return False
    key = f"collab-connects:{user_id}"
    if cache.add(key, 1, 60):
        return True
    try:
        return cache.incr(key) <= settings.REALTIME_CONNECTS_PER_MINUTE
    except ValueError:  # the window ended between add() and incr()
        cache.set(key, 1, 60)
        return True
