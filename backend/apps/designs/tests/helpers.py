from __future__ import annotations

import uuid


def make_doc(
    pages: int = 1, width: int = 800, height: int = 600, objects: list | None = None, **extra
) -> dict:
    doc = {
        "schemaVersion": 1,
        "width": width,
        "height": height,
        "unit": "px",
        "pages": [
            {
                "id": str(uuid.uuid4()),
                "background": {"type": "solid", "color": "#ffffff"},
                "objects": list(objects) if objects else [],
            }
            for _ in range(pages)
        ],
    }
    doc.update(extra)
    return doc


def text_object(text: str = "Hello") -> dict:
    return {"id": str(uuid.uuid4()), "type": "textbox", "text": text, "left": 10, "top": 20}


def image_object(src: str) -> dict:
    return {"id": str(uuid.uuid4()), "type": "image", "src": src}


def make_design(owner, title: str = "Design", **kwargs):
    from apps.designs.models import Design

    document = kwargs.pop("document", None) or make_doc()
    return Design.objects.create(
        owner=owner,
        title=title,
        width=document["width"],
        height=document["height"],
        page_count=len(document["pages"]),
        document=document,
        **kwargs,
    )
