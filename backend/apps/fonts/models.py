from __future__ import annotations

from django.conf import settings
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.db.models import Q

from apps.core.models import BaseModel

UNRANKED = 9999


class FontCategory(models.TextChoices):
    SANS_SERIF = "sans-serif", "Sans serif"
    SERIF = "serif", "Serif"
    DISPLAY = "display", "Display"
    HANDWRITING = "handwriting", "Handwriting"
    MONOSPACE = "monospace", "Monospace"


class FontOrigin(models.TextChoices):
    FONTSOURCE = "fontsource", "Fontsource"
    UPLOAD = "upload", "User upload"


class FontStyle(models.TextChoices):
    NORMAL = "normal", "Normal"
    ITALIC = "italic", "Italic"


class FontFormat(models.TextChoices):
    WOFF2 = "woff2", "WOFF2"
    WOFF = "woff", "WOFF"
    TTF = "ttf", "TrueType"
    OTF = "otf", "OpenType"


def variant_file_path(instance: FontVariant, filename: str) -> str:
    """Stored under an unguessable name; the extension always comes from the sniffed `format`."""
    family = instance.family
    if family.owner_id:
        return f"fonts/user/{family.owner_id}/{instance.id}.{instance.format}"
    return f"fonts/system/{family.slug}/{instance.id}.{instance.format}"


class FontFamily(BaseModel):
    """A family offered in the editor: either a built-in (system) font or one uploaded by a user."""

    family = models.CharField(max_length=120)
    slug = models.SlugField(max_length=120, help_text="Fontsource id for built-in fonts.")
    category = models.CharField(max_length=16, choices=FontCategory.choices, default=FontCategory.SANS_SERIF)
    scripts = models.JSONField(
        default=list, blank=True, help_text="Script/subset names covered by the stored files, e.g. latin."
    )
    is_variable = models.BooleanField(default=False)
    popularity = models.PositiveIntegerField(
        default=UNRANKED, db_index=True, help_text="Rank: 1 is the most popular."
    )
    license = models.CharField(max_length=64, default="OFL-1.1")
    source = models.CharField(max_length=16, choices=FontOrigin.choices, default=FontOrigin.FONTSOURCE)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.CASCADE, related_name="fonts"
    )
    is_published = models.BooleanField(default=True)

    class Meta:
        ordering = ["popularity", "family"]
        verbose_name_plural = "font families"
        constraints = [
            models.UniqueConstraint(
                fields=["family"], condition=Q(owner__isnull=True), name="fonts_system_family_unique"
            ),
            models.UniqueConstraint(
                fields=["slug"], condition=Q(owner__isnull=True), name="fonts_system_slug_unique"
            ),
            models.UniqueConstraint(
                fields=["owner", "family"], condition=Q(owner__isnull=False), name="fonts_user_family_unique"
            ),
        ]
        indexes = [models.Index(fields=["is_published", "popularity"])]

    def __str__(self):
        return self.family

    @property
    def is_user_font(self) -> bool:
        return self.owner_id is not None


class FontVariant(BaseModel):
    """One font file: a weight/style of a family, for one subset (system fonts ship one file per subset)."""

    family = models.ForeignKey(FontFamily, on_delete=models.CASCADE, related_name="variants")
    weight = models.PositiveSmallIntegerField(
        default=400, validators=[MinValueValidator(100), MaxValueValidator(900)]
    )
    style = models.CharField(max_length=8, choices=FontStyle.choices, default=FontStyle.NORMAL)
    subset = models.CharField(
        max_length=32, blank=True, help_text="Unicode subset, e.g. latin. Empty = whole font."
    )
    unicode_range = models.TextField(blank=True, help_text="CSS unicode-range of the subset.")
    file = models.FileField(upload_to=variant_file_path, max_length=255)
    format = models.CharField(max_length=8, choices=FontFormat.choices, default=FontFormat.WOFF2)
    size = models.PositiveIntegerField(default=0, help_text="File size in bytes.")

    class Meta:
        ordering = ["weight", "style", "subset"]
        constraints = [
            models.UniqueConstraint(
                fields=["family", "weight", "style", "subset"], name="fonts_variant_unique_per_subset"
            )
        ]

    def __str__(self):
        label = f"{self.family.family} {self.weight} {self.style}"
        return f"{label} ({self.subset})" if self.subset else label
