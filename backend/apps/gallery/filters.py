from __future__ import annotations

import django_filters
from django.db.models import F, Q, QuerySet

from .models import Template

MAX_SEARCH_WORDS = 8
ORIENTATIONS = [("landscape", "Landscape"), ("portrait", "Portrait"), ("square", "Square")]


class TemplateFilter(django_filters.rest_framework.FilterSet):
    category = django_filters.CharFilter(field_name="category__slug")
    q = django_filters.CharFilter(method="filter_q")
    orientation = django_filters.ChoiceFilter(choices=ORIENTATIONS, method="filter_orientation")
    preset = django_filters.CharFilter(field_name="preset")
    featured = django_filters.BooleanFilter(field_name="is_featured")
    ordering = django_filters.OrderingFilter(
        fields=(("use_count", "use_count"), ("created_at", "created_at"), ("title", "title"))
    )

    class Meta:
        model = Template
        fields: list[str] = []

    def filter_q(self, queryset: QuerySet[Template], name: str, value: str) -> QuerySet[Template]:
        """Every word must appear in the title, description or tags (case-insensitive)."""
        for word in value.split()[:MAX_SEARCH_WORDS]:
            queryset = queryset.filter(
                Q(title__icontains=word) | Q(description__icontains=word) | Q(tags__icontains=word)
            )
        return queryset

    def filter_orientation(self, queryset: QuerySet[Template], name: str, value: str) -> QuerySet[Template]:
        if value == "square":
            return queryset.filter(width=F("height"))
        if value == "landscape":
            return queryset.filter(width__gt=F("height"))
        return queryset.filter(width__lt=F("height"))

    def filter_queryset(self, queryset: QuerySet[Template]) -> QuerySet[Template]:
        """Apply the filters, then make the ordering total so pagination never repeats or skips rows."""
        queryset = super().filter_queryset(queryset)
        ordering = list(queryset.query.order_by)
        used = {field.lstrip("-") for field in ordering}
        ordering += [
            tiebreaker
            for name, tiebreaker in (("created_at", "-created_at"), ("id", "id"))
            if name not in used
        ]
        return queryset.order_by(*ordering)
