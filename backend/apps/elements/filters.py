from __future__ import annotations

import django_filters
from django.db.models import Q, QuerySet
from django.db.models.functions import Length

from .models import Element, ElementKind, ElementStyle
from .search import relevance_expression, split_query

ORDERING_CHOICES = [
    (value, value) for field in ("name", "created_at", "sort_order") for value in (field, f"-{field}")
] + [("relevance", "relevance")]


class ElementFilter(django_filters.rest_framework.FilterSet):
    """`pack`, `kind`, `style`, `q` and `ordering` for the element list.

    `q` is a multi-word search: every word must occur in the name or the tags (accent- and
    case-insensitive). With a query the default ordering is `relevance` (exact name match, then name
    prefix, then a word-prefix or substring of the name, then tags); without one it is the pack order.
    """

    pack = django_filters.CharFilter(field_name="pack__slug")
    kind = django_filters.ChoiceFilter(choices=ElementKind.choices)
    style = django_filters.ChoiceFilter(choices=ElementStyle.choices)
    q = django_filters.CharFilter(method="filter_q")
    ordering = django_filters.ChoiceFilter(choices=ORDERING_CHOICES, method="filter_ordering")

    class Meta:
        model = Element
        fields: list[str] = []

    def filter_q(self, queryset: QuerySet[Element], name: str, value: str) -> QuerySet[Element]:
        for word in split_query(value):
            queryset = queryset.filter(Q(search_name__contains=word) | Q(search_tags__contains=word))
        return queryset

    def filter_ordering(self, queryset: QuerySet[Element], name: str, value: str) -> QuerySet[Element]:
        return queryset  # applied in filter_queryset, once the search words are known

    def filter_queryset(self, queryset: QuerySet[Element]) -> QuerySet[Element]:
        queryset = super().filter_queryset(queryset)
        words = split_query(self.form.cleaned_data.get("q") or "")
        ordering = self.form.cleaned_data.get("ordering") or ("relevance" if words else "")
        if ordering == "relevance":
            if not words:
                return queryset  # nothing to rank by: keep the pack order
            return queryset.annotate(
                relevance=relevance_expression(words), name_length=Length("search_name")
            ).order_by("-relevance", "name_length", "pack__sort_order", "name", "id")
        if ordering:
            # Make the ordering total so pagination never repeats or skips a row.
            return queryset.order_by(ordering, "id")
        return queryset
