import uuid

from django.conf import settings
from django.db import models
from django.db.models.functions import Lower

from apps.core.models import BaseModel


def design_thumbnail_path(instance, filename):
    return f"designs/{instance.owner_id}/{instance.id}-{uuid.uuid4().hex[:10]}.webp"


def version_thumbnail_path(instance, filename):
    return f"designs/{instance.design.owner_id}/versions/{instance.id}.webp"


class Folder(BaseModel):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="folders")
    name = models.CharField(max_length=120)
    parent = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.SET_NULL, related_name="children"
    )

    class Meta:
        ordering = ["name"]
        indexes = [models.Index(fields=["owner", "parent"])]
        constraints = [
            models.UniqueConstraint(
                "owner",
                "parent",
                Lower("name"),
                condition=models.Q(parent__isnull=False),
                name="designs_folder_unique_name_in_parent",
            ),
            models.UniqueConstraint(
                "owner",
                Lower("name"),
                condition=models.Q(parent__isnull=True),
                name="designs_folder_unique_name_at_root",
            ),
        ]

    def __str__(self):
        return self.name


class Design(BaseModel):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="designs")
    title = models.CharField(max_length=200, default="Untitled design")
    width = models.PositiveIntegerField(default=1080)
    height = models.PositiveIntegerField(default=1080)
    preset = models.CharField(max_length=64, blank=True)
    document = models.JSONField(default=dict)
    page_count = models.PositiveSmallIntegerField(default=1)
    thumbnail = models.ImageField(upload_to=design_thumbnail_path, blank=True)
    folder = models.ForeignKey(
        Folder, null=True, blank=True, on_delete=models.SET_NULL, related_name="designs"
    )
    starred = models.BooleanField(default=False)
    revision = models.PositiveIntegerField(default=1)
    trashed_at = models.DateTimeField(null=True, blank=True, db_index=True)

    class Meta:
        ordering = ["-updated_at"]
        indexes = [
            models.Index(fields=["owner", "trashed_at", "-updated_at"]),
            models.Index(fields=["owner", "folder"]),
        ]

    def __str__(self):
        return self.title


class DesignVersion(BaseModel):
    design = models.ForeignKey(Design, on_delete=models.CASCADE, related_name="versions")
    label = models.CharField(max_length=120, blank=True)
    is_auto = models.BooleanField(default=True)
    document = models.JSONField(default=dict)
    page_count = models.PositiveSmallIntegerField(default=1)
    thumbnail = models.ImageField(upload_to=version_thumbnail_path, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["design", "-created_at"])]
