"""User font uploads: validate by content, group into one family, enforce per-user limits."""

from __future__ import annotations

import uuid
from collections.abc import Sequence

from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.db import transaction
from django.db.models import Sum
from django.utils.text import slugify
from rest_framework import status
from rest_framework.exceptions import APIException, ValidationError

from .inspector import FontError, FontInfo, clean_family_name, inspect_font
from .models import FontFamily, FontOrigin, FontVariant

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_FILES_PER_UPLOAD = 5
MAX_FAMILIES_PER_USER = 50
MAX_BYTES_PER_USER = 150 * 1024 * 1024
USER_FONT_LICENSE = "user-supplied"


class FontConflict(APIException):
    status_code = status.HTTP_409_CONFLICT
    default_detail = "That font conflicts with an existing one."
    default_code = "font_conflict"


class FontLimitReached(APIException):
    status_code = status.HTTP_403_FORBIDDEN
    default_detail = "Font limit reached."
    default_code = "font_limit_reached"


def _reject(message: str, field: str = "files") -> ValidationError:
    return ValidationError({field: [message]})


def _read(upload) -> bytes:
    data = upload.read(MAX_FILE_BYTES + 1)
    if not data:
        raise _reject(f"{upload.name}: the file is empty.")
    if len(data) > MAX_FILE_BYTES:
        raise _reject(f"{upload.name}: the file is larger than 10 MB.")
    return data


def _describe(uploads: Sequence, family_override: str | None) -> list[tuple[bytes, FontInfo]]:
    if not 1 <= len(uploads) <= MAX_FILES_PER_UPLOAD:
        raise _reject(f"Upload between 1 and {MAX_FILES_PER_UPLOAD} font files at a time.")
    described = []
    for upload in uploads:
        data = _read(upload)
        try:
            described.append((data, inspect_font(data)))
        except FontError as exc:
            raise _reject(f"{upload.name}: {exc}") from exc
    names = {info.family for _, info in described}
    if len(names) > 1 and not family_override:
        raise _reject(
            "These files belong to different families ("
            + ", ".join(sorted(names))
            + "). Upload one family at a time or choose a family name."
        )
    slots = [(info.weight, info.style) for _, info in described]
    if len(set(slots)) != len(slots):
        raise _reject("Two of the files have the same weight and style.")
    return described


def add_user_font(
    user, uploads: Sequence, *, family: str | None = None, category: str | None = None
) -> FontFamily:
    """Store the uploaded font files as one family owned by `user`. Raises DRF API exceptions."""
    override = None
    if family and family.strip():
        override = clean_family_name(family)
        if not override:
            raise _reject("The family name has no usable letters or digits.", "family")
    described = _describe(uploads, override)
    name = override or described[0][1].family

    if FontFamily.objects.filter(owner__isnull=True, family__iexact=name).exists():
        raise FontConflict(
            f'A built-in font named "{name}" already exists. Choose a different family name.',
            code="font_name_taken",
        )

    stored: list[str] = []
    try:
        with transaction.atomic():
            get_user_model().objects.select_for_update().get(pk=user.pk)  # serialises quota checks
            owned = FontFamily.objects.filter(owner=user)
            existing = owned.filter(family__iexact=name).first()
            if existing is None and owned.count() >= MAX_FAMILIES_PER_USER:
                raise FontLimitReached(
                    f"You can keep at most {MAX_FAMILIES_PER_USER} uploaded font families.",
                    code="font_limit_reached",
                )
            used = FontVariant.objects.filter(family__owner=user).aggregate(total=Sum("size"))["total"] or 0
            if used + sum(len(data) for data, _ in described) > MAX_BYTES_PER_USER:
                raise FontLimitReached(
                    "Your uploaded fonts would exceed the storage limit.", code="font_storage_limit"
                )
            if existing is None:
                existing = FontFamily.objects.create(
                    family=name,
                    slug=slugify(name) or "font",
                    category=category or described[0][1].category,
                    license=USER_FONT_LICENSE,
                    source=FontOrigin.UPLOAD,
                    owner=user,
                )
            else:
                taken = {(v.weight, v.style) for v in existing.variants.all()}
                clash = sorted(
                    {
                        f"{info.weight} {info.style}"
                        for _, info in described
                        if (info.weight, info.style) in taken
                    }
                )
                if clash:
                    raise FontConflict(
                        f'"{existing.family}" already has {", ".join(clash)}. Delete it first to replace.',
                        code="variant_exists",
                    )
            for data, info in described:
                variant = FontVariant(
                    id=uuid.uuid4(),
                    family=existing,
                    weight=info.weight,
                    style=info.style,
                    format=info.format,
                    size=len(data),
                )
                variant.file.save(f"{variant.id}.{info.format}", ContentFile(data), save=False)
                stored.append(variant.file.name)
                variant.save()
            existing.scripts = sorted({*existing.scripts, *(s for _, i in described for s in i.scripts)})
            existing.is_variable = existing.is_variable or any(i.is_variable for _, i in described)
            if category:
                existing.category = category
            existing.save()
    except BaseException:
        for path in stored:
            FontVariant._meta.get_field("file").storage.delete(path)
        raise
    return FontFamily.objects.prefetch_related("variants").get(pk=existing.pk)
