"""Create or update a template from a JSON description (used by `import_template`).

```json
{"title": "Summer Sale", "category": "marketing", "tags": ["sale"], "document": {...},
 "slug": "summer-sale", "description": "...", "preset": "instagram-post", "is_featured": false,
 "is_published": true, "thumbnail": "summer-sale.png"}
```

Only `title` and `document` are required. The import is idempotent on the slug (given, or derived from the
title): re-importing updates the row in place and keeps its use count and creator.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from django.db import transaction
from django.utils.text import slugify

from apps.core.images import ImageError

from .models import Template, TemplateCategory
from .services import replace_thumbnail, thumbnail_from_upload
from .validators import TemplateDocumentError, normalize_tags

_SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_KNOWN_KEYS = {
    "title",
    "slug",
    "category",
    "description",
    "tags",
    "preset",
    "is_featured",
    "is_published",
    "document",
    "thumbnail",
}


class TemplateImportError(ValueError):
    """The JSON description cannot be imported; the message names the problem."""


def _text(data: dict[str, Any], key: str, *, limit: int, required: bool = False) -> str | None:
    value = data.get(key)
    if value is None:
        if required:
            raise TemplateImportError(f'"{key}" is required.')
        return None
    if not isinstance(value, str) or (required and not value.strip()) or len(value) > limit:
        raise TemplateImportError(f'"{key}" must be a non-empty string of at most {limit} characters.')
    return value.strip() if key != "description" else value


def _flag(data: dict[str, Any], key: str) -> bool | None:
    value = data.get(key)
    if value is not None and not isinstance(value, bool):
        raise TemplateImportError(f'"{key}" must be true or false.')
    return value


def _resolve_category(value: Any, *, create: bool) -> TemplateCategory | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise TemplateImportError('"category" must be a category slug or name.')
    ref = value.strip()
    match = (
        TemplateCategory.objects.filter(slug=slugify(ref)).first()
        or TemplateCategory.objects.filter(name__iexact=ref).first()
    )
    if match:
        return match
    if create:
        slug = slugify(ref)
        if not slug:
            raise TemplateImportError(f'"{ref}" is not a usable category name.')
        return TemplateCategory.objects.create(slug=slug, name=ref[:80])
    known = ", ".join(TemplateCategory.objects.values_list("slug", flat=True)) or "none yet"
    raise TemplateImportError(
        f'Unknown category "{ref}" (known: {known}). Run seed_gallery or pass --create-categories.'
    )


def _read_thumbnail(reference: Any, base_dir: Path | None, slug: str):
    if not isinstance(reference, str) or not reference.strip():
        raise TemplateImportError('"thumbnail" must be a file path relative to the JSON file.')
    if base_dir is None:
        raise TemplateImportError('"thumbnail" needs a JSON file to resolve its path against.')
    root = base_dir.resolve()
    path = (root / reference).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise TemplateImportError(f'Thumbnail "{reference}" was not found next to the JSON file.')
    try:
        with path.open("rb") as handle:
            return thumbnail_from_upload(handle, slug=slug)
    except ImageError as exc:
        raise TemplateImportError(f'Thumbnail "{reference}": {exc}') from exc


@transaction.atomic
def import_template(
    data: Any,
    *,
    base_dir: Path | None = None,
    publish: bool | None = None,
    create_categories: bool = False,
) -> tuple[Template, bool]:
    """Import one template description. Returns `(template, created)`; raises `TemplateImportError`."""
    if not isinstance(data, dict):
        raise TemplateImportError("The file must contain a JSON object.")
    unknown = sorted(set(data) - _KNOWN_KEYS)
    if unknown:
        raise TemplateImportError(f"Unknown field(s): {', '.join(unknown)}.")

    title = _text(data, "title", limit=200, required=True)
    slug = _text(data, "slug", limit=Template._meta.get_field("slug").max_length) or slugify(title)
    if not _SLUG.match(slug or ""):
        raise TemplateImportError(f'"{slug}" is not a valid slug (lower-case letters, digits and hyphens).')
    try:
        if "tags" in data and not isinstance(data["tags"], list):
            raise ValueError("Tags must be a list of strings.")
        tags = normalize_tags(data.get("tags"))
    except ValueError as exc:
        raise TemplateImportError(f'"tags": {exc}') from exc

    template = Template.objects.filter(slug=slug).first()
    created = template is None
    if template is None:
        template = Template(slug=slug)
    template.title = title
    if (description := _text(data, "description", limit=5000)) is not None:
        template.description = description
    if "tags" in data:
        template.tags = tags
    if "category" in data:
        template.category = _resolve_category(data["category"], create=create_categories)
    if (preset := _text(data, "preset", limit=64)) is not None:
        template.preset = preset
    if (featured := _flag(data, "is_featured")) is not None:
        template.is_featured = featured
    published = publish if publish is not None else _flag(data, "is_published")
    if published is not None:
        template.is_published = published
    try:
        template.apply_document(data.get("document"))
    except TemplateDocumentError as exc:
        raise TemplateImportError(f"Invalid document: {exc}") from exc

    thumbnail = _read_thumbnail(data["thumbnail"], base_dir, slug) if "thumbnail" in data else None
    if thumbnail is not None:
        replace_thumbnail(template, thumbnail)
    template.save()
    return template, created
