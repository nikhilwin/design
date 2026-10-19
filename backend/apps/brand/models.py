from django.conf import settings
from django.db import models

from apps.core.models import BaseModel


class BrandKit(BaseModel):
    """A user's reusable brand: named colours, font roles and logo assets."""

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="brand_kits")
    name = models.CharField(max_length=80)
    is_default = models.BooleanField(default=False)
    colors = models.JSONField(default=list, blank=True)  # [{id, name, hex}]
    fonts = models.JSONField(default=list, blank=True)  # [{role, family}]
    logos = models.ManyToManyField("assets.Asset", blank=True, related_name="brand_kits")

    class Meta:
        ordering = ["-is_default", "name", "created_at"]
        indexes = [models.Index(fields=["owner", "-is_default"])]
        constraints = [
            models.UniqueConstraint(
                fields=["owner"], condition=models.Q(is_default=True), name="brand_one_default_kit_per_owner"
            ),
        ]

    def __str__(self):
        return self.name
