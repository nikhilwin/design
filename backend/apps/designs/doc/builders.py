"""Objects built the way the editor's "Add …" actions build them (`objects/factories.ts`).

Positions given to the builders are the top-left corner of the object's box in page pixels; the objects
themselves are centred on their position (`originX/Y: center`), like every object the editor makes.
"""

from __future__ import annotations

import copy
import json
import math
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

SHAPE_FILL = "#7a64e0"
TEXT_COLOR = "#1c1517"
HEADING_FONT = '"Plus Jakarta Sans", sans-serif'
BODY_FONT = '"Inter", sans-serif'
PRESET_PAGE_SIDE = 559  # the page side the text presets are specified for (A5 at 96 dpi)
FONT_SIZE_MULT = 1.13  # Fabric's `_fontSizeMult`: a line of text is this many font sizes tall
QR_SIDE = 512  # the QR code SVG the editor renders is 512 px square
QR_MAX_TEXT = 1000

TextPreset = Literal["heading", "subheading", "body"]
TextAlign = Literal["left", "center", "right", "justify"]
ShapeKind = Literal["rect", "ellipse", "triangle", "polygon", "star", "path"]

# The editor's catalogue shapes (`shapeGeometry.ts` PATH_SHAPES) as Fabric stores them: the parsed path and
# the size of its exact bounding box. Taken from the editor; the contract test fails if they drift apart.
PATH_SHAPES: dict[str, dict] = json.loads((Path(__file__).with_name("path_shapes.json")).read_text())
PathShapeId = Literal[tuple(PATH_SHAPES)]  # type: ignore[valid-type]
ArrowHead = Literal["none", "triangle", "open", "circle", "diamond"]
FontCategory = Literal["sans-serif", "serif", "display", "handwriting", "monospace"]


@dataclass(frozen=True)
class TextPresetSpec:
    size: int
    color: str
    weight: int
    font: str
    width: float
    line_height: float


TEXT_PRESETS: dict[str, TextPresetSpec] = {
    "heading": TextPresetSpec(36, "#1a1a2e", 700, HEADING_FONT, 0.72, 1.16),
    "subheading": TextPresetSpec(22, "#334155", 600, BODY_FONT, 0.62, 1.16),
    "body": TextPresetSpec(16, "#475569", 400, BODY_FONT, 0.5, 1.16),
}


@dataclass(frozen=True)
class Page:
    width: int
    height: int


def new_id() -> str:
    return str(uuid.uuid4())


def text_scale(page: Page) -> float:
    """`textScale`: preset sizes grow with the page so text starts out readable on any format."""
    return min(5.0, max(0.5, min(page.width, page.height) / PRESET_PAGE_SIDE))


def default_shape_size(page: Page) -> int:
    return round(min(page.width, page.height) * 0.28)


GENERIC_FAMILY = {
    "sans-serif": "sans-serif",
    "serif": "serif",
    "display": "sans-serif",
    "handwriting": "cursive",
    "monospace": "monospace",
}


def primary_family(stack: str) -> str:
    """`primaryFamily`: the first family of a CSS font stack, unquoted."""
    return stack.split(",")[0].strip().strip("\"'")


def font_stack(family: str, category: str | None = None) -> str:
    """`fontStack`: `"Name", generic`, so text stays legible while the web font loads (or if it fails)."""
    name = primary_family(family).replace('"', "")
    return f'"{name}", {GENERIC_FAMILY.get(category or "sans-serif", "sans-serif")}'


def js_round(value: float) -> int:
    """`Math.round` (halves round up, unlike Python's banker's rounding)."""
    return math.floor(value + 0.5)


def _num(value: float) -> int | float:
    """Whole floats as ints, others to three decimals (the precision Fabric serialises with)."""
    rounded = round(value, 3)
    return int(rounded) if float(rounded).is_integer() else rounded


def _centred(x: float, y: float, width: float, height: float) -> dict:
    return {
        "originX": "center",
        "originY": "center",
        "left": _num(x + width / 2),
        "top": _num(y + height / 2),
    }


# ---------------------------------------------------------------------------------------------
# Text
# ---------------------------------------------------------------------------------------------

