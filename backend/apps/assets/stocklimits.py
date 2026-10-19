"""Stock-provider settings and the limits shared by every worker and user of one API key.

A provider's limit is per key, not per Doory user: the calls are counted in the cache (shared by all workers
with Redis or the database cache), and a provider that says its quota is used up is paused until it resets.
"""

from __future__ import annotations

import logging
import math
import re
import time
from dataclasses import dataclass

from django.conf import settings
from django.core.cache import cache

MAX_PAUSE_SECONDS = 31 * 24 * 60 * 60
_PERIODS = {"s": 1, "m": 60, "h": 60 * 60, "d": 24 * 60 * 60}
_RATE = re.compile(r"\s*(\d+)\s*/\s*(\d*)\s*([smhd])[a-z]*\s*")

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class StockConfig:
    cache_seconds: int
    rate: str
    safesearch: bool


def config_for(name: str) -> StockConfig:
    values = settings.STOCK_PROVIDER_SETTINGS.get(name, {})
    return StockConfig(
        cache_seconds=max(0, int(values.get("cache_seconds", 3600))),
        rate=str(values.get("rate", "")),
        safesearch=bool(values.get("safesearch", False)),
    )


def parse_rate(rate: str) -> tuple[int, int] | None:
    """`"100/m"`, `"50/h"`, `"20000/30d"` → (calls, seconds). None: no limit (empty or unreadable)."""
    match = _RATE.fullmatch(rate.lower())
    if not match:
        if rate.strip():
            logger.warning("Ignoring the unreadable stock rate %r.", rate)
        return None
    return int(match[1]), int(match[2] or 1) * _PERIODS[match[3]]


def _seconds_until(moment: float) -> int:
    return max(1, math.ceil(moment - time.time()))


def paused_for(name: str) -> int | None:
    """Seconds left of a pause the provider asked for, or None."""
    until = cache.get(f"stock:pause:{name}")
    if isinstance(until, (int, float)) and until > time.time():
        return _seconds_until(until)
    return None


def pause(name: str, seconds: float) -> None:
    seconds = min(max(1, math.ceil(seconds)), MAX_PAUSE_SECONDS)
    cache.set(f"stock:pause:{name}", time.time() + seconds, seconds)


def acquire(name: str, rate: str) -> int | None:
    """Count one call against the key's budget. None: go ahead; a number: wait that many seconds first."""
    paused = paused_for(name)
    if paused:
        return paused
    parsed = parse_rate(rate)
    if parsed is None:
        return None
    allowed, period = parsed
    now = time.time()
    window = int(now // period)
    key = f"stock:rate:{name}:{period}:{window}"
    cache.add(key, 0, period + 5)
    # incr is atomic on Redis and locmem but a read-then-write on the database cache, so there it can count a
    # little low under load; the provider's own 429 and rate-limit headers (see `pause`) are the backstop.
    try:
        used = cache.incr(key)
    except ValueError:  # expired between add and incr
        cache.set(key, 1, period + 5)
        used = 1
    if used > allowed:
        return _seconds_until((window + 1) * period)
    return None
