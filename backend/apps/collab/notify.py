"""Tell running rooms about changes made through the HTTP API (title, version restore, share links).

Delivery over the channel layer is an optimisation: when it fails, or the server that hosts the room shares
no layer with this process, the room notices the change itself at its next re-check.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.conf import settings

log = logging.getLogger("doory.collab")


def group_name(design_id: uuid.UUID | str) -> str:
    return f"doory.collab.design.{design_id}"


def notify_design(design_id: uuid.UUID | str, message_type: str, **payload: Any) -> None:
    layer = get_channel_layer() if settings.REALTIME_ENABLED else None
    if layer is None:
        return
    try:
        async_to_sync(layer.group_send)(
            group_name(design_id), {"type": message_type, "origin": "http", **payload}
        )
    except Exception:
        log.warning("could not notify rooms design=%s type=%s", design_id, message_type, exc_info=True)
