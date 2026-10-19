"""Shared building blocks for Doory's original graphics: palette, SVG element helpers, a deterministic
random generator and the registry every set module adds its artwork to.

Everything here is plain geometry computed in code; there is no third-party artwork and no randomness that
is not seeded, so a run always writes the same bytes. Every colour is an explicit `#rrggbb` value on the
shape that uses it (the editor recolours an element by remapping those), numbers are written with at most
two decimals, and no text elements or fonts are used (lettering is drawn as paths, see `lettering.py`).
"""

from __future__ import annotations

import importlib.util
import math
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from html import escape
from pathlib import Path

# ---- palette ---------------------------------------------------------------------------------------------

RED = "#e11d48"
ROSE_DARK = "#881337"
ROSE_MID = "#be123c"
ROSE_SOFT = "#fda4af"
ROSE_LIGHT = "#fecdd3"
BLUSH = "#fff1f2"
INK = "#18181b"
SLATE = "#64748b"
MIST = "#e2e8f0"
CLOUD = "#f1f5f9"
WHITE = "#ffffff"
SUN = "#fbbf24"
AMBER = "#f59e0b"
SKY = "#38bdf8"

#: (background, main, accent) combinations the patterns cycle through.
COLORWAYS = [
    (BLUSH, RED, ROSE_SOFT),
    (RED, WHITE, ROSE_LIGHT),
    (INK, "#fb7185", RED),
    (ROSE_LIGHT, ROSE_MID, WHITE),
    (WHITE, INK, RED),
    (ROSE_DARK, ROSE_SOFT, SUN),
]

NS = "http://www.w3.org/2000/svg"


def _load_shapes():
    """The path helpers of `generate_shapes.py` (a stand-alone script next to this package)."""
    name = "doory_graphics_shapes"
    if name in sys.modules:
        return sys.modules[name]
    path = Path(__file__).resolve().parent.parent / "generate_shapes.py"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


shapes = _load_shapes()
Outline = shapes.Outline
regular_polygon = shapes.regular_polygon
star_points = shapes.star_points
polar = shapes.polar
scallop_path = shapes.scallop_path
heart_path = shapes.heart_path
blob_path = shapes.blob_path
circle_path = shapes.circle_path
rrect = shapes.rrect


def n(value: float) -> str:
    """Compact number: at most 2 decimals, no trailing zeros, never `-0`."""
    return shapes.n(value)


# ---- deterministic randomness ----------------------------------------------------------------------------


class Rng:
    """A tiny seeded generator (a 64-bit LCG), stable across Python versions unlike `random`."""

    def __init__(self, seed: int) -> None:
        self.state = (seed * 6364136223846793005 + 1442695040888963407) % 2**64

    def random(self) -> float:
        self.state = (self.state * 6364136223846793005 + 1442695040888963407) % 2**64
        return (self.state >> 11) / 2**53

    def uniform(self, low: float, high: float) -> float:
        return low + (high - low) * self.random()

    def integer(self, low: int, high: int) -> int:
        """An int in `[low, high]`."""
        return low + int(self.random() * (high - low + 1))

    def choice(self, items: Sequence):
        return items[int(self.random() * len(items))]


# ---- element helpers -------------------------------------------------------------------------------------


def attrs(**kw: object) -> str:
    """` name="value"` pairs; `_` becomes `-`, `None`/empty values are dropped, numbers are compacted."""
    out = []
    for key, value in kw.items():
        if value is None or value == "":
            continue
        text = (
            n(value)
            if isinstance(value, (int, float)) and not isinstance(value, bool)
            else escape(str(value))
        )
        out.append(f' {key.rstrip("_").replace("_", "-")}="{text}"')
    return "".join(out)


def rect(x, y, w, h, fill, r: float = 0, **kw) -> str:
    return f"<rect{attrs(x=x, y=y, width=w, height=h, rx=r or None, fill=fill, **kw)}/>"


def circle(cx, cy, r, fill, **kw) -> str:
    return f"<circle{attrs(cx=cx, cy=cy, r=r, fill=fill, **kw)}/>"


def ellipse(cx, cy, rx, ry, fill, **kw) -> str:
    return f"<ellipse{attrs(cx=cx, cy=cy, rx=rx, ry=ry, fill=fill, **kw)}/>"


def polygon(points: Sequence[tuple[float, float]], fill, **kw) -> str:
    pts = " ".join(f"{n(x)},{n(y)}" for x, y in points)
    return f'<polygon points="{pts}"{attrs(fill=fill, **kw)}/>'


def path(d: str | Outline, fill, **kw) -> str:
    data = d if isinstance(d, str) else d.d()
    return f'<path d="{data}"{attrs(fill=fill, **kw)}/>'


def stroke(d: str | Outline, color, width: float = 4, **kw) -> str:
    """An open or closed outline: no fill, round caps and joins."""
    data = d if isinstance(d, str) else d.d()
    kw.setdefault("stroke_linecap", "round")
    kw.setdefault("stroke_linejoin", "round")
    return f'<path d="{data}" fill="none"{attrs(stroke=color, stroke_width=width, **kw)}/>'


def line(x1, y1, x2, y2, color, width: float = 4, **kw) -> str:
    kw.setdefault("stroke_linecap", "round")
    return f'<line{attrs(x1=x1, y1=y1, x2=x2, y2=y2, stroke=color, stroke_width=width, **kw)} fill="none"/>'


def group(body: str, **kw) -> str:
    return f"<g{attrs(**kw)}>{body}</g>"


