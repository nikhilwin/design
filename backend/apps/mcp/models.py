from django.conf import settings
from django.db import models


class CallWindow(models.Model):
    """Each user's MCP calls in the current minute: one row per user, so the rate limit keeps a bounded
    amount of state and never touches the cache (where per-call keys could push out lockout counters)."""

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, primary_key=True, related_name="+"
    )
    window = models.BigIntegerField()  # minutes since the epoch
    calls = models.PositiveIntegerField()

    def __str__(self):
        return f"{self.user_id}: {self.calls} calls in minute {self.window}"