AVERAGE_GLYPH_WIDTH = 0.52  # of the font size; Latin text in the catalogue's sans fonts averages about this


def estimate_text_lines(text: str, width: float, font_size: float, weight: int = 400) -> int:
    """How many lines a textbox wraps to: an estimate (the editor measures with real font metrics)."""
    glyph = font_size * AVERAGE_GLYPH_WIDTH * (1.06 if weight >= 600 else 1.0)
    per_line = max(1, int(width // max(glyph, 0.1)))
    lines = 0
    for paragraph in text.split("\n"):
        length, count = 0, 1
        for word in paragraph.split(" "):
            needed = len(word) if length == 0 else length + 1 + len(word)
            if needed <= per_line:
                length = needed
                continue
            count += 1 if length else 0
            length = len(word)
            while length > per_line:  # a word longer than a line breaks inside the word
                count += 1
                length -= per_line
        lines += count
    return max(1, lines)


def text_height(lines: int, font_size: float, line_height: float) -> float:
    """Fabric's textbox height: every line is `fontSize * 1.13` tall, all but the last times `lineHeight`."""
    return font_size * FONT_SIZE_MULT * (1 + (lines - 1) * line_height)


MIN_FONT_SIZE = 4
MAX_FONT_SIZE = 999


def valid_font_size(value: Any) -> float | None:
    """`value` as a float when it is a finite number inside the editor's font size range (1..999)."""
    if (
        isinstance(value, int | float)
        and not isinstance(value, bool)
        and math.isfinite(value)
        and 1 <= float(value) <= MAX_FONT_SIZE
    ):
        return float(value)
    return None


def _pos_float(value: Any, default: float) -> float:
    if isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value) and value > 0:
        return float(value)
    return default


def default_min_font_size(font_size: float) -> int:
    return max(MIN_FONT_SIZE, js_round(font_size * 0.5))


def fit_font_size(
    text: str,
    width: float,
    height: float,
    font_size: float,
    weight: int = 400,
    line_height: float = 1.16,
    min_font_size: float | None = None,
) -> int | float:
    """Largest font size (stepped down in 1 px steps from `font_size` to `min_font_size`) at which `text`
    wraps inside `width x height`, found by binary search."""
    target = min(float(MAX_FONT_SIZE), max(float(MIN_FONT_SIZE), float(font_size)))
    raw_min = float(min_font_size) if min_font_size is not None else float(default_min_font_size(target))
    floor = min(target, max(float(MIN_FONT_SIZE), min(float(MAX_FONT_SIZE), raw_min)))

    def fits(size: float) -> bool:
        lines = estimate_text_lines(text, width, size, weight)
        return text_height(lines, size, line_height) <= height + 1e-3

    if fits(target) or target <= floor:
        return _num(target)
    low, high = 1, math.ceil(target - floor)
    while low < high:
        mid = (low + high) // 2
        if fits(max(floor, target - mid)):
            high = mid
        else:
            low = mid + 1
    return _num(max(floor, target - low))


def apply_fit(obj: dict, fit: dict | None) -> None:
    """Set or clear shrink-to-fit (`fit`) on a text object, keeping its height and deriving `fitFontSize`."""
    if not fit:
        obj.pop("fit", None)
        obj.pop("fitFontSize", None)
        return
    size = valid_font_size(obj.get("fontSize", 40.0))
    if size is None:
        obj.pop("fitFontSize", None)
        return
    obj["fit"] = fit
    width = _pos_float(obj.get("width"), 200.0)
    leading = _pos_float(obj.get("lineHeight"), 1.16)
    height = _pos_float(obj.get("height"), text_height(1, size, leading))
    weight = int(_pos_float(obj.get("fontWeight"), 400.0))
    min_size = fit.get("minFontSize")
    obj["fitFontSize"] = fit_font_size(
        str(obj.get("text", "")),
        width,
        height,
        size,
        weight,
        leading,
        float(min_size) if isinstance(min_size, int | float) and not isinstance(min_size, bool) else None,
    )


def build_text(
    page: Page,
    *,
    text: str,
    x: float | None = None,
    y: float | None = None,
    width: float | None = None,
    preset: TextPreset = "body",
    font_family: str | None = None,
    font_category: str | None = None,
    font_size: float | None = None,
    font_weight: int | None = None,
    color: str | None = None,
    align: TextAlign = "center",
    line_height: float | None = None,
) -> dict:
    spec = TEXT_PRESETS[preset]
    box_width = width if width is not None else js_round(page.width * spec.width)
    size = font_size if font_size is not None else js_round(spec.size * text_scale(page))
    weight = font_weight if font_weight is not None else spec.weight
    leading = line_height if line_height is not None else spec.line_height
    height = text_height(estimate_text_lines(text, box_width, size, weight), size, leading)
    left = x if x is not None else (page.width - box_width) / 2
    top = y if y is not None else (page.height - height) / 2
    return {
        "id": new_id(),
        "type": "textbox",
        "text": text,
        **_centred(left, top, box_width, height),
        "width": _num(box_width),
        "height": _num(height),
        "fontFamily": font_stack(font_family, font_category) if font_family else spec.font,
        "fontSize": _num(size),
        "fontWeight": weight,
        "fill": color or spec.color,
        "textAlign": align,
        "lineHeight": leading,
        "splitByGrapheme": False,
        "strokeUniform": True,
    }


CURVE_MAX = 400  # frontend/src/editor/engine/text/curve.ts


def apply_curve(obj: dict, amount: float) -> None:
    """Bend a text's baseline into an arc (negative = arch, positive = valley), as the editor stores it: only
    `curveAmount`; the editor rebuilds the arc when it loads the text. 0 straightens it."""
    amount = max(-CURVE_MAX, min(CURVE_MAX, amount))
    if amount:
        obj["curveAmount"] = _num(amount)
    else:
        obj.pop("curveAmount", None)


MaskShape = Literal[
    "circle", "rounded", "triangle", "diamond", "hexagon", "star", "heart", "blob", "arch", "cross"
]


def apply_mask(obj: dict, shape: str | None, radius: float | None = None) -> None:
    """Crop a picture to a shape (`masks.ts`): the editor rebuilds the clip from `maskShape` when it loads
    the picture. `radius` is the corner radius of `rounded`, as a fraction of the shorter side. None removes
    the mask."""
    obj.pop("clipPath", None)
    if shape:
        obj["maskShape"] = shape
    else:
        obj.pop("maskShape", None)
    if shape == "rounded" and radius is not None:
        obj["maskRadius"] = _num(max(0.0, min(0.5, radius)))
    elif shape != "rounded":
        obj.pop("maskRadius", None)


def apply_effects(obj: dict, effects: dict, *, text: bool) -> None:
    """Set an object's effects (`effects.ts` `applyEffects`): the declarative `effects` the editor reads,
    plus the native text props they imply, so an outline or highlight that is removed does not linger.
    The editor recreates the shadow from `effects` when it loads the object."""
    if effects:
        obj["effects"] = effects
    else:
        obj.pop("effects", None)
    obj.pop("shadow", None)
    if not text:
        return
    outline = effects.get("outline")
    if outline:
        obj.update(
            stroke=outline["color"],
            strokeWidth=_num(outline["width"]),
            paintFirst="stroke",
            strokeLineJoin="round",
            strokeUniform=True,
        )
    elif obj.get("stroke") is not None:
        obj.update(stroke=None, strokeWidth=0)
    background = effects.get("background")
    if background:
        obj["textBackgroundColor"] = background["color"]
    else:
        obj.pop("textBackgroundColor", None)


# ---------------------------------------------------------------------------------------------
# Shapes
# ---------------------------------------------------------------------------------------------


def _js_round3(value: float) -> float:
    return math.floor(value * 1000 + 0.5) / 1000


def _normalise(points: list[tuple[float, float]], size: float = 100) -> list[dict]:
    """`normalizePoints`: fit the points tightly into [0, size]² so the shape fills its box."""
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    min_x, min_y = min(xs), min(ys)
    w = (max(xs) - min_x) or 1
    h = (max(ys) - min_y) or 1
    return [
        {"x": _num(_js_round3((px - min_x) / w * size)), "y": _num(_js_round3((py - min_y) / h * size))}
        for px, py in points
    ]


def regular_polygon_points(sides: int, size: float = 100) -> list[dict]:
    n = max(3, min(12, js_round(sides)))
    r = size / 2
    pts = []
    for i in range(n):
        a = -math.pi / 2 + i * 2 * math.pi / n
        pts.append((r + r * math.cos(a), r + r * math.sin(a)))
    return _normalise(pts, size)


def star_points(points: int, inner_ratio: float, size: float = 100) -> list[dict]:
    n = max(3, min(24, js_round(points)))
    ratio = max(0.1, min(0.95, inner_ratio))
    r = size / 2
    pts = []
    for i in range(n * 2):
        radius = r if i % 2 == 0 else r * ratio
        a = -math.pi / 2 + i * math.pi / n
        pts.append((r + radius * math.cos(a), r + radius * math.sin(a)))
    return _normalise(pts, size)


def build_shape(
    page: Page,
    *,
    shape: ShapeKind,
    x: float | None = None,
    y: float | None = None,
    width: float | None = None,
    height: float | None = None,
    fill: str | None = None,
    stroke: str | None = None,
    stroke_width: float = 0,
    corner_radius: float = 0,
    sides: int = 6,
    star_tips: int = 5,
    inner_ratio: float = 0.45,
    path_shape: str | None = None,
) -> dict:
    size = default_shape_size(page)
    if shape == "path":
        return _build_path_shape(
            page, path_shape or "", x, y, width, height, fill, stroke, stroke_width, size
        )
    w = width if width is not None else (size if shape != "triangle" or height is None else height / 0.9)
    h = height if height is not None else (w * 0.9 if shape == "triangle" else w)
    left = x if x is not None else (page.width - w) / 2
    top = y if y is not None else (page.height - h) / 2
    obj: dict = {
        "id": new_id(),
        "type": shape if shape in ("rect", "ellipse", "triangle") else "polygon",
        **_centred(left, top, w, h),
        "fill": fill or SHAPE_FILL,
        "stroke": stroke,
        "strokeWidth": _num(stroke_width if stroke else 0),
        "strokeUniform": True,
        "shapeKind": shape,
    }
    if shape in ("rect", "ellipse", "triangle"):
        obj["width"], obj["height"] = _num(w), _num(h)
    if shape == "rect":
        obj["rx"] = obj["ry"] = _num(corner_radius)
    elif shape == "ellipse":
        obj["rx"], obj["ry"] = _num(w / 2), _num(h / 2)
    elif shape in ("polygon", "star"):
        # Points live in a 100 x 100 box; scaling stretches it to the requested size (like `polygonFrom`).
        obj.update(width=100, height=100, scaleX=_num(w / 100), scaleY=_num(h / 100))
        if shape == "polygon":
            obj["sides"] = max(3, min(12, sides))
            obj["points"] = regular_polygon_points(obj["sides"])
        else:
            obj["starPoints"] = max(3, min(24, star_tips))
            obj["innerRatio"] = max(0.1, min(0.95, inner_ratio))
            obj["points"] = star_points(obj["starPoints"], obj["innerRatio"])
    return obj


def _build_path_shape(page, shape_id, x, y, width, height, fill, stroke, stroke_width, size) -> dict:
    """`createPathShape`: a catalogue shape, scaled so its longer side is `size` unless a box is given."""
    if shape_id not in PATH_SHAPES:
        raise ValueError(f"Unknown shape {shape_id!r}; choose one of {', '.join(PATH_SHAPES)}.")
    data = PATH_SHAPES[shape_id]
    natural_w, natural_h = data["width"], data["height"]
    if width is not None and height is not None:
        scale_x, scale_y = width / natural_w, height / natural_h
    elif width is not None or height is not None:
        scale_x = scale_y = width / natural_w if width is not None else height / natural_h
    else:
        scale_x = scale_y = size / max(natural_w, natural_h)
    w, h = natural_w * scale_x, natural_h * scale_y
    left = x if x is not None else (page.width - w) / 2
    top = y if y is not None else (page.height - h) / 2
    return {
        "id": new_id(),
        "type": "path",
        **_centred(left, top, w, h),
        "width": natural_w,
        "height": natural_h,
        "scaleX": round(scale_x, 6),
        "scaleY": round(scale_y, 6),
        "path": copy.deepcopy(data["path"]),
        "fillRule": data["fillRule"],
        "fill": fill or SHAPE_FILL,
        "stroke": stroke,
        "strokeWidth": _num(stroke_width if stroke else 0),
        "strokeUniform": True,
        "shapeKind": "path",
        "shapeId": shape_id,
    }


# ---------------------------------------------------------------------------------------------
# Lines
# ---------------------------------------------------------------------------------------------


def build_line(
    *,
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    color: str = TEXT_COLOR,
    width: float = 6,
    arrow_start: ArrowHead = "none",
    arrow_end: ArrowHead = "none",
    dash: list[float] | None = None,
) -> dict:
    """A straight line from (x1, y1) to (x2, y2): a horizontal segment centred between them, rotated."""
    length = math.hypot(x2 - x1, y2 - y1)
    angle = math.degrees(math.atan2(y2 - y1, x2 - x1)) % 360
    return {
        "id": new_id(),
        "type": "doryline",
        "originX": "center",
        "originY": "center",
        "left": _num((x1 + x2) / 2),
        "top": _num((y1 + y2) / 2),
        "width": _num(max(length, 1)),
        "height": 0,
        "angle": _num(angle),
        "stroke": color,
        "strokeWidth": _num(width),
        "strokeDashArray": dash or None,
        "arrowStart": arrow_start,
        "arrowEnd": arrow_end,
    }


# ---------------------------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------------------------


def build_image(
    page: Page,
    *,
    src: str,
    natural_width: float,
    natural_height: float,
    x: float | None = None,
    y: float | None = None,
    width: float | None = None,
    height: float | None = None,
    asset_id: str | None = None,
    name: str | None = None,
) -> dict:
    """An image scaled to fit inside the requested box, proportions kept (default: half the page's shorter
    side)."""
    nat_w, nat_h = max(natural_width, 1), max(natural_height, 1)
    if width is None and height is None:
        side = min(page.width, page.height) * 0.5
        width = height = side
    if width is None:
        width = height * nat_w / nat_h  # type: ignore[operator]
    if height is None:
        height = width * nat_h / nat_w
    scale = min(width / nat_w, height / nat_h)
    w, h = nat_w * scale, nat_h * scale
    left = x if x is not None else (page.width - w) / 2
    top = y if y is not None else (page.height - h) / 2
    obj = {
        "id": new_id(),
        "type": "image",
        "src": src,
        **_centred(left, top, w, h),
        "width": _num(nat_w),
        "height": _num(nat_h),
        "scaleX": _num(scale),
        "scaleY": _num(scale),
        "strokeUniform": True,
    }
    if asset_id:
        obj["assetId"] = asset_id
    if name:
        obj["name"] = name
    return obj


def _frame_size(frame: tuple[float, float] | Page | dict) -> tuple[float, float]:
    if isinstance(frame, dict):
        w, h = float(frame["width"]), float(frame["height"])
    elif isinstance(frame, Page):
        w, h = float(frame.width), float(frame.height)
    else:
        w, h = float(frame[0]), float(frame[1])
    return max(w, 1.0), max(h, 1.0)


def cover_fit(
    frame: tuple[float, float] | Page | dict,
    img_w: float,
    img_h: float,
    focal: tuple[float, float] = (0.5, 0.5),
) -> dict:
    """Crop (`cropX`/`cropY`, `width`/`height`) and scale (`scaleX`/`scaleY`) a picture of size
    `img_w x img_h` so it covers `frame`, centred on `focal` (`[0, 0]` = top-left, `[1, 1]` = bottom-right),
    matching the editor's `coverFrame` (`insert.ts`)."""
    frame_w, frame_h = _frame_size(frame)
    nat_w, nat_h = max(float(img_w), 1.0), max(float(img_h), 1.0)
    fx = max(0.0, min(1.0, float(focal[0])))
    fy = max(0.0, min(1.0, float(focal[1])))
    scale = max(frame_w / nat_w, frame_h / nat_h)
    vis_w = min(nat_w, frame_w / scale)
    vis_h = min(nat_h, frame_h / scale)
    return {
        "cropX": _num(max(0.0, (nat_w - vis_w) * fx)),
        "cropY": _num(max(0.0, (nat_h - vis_h) * fy)),
        "width": _num(vis_w),
        "height": _num(vis_h),
        "scaleX": _num(scale),
        "scaleY": _num(scale),
    }


def _slot_mask_of(obj: dict) -> tuple[str | dict | None, float | None]:
    shape = obj.get("maskShape")
    radius = obj.get("maskRadius")
    if shape:
        return shape, float(radius) if isinstance(radius, int | float) else None
    obj_type = str(obj.get("type") or "").lower()
    if obj_type in ("ellipse", "circle"):
        return "circle", None
    if obj_type == "rect" and float(obj.get("rx") or 0) > 0:
        side = max(1.0, min(float(obj.get("width") or 1), float(obj.get("height") or 1)))
        return "rounded", min(0.5, float(obj["rx"]) / side)
    if obj_type == "triangle":
        return {"path": "M50 0 L100 100 L0 100 Z"}, None
    if obj_type == "polygon" and isinstance(obj.get("points"), list) and obj["points"]:
        pts = obj["points"]
        d = (
            " ".join(
                f"{'M' if i == 0 else 'L'}{_num(float(p['x']))} {_num(float(p['y']))}"
                for i, p in enumerate(pts)
            )
            + " Z"
        )
        return {"path": d}, None
    if obj_type == "path" and isinstance(obj.get("path"), list) and obj["path"]:
        d = " ".join(
            " ".join(str(_num(x) if isinstance(x, int | float) else x) for x in cmd) for cmd in obj["path"]
        )
        return {"path": d}, None
    return None, None


def slot_of(obj: dict) -> dict:
    """The photo frame (`SlotSpec` in `slot.ts`) of a placeholder or a picture that already fills a frame."""
    existing = obj.get("slot")
    if (
        isinstance(existing, dict)
        and float(existing.get("width") or 0) > 0
        and float(existing.get("height") or 0) > 0
    ):
        return copy.deepcopy(existing)
    scale_x = abs(float(obj.get("scaleX", 1) or 1))
    scale_y = abs(float(obj.get("scaleY", 1) or 1))
    w = max(float(obj.get("width") or 1) * scale_x, 1.0)
    h = max(float(obj.get("height") or 1) * scale_y, 1.0)
    ox = {"left": 0.0, "center": 0.5, "right": 1.0}.get(str(obj.get("originX", "left")), 0.0)
    oy = {"top": 0.0, "center": 0.5, "bottom": 1.0}.get(str(obj.get("originY", "top")), 0.0)
    cx = float(obj.get("left") or 0) + (0.5 - ox) * w
    cy = float(obj.get("top") or 0) + (0.5 - oy) * h
    slot: dict = {
        "cx": _num(cx),
        "cy": _num(cy),
        "width": _num(w),
        "height": _num(h),
        "angle": _num(float(obj.get("angle") or 0)),
    }
    mask, radius = _slot_mask_of(obj)
    if mask:
        slot["mask"] = mask
    if radius is not None:
        slot["radius"] = _num(max(0.0, min(0.5, radius)))
    if str(obj.get("type") or "").lower() == "image" and isinstance(obj.get("src"), str) and obj["src"]:
        slot["src"] = obj["src"]
    return slot


def cover_slot(
    slot: dict,
    img_w: float,
    img_h: float,
    focal: tuple[float, float] = (0.5, 0.5),
) -> dict:
    """The position and scale of a picture of size `img_w x img_h` that covers `slot`, centred on `focal`."""
    nat_w, nat_h = max(float(img_w), 1.0), max(float(img_h), 1.0)
    slot_w, slot_h = max(float(slot["width"]), 1.0), max(float(slot["height"]), 1.0)
    angle = float(slot.get("angle") or 0.0)
    fx = max(0.0, min(1.0, float(focal[0])))
    fy = max(0.0, min(1.0, float(focal[1])))
    scale = max(slot_w / nat_w, slot_h / nat_h)
    dx = (0.5 - fx) * (nat_w * scale - slot_w)
    dy = (0.5 - fy) * (nat_h * scale - slot_h)
    rad = math.radians(angle)
    cx = float(slot["cx"]) + dx * math.cos(rad) - dy * math.sin(rad)
    cy = float(slot["cy"]) + dx * math.sin(rad) + dy * math.cos(rad)
    return {
        "originX": "center",
        "originY": "center",
        "left": _num(cx),
        "top": _num(cy),
        "width": _num(nat_w),
        "height": _num(nat_h),
        "scaleX": _num(scale),
        "scaleY": _num(scale),
        "angle": _num(angle),
        "cropX": 0,
        "cropY": 0,
    }


def replace_image(
    obj: dict,
    *,
    src: str,
    natural_width: float,
    natural_height: float,
    asset_id: str | None = None,
    name: str | None = None,
    focal: tuple[float, float] = (0.5, 0.5),
) -> dict:
    """Put a new picture into `obj` (an image or a photo placeholder), keeping its frame, mask, filters,
    effects and template field tag."""
    was_image = str(obj.get("type") or "").lower() == "image"
    is_slot = bool(obj.get("isPlaceholder")) or isinstance(obj.get("slot"), dict)
    if is_slot:
        slot = slot_of(obj)
        obj.update(
            type="image",
            strokeUniform=True,
            slot=slot,
            **cover_slot(slot, natural_width, natural_height, focal),
        )
        for key in (
            "isPlaceholder",
            "clipPath",
            "maskShape",
            "maskRadius",
            "rx",
            "ry",
            "points",
            "path",
            "fillRule",
            "shapeKind",
            "shapeId",
            "sides",
            "starPoints",
            "innerRatio",
        ):
            obj.pop(key, None)
        if not was_image:
            obj.pop("fill", None)
    else:
        scale_x = abs(float(obj.get("scaleX", 1) or 1))
        scale_y = abs(float(obj.get("scaleY", 1) or 1))
        frame_w = max(float(obj.get("width") or 1) * scale_x, 1.0)
        frame_h = max(float(obj.get("height") or 1) * scale_y, 1.0)
        ox = {"left": 0.0, "center": 0.5, "right": 1.0}.get(str(obj.get("originX", "left")), 0.0)
        oy = {"top": 0.0, "center": 0.5, "bottom": 1.0}.get(str(obj.get("originY", "top")), 0.0)
        cx = float(obj.get("left") or 0) + (0.5 - ox) * frame_w
        cy = float(obj.get("top") or 0) + (0.5 - oy) * frame_h
        fit = cover_fit((frame_w, frame_h), natural_width, natural_height, focal)
        obj.update(originX="center", originY="center", left=_num(cx), top=_num(cy), **fit)
        obj.pop("clipPath", None)
    obj["src"] = src
    for key in ("docSrc", "elementId", "colorMap", "isPlaceholder"):
        obj.pop(key, None)
    if asset_id:
        obj["assetId"] = asset_id
    else:
        obj.pop("assetId", None)
    if name and (not obj.get("name") or obj.get("name") == "Image placeholder"):
        obj["name"] = name
    return obj


def build_qr(
    page: Page,
    *,
    text: str,
    x: float | None = None,
    y: float | None = None,
    size: float | None = None,
    color: str = "#000000",
    background: str = "#ffffff",
) -> dict:
    """A QR code. The editor renders the picture from `qr` on load, so no `src` is stored."""
    side = size if size is not None else min(page.width, page.height) * 0.25
    left = x if x is not None else (page.width - side) / 2
    top = y if y is not None else (page.height - side) / 2
    return {
        "id": new_id(),
        "type": "image",
        "name": "QR code",
        "qr": {"text": text[:QR_MAX_TEXT], "fg": color, "bg": background},
        **_centred(left, top, side, side),
        "width": QR_SIDE,
        "height": QR_SIDE,
        "scaleX": _num(side / QR_SIDE),
        "scaleY": _num(side / QR_SIDE),
    }
