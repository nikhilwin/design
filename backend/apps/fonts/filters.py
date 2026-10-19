from __future__ import annotations

import json
import re

import django_filters
from django.core.exceptions import ValidationError
from django.db.models import QuerySet

from .models import FontCategory, FontFamily

MAX_SEARCH_WORDS = 6
_SCRIPT = re.compile(r"^[a-z]+(?:-[a-z]+)?$")


def validate_script(value: str) -> None:
    if not _SCRIPT.match(value):
        raise ValidationError("Use a script name such as latin, cyrillic or devanagari.")


class FontFilter(django_filters.rest_framework.FilterSet):
    q = django_filters.CharFilter(method="filter_q")
    category = django_filters.ChoiceFilter(choices=FontCategory.choices)
    script = django_filters.CharFilter(method="filter_script", validators=[validate_script])
    ordering = django_filters.OrderingFilter(
        fields=(("popularity", "popularity"), ("family", "family"), ("created_at", "created_at"))
    )

    class Meta:
        model = FontFamily
        fields: list[str] = []

    def filter_q(self, queryset: QuerySet[FontFamily], name: str, value: str) -> QuerySet[FontFamily]:
        for word in value.split()[:MAX_SEARCH_WORDS]:
            queryset = queryset.filter(family__icontains=word)
        return queryset

    def filter_script(self, queryset: QuerySet[FontFamily], name: str, value: str) -> QuerySet[FontFamily]:
        # The quotes make `latin` match the element "latin" but not "latin-ext".
        return queryset.filter(scripts__icontains=json.dumps(value))

    def filter_queryset(self, queryset: QuerySet[FontFamily]) -> QuerySet[FontFamily]:
        """Make the ordering total so pagination never repeats or skips rows."""
        queryset = super().filter_queryset(queryset)
        ordering = list(queryset.query.order_by)
        used = {field.lstrip("-") for field in ordering}
        ordering += [tiebreaker for tiebreaker in ("family", "id") if tiebreaker not in used]
        return queryset.order_by(*ordering)
