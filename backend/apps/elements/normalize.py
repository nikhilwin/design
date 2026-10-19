"""Turn upstream SVG artwork into the form the editor can recolour.

The editor recolours an element by remapping the colours it finds on the leaf shapes after parsing
(`Element.colors` lists them). Upstream icon sets rarely make that easy: strokes and fills are inherited from
the root `<svg>`, colours are `currentColor`, tags carry CSS classes, helper shapes are invisible. This module
resolves all of that so that

- every visible shape carries explicit `fill` / `stroke` values (resolved from its ancestors and any inline
  `style`), written as `#rrggbb` hex (`mono` mode paints everything with one colour, `colour` mode keeps the
  artwork's own palette and only converts named / `rgb()` / `hsl()` colours to hex);
- invisible helper shapes (no fill and no stroke) and metadata (`title`, `desc`, `metadata`) are dropped,
  as are ids nothing refers to and whitespace between elements;
- `width` / `height` are explicit numbers (icons: scaled so the longer side equals `size`, normally 24) on top
  of a `viewBox`, so every icon of a set has the same intrinsic size whatever grid it was drawn on; with
  `frame` an invisible rectangle the size of the viewBox keeps that size when the editor measures the shapes.

The result is still untrusted as far as safety goes: `apps.core.svg.sanitize_svg` runs afterwards, in
`bulk_import`, on everything that gets stored.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from xml.etree import ElementTree as ET

from defusedxml import ElementTree as SafeET
from defusedxml.common import DefusedXmlException
from PIL import ImageColor

from apps.core.svg import ALLOWED_ATTRIBUTES, MAX_BYTES, SVG_NS, XLINK_NS, SvgError

#: Bump when the normaliser's output changes: packs are re-synced (their fingerprint includes this).
NORMALIZER_VERSION = 3
DEFAULT_COLOR = "#7a64e0"

SHAPES = {"path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text"}
CONTAINERS = {"svg", "g", "a", "switch"}
OPAQUE_SUBTREES = {
    "defs",
    "clipPath",
    "mask",
    "pattern",
    "marker",
    "symbol",
    "linearGradient",
    "radialGradient",
}
DROPPED_ELEMENTS = {"title", "desc", "metadata"}

FILL_PROPS = ("fill-rule", "fill-opacity", "clip-rule")
STROKE_PROPS = (
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-opacity",
)
INHERITED = ("fill", "stroke", *FILL_PROPS, *STROKE_PROPS)
ROOT_DROPPED = {
    "class",
    "style",
    "version",
    "x",
    "y",
    "role",
    "focusable",
    "xml:space",
    "enable-background",
}
PAINT_ATTRS = ("fill", "stroke", "stop-color", "flood-color", "lighting-color")
_ALPHA_ATTR = {"fill": "fill-opacity", "stroke": "stroke-opacity", "stop-color": "stop-opacity"}

_URL_REF = re.compile(r"url\(\s*['\"]?#([^'\")\s]+)['\"]?\s*\)")
_NUMBER = re.compile(r"^\s*([0-9]*\.?[0-9]+)\s*(?:px)?\s*$")
_HEX = re.compile(r"^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
_SPACE_PRESERVING = {"text", "tspan", "textPath", "style"}


def _q(name: str) -> str:
    return f"{{{SVG_NS}}}{name}"


def _local(tag: object) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


@dataclass(frozen=True)
class NormalizeSpec:
    #: `mono`: one recolourable colour (icons); `colour`: keep the artwork's palette (emoji, illustrations).
    mode: str
    color: str = DEFAULT_COLOR
    #: Longer side of the output `width`/`height` in px (None: keep the artwork's own size).
    size: float | None = None
    #: Add an invisible rectangle the size of the viewBox, so the editor sizes every icon of a set by the same
    #: frame (the way icon sets keep their padding) instead of by the ink of each individual icon.
    frame: bool = False


def fmt(value: float) -> str:
    text = f"{value:.2f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


# ---- colours -----------------------------------------------------------------------------------------------


_RGB_FUNCTION = re.compile(
    r"^rgba?\(\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$", re.I
)


def _channel(value: str, scale: float) -> float:
    return float(value[:-1]) / 100 * scale if value.endswith("%") else float(value)


def _rgb_function(text: str) -> tuple[str, float | None] | None:
    match = _RGB_FUNCTION.match(text)
    if match is None:
        return None
    try:
        r, g, b = (round(min(255.0, max(0.0, _channel(match.group(i), 255)))) for i in (1, 2, 3))
        alpha = min(1.0, max(0.0, _channel(match.group(4), 1))) if match.group(4) else 1.0
    except ValueError:
        return None
    return f"#{r:02x}{g:02x}{b:02x}", (None if alpha >= 1 else round(alpha, 3))


def parse_color(value: str) -> tuple[str, float | None] | None:
    """`(#rrggbb, alpha or None)` for a CSS colour, or None when it is not a plain colour."""
    text = value.strip()
    if not text or text.startswith("url(") or text.lower() in {"inherit", "context-fill", "context-stroke"}:
        return None
    if text.lower().startswith("rgb"):
        return _rgb_function(text)
    if _HEX.match(text) is None and not re.match(r"^[A-Za-z]+(\(.*\))?$", text):
        return None
    try:
        rgb = ImageColor.getrgb(text)
    except ValueError:
        return None
    alpha = rgb[3] / 255 if len(rgb) == 4 and rgb[3] != 255 else None
    return f"#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}", alpha


# ---- inline styles -----------------------------------------------------------------------------------------


def _declarations(style: str) -> dict[str, str]:
    found: dict[str, str] = {}
    for part in style.split(";"):
        name, sep, value = part.partition(":")
        if sep and name.strip() and value.strip():
            found[name.strip().lower()] = value.strip().removesuffix("!important").strip()
    return found


def _inline_style(el: ET.Element) -> None:
    """Move the declarations of a `style` attribute into presentation attributes (a style wins)."""
    style = el.attrib.pop("style", "")
    if not style:
        return
    for name, value in _declarations(style).items():
        if name in ALLOWED_ATTRIBUTES:
            el.attrib[name] = value


# ---- paint resolution --------------------------------------------------------------------------------------


class _Painter:
    """Maps one paint value to what the stored SVG should carry."""

    def __init__(self, spec: NormalizeSpec) -> None:
        self.spec = spec

    def resolve(self, raw: str | None, *, default: str) -> tuple[str, float | None]:
        value = (raw if raw is not None else default).strip()
        lowered = value.lower()
        if lowered in ("none", "transparent"):
            return "none", None
        if lowered == "currentcolor":
            return self.spec.color, None
        if value.startswith("url("):
            return value, None
        parsed = parse_color(value)
        if parsed is None:
            return (self.spec.color if self.spec.mode == "mono" else value), None
        hex_color, alpha = parsed
        return (self.spec.color if self.spec.mode == "mono" else hex_color), alpha


def _paint_shape(el: ET.Element, effective: dict[str, str], painter: _Painter) -> bool:
    """Write explicit paint onto a shape. Returns False when the shape is invisible and should go."""
    if el.get("display") == "none" or el.get("visibility") == "hidden":
        return False
    fill, fill_alpha = painter.resolve(effective.get("fill"), default="#000000")
    stroke, stroke_alpha = painter.resolve(effective.get("stroke"), default="none")
    if fill == "none" and stroke == "none":
        return False
    for name in INHERITED:
        el.attrib.pop(name, None)
    el.attrib["fill"] = fill
    if fill != "none":
        for name in FILL_PROPS:
            if name in effective:
                el.attrib[name] = effective[name]
        if fill_alpha is not None and "fill-opacity" not in el.attrib:
            el.attrib["fill-opacity"] = fmt(fill_alpha)
    if stroke != "none":
        el.attrib["stroke"] = stroke
        for name in STROKE_PROPS:
            if name in effective:
                el.attrib[name] = effective[name]
        if stroke_alpha is not None and "stroke-opacity" not in el.attrib:
            el.attrib["stroke-opacity"] = fmt(stroke_alpha)
    return True


def _recolor_in_place(el: ET.Element, painter: _Painter) -> None:
    """Resolve colours where they stand, without moving anything (defs, masks, documents using `<use>`).

    In `mono` mode only `currentColor` is replaced (it has no hex value the editor could recolour); the
    colours explicitly written down are the artwork's and stay.
    """
    for name in PAINT_ATTRS:
        raw = el.attrib.get(name)
        if raw is None:
            continue
        if painter.spec.mode == "mono" and raw.strip().lower() != "currentcolor":
            continue
        value, alpha = painter.resolve(raw, default=raw)
        el.attrib[name] = value
        if alpha is not None and name in _ALPHA_ATTR and _ALPHA_ATTR[name] not in el.attrib:
            el.attrib[_ALPHA_ATTR[name]] = fmt(alpha)


def _walk(el: ET.Element, inherited: dict[str, str], painter: _Painter, *, opaque: bool) -> None:
    kept: list[ET.Element] = []
    for child in list(el):
        name = _local(child.tag)
        if name in DROPPED_ELEMENTS:
            continue
        _inline_style(child)
        child_opaque = opaque or name in OPAQUE_SUBTREES
        if child_opaque:
            _recolor_in_place(child, painter)
            _walk(child, {}, painter, opaque=True)
            kept.append(child)
            continue
        own = {key: child.attrib[key] for key in INHERITED if key in child.attrib}
        effective = {**inherited, **own}
        if name in SHAPES:
            if _paint_shape(child, effective, painter):
                kept.append(child)
            continue
        if name in CONTAINERS:
            for key in INHERITED:
                child.attrib.pop(key, None)
            _walk(child, effective, painter, opaque=False)
            if len(child):
                kept.append(child)
            continue
        kept.append(child)
    el[:] = kept


# ---- ids, whitespace, size ---------------------------------------------------------------------------------


def _referenced_ids(root: ET.Element) -> set[str]:
    refs: set[str] = set()
    for el in root.iter():
        for key, value in el.attrib.items():
            if key in ("href", f"{{{XLINK_NS}}}href") and value.startswith("#"):
                refs.add(value[1:])
            elif "url(" in value:
                refs.update(_URL_REF.findall(value))
        if _local(el.tag) == "style" and el.text:
            refs.update(_URL_REF.findall(el.text))
    return refs


def _tidy(el: ET.Element, referenced: set[str], *, in_text: bool = False) -> None:
    """Drop ids nothing refers to and the whitespace between elements (text content is left alone)."""
    keep_text = in_text or _local(el.tag) in _SPACE_PRESERVING
    if "id" in el.attrib and el.attrib["id"] not in referenced:
        del el.attrib["id"]
    if not keep_text and el.text is not None and not el.text.strip():
        el.text = None
    for child in el:
        _tidy(child, referenced, in_text=keep_text)
        if not keep_text and child.tail is not None and not child.tail.strip():
            child.tail = None


def _number(value: str | None) -> float | None:
    match = _NUMBER.match(value or "")
    return float(match.group(1)) if match else None


def _viewbox(root: ET.Element) -> tuple[float, float, float, float]:
    parts = (root.get("viewBox") or "").replace(",", " ").split()
    if len(parts) == 4:
        try:
            x, y, w, h = (float(p) for p in parts)
        except ValueError:
            x = y = w = h = 0.0
        if w > 0 and h > 0:
            return x, y, w, h
    width, height = _number(root.get("width")), _number(root.get("height"))
    if width and height:
        return 0.0, 0.0, width, height
    raise SvgError("The SVG has neither a usable viewBox nor a width and height.")


def _set_size(root: ET.Element, spec: NormalizeSpec) -> None:
    x, y, w, h = _viewbox(root)
    width, height = _number(root.get("width")), _number(root.get("height"))
    if spec.size:
        scale = spec.size / max(w, h)
        width, height = w * scale, h * scale
    elif not (width and height):
        width, height = w, h
    root.set("viewBox", f"{fmt(x)} {fmt(y)} {fmt(w)} {fmt(h)}")
    root.set("width", fmt(width))
    root.set("height", fmt(height))
    if spec.frame:
        frame = ET.Element(_q("rect"), x=fmt(x), y=fmt(y), width=fmt(w), height=fmt(h), fill="none")
        root.insert(0, frame)


# ---- entry point -------------------------------------------------------------------------------------------


def normalize_svg(raw: bytes, spec: NormalizeSpec) -> bytes:
    """Return the recolourable form of `raw`. Raises `SvgError` when it is not a usable SVG."""
    if not isinstance(raw, (bytes, bytearray)) or not raw:
        raise SvgError("Empty SVG.")
    if len(raw) > MAX_BYTES:
        raise SvgError("SVG is too large.")
    try:
        root = SafeET.fromstring(bytes(raw), forbid_dtd=True, forbid_entities=True, forbid_external=True)
    except (DefusedXmlException, ET.ParseError, ValueError, UnicodeDecodeError) as exc:
        raise SvgError("Invalid or unsafe SVG.") from exc
    if root.tag != _q("svg"):
        raise SvgError("Not an SVG document.")

    painter = _Painter(spec)
    _inline_style(root)
    dropped = ROOT_DROPPED
    if any(_local(el.tag) == "use" for el in root.iter()):
        dropped = ROOT_DROPPED - set(INHERITED)  # referenced shapes still inherit from the root
        for el in root.iter():
            _inline_style(el)
            _recolor_in_place(el, painter)
    else:
        dropped = ROOT_DROPPED | set(INHERITED)
        _walk(root, {key: root.attrib[key] for key in INHERITED if key in root.attrib}, painter, opaque=False)
    if not any(_local(el.tag) in SHAPES | {"use", "image"} for el in root.iter()):
        raise SvgError("The SVG contains no visible shapes.")

    _set_size(root, spec)
    for key in list(root.attrib):
        if key in dropped or key.startswith(("aria-", "data-")):
            del root.attrib[key]
    _tidy(root, _referenced_ids(root))
    return ET.tostring(root, encoding="utf-8", xml_declaration=False)
