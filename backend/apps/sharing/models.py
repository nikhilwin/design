import secrets

from django.conf import settings
from django.contrib.auth.hashers import check_password, make_password
from django.db import models
from django.utils import timezone

from apps.core.models import BaseModel

SHARE_TOKEN_BYTES = 24


def generate_share_token() -> str:
    """Unguessable URL-safe token (192 bits of entropy)."""
    return secrets.token_urlsafe(SHARE_TOKEN_BYTES)


class ShareRole(models.TextChoices):
    VIEW = "view", "Can view"
    COMMENT = "comment", "Can comment"
    EDIT = "edit", "Can edit"


class ShareLink(BaseModel):
    design = models.ForeignKey("designs.Design", on_delete=models.CASCADE, related_name="share_links")
    token = models.CharField(max_length=64, unique=True, default=generate_share_token, editable=False)
    role = models.CharField(max_length=8, choices=ShareRole.choices, default=ShareRole.VIEW)
    is_active = models.BooleanField(default=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    password_hash = models.CharField(max_length=256, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    last_accessed_at = models.DateTimeField(null=True, blank=True)
    access_count = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["design", "is_active"])]

    def __str__(self) -> str:
        return f"{self.get_role_display()} link for {self.design_id}"

    @property
    def has_password(self) -> bool:
        return bool(self.password_hash)

    def set_password(self, raw_password: str | None) -> None:
        """Hash `raw_password`; an empty value removes password protection."""
        self.password_hash = make_password(raw_password) if raw_password else ""

    def check_password(self, raw_password: str) -> bool:
        """Constant-time verification through Django's password hashers."""
        return bool(self.password_hash) and check_password(raw_password, self.password_hash)

    def is_expired(self, now=None) -> bool:
        return self.expires_at is not None and self.expires_at <= (now or timezone.now())


class Comment(BaseModel):
    design = models.ForeignKey("designs.Design", on_delete=models.CASCADE, related_name="comments")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    body = models.CharField(max_length=2000)
    page_id = models.CharField(max_length=64, blank=True)
    x = models.FloatField(null=True, blank=True)
    y = models.FloatField(null=True, blank=True)
    parent = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.CASCADE, related_name="replies"
    )
    resolved = models.BooleanField(default=False)

    class Meta:
        ordering = ["created_at", "id"]
        indexes = [models.Index(fields=["design", "created_at"])]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(x__isnull=True, y__isnull=True)
                | models.Q(x__isnull=False, y__isnull=False),
                name="sharing_comment_xy_together",
            )
        ]

    def __str__(self) -> str:
        return f"Comment {self.pk} on {self.design_id}"
