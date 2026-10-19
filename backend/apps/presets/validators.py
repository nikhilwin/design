"""Field rules shared by the models (admin forms) and the JSON importer."""

from __future__ import annotations

import json
import re
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

from apps.designs.validators import MAX_DIMENSION, MAX_PRESET_LENGTH

# The same characters `Design.preset` accepts, so every preset slug (and alias) can be stored on a design.
PRESET_SLUG = re.compile(rf"[A-Za-z0-9._-]{{1,{MAX_PRESET_LENGTH}}}")
GROUP_SLUG = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
ICON_NAME = re.compile(r"[a-z0-9-]{0,64}")

UNITS = ("px", "mm", "cm", "in")
PX_PER_INCH = Decimal(96)
UNITS_PER_INCH = {"px": PX_PER_INCH, "in": Decimal(1), "cm": Decimal("2.54"), "mm": Decimal("25.4")}

MAX_TAGS = 20
MAX_TAG_LENGTH = 32
MAX_ALIASES = 20
MAX_META_BYTES = 4096
SAFE_ZONE_SIDES = ("top", "bottom", "left", "right")


def to_px(value: Decimal | int | float, unit: str) -> int:
    """Whole CSS pixels at 96 dpi, rounded like the web app does (half away from zero)."""
    px = Decimal(str(value)) * PX_PER_INCH / UNITS_PER_INCH[unit]
    return int(px.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def check_size(width: Any, height: Any, unit: str) -> tuple[Decimal, Decimal]:
    """`ValueError` unless both sides are positive numbers that come to 1 … MAX_DIMENSION px."""
    if unit not in UNITS:
        raise ValueError(f"The unit must be one of {', '.join(UNITS)}.")
    sides = []
    for name, raw in (("width", width), ("height", height)):
        if isinstance(raw, bool) or not isinstance(raw, (int, float, str, Decimal)):
            raise ValueError(f"The {name} must be a number.")
        try:
            value = Decimal(str(raw))
        except InvalidOperation:
            raise ValueError(f"The {name} must be a number.")
        if not value.is_finite() or value <= 0:
            raise ValueError(f"The {name} must be greater than 0.")
        if unit == "px" and value != value.to_integral_value():
            raise ValueError(f"The {name} must be a whole number of pixels.")
        if value != value.quantize(Decimal("0.001")):
            raise ValueError(f"The {name} can have at most 3 decimals.")
        if not 1 <= to_px(value, unit) <= MAX_DIMENSION:
            raise ValueError(f"The {name} must come to between 1 and {MAX_DIMENSION} px.")
        sides.append(value)
    return sides[0], sides[1]


def normalize_labels(raw: Any, *, what: str, limit: int, pattern: re.Pattern | None = None) -> list[str]:
    """Trimmed, de-duplicated short strings from a list or comma-separated text; `ValueError` otherwise."""
    if raw in (None, ""):
        return []
    if isinstance(raw, str):
        raw = raw.split(",")
    if not isinstance(raw, (list, tuple)) or not all(isinstance(item, str) for item in raw):
        raise ValueError(f"{what.capitalize()} must be a list of strings.")
    items: dict[str, None] = {}
    for item in raw:
        cleaned = " ".join(item.split())
        if not cleaned:
            continue
        if pattern is not None and not pattern.fullmatch(cleaned):
            raise ValueError(f"{cleaned!r} is not a valid {what[:-1]}.")
        if len(cleaned) > MAX_TAG_LENGTH and pattern is None:
            raise ValueError(f"A {what[:-1]} is longer than {MAX_TAG_LENGTH} characters.")
        items[cleaned] = None
    if len(items) > limit:
        raise ValueError(f"Use at most {limit} {what}.")
    return list(items)


def normalize_tags(raw: Any) -> list[str]:
    """Lower-case tags such as "4:5" or "paid"."""
    return [tag.lower() for tag in normalize_labels(raw, what="tags", limit=MAX_TAGS)]


def normalize_aliases(raw: Any) -> list[str]:
    """Old slugs that should still resolve to the preset; each follows the preset slug rule."""
    return normalize_labels(raw, what="aliases", limit=MAX_ALIASES, pattern=PRESET_SLUG)


def check_meta(meta: Any) -> dict:
    """A small JSON object; a `safe_zone` in it holds fractions of the page for the sides it names."""
    if meta in (None, ""):
        return {}
    if not isinstance(meta, dict):
        raise ValueError("Meta must be a JSON object.")
    if len(json.dumps(meta)) > MAX_META_BYTES:
        raise ValueError(f"Meta is larger than {MAX_META_BYTES} bytes.")
    zone = meta.get("safe_zone")
    if zone is not None:
        if not isinstance(zone, dict) or not set(zone) <= set(SAFE_ZONE_SIDES):
            raise ValueError(f"`safe_zone` must be an object with some of: {', '.join(SAFE_ZONE_SIDES)}.")
        for side, value in zone.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value < 0.5:
                raise ValueError(f"`safe_zone.{side}` must be a fraction of the page from 0 to below 0.5.")
    return meta
