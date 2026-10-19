from __future__ import annotations

import re

from django import forms
from django.contrib import admin
from django.core.exceptions import ValidationError
from django.http import HttpRequest
from django.utils.html import format_html
from django.utils.translation import gettext_lazy as _
from unfold.admin import ModelAdmin, TabularInline
from unfold.decorators import display

from .inspector import FontError, inspect_font
from .models import FontFamily, FontFormat, FontStyle, FontVariant
from .uploads import MAX_FILE_BYTES

PREVIEW_TEXT = "The quick brown fox jumps over the lazy dog"
_SAFE_URL = re.compile(r"^[A-Za-z0-9/_.:%?=&~+-]+$")
_CSS_FORMAT = {
    FontFormat.WOFF2: "woff2",
    FontFormat.WOFF: "woff",
    FontFormat.TTF: "truetype",
    FontFormat.OTF: "opentype",
}


class FontVariantAdminForm(forms.ModelForm):
    class Meta:
        model = FontVariant
        fields = ["weight", "style", "subset", "file"]

    def clean(self):
        cleaned = super().clean()
        upload = cleaned.get("file")
        if upload and "file" in self.changed_data and hasattr(upload, "read"):
            data = upload.read(MAX_FILE_BYTES + 1)
            if len(data) > MAX_FILE_BYTES:
                raise ValidationError({"file": _("The file is larger than 10 MB.")})
            try:
                info = inspect_font(data)
            except FontError as exc:
                raise ValidationError({"file": str(exc)}) from exc
            upload.seek(0)
            self.instance.format = info.format
            self.instance.size = len(data)
        return cleaned


class FontVariantInline(TabularInline):
    model = FontVariant
    form = FontVariantAdminForm
    extra = 0
    fields = ["weight", "style", "subset", "file", "file_format", "file_size"]
    readonly_fields = ["file_format", "file_size"]

    @display(description=_("Format"))
    def file_format(self, obj: FontVariant) -> str:
        return obj.get_format_display() if obj.pk else "—"

    @display(description=_("Size"))
    def file_size(self, obj: FontVariant) -> str:
        return f"{obj.size / 1024:.1f} KB" if obj.pk else "—"


def preview_variant(family: FontFamily) -> FontVariant | None:
    """The variant used for the sample text: regular weight, normal style, Latin when available."""
    variants = list(family.variants.all())
    if not variants:
        return None
    return min(
        variants,
        key=lambda v: (
            v.style != FontStyle.NORMAL,
            abs(v.weight - 400),
            v.subset not in ("", "latin"),
        ),
    )


@admin.register(FontFamily)
class FontFamilyAdmin(ModelAdmin):
    list_display = [
        "family",
        "sample",
        "category",
        "scripts_list",
        "variant_count",
        "source",
        "owner",
        "popularity",
        "is_published",
    ]
    list_editable = ["is_published"]
    list_filter = ["source", "category", "is_published"]
    list_select_related = ["owner"]
    list_per_page = 40
    search_fields = ["family", "slug", "owner__email"]
    prepopulated_fields = {"slug": ("family",)}
    inlines = [FontVariantInline]
    actions = ["publish", "unpublish"]
    readonly_fields = ["owner", "created_at", "updated_at"]
    fieldsets = [
        (None, {"fields": ["family", "slug", "category", "is_published"]}),
        (_("Coverage"), {"fields": ["scripts", "is_variable", "popularity"]}),
        (_("Origin"), {"fields": ["source", "license", "owner"]}),
        (_("Audit"), {"fields": ["created_at", "updated_at"], "classes": ["collapse"]}),
    ]

    def get_queryset(self, request: HttpRequest):
        return super().get_queryset(request).prefetch_related("variants")

    @display(description=_("Preview"))
    def sample(self, obj: FontFamily):
        variant = preview_variant(obj)
        if variant is None or not _SAFE_URL.match(variant.file.url):
            return "—"
        face = f"doory-preview-{obj.pk.hex}"
        return format_html(
            '<style>@font-face{{font-family:"{face}";font-weight:{weight};font-style:{style};'
            'src:url("{url}") format("{fmt}")}}</style>'
            "<span style=\"font-family:'{face}',sans-serif;font-weight:{weight};font-style:{style};"
            'font-size:1.1rem;white-space:nowrap">{text}</span>',
            face=face,
            weight=variant.weight,
            style=variant.style,
            url=variant.file.url,
            fmt=_CSS_FORMAT[variant.format],
            text=PREVIEW_TEXT,
        )

    @display(description=_("Scripts"))
    def scripts_list(self, obj: FontFamily) -> str:
        return ", ".join(obj.scripts)

    @display(description=_("Files"))
    def variant_count(self, obj: FontFamily) -> int:
        return len(obj.variants.all())

    @admin.action(description=_("Publish selected families"))
    def publish(self, request: HttpRequest, queryset) -> None:
        self.message_user(
            request, _("%(n)d family/families published.") % {"n": queryset.update(is_published=True)}
        )

    @admin.action(description=_("Unpublish selected families"))
    def unpublish(self, request: HttpRequest, queryset) -> None:
        self.message_user(
            request, _("%(n)d family/families unpublished.") % {"n": queryset.update(is_published=False)}
        )
