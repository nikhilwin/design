"""Durable state of real-time rooms: Y updates, the compacted snapshot and who is connected where."""

from django.conf import settings
from django.db import models

from apps.core.models import BaseModel


class YState(BaseModel):
    """The compacted Y state of one design plus the bookkeeping that ties it to `Design.document`.

    `version` counts the update batches ever appended; `flushed_version` is the version the design document
    was last saved from. `base_revision` is the `Design.revision` the state corresponds to: when the design
    moves on without the room (a REST save, a version restore) the two differ and the state is stale.
    """

    design = models.OneToOneField("designs.Design", on_delete=models.CASCADE, related_name="y_state")
    snapshot = models.BinaryField(default=bytes)
    version = models.PositiveBigIntegerField(default=0)
    flushed_version = models.PositiveBigIntegerField(default=0)
    base_revision = models.PositiveIntegerField(default=1)
    last_editor = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    def __str__(self) -> str:
        return f"Y state of {self.design_id} (v{self.version})"


class YUpdate(BaseModel):
    """One batch of Y updates appended since the last compaction. Order does not matter to a CRDT."""

    design = models.ForeignKey("designs.Design", on_delete=models.CASCADE, related_name="y_updates")
    version = models.PositiveBigIntegerField()
    data = models.BinaryField()

    class Meta:
        indexes = [models.Index(fields=["design", "version"])]


class RoomConnection(BaseModel):
    """One live WebSocket. Rows carry a heartbeat so a crashed process leaves nothing behind for long."""

    design = models.ForeignKey("designs.Design", on_delete=models.CASCADE, related_name="room_connections")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    instance = models.CharField(max_length=80)
    role = models.CharField(max_length=8)
    share_link = models.ForeignKey(
        "sharing.ShareLink", null=True, blank=True, on_delete=models.CASCADE, related_name="+"
    )
    heartbeat_at = models.DateTimeField()

    class Meta:
        indexes = [
            models.Index(fields=["design", "heartbeat_at"]),
            models.Index(fields=["user", "heartbeat_at"]),
            models.Index(fields=["instance"]),
        ]


class CollabInstance(BaseModel):
    """A realtime server process: heartbeat and counters for `GET /collab/stats/`."""

    instance = models.CharField(max_length=80, unique=True)
    shared_layer = models.BooleanField(default=False)
    heartbeat_at = models.DateTimeField()
    counters = models.JSONField(default=dict)
