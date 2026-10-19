from __future__ import annotations

import hashlib
import re

from django.core.exceptions import ValidationError
from django.core.files.base import ContentFile
from django.db import models
from django.utils.text import slugify

from apps.core.models import BaseModel
from apps.core.svg import MAX_BYTES, SvgError

from .search import search_name, search_tags
from .svgdata import process_svg


class ElementKind(models.TextChoices):
    SHAPE = "shape", "Shape"
    LINE = "line", "Line"
    ICON = "icon", "Icon"
    STICKER = "sticker", "Sticker"
    ILLUSTRATION = "illustration", "Illustration"
    FRAME = "frame", "Frame"
    GRAPHIC = "graphic", "Graphic"


class ElementStyle(models.TextChoices):
    """How an icon is drawn; blank for elements where the distinction does not apply."""

    OUTLINE = "outline", "Outline"
    FILLED = "filled", "Filled"
    DUOTONE = "duotone", "Duotone"
    COLOUR = "colour", "Colour"


_SPDX = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.+-]*(?: (?:AND|OR|WITH) [A-Za-z0-9][A-Za-z0-9.+-]*)*$")


def validate_license(value: str) -> None:
    if not _SPDX.match(value):
        raise ValidationError("Use an SPDX licence identifier such as CC0-1.0, MIT or Apache-2.0.")


def pack_thumbnail_path(instance, filename):
    return f"elements/packs/{instance.slug}.webp"


def element_svg_path(instance, filename):
    return f"elements/{instance.pack.slug}/{instance.pk}.svg"


class ElementPack(BaseModel):
    slug = models.SlugField(max_length=80, unique=True)
    name = models.CharField(max_length=120)
    kind = models.CharField(max_length=16, choices=ElementKind.choices, default=ElementKind.SHAPE)
    license = models.CharField(
        max_length=64,
        validators=[validate_license],
        help_text="SPDX identifier, e.g. CC0-1.0, MIT, Apache-2.0.",
    )
    license_url = models.URLField(blank=True, help_text="The licence text the artwork is distributed under.")
    attribution = models.TextField(
        blank=True,
        help_text="Copyright notice(s) the licence asks to be kept with the artwork.",
    )
    source_url = models.URLField(blank=True, help_text="Where the artwork comes from (attribution).")
    source_ref = models.CharField(
        max_length=160,
        blank=True,
        editable=False,
        help_text="Exact upstream release last synced by `sync_element_packs`, e.g. lucide-static@1.52.0.",
    )
    sync_fingerprint = models.CharField(max_length=64, blank=True, editable=False)
    synced_at = models.DateTimeField(null=True, blank=True, editable=False)
    description = models.TextField(blank=True)
    thumbnail = models.ImageField(
        upload_to=pack_thumbnail_path,
        blank=True,
        help_text="Optional. Packs without one are shown with their first element.",
    )
    sort_order = models.PositiveIntegerField(default=0)
    is_published = models.BooleanField(default=True)

    class Meta:
        ordering = ["sort_order", "name"]

    def __str__(self):
        return self.name


class ElementQuerySet(models.QuerySet):
    def bulk_create(self, *args, **kwargs):
        raise NotImplementedError(
            "Element.save() sanitises the SVG; use Element.objects.bulk_import() or save elements one by one."
        )

    def bulk_import(self, pack: ElementPack, entries, **options):
        """Create or refresh many elements of `pack` at once; every SVG is sanitised."""
        from .bulk import bulk_import

        return bulk_import(pack, entries, **options)


