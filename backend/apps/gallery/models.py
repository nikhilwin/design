from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models

from apps.core.models import BaseModel

from .validators import TemplateDocumentError, normalize_tags, validate_template_document


def template_thumbnail_path(instance, filename):
    return f"templates/{instance.slug}.webp"


class TemplateCategory(BaseModel):
    slug = models.SlugField(max_length=80, unique=True)
    name = models.CharField(max_length=80)
    icon = models.CharField(max_length=64, blank=True, help_text="Icon name understood by the web app.")
    sort_order = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["sort_order", "name"]
        verbose_name_plural = "template categories"

    def __str__(self):
        return self.name


class Template(BaseModel):
    slug = models.SlugField(max_length=120, unique=True)
    title = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    category = models.ForeignKey(
        TemplateCategory, null=True, blank=True, on_delete=models.SET_NULL, related_name="templates"
    )
    tags = models.JSONField(default=list, blank=True)
    width = models.PositiveIntegerField()
    height = models.PositiveIntegerField()
    preset = models.CharField(max_length=64, blank=True)
    document = models.JSONField(default=dict)
    page_count = models.PositiveSmallIntegerField(default=1)
    thumbnail = models.ImageField(upload_to=template_thumbnail_path, blank=True)
    is_featured = models.BooleanField(default=False)
    is_published = models.BooleanField(default=False)
    use_count = models.PositiveIntegerField(default=0)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["is_published", "-use_count"])]

    def __str__(self):
        return self.title

    def apply_document(self, document: dict) -> None:
        """Validate `document` and mirror its size, page count and preset onto the row."""
        summary = validate_template_document(document)
        self.document = document
        self.width = summary.width
        self.height = summary.height
        self.page_count = summary.page_count
        if summary.preset and not self.preset:
            self.preset = summary.preset

    def clean(self):
        super().clean()
        try:
            summary = validate_template_document(self.document)
        except TemplateDocumentError as exc:
            raise ValidationError(f"Invalid document: {exc}") from exc
        if (self.width, self.height, self.page_count) != (
            summary.width,
            summary.height,
            summary.page_count,
        ):
            raise ValidationError("Width, height and page count must match the document.")
        try:
            self.tags = normalize_tags(self.tags)
        except ValueError as exc:
            raise ValidationError(f"Invalid tags: {exc}") from exc

    @property
    def orientation(self) -> str:
        if self.width == self.height:
            return "square"
        return "landscape" if self.width > self.height else "portrait"
