"""Whitelisted, tie-broken ordering for list endpoints (`?ordering=-name`)."""

from __future__ import annotations

from collections.abc import Mapping

from django.db.models import Expression, F, QuerySet
from rest_framework.exceptions import ValidationError


def order_queryset(
    queryset: QuerySet, param: str | None, allowed: Mapping[str, Expression | F], default: str
) -> QuerySet:
    """Order by a whitelisted key (optionally `-`-prefixed); unknown keys are a 400, ties break on pk."""
    key = (param or "").strip() or default
    descending = key.startswith("-")
    expression = allowed.get(key.removeprefix("-"))
    if expression is None:
        choices = ", ".join(sorted(allowed))
        raise ValidationError(
            {"ordering": [f"Unsupported ordering. Use one of: {choices} (prefix - for descending)."]}
        )
    return queryset.order_by(expression.desc() if descending else expression.asc(), "pk")
