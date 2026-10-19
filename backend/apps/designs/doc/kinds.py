"""Which kind of object a document entry is, decided like the editor does (`objects/builtinKinds.ts`)."""

from __future__ import annotations

TEXT_TYPES = frozenset({"textbox", "itext", "i-text", "text"})
SHAPE_TYPES = frozenset({"rect", "ellipse", "circle", "triangle", "polygon", "polyline", "path"})
LINE_TYPES = frozenset({"doryline", "line"})
GROUP_TYPES = frozenset({"group", "activeselection"})


def object_kind(obj: dict) -> str:
    """qr, placeholder, element, image, text, line, shape, group or unknown (highest priority first)."""
    kind = str(obj.get("type", "")).lower()
    if obj.get("qr"):
        return "qr"
    if obj.get("isPlaceholder") is True:
        return "placeholder"
    if isinstance(obj.get("elementId"), str):
        return "element"
    if kind == "image":
        return "image"
    if kind in TEXT_TYPES:
        return "text"
    if kind in LINE_TYPES:
        return "line"
    if kind in SHAPE_TYPES:
        return "shape"
    if kind in GROUP_TYPES:
        return "group"
    return "unknown"
