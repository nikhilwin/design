from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from django.core.files.base import ContentFile

from apps.fonts.models import FontFamily, FontVariant

FAKE_WOFF2 = b"wOF2" + b"\x00" * 200


def make_family(
    family: str = "Test Sans",
    *,
    variants: Iterable[tuple[int, str, str]] = ((400, "normal", "latin"),),
    owner=None,
    **kwargs: Any,
) -> FontFamily:
    """A family with files in storage. `variants` are (weight, style, subset) triples."""
    kwargs.setdefault("slug", family.lower().replace(" ", "-"))
    row = FontFamily.objects.create(family=family, owner=owner, **kwargs)
    for weight, style, subset in variants:
        variant = FontVariant(family=row, weight=weight, style=style, subset=subset, size=len(FAKE_WOFF2))
        variant.file.save(f"{weight}-{style}-{subset}.woff2", ContentFile(FAKE_WOFF2), save=False)
        variant.save()
    return row
