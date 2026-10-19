from __future__ import annotations

from typing import Any

from django.db.models import Prefetch
from rest_framework import serializers

from .models import FontCategory, FontFamily, FontVariant

# Order in which a family's subsets are preferred as the "default" file of a weight/style.
SUBSET_PRIORITY = {"": 0, "latin": 1, "latin-ext": 2}
MAX_FONT_FILES = 5


def with_variants() -> Prefetch:
    """Prefetch of a family's files in the order the serializer lists them."""
    return Prefetch("variants", queryset=FontVariant.objects.order_by("weight", "style", "subset"))


def _primary(rows: list[FontVariant]) -> FontVariant:
    return min(rows, key=lambda row: (SUBSET_PRIORITY.get(row.subset, 10), row.subset))


class FontFamilySerializer(serializers.ModelSerializer):
    """A family with one entry per weight/style. `url` is the default (Latin) file; `subsets` lists every
    per-script file, and `unicode_ranges` maps each subset to its CSS `unicode-range`, so the editor can
    load Cyrillic, Greek, etc. on demand."""

    is_user_font = serializers.BooleanField(read_only=True)
    variants = serializers.SerializerMethodField()
    unicode_ranges = serializers.SerializerMethodField()

    class Meta:
        model = FontFamily
        fields = [
            "id",
            "family",
            "category",
            "scripts",
            "is_variable",
            "is_user_font",
            "variants",
            "unicode_ranges",
            "popularity",
        ]
        read_only_fields = fields

    def get_variants(self, obj: FontFamily) -> list[dict[str, Any]]:
        groups: dict[tuple[int, str], list[FontVariant]] = {}
        for variant in obj.variants.all():
            groups.setdefault((variant.weight, variant.style), []).append(variant)
        return [
            {
                "weight": weight,
                "style": style,
                "url": _primary(rows).file.url,
                "subsets": [
                    {"subset": row.subset, "url": row.file.url}
                    for row in sorted(rows, key=lambda r: (SUBSET_PRIORITY.get(r.subset, 10), r.subset))
                    if row.subset
                ],
            }
            for (weight, style), rows in sorted(
                groups.items(), key=lambda item: (item[0][0], item[0][1] != "normal")
            )
        ]

    def get_unicode_ranges(self, obj: FontFamily) -> dict[str, str]:
        ranges: dict[str, str] = {}
        for variant in obj.variants.all():
            if variant.subset and variant.unicode_range:
                ranges.setdefault(variant.subset, variant.unicode_range)
        return dict(sorted(ranges.items(), key=lambda item: (SUBSET_PRIORITY.get(item[0], 10), item[0])))


class FontUploadSerializer(serializers.Serializer):
    files = serializers.ListField(
        child=serializers.FileField(allow_empty_file=False, max_length=255),
        min_length=1,
        max_length=MAX_FONT_FILES,
        allow_empty=False,
    )
    family = serializers.CharField(required=False, allow_blank=True, max_length=100)
    category = serializers.ChoiceField(choices=FontCategory.choices, required=False)
