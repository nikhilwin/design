from django.conf import settings
from django.db import models

from apps.core.models import BaseModel


class ApiToken(BaseModel):
    """A personal access token. Only a hash of the secret is stored; the full token is shown once."""

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="api_tokens")
    name = models.CharField(max_length=80)
    prefix = models.CharField(max_length=16, unique=True)  # public part, shown in lists to tell tokens apart
    secret_hash = models.CharField(max_length=64)  # SHA-256 hex of the whole token
    scopes = models.JSONField(default=list)
    last_used_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    # HMAC of the owner's password hash when the token was made; see `services.password_digest`.
    password_digest = models.CharField(max_length=64)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["owner", "-created_at"])]

    def __str__(self):
        return f"{self.name} ({self.prefix})"
