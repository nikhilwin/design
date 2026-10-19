"""Whether real-time co-editing is on for this deployment (advertised through `GET /config/`)."""

from __future__ import annotations

from importlib.util import find_spec

from django.conf import settings


def realtime_enabled() -> bool:
    """True when switched on, Channels is installed and a channel layer is configured."""
    return bool(
        settings.REALTIME_ENABLED and getattr(settings, "CHANNEL_LAYERS", None) and find_spec("channels")
    )


def max_participants() -> int:
    return settings.REALTIME_MAX_CONNECTIONS_PER_DESIGN
