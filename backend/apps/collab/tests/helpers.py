"""Shared test helpers: documents, JSON canonicalisation."""

from __future__ import annotations

import uuid
from typing import Any


def canon(value: Any) -> Any:
    """JSON with integral floats turned into ints (the Y encoding cannot tell them apart)."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [canon(item) for item in value]
    if isinstance(value, dict):
        return {key: canon(item) for key, item in value.items()}
    return value


def make_object(index: int = 0, **extra: Any) -> dict:
    return {
        "id": str(uuid.uuid4()),
        "type": ("rect", "textbox", "ellipse", "image", "group")[index % 5],
        "name": f"Layer {index}",
        "left": 10.5 + index,
        "top": 20 + index,
        "width": 100,
        "height": 50.25,
        "angle": 0,
        "fill": "#ff0000",
        "opacity": 1,
        "shadow": {"color": "#000000", "blur": 5, "offsetX": 2, "offsetY": 2},
        "visible": True,
        "locked": False,
        **extra,
    }


def sample_document(pages: int = 1, objects: int = 3, **extra: Any) -> dict:
    return {
        "schemaVersion": 1,
        "width": 800,
        "height": 600,
        "unit": "px",
        "meta": {"presetId": "instagram-post"},
        "pages": [
            {
                "id": str(uuid.uuid4()),
                "name": f"Page {number + 1}",
                "background": {"type": "solid", "color": "#ffffff"},
                "objects": [make_object(index) for index in range(objects)],
            }
            for number in range(pages)
        ],
        **extra,
    }