def hollow(outer: Outline | str, inner: Outline | str, fill, **kw) -> str:
    """`outer` with `inner` cut out (even-odd), e.g. a ring or a frame."""
    a = outer if isinstance(outer, str) else outer.d()
    b = inner if isinstance(inner, str) else inner.d()
    return f'<path d="{a} {b}"{attrs(fill=fill, fill_rule="evenodd", **kw)}/>'


def linear_gradient(gid: str, stops: Sequence[tuple[float, str, float]], x1=0, y1=0, x2=0, y2=1) -> str:
    body = "".join(
        f"<stop{attrs(offset=offset, stop_color=color, stop_opacity=None if opacity >= 1 else opacity)}/>"
        for offset, color, opacity in stops
    )
    return f'<linearGradient id="{gid}"{attrs(x1=x1, y1=y1, x2=x2, y2=y2)}>{body}</linearGradient>'


def radial_gradient(gid: str, cx, cy, r, stops: Sequence[tuple[float, str, float]]) -> str:
    body = "".join(
        f"<stop{attrs(offset=offset, stop_color=color, stop_opacity=None if opacity >= 1 else opacity)}/>"
        for offset, color, opacity in stops
    )
    box = attrs(cx=cx, cy=cy, r=r, gradientUnits="userSpaceOnUse")
    return f'<radialGradient id="{gid}"{box}>{body}</radialGradient>'


def defs(*items: str) -> str:
    return f"<defs>{''.join(items)}</defs>"


def rounded_rect(x, y, w, h, r) -> Outline:
    return rrect(x, y, w, h, r)


def smooth(points: Sequence[tuple[float, float]], closed: bool = False, tension: float = 1.0) -> str:
    """A smooth curve through `points` (Catmull-Rom converted to cubic Beziers), as path data."""
    count = len(points)
    if count < 2:
        raise ValueError("a curve needs two points")
    parts = [f"M{n(points[0][0])} {n(points[0][1])}"]
    span = count if closed else count - 1
    for i in range(span):
        p0 = points[(i - 1) % count] if closed or i > 0 else points[0]
        p1, p2 = points[i % count], points[(i + 1) % count]
        p3 = points[(i + 2) % count] if closed or i + 2 < count else points[-1]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6 * tension, p1[1] + (p2[1] - p0[1]) / 6 * tension)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6 * tension, p2[1] - (p3[1] - p1[1]) / 6 * tension)
        parts.append(f"C{n(c1[0])} {n(c1[1])} {n(c2[0])} {n(c2[1])} {n(p2[0])} {n(p2[1])}")
    if closed:
        parts.append("Z")
    return " ".join(parts)


def wobble(points: Sequence[tuple[float, float]], rng: Rng, amount: float = 1.5) -> list[tuple[float, float]]:
    """`points` nudged by up to `amount` in each direction (the hand-drawn look)."""
    return [(x + rng.uniform(-amount, amount), y + rng.uniform(-amount, amount)) for x, y in points]


def resample(a: tuple[float, float], b: tuple[float, float], steps: int) -> list[tuple[float, float]]:
    return [(a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps) for i in range(steps + 1)]


def shifted(outline: Outline, dx: float, dy: float) -> Outline:
    """A copy of `outline` moved by `(dx, dy)`."""
    out = Outline()
    for cmd, args in outline.ops:
        if cmd == "A":
            rx, ry, rot, large, sweep, x, y = args
            out.ops.append((cmd, (rx, ry, rot, large, sweep, x + dx, y + dy)))
        else:
            out.ops.append((cmd, tuple(v + (dx if i % 2 == 0 else dy) for i, v in enumerate(args))))
    return out


def bumpy_rect(x: float, y: float, w: float, h: float, bumps_x: int, bumps_y: int) -> Outline:
    """A rectangle whose four edges are rows of outward half-circles (scalloped border)."""
    out = Outline().M(x, y)
    step_x, step_y = w / bumps_x, h / bumps_y
    for i in range(bumps_x):
        out.A(step_x / 2, step_x / 2, 0, 1, x + step_x * (i + 1), y)
    for j in range(bumps_y):
        out.A(step_y / 2, step_y / 2, 0, 1, x + w, y + step_y * (j + 1))
    for i in range(bumps_x):
        out.A(step_x / 2, step_x / 2, 0, 1, x + w - step_x * (i + 1), y + h)
    for j in range(bumps_y):
        out.A(step_y / 2, step_y / 2, 0, 1, x, y + h - step_y * (j + 1))
    return out.Z()


def rotate_point(x: float, y: float, cx: float, cy: float, degrees: float) -> tuple[float, float]:
    rad = math.radians(degrees)
    dx, dy = x - cx, y - cy
    return cx + dx * math.cos(rad) - dy * math.sin(rad), cy + dx * math.sin(rad) + dy * math.cos(rad)


# ---- registry --------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Item:
    set_id: str
    folder: str
    name: str
    width: float
    height: float
    body: str

    def svg(self) -> str:
        title = escape(self.name.replace("-", " ").title())
        return (
            f'<svg xmlns="{NS}" viewBox="0 0 {n(self.width)} {n(self.height)}" '
            f'width="{n(self.width)}" height="{n(self.height)}"><title>{title}</title>{self.body}</svg>\n'
        )


class Collector:
    """What a set module's `build(add)` receives: call it once per graphic."""

    def __init__(self, set_id: str) -> None:
        self.set_id = set_id
        self.items: list[Item] = []

    def __call__(self, folder: str, name: str, body: str, width: float, height: float) -> None:
        if any(i.folder == folder and i.name == name for i in self.items):
            raise ValueError(f"duplicate graphic {self.set_id}/{folder}/{name}")
        self.items.append(Item(self.set_id, folder, name, width, height, body))
