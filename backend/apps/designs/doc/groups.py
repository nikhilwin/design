"""Grouping and ungrouping, with Fabric.js's geometry.

Fabric keeps a group's stored size and position when it loads one (it does not re-fit), so the server
must compute them exactly as `new Group(objects)` does: the union of each child's bounds
(`LayoutStrategies/utils.ts` `getObjectBounds`), around the child's centre, sized by its own transform, with
the stroke scaled along unless `strokeUniform`, in which case it is added afterwards. Children are then
stored relative to the group's centre. Ungrouping applies the group's transform back to each child.
"""

from __future__ import annotations

import math
from typing import Any

from . import builders

_ORIGIN = {"left": -0.5, "top": -0.5, "center": 0.0, "right": 0.5, "bottom": 0.5}
_NO_STROKE_TYPES = frozenset({"image", "group"})  # Fabric's default strokeWidth is 1, except for these
_ROUND = 4


class GroupError(ValueError):
    pass


def _num(value: Any, default: float) -> float:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else default


def _stroke(obj: dict) -> float:
    default = 0.0 if str(obj.get("type", "")).lower() in _NO_STROKE_TYPES else 1.0
    return _num(obj.get("strokeWidth"), default)


def _own(obj: dict) -> tuple[float, float, float, float, float]:
    """width, height, scaleX (signed, flips included), scaleY, angle in radians."""
    if _num(obj.get("skewX"), 0) or _num(obj.get("skewY"), 0):
        raise GroupError("Skewed objects cannot be grouped or ungrouped here; use the editor.")
    sx = _num(obj.get("scaleX"), 1.0) * (-1 if obj.get("flipX") else 1)
    sy = _num(obj.get("scaleY"), 1.0) * (-1 if obj.get("flipY") else 1)
    return (
        _num(obj.get("width"), 0.0),
        _num(obj.get("height"), 0.0),
        sx,
        sy,
        math.radians(_num(obj.get("angle"), 0.0)),
    )


def _dimensions(obj: dict) -> tuple[float, float]:
    """`_getTransformedDimensions` without rotation: the scaled size including the stroke."""
    width, height, sx, sy, _ = _own(obj)
    stroke = _stroke(obj)
    uniform = bool(obj.get("strokeUniform"))
    pre, post = (0.0, stroke) if uniform else (stroke, 0.0)
    return abs((width + pre) * sx) + post, abs((height + pre) * sy) + post


def centre(obj: dict) -> tuple[float, float]:
    """`translateToCenterPoint`: the object's centre in its parent's plane."""
    left, top = _num(obj.get("left"), 0.0), _num(obj.get("top"), 0.0)
    fx = -_ORIGIN.get(str(obj.get("originX", "left")), -0.5)
    fy = -_ORIGIN.get(str(obj.get("originY", "top")), -0.5)
    if not fx and not fy:
        return left, top
    dim_x, dim_y = _dimensions(obj)
    dx, dy = fx * dim_x, fy * dim_y
    angle = math.radians(_num(obj.get("angle"), 0.0))
    cos, sin = math.cos(angle), math.sin(angle)
    return left + dx * cos - dy * sin, top + dx * sin + dy * cos


def bounds(obj: dict) -> tuple[float, float, float, float]:
    """`getObjectBounds`: min x, min y, max x, max y of the object's axis-aligned bounds."""
    width, height, sx, sy, angle = _own(obj)
    stroke = _stroke(obj)
    uniform = bool(obj.get("strokeUniform"))
    if str(obj.get("type", "")).lower() in ("polygon", "polyline") and obj.get("exactBoundingBox"):
        stroke = 0.0  # already part of its width and height
    w = width + (0.0 if uniform else stroke)
    h = height + (0.0 if uniform else stroke)
    cos, sin = math.cos(angle), math.sin(angle)
    a, b, c, d = cos * sx, sin * sx, -sin * sy, cos * sy  # calcOwnMatrix without translation
    half_x = (abs(a) * w + abs(c) * h + (stroke if uniform else 0.0)) / 2
    half_y = (abs(b) * w + abs(d) * h + (stroke if uniform else 0.0)) / 2
    cx, cy = centre(obj)
    return cx - half_x, cy - half_y, cx + half_x, cy + half_y


def group(children: list[dict], group_id: str) -> dict:
    """`new Group(children)`: a group around `children` (bottom to top), which it takes over."""
    boxes = [bounds(child) for child in children]
    min_x, min_y = min(b[0] for b in boxes), min(b[1] for b in boxes)
    max_x, max_y = max(b[2] for b in boxes), max(b[3] for b in boxes)
    gx, gy = (min_x + max_x) / 2, (min_y + max_y) / 2
    for child in children:
        child["left"] = round(_num(child.get("left"), 0.0) - gx, _ROUND)
        child["top"] = round(_num(child.get("top"), 0.0) - gy, _ROUND)
    return {
        "id": group_id,
        "type": "group",
        "originX": "center",
        "originY": "center",
        "left": round(gx, _ROUND),
        "top": round(gy, _ROUND),
        "width": round(max_x - min_x, _ROUND),
        "height": round(max_y - min_y, _ROUND),
        "strokeWidth": 0,
        "layoutManager": {"type": "layoutManager", "strategy": "fit-content"},
        "interactive": False,
        "subTargetCheck": False,
        "objects": children,
    }


def ungroup(obj: dict) -> list[dict]:
    """The group's children placed on the page as they appear (`group.removeAll()`)."""
    _, _, sx, sy, angle = _own(obj)
    if not math.isclose(sx, sy, rel_tol=1e-9) or sx <= 0:
        raise GroupError("This group is stretched or flipped; ungroup it in the editor.")
    gx, gy = centre(obj)
    cos, sin = math.cos(angle), math.sin(angle)
    children = obj.get("objects") if isinstance(obj.get("objects"), list) else []
    placed = []
    for child in children:
        if not isinstance(child, dict):
            continue
        cx, cy = centre(child)
        child = dict(child)
        child["left"] = round(gx + sx * (cx * cos - cy * sin), _ROUND)
        child["top"] = round(gy + sx * (cx * sin + cy * cos), _ROUND)
        child["originX"] = child["originY"] = "center"
        if angle:
            child["angle"] = builders._num(
                round((_num(child.get("angle"), 0.0) + math.degrees(angle)) % 360, 6)
            )
        if sx != 1:
            for key in ("scaleX", "scaleY"):
                child[key] = round(_num(child.get(key), 1.0) * sx, 6)
        placed.append(child)
    return placed