class Element(BaseModel):
    """One SVG graphic. Whatever path it arrives by, `save()` sanitises the SVG and derives its metadata."""

    pack = models.ForeignKey(ElementPack, on_delete=models.CASCADE, related_name="elements")
    key = models.CharField(
        max_length=200,
        blank=True,
        help_text="Stable id inside the pack (the import path without extension). Generated if empty.",
    )
    name = models.CharField(max_length=120)
    kind = models.CharField(max_length=16, choices=ElementKind.choices, default=ElementKind.SHAPE)
    style = models.CharField(max_length=16, choices=ElementStyle.choices, blank=True, default="")
    tags = models.JSONField(default=list, blank=True)
    search_name = models.CharField(max_length=160, blank=True, editable=False)
    search_tags = models.TextField(blank=True, editable=False)
    content_hash = models.CharField(max_length=64, blank=True, editable=False)
    svg = models.FileField(upload_to=element_svg_path, max_length=255)
    width = models.FloatField(default=0, editable=False)
    height = models.FloatField(default=0, editable=False)
    colors = models.JSONField(default=list, blank=True, editable=False)
    is_recolorable = models.BooleanField(default=False, editable=False)
    is_published = models.BooleanField(default=True)
    sort_order = models.PositiveIntegerField(default=0)

    objects = ElementQuerySet.as_manager()

    class Meta:
        ordering = ["sort_order", "name"]
        constraints = [models.UniqueConstraint(fields=["pack", "key"], name="elements_element_unique_key")]
        indexes = [
            models.Index(fields=["pack", "is_published", "sort_order"]),
            models.Index(fields=["kind", "is_published"]),
            models.Index(fields=["style", "is_published"]),
        ]

    def __str__(self):
        return self.name

    # ---- SVG ingestion -------------------------------------------------------------------------

    @property
    def has_pending_svg(self) -> bool:
        """True while `svg` holds an uploaded file that has not been stored (and so not sanitised) yet."""
        return bool(self.svg) and not self.svg._committed

    def ingest_svg(self) -> None:
        """Sanitise the pending upload in place and derive size, colours and recolour-ability from it.

        Raises `SvgError` when the upload is not a safe SVG. Idempotent: re-running it changes nothing.
        """
        upload = self.svg.file
        upload.seek(0)
        raw = upload.read(MAX_BYTES + 1)
        processed = process_svg(raw)
        self.width, self.height = processed.width, processed.height
        self.colors = processed.colors
        self.is_recolorable = processed.is_recolorable
        self.content_hash = hashlib.sha256(processed.data).hexdigest()
        self.svg = ContentFile(processed.data, name=f"{self.pk}.svg")

    def clean(self):
        super().clean()
        if self.has_pending_svg:
            try:
                self.ingest_svg()
            except SvgError as exc:
                raise ValidationError({"svg": str(exc)}) from exc

    def save(self, *args, **kwargs):
        if not self.svg:
            raise ValueError("An element needs an SVG file.")
        previous = ""
        if self.has_pending_svg:
            self.ingest_svg()  # cannot be bypassed: every stored SVG has been through sanitize_svg
            if not self._state.adding:
                previous = Element.objects.filter(pk=self.pk).values_list("svg", flat=True).first() or ""
            fields = kwargs.get("update_fields")
            if fields is not None:
                kwargs["update_fields"] = {
                    *fields,
                    "svg",
                    "width",
                    "height",
                    "colors",
                    "is_recolorable",
                    "content_hash",
                }
        if not self.key:
            self.key = self._free_key()
        self.refresh_search_fields()
        fields = kwargs.get("update_fields")
        if fields is not None and ({"name", "tags"} & set(fields)):
            kwargs["update_fields"] = {*fields, "search_name", "search_tags"}
        super().save(*args, **kwargs)
        if previous and previous != self.svg.name:
            self.svg.storage.delete(previous)

    def refresh_search_fields(self) -> None:
        """Re-derive the search columns from `name` and `tags` (`QuerySet.update()` bypasses `save()`)."""
        self.search_name = search_name(self.name)
        self.search_tags = search_tags(self.tags or [])

    def _free_key(self) -> str:
        base = slugify(self.name)[:150] or "element"
        taken = set(
            Element.objects.filter(pack_id=self.pack_id, key__startswith=base).values_list("key", flat=True)
        )
        candidate, counter = base, 1
        while candidate in taken:
            counter += 1
            candidate = f"{base}-{counter}"
        return candidate
