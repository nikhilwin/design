from __future__ import annotations

import uuid
from typing import Any

from apps.gallery.models import Template, TemplateCategory


def make_document(width: int = 1080, height: int = 1080, pages: int = 1, **extra: Any) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "width": width,
        "height": height,
        "unit": "px",
        "pages": [
            {
                "id": str(uuid.uuid4()),
                "background": {"type": "solid", "color": "#ffffff"},
                "objects": [
                    {"id": str(uuid.uuid4()), "type": "textbox", "text": "Hello", "left": 10, "top": 10}
                ],
            }
            for _ in range(pages)
        ],
        **extra,
    }


def make_category(name: str = "Social Media", **kwargs: Any) -> TemplateCategory:
    slug = kwargs.pop("slug", name.lower().replace(" ", "-"))
    return TemplateCategory.objects.create(name=name, slug=slug, **kwargs)


def make_template(title: str = "Summer Sale", **kwargs: Any) -> Template:
    document = kwargs.pop("document", None) or make_document(
        kwargs.pop("width", 1080), kwargs.pop("height", 1080), kwargs.pop("pages", 1)
    )
    kwargs.setdefault("slug", title.lower().replace(" ", "-"))
    kwargs.setdefault("is_published", True)
    kwargs.pop("width", None)
    kwargs.pop("height", None)
    return Template.objects.create(
        title=title,
        width=document["width"],
        height=document["height"],
        page_count=len(document["pages"]),
        document=document,
        **kwargs,
    )
