"""Generate Doory's built-in vector shapes: original geometric SVG files, released under CC0-1.0.

Usage:  python generate_shapes.py <target-dir>

Writes one folder per pack (`basic-shapes`, `lines-dividers`, `frames-masks`, `arrows-callouts`), with
sub-folders that become search tags. Every file has a tidy `viewBox`, a `<title>` and a single hex colour
(`#7a64e0`, the brand's lilac) used for all fills and strokes, so the editor can recolour it by swapping
that one value.
The geometry is computed here (no third-party artwork), which keeps the whole set original.
"""

from __future__ import annotations

import math
import sys
from collections.abc import Callable
from dataclasses import dataclass
from html import escape
from pathlib import Path as FilePath

COLOR = "#7a64e0"
NS = "http://www.w3.org/2000/svg"

PACKS = {
    "basic-shapes": "Basic Shapes",
    "lines-dividers": "Lines & Dividers",
    "frames-masks": "Frames & Masks",
    "arrows-callouts": "Arrows & Callouts",
}


def n(value: float) -> str:
    """Compact number: at most 2 decimals, no trailing zeros, never `-0`."""
    text = f"{value:.2f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


class Outline:
    """Minimal absolute-coordinate path builder that can be scaled, so one outline can make a hollow frame."""

    def __init__(self) -> None:
        self.ops: list[tuple[str, tuple[float, ...]]] = []

    def M(self, x: float, y: float) -> Outline:
        self.ops.append(("M", (x, y)))
        return self

    def L(self, x: float, y: float) -> Outline:
        self.ops.append(("L", (x, y)))
        return self

    def C(self, x1: float, y1: float, x2: float, y2: float, x: float, y: float) -> Outline:
        self.ops.append(("C", (x1, y1, x2, y2, x, y)))
        return self

    def Q(self, x1: float, y1: float, x: float, y: float) -> Outline:
        self.ops.append(("Q", (x1, y1, x, y)))
        return self

    def A(self, rx: float, ry: float, large: int, sweep: int, x: float, y: float) -> Outline:
        self.ops.append(("A", (rx, ry, 0, large, sweep, x, y)))
        return self

    def Z(self) -> Outline:
        self.ops.append(("Z", ()))
        return self

    def polygon(self, points: list[tuple[float, float]]) -> Outline:
        self.M(*points[0])
        for point in points[1:]:
            self.L(*point)
        return self.Z()

    def scaled(self, factor: float, cx: float, cy: float) -> Outline:
        out = Outline()
        for cmd, args in self.ops:
            if cmd == "A":
                rx, ry, rot, large, sweep, x, y = args
                out.ops.append(
                    (
                        cmd,
                        (
                            rx * factor,
                            ry * factor,
                            rot,
                            large,
                            sweep,
                            cx + (x - cx) * factor,
                            cy + (y - cy) * factor,
                        ),
                    )
                )
            else:
                out.ops.append(
                    (
                        cmd,
                        tuple(
                            cx + (v - cx) * factor if i % 2 == 0 else cy + (v - cy) * factor
                            for i, v in enumerate(args)
                        ),
                    )
                )
        return out

    def d(self) -> str:
        parts = []
        for cmd, args in self.ops:
            parts.append(cmd + " ".join(n(v) for v in args))
        return " ".join(parts)


def rrect(x: float, y: float, w: float, h: float, r: float) -> Outline:
    r = min(r, w / 2, h / 2)
    return (
        Outline()
        .M(x + r, y)
        .L(x + w - r, y)
        .A(r, r, 0, 1, x + w, y + r)
        .L(x + w, y + h - r)
        .A(r, r, 0, 1, x + w - r, y + h)
        .L(x + r, y + h)
        .A(r, r, 0, 1, x, y + h - r)
        .L(x, y + r)
        .A(r, r, 0, 1, x + r, y)
        .Z()
    )


def circle_path(cx: float, cy: float, r: float) -> Outline:
    return Outline().M(cx - r, cy).A(r, r, 1, 1, cx + r, cy).A(r, r, 1, 1, cx - r, cy).Z()


def ellipse_path(cx: float, cy: float, rx: float, ry: float) -> Outline:
    return Outline().M(cx - rx, cy).A(rx, ry, 1, 1, cx + rx, cy).A(rx, ry, 1, 1, cx - rx, cy).Z()


def arch_path(x: float, y: float, w: float, h: float) -> Outline:
    r = w / 2
    return Outline().M(x, y + h).L(x, y + r).A(r, r, 0, 1, x + w, y + r).L(x + w, y + h).Z()


def regular_polygon(
    sides: int, cx: float, cy: float, r: float, rotation: float = -90
) -> list[tuple[float, float]]:
    return [
        (
            cx + r * math.cos(math.radians(rotation + 360 * i / sides)),
            cy + r * math.sin(math.radians(rotation + 360 * i / sides)),
        )
        for i in range(sides)
    ]


def star_points(
    points: int, cx: float, cy: float, outer: float, inner: float, rotation: float = -90
) -> list[tuple[float, float]]:
    out = []
    for i in range(points * 2):
        radius = outer if i % 2 == 0 else inner
        angle = math.radians(rotation + 180 * i / points)
        out.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    return out


def heart_path() -> Outline:
    return (
        Outline()
        .M(50, 90)
        .C(20, 68, 6, 50, 6, 31)
        .C(6, 17, 17, 8, 29, 8)
        .C(38, 8, 46, 13, 50, 21)
        .C(54, 13, 62, 8, 71, 8)
        .C(83, 8, 94, 17, 94, 31)
        .C(94, 50, 80, 68, 50, 90)
        .Z()
    )


def blob_path(seed: int, cx: float = 50, cy: float = 50, radius: float = 44, points: int = 8) -> Outline:
    """Smooth closed organic outline through radially perturbed points (Catmull-Rom -> cubic Bezier)."""
    state = seed * 2654435761 % 2**32
    pts = []
    for i in range(points):
        state = (state * 1664525 + 1013904223) % 2**32
        r = radius * (0.68 + 0.32 * state / 2**32)
        angle = 2 * math.pi * i / points
        pts.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
    path = Outline().M(*pts[0])
    for i in range(points):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[(i + 1) % points], pts[(i + 2) % points]
        path.C(
            p1[0] + (p2[0] - p0[0]) / 6,
            p1[1] + (p2[1] - p0[1]) / 6,
            p2[0] - (p3[0] - p1[0]) / 6,
            p2[1] - (p3[1] - p1[1]) / 6,
            p2[0],
            p2[1],
        )
    return path.Z()


def scallop_path(cx: float, cy: float, radius: float, count: int, bulge: float = 0.52) -> Outline:
    """A circle whose edge is `count` outward semicircle-like bumps (seals, stamps, flower borders)."""
    verts = regular_polygon(count, cx, cy, radius)
    chord = 2 * radius * math.sin(math.pi / count)
    path = Outline().M(*verts[0])
    for i in range(count):
        path.A(chord * bulge, chord * bulge, 0, 1, *verts[(i + 1) % count])
    return path.Z()


def superellipse(
    cx: float, cy: float, rx: float, ry: float, exponent: float = 4, steps: int = 72
) -> list[tuple[float, float]]:
    out = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        out.append(
            (
                cx + rx * math.copysign(abs(c) ** (2 / exponent), c),
                cy + ry * math.copysign(abs(s) ** (2 / exponent), s),
            )
        )
    return out


def crescent_path() -> Outline:
    """Big circle minus an offset circle, built from the two real intersection points."""
    c1, r1, c2, r2 = (50.0, 50.0), 44.0, (68.0, 40.0), 36.0
    dx, dy = c2[0] - c1[0], c2[1] - c1[1]
    dist = math.hypot(dx, dy)
    a = (r1**2 - r2**2 + dist**2) / (2 * dist)
    h = math.sqrt(r1**2 - a**2)
    mx, my = c1[0] + a * dx / dist, c1[1] + a * dy / dist
    p1 = (mx + h * dy / dist, my - h * dx / dist)
    p2 = (mx - h * dy / dist, my + h * dx / dist)

    def arc(center, radius, start, end, wanted: Callable[[tuple[float, float]], bool]):
        a0 = math.atan2(start[1] - center[1], start[0] - center[0])
        a1 = math.atan2(end[1] - center[1], end[0] - center[0])
        for sweep in (1, 0):
            span = (a1 - a0) % (2 * math.pi) if sweep else (a0 - a1) % (2 * math.pi)
            mid = a0 + span / 2 if sweep else a0 - span / 2
            probe = (center[0] + radius * math.cos(mid), center[1] + radius * math.sin(mid))
            if wanted(probe):
                return (1 if span > math.pi else 0), sweep
        raise ValueError("no matching arc")

    def outside_c2(p: tuple[float, float]) -> bool:
        return math.hypot(p[0] - c2[0], p[1] - c2[1]) > r2

    def inside_c1(p: tuple[float, float]) -> bool:
        return math.hypot(p[0] - c1[0], p[1] - c1[1]) < r1

    large1, sweep1 = arc(c1, r1, p1, p2, outside_c2)
    large2, sweep2 = arc(c2, r2, p2, p1, inside_c1)
    return Outline().M(*p1).A(r1, r1, large1, sweep1, *p2).A(r2, r2, large2, sweep2, *p1).Z()


# ---- SVG element helpers ----------------------------------------------------------------------------------


def fill(path: Outline | str, evenodd: bool = False, transform: str = "") -> str:
    d = path if isinstance(path, str) else path.d()
    rule = ' fill-rule="evenodd"' if evenodd else ""
    moved = f' transform="{transform}"' if transform else ""
    return f'<path d="{d}" fill="{COLOR}"{rule}{moved}/>'


def polygon(points: list[tuple[float, float]]) -> str:
    return f'<polygon points="{" ".join(f"{n(x)},{n(y)}" for x, y in points)}" fill="{COLOR}"/>'


def circle(cx: float, cy: float, r: float) -> str:
    return f'<circle cx="{n(cx)}" cy="{n(cy)}" r="{n(r)}" fill="{COLOR}"/>'


def ellipse(cx: float, cy: float, rx: float, ry: float) -> str:
    return f'<ellipse cx="{n(cx)}" cy="{n(cy)}" rx="{n(rx)}" ry="{n(ry)}" fill="{COLOR}"/>'


def rect(x: float, y: float, w: float, h: float, r: float = 0) -> str:
    radius = f' rx="{n(r)}"' if r else ""
    return f'<rect x="{n(x)}" y="{n(y)}" width="{n(w)}" height="{n(h)}"{radius} fill="{COLOR}"/>'


def stroke_path(d: str, width: float = 6, extra: str = "") -> str:
    return (
        f'<path d="{d}" fill="none" stroke="{COLOR}" stroke-width="{n(width)}" '
        f'stroke-linecap="round" stroke-linejoin="round"{extra}/>'
    )


def stroke_line(x1: float, y1: float, x2: float, y2: float, width: float = 4, extra: str = "") -> str:
    return (
        f'<line x1="{n(x1)}" y1="{n(y1)}" x2="{n(x2)}" y2="{n(y2)}" stroke="{COLOR}" '
        f'stroke-width="{n(width)}" stroke-linecap="round"{extra}/>'
    )


# ---- Registry ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Shape:
    pack: str
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


SHAPES: list[Shape] = []


def add(pack: str, folder: str, name: str, body: str, width: float = 100, height: float = 100) -> None:
    SHAPES.append(Shape(pack, folder, name, width, height, body))


# ---- Basic shapes -----------------------------------------------------------------------------------------


def polar(cx: float, cy: float, radius: float, degrees: float) -> tuple[float, float]:
    return cx + radius * math.cos(math.radians(degrees)), cy + radius * math.sin(math.radians(degrees))


def notched_square(x: float, y: float, size: float, cells: int, radius: float) -> Outline:
    """Square outline with a half-circle notch in every cell of every edge (postage-stamp edge)."""
    pitch = size / cells
    pad = (pitch - 2 * radius) / 2
    path = Outline().M(x, y)
    px, py = x, y
    for dx, dy in ((1, 0), (0, 1), (-1, 0), (0, -1)):
        for _ in range(cells):
            path.L(px + dx * pad, py + dy * pad)
            path.A(radius, radius, 0, 0, px + dx * (pad + 2 * radius), py + dy * (pad + 2 * radius))
            px, py = px + dx * pitch, py + dy * pitch
            path.L(px, py)
    return path.Z()


def hollow(outer: Outline, inner: Outline) -> str:
    """A frame: `outer` with `inner` cut out (even-odd fill)."""
    return fill(outer.d() + " " + inner.d(), True)


def circular_arrow() -> Outline:
    outer, inner, mid, start, end = 38.0, 24.0, 31.0, 120.0, 390.0
    return (
        Outline()
        .M(*polar(50, 50, outer, start))
        .A(outer, outer, 1, 1, *polar(50, 50, outer, end))
        .L(*polar(50, 50, outer + 10, end))
        .L(*polar(50, 50, mid, end + 26))
        .L(*polar(50, 50, inner - 10, end))
        .L(*polar(50, 50, inner, end))
        .A(inner, inner, 1, 0, *polar(50, 50, inner, start))
        .Z()
    )


def build_basic_shapes() -> None:
    pack = "basic-shapes"
    add(pack, "rectangles", "square", rect(8, 8, 84, 84))
    add(pack, "rectangles", "rectangle-wide", rect(4, 8, 112, 64), 120, 80)
    add(pack, "rectangles", "rectangle-tall", rect(8, 4, 64, 112), 80, 120)
    add(pack, "rectangles", "rounded-square", rect(8, 8, 84, 84, 18))
    add(pack, "rectangles", "rounded-rectangle", rect(4, 8, 112, 64, 16), 120, 80)
    add(pack, "rectangles", "pill", rect(4, 8, 112, 44, 22), 120, 60)
    add(pack, "rectangles", "pill-vertical", rect(8, 4, 44, 112, 22), 60, 120)
    add(pack, "rectangles", "squircle", polygon(superellipse(50, 50, 44, 44)))
    add(pack, "circles", "circle", circle(50, 50, 44))
    add(pack, "circles", "ellipse-wide", ellipse(60, 40, 56, 36), 120, 80)
    add(pack, "circles", "ellipse-tall", ellipse(40, 60, 36, 56), 80, 120)
    add(pack, "circles", "semicircle", fill(Outline().M(6, 52).A(44, 44, 0, 1, 94, 52).Z()), 100, 60)
    add(pack, "circles", "quarter-circle", fill(Outline().M(8, 92).L(8, 8).A(84, 84, 0, 1, 92, 92).Z()))
    add(pack, "circles", "ring", hollow(circle_path(50, 50, 44), circle_path(50, 50, 28)))
    add(pack, "circles", "crescent-moon", fill(crescent_path()))
    add(pack, "triangles", "triangle", polygon([(50, 8), (94, 88), (6, 88)]))
    add(pack, "triangles", "right-triangle", polygon([(10, 90), (10, 10), (90, 90)]))
    add(pack, "triangles", "triangle-wide", polygon([(60, 6), (116, 74), (4, 74)]), 120, 80)
    add(pack, "triangles", "rhombus", polygon([(50, 4), (96, 50), (50, 96), (4, 50)]))
    add(pack, "triangles", "parallelogram", polygon([(30, 8), (116, 8), (90, 72), (4, 72)]), 120, 80)
    add(pack, "triangles", "trapezoid", polygon([(30, 8), (90, 8), (116, 72), (4, 72)]), 120, 80)
    for sides, label in ((5, "pentagon"), (6, "hexagon"), (7, "heptagon"), (8, "octagon")):
        rotation = -90 if sides % 2 else -90 + 180 / sides
        add(pack, "polygons", label, polygon(regular_polygon(sides, 50, 52, 46, rotation)))
    inner_ratio = {4: 0.42, 5: 0.4, 6: 0.55, 7: 0.5, 8: 0.6, 9: 0.55, 10: 0.7, 12: 0.78}
    for count, ratio in inner_ratio.items():
        add(pack, "stars", f"star-{count}", polygon(star_points(count, 50, 52, 46, 46 * ratio)))
    add(pack, "stars", "starburst", polygon(star_points(24, 50, 50, 46, 38)))
    add(
        pack,
        "stars",
        "sparkle",
        fill(Outline().M(50, 2).Q(58, 42, 98, 50).Q(58, 58, 50, 98).Q(42, 58, 2, 50).Q(42, 42, 50, 2).Z()),
    )
    add(
        pack,
        "stars",
        "sparkles",
        fill(Outline().M(38, 14).Q(44, 38, 68, 44).Q(44, 50, 38, 74).Q(32, 50, 8, 44).Q(32, 38, 38, 14).Z())
        + fill(
            Outline().M(78, 52).Q(81, 66, 94, 69).Q(81, 72, 78, 86).Q(75, 72, 62, 69).Q(75, 66, 78, 52).Z()
        ),
    )
    add(pack, "hearts", "heart", fill(heart_path()))
    add(pack, "hearts", "heart-outline", hollow(heart_path(), heart_path().scaled(0.7, 50, 46)))
    add(
        pack,
        "hearts",
        "double-heart",
        fill(heart_path().scaled(0.66, 50, 50), transform="translate(-13 -8)")
        + fill(heart_path().scaled(0.5, 50, 50), transform="translate(24 20)"),
    )
    for seed in (3, 7, 12, 21):
        add(pack, "blobs", f"blob-{seed}", fill(blob_path(seed)))
    add(
        pack,
        "nature",
        "cloud",
        circle(34, 54, 20) + circle(56, 40, 26) + circle(78, 56, 18) + rect(14, 54, 80, 22, 11),
        110,
        92,
    )
    add(pack, "nature", "lightning", polygon([(58, 4), (20, 56), (46, 56), (36, 96), (80, 40), (54, 40)]))
    add(
        pack,
        "nature",
        "droplet",
        fill(Outline().M(50, 6).C(50, 6, 18, 44, 18, 64).A(32, 32, 0, 0, 82, 64).C(82, 44, 50, 6, 50, 6).Z()),
    )
    add(
        pack,
        "nature",
        "leaf",
        fill(Outline().M(10, 90).C(10, 40, 40, 10, 90, 10).C(90, 60, 60, 90, 10, 90).Z()),
    )
    petals = "".join(circle(*polar(50, 50, 24, angle), 20) for angle in range(-90, 270, 72))
    add(pack, "nature", "flower", petals + circle(50, 50, 18))
    rays = "".join(
        polygon([polar(50, 50, 32, angle - 7), polar(50, 50, 46, angle), polar(50, 50, 32, angle + 7)])
        for angle in range(0, 360, 30)
    )
    add(pack, "nature", "sun", circle(50, 50, 22) + rays)
    add(
        pack,
        "symbols",
        "crown",
        polygon([(6, 76), (2, 26), (28, 46), (50, 12), (72, 46), (98, 26), (94, 76)])
        + rect(6, 82, 88, 12, 4),
    )
    add(
        pack,
        "symbols",
        "shield",
        fill(
            Outline()
            .M(50, 6)
            .L(90, 20)
            .L(90, 52)
            .C(90, 74, 72, 88, 50, 96)
            .C(28, 88, 10, 74, 10, 52)
            .L(10, 20)
            .Z()
        ),
    )
    pin = Outline().M(50, 96).C(50, 96, 16, 58, 16, 38).A(34, 34, 0, 1, 84, 38).C(84, 58, 50, 96, 50, 96).Z()
    add(pack, "symbols", "location-pin", hollow(pin, circle_path(50, 38, 12)))
    add(pack, "symbols", "bookmark", polygon([(24, 6), (76, 6), (76, 94), (50, 74), (24, 94)]))
    add(
        pack,
        "symbols",
        "cross",
        polygon(
            [
                (36, 6),
                (64, 6),
                (64, 36),
                (94, 36),
                (94, 64),
                (64, 64),
                (64, 94),
                (36, 94),
                (36, 64),
                (6, 64),
                (6, 36),
                (36, 36),
            ]
        ),
    )
    add(pack, "symbols", "plus-rounded", rect(40, 8, 20, 84, 10) + rect(8, 40, 84, 20, 10))
    add(
        pack,
        "symbols",
        "x-mark",
        f'<g transform="rotate(45 50 50)">{rect(40, 4, 20, 92, 10)}{rect(4, 40, 92, 20, 10)}</g>',
    )
    add(pack, "symbols", "minus-rounded", rect(8, 40, 84, 20, 10))
    add(pack, "symbols", "check-mark", polygon([(8, 54), (22, 40), (40, 58), (78, 16), (92, 30), (40, 86)]))
    add(pack, "badges", "seal-12", fill(scallop_path(50, 50, 40, 12)))
    add(pack, "badges", "seal-16", fill(scallop_path(50, 50, 41, 16, 0.55)))
    add(pack, "badges", "seal-20", fill(scallop_path(50, 50, 42, 20, 0.6)))
    add(pack, "badges", "seal-ring", hollow(scallop_path(50, 50, 42, 16, 0.55), circle_path(50, 50, 28)))
    add(pack, "badges", "burst-badge", polygon(star_points(16, 50, 50, 47, 38)))
    for label, height, amp in (("gentle", 56, 9), ("deep", 64, 16)):
        mid = height / 2
        smooth = " ".join(f"T{x} {n(mid)}" for x in (100, 150, 200))
        wave = f"M0 {n(mid)} Q25 {n(mid - amp)} 50 {n(mid)} {smooth} V{n(height)} H0 Z"
        add(pack, "waves", f"wave-{label}", fill(wave), 200, height)
    zigzag = Outline().M(0, 10)
    for i in range(10):
        zigzag.L(10 + 20 * i, 10 if i % 2 else 28)
    zigzag.L(200, 10).L(200, 48).L(0, 48).Z()
    add(pack, "waves", "wave-zigzag", fill(zigzag), 200, 48)
    scallops = Outline().M(0, 14)
    for i in range(10):
        scallops.A(10, 10, 0, 1, 20 * (i + 1), 14)
    scallops.L(200, 40).L(0, 40).Z()
    add(pack, "waves", "wave-scallop", fill(scallops), 200, 40)


# ---- Lines & dividers --------------------------------------------------------------------------------------


def build_lines() -> None:
    pack = "lines-dividers"
    w = 200
    dash = ' stroke-dasharray="{}"'.format
    add(pack, "lines", "line-solid", stroke_line(6, 8, w - 6, 8, 4), w, 16)
    add(pack, "lines", "line-thin", stroke_line(6, 8, w - 6, 8, 2), w, 16)
    add(pack, "lines", "line-thick", stroke_line(10, 10, w - 10, 10, 10), w, 20)
    add(pack, "lines", "line-dashed", stroke_line(6, 8, w - 6, 8, 4, dash("16 12")), w, 16)
    add(pack, "lines", "line-dotted", stroke_line(6, 8, w - 6, 8, 5, dash("0 12")), w, 16)
    add(pack, "lines", "line-dash-dot", stroke_line(6, 8, w - 6, 8, 4, dash("18 8 2 8")), w, 16)
    add(
        pack, "lines", "line-double", stroke_line(6, 6, w - 6, 6, 3) + stroke_line(6, 16, w - 6, 16, 3), w, 22
    )
    add(
        pack,
        "lines",
        "line-thick-thin",
        stroke_line(8, 8, w - 8, 8, 8) + stroke_line(6, 20, w - 6, 20, 2),
        w,
        28,
    )
    add(pack, "lines", "line-vertical", stroke_line(8, 6, 8, 194, 4), 16, 200)
    add(pack, "lines", "line-vertical-dashed", stroke_line(8, 6, 8, 194, 4, dash("16 12")), 16, 200)
    add(pack, "lines", "line-diagonal", stroke_line(10, 190, 190, 10, 4), 200, 200)
    head_r = polygon([(176, 2), (196, 12), (176, 22)])
    head_l = polygon([(24, 2), (4, 12), (24, 22)])
    add(pack, "arrow-lines", "arrow-line-right", stroke_line(6, 12, 182, 12, 4) + head_r, w, 24)
    add(pack, "arrow-lines", "arrow-line-left", stroke_line(18, 12, 194, 12, 4) + head_l, w, 24)
    add(pack, "arrow-lines", "arrow-line-both", stroke_line(16, 12, 184, 12, 4) + head_r + head_l, w, 24)
    add(
        pack,
        "arrow-lines",
        "arrow-line-dashed",
        stroke_line(6, 12, 182, 12, 4, dash("14 10")) + head_r,
        w,
        24,
    )
    add(pack, "arrow-lines", "arrow-line-open", stroke_path("M6 14 H190 M170 2 L192 14 L170 26", 4), w, 28)
    add(
        pack,
        "arrow-lines",
        "arrow-line-curved",
        stroke_path("M8 52 C50 52 60 8 110 8 S160 40 184 40", 4) + polygon([(180, 28), (198, 40), (178, 52)]),
        w,
        60,
    )
    add(
        pack,
        "arrow-lines",
        "arrow-line-elbow",
        stroke_path("M8 8 H100 V52 H176", 4) + polygon([(174, 42), (194, 52), (174, 62)]),
        w,
        64,
    )
    wave = "M6 16 " + " ".join(
        f"Q{n(6 + 16 * (2 * i + 1))} {0 if i % 2 == 0 else 32} {n(6 + 32 * (i + 1))} 16" for i in range(6)
    )
    add(pack, "decorative", "wavy-line", stroke_path(wave, 4), w, 32)
    zigzag = "M6 24 " + " ".join(f"L{n(6 + 16 * (i + 1))} {8 if i % 2 == 0 else 24}" for i in range(12))
    add(pack, "decorative", "zigzag-line", stroke_path(zigzag, 4), w, 32)
    scallop = "M6 22 " + " ".join(f"A12 12 0 0 1 {n(6 + 24 * (i + 1))} 22" for i in range(8))
    add(pack, "decorative", "scalloped-line", stroke_path(scallop, 4), w, 32)
    add(
        pack,
        "decorative",
        "diamond-divider",
        stroke_line(6, 14, 84, 14, 3)
        + stroke_line(116, 14, 194, 14, 3)
        + polygon([(100, 2), (112, 14), (100, 26), (88, 14)]),
        w,
        28,
    )
    add(pack, "decorative", "dots-divider", "".join(circle(70 + 30 * i, 10, 5) for i in range(3)), w, 20)
    add(
        pack,
        "decorative",
        "star-divider",
        stroke_line(6, 14, 82, 14, 3)
        + stroke_line(118, 14, 194, 14, 3)
        + polygon(star_points(5, 100, 14, 13, 5.5)),
        w,
        28,
    )
    add(
        pack,
        "decorative",
        "flourish",
        stroke_path("M8 20 C30 20 36 6 56 6 C76 6 80 20 100 20 C120 20 124 6 144 6 C164 6 170 20 192 20", 3.5)
        + circle(100, 20, 4),
        w,
        28,
    )
    add(pack, "brackets", "bracket-square-left", stroke_path("M30 6 H10 V94 H30", 6), 40, 100)
    add(pack, "brackets", "bracket-square-right", stroke_path("M10 6 H30 V94 H10", 6), 40, 100)
    add(pack, "brackets", "bracket-round-left", stroke_path("M30 6 C8 30 8 70 30 94", 6), 40, 100)
    add(pack, "brackets", "bracket-round-right", stroke_path("M10 6 C32 30 32 70 10 94", 6), 40, 100)
    add(
        pack,
        "brackets",
        "bracket-curly-left",
        stroke_path("M32 6 C18 6 22 30 22 40 C22 46 16 50 8 50 C16 50 22 54 22 60 C22 70 18 94 32 94", 5),
        40,
        100,
    )
    add(
        pack,
        "brackets",
        "bracket-curly-right",
        stroke_path("M8 6 C22 6 18 30 18 40 C18 46 24 50 32 50 C24 50 18 54 18 60 C18 70 22 94 8 94", 5),
        40,
        100,
    )
    add(pack, "brackets", "bracket-angle-left", stroke_path("M30 6 L8 50 L30 94", 6), 40, 100)
    add(pack, "brackets", "bracket-angle-right", stroke_path("M10 6 L32 50 L10 94", 6), 40, 100)


# ---- Frames & masks ----------------------------------------------------------------------------------------


def build_frames() -> None:
    pack = "frames-masks"
    add(pack, "masks", "mask-circle", circle(50, 50, 46))
    add(pack, "masks", "mask-square", rect(6, 6, 88, 88))
    add(pack, "masks", "mask-rounded-square", rect(6, 6, 88, 88, 18))
    add(pack, "masks", "mask-rounded-landscape", rect(4, 6, 112, 78, 14), 120, 90)
    add(pack, "masks", "mask-rounded-portrait", rect(6, 4, 78, 112, 14), 90, 120)
    add(pack, "masks", "mask-squircle", polygon(superellipse(50, 50, 46, 46)))
    add(pack, "masks", "mask-oval", ellipse(40, 60, 36, 56), 80, 120)
    add(pack, "masks", "mask-arch", fill(arch_path(14, 6, 72, 90)))
    add(pack, "masks", "mask-heart", fill(heart_path()))
    add(pack, "masks", "mask-star", polygon(star_points(5, 50, 53, 48, 20)))
    add(pack, "masks", "mask-hexagon", polygon(regular_polygon(6, 50, 50, 47, -90)))
    add(pack, "masks", "mask-diamond", polygon([(50, 3), (97, 50), (50, 97), (3, 50)]))
    add(pack, "masks", "mask-blob", fill(blob_path(5, radius=47)))
    add(pack, "masks", "mask-seal", fill(scallop_path(50, 50, 42, 14, 0.55)))
    ticket = (
        Outline()
        .M(6, 14)
        .L(94, 14)
        .L(94, 38)
        .A(12, 12, 0, 0, 94, 62)
        .L(94, 86)
        .L(6, 86)
        .L(6, 62)
        .A(12, 12, 0, 0, 6, 38)
        .Z()
    )
    add(pack, "masks", "mask-ticket", fill(ticket))
    add(pack, "frames", "frame-square", hollow(rrect(4, 4, 92, 92, 0), rrect(14, 14, 72, 72, 0)))
    add(pack, "frames", "frame-square-thin", hollow(rrect(4, 4, 92, 92, 0), rrect(8, 8, 84, 84, 0)))
    add(pack, "frames", "frame-rounded", hollow(rrect(4, 4, 92, 92, 18), rrect(14, 14, 72, 72, 9)))
    add(pack, "frames", "frame-circle", hollow(circle_path(50, 50, 46), circle_path(50, 50, 38)))
    add(pack, "frames", "frame-circle-thick", hollow(circle_path(50, 50, 46), circle_path(50, 50, 30)))
    add(
        pack,
        "frames",
        "frame-oval",
        hollow(ellipse_path(40, 60, 38, 56), ellipse_path(40, 60, 30, 48)),
        80,
        120,
    )
    add(pack, "frames", "frame-arch", hollow(arch_path(10, 4, 80, 92), arch_path(20, 14, 60, 72)))
    add(pack, "frames", "frame-heart", hollow(heart_path(), heart_path().scaled(0.78, 50, 46)))
    add(
        pack,
        "frames",
        "frame-hexagon",
        hollow(
            Outline().polygon(regular_polygon(6, 50, 50, 47)),
            Outline().polygon(regular_polygon(6, 50, 50, 38)),
        ),
    )
    add(
        pack,
        "frames",
        "frame-double",
        hollow(rrect(2, 2, 96, 96, 8), rrect(8, 8, 84, 84, 4))
        + hollow(rrect(16, 16, 68, 68, 2), rrect(21, 21, 58, 58, 0)),
    )
    add(
        pack,
        "frames",
        "frame-cut-corner",
        hollow(
            Outline().polygon([(20, 4), (80, 4), (96, 20), (96, 80), (80, 96), (20, 96), (4, 80), (4, 20)]),
            Outline().polygon(
                [(24, 12), (76, 12), (88, 24), (88, 76), (76, 88), (24, 88), (12, 76), (12, 24)]
            ),
        ),
    )
    add(pack, "frames", "frame-seal", hollow(scallop_path(50, 50, 44, 18, 0.55), circle_path(50, 50, 34)))
    add(pack, "frames", "frame-polaroid", hollow(rrect(8, 4, 84, 92, 3), rrect(16, 12, 68, 62, 1)))
    holes = Outline()
    for i in range(8):
        for y in (5, 49):
            holes.ops.extend(rrect(6 + 19.5 * i, y, 9, 6, 1.5).ops)
    for i in range(4):
        holes.ops.extend(rrect(10 + 36 * i, 18, 32, 24, 2).ops)
    add(
        pack, "frames", "frame-film-strip", fill(rrect(0, 0, 160, 60, 4).d() + " " + holes.d(), True), 160, 60
    )
    add(pack, "frames", "frame-stamp", hollow(notched_square(4, 4, 92, 9, 2.5), rrect(16, 16, 68, 68, 0)))

    def corner(x: float, y: float, sx: int, sy: int) -> str:
        return polygon(
            [
                (x, y),
                (x + sx * 26, y),
                (x + sx * 26, y + sy * 6),
                (x + sx * 6, y + sy * 6),
                (x + sx * 6, y + sy * 26),
                (x, y + sy * 26),
            ]
        )

    add(
        pack,
        "frames",
        "frame-corners",
        corner(4, 4, 1, 1) + corner(96, 4, -1, 1) + corner(4, 96, 1, -1) + corner(96, 96, -1, -1),
    )


# ---- Arrows & callouts -------------------------------------------------------------------------------------


def build_arrows() -> None:
    pack = "arrows-callouts"
    right = [(6, 36), (58, 36), (58, 14), (94, 50), (58, 86), (58, 64), (6, 64)]
    add(pack, "arrows", "arrow-right", polygon(right))
    add(pack, "arrows", "arrow-left", polygon([(100 - x, y) for x, y in right]))
    add(pack, "arrows", "arrow-up", polygon([(y, 100 - x) for x, y in right]))
    add(pack, "arrows", "arrow-down", polygon([(y, x) for x, y in right]))
    add(
        pack,
        "arrows",
        "arrow-double",
        polygon(
            [
                (4, 50),
                (30, 24),
                (30, 40),
                (70, 40),
                (70, 24),
                (96, 50),
                (70, 76),
                (70, 60),
                (30, 60),
                (30, 76),
            ]
        ),
    )
    add(
        pack,
        "arrows",
        "arrow-notched",
        polygon([(6, 30), (62, 30), (62, 12), (96, 50), (62, 88), (62, 70), (6, 70), (22, 50)]),
    )
    add(pack, "arrows", "arrow-pentagon", polygon([(6, 24), (66, 24), (96, 50), (66, 76), (6, 76)]))
    add(
        pack,
        "arrows",
        "arrow-bent",
        polygon([(10, 92), (10, 44), (58, 44), (58, 20), (92, 54), (58, 88), (58, 64), (34, 64), (34, 92)]),
    )
    add(
        pack,
        "arrows",
        "arrow-u-turn",
        stroke_path("M22 94 V42 A22 22 0 0 1 66 42 V58", 14) + polygon([(44, 56), (88, 56), (66, 90)]),
    )
    add(
        pack,
        "arrows",
        "arrow-curved",
        fill(
            Outline()
            .M(8, 80)
            .C(8, 40, 34, 24, 68, 24)
            .L(68, 8)
            .L(94, 36)
            .L(68, 64)
            .L(68, 48)
            .C(44, 48, 28, 58, 28, 80)
            .Z()
        ),
    )
    add(pack, "arrows", "arrow-circular", fill(circular_arrow()))
    add(pack, "arrows", "arrow-triangle-right", polygon([(24, 10), (90, 50), (24, 90)]))
    add(pack, "arrows", "arrow-triangle-up", polygon([(10, 76), (50, 10), (90, 76)]))
    for direction, points in (
        ("right", [(26, 8), (46, 8), (84, 50), (46, 92), (26, 92), (64, 50)]),
        ("left", [(74, 8), (54, 8), (16, 50), (54, 92), (74, 92), (36, 50)]),
        ("up", [(8, 74), (8, 54), (50, 16), (92, 54), (92, 74), (50, 36)]),
        ("down", [(8, 26), (8, 46), (50, 84), (92, 46), (92, 26), (50, 64)]),
    ):
        add(pack, "chevrons", f"chevron-{direction}", polygon(points))
    add(
        pack,
        "chevrons",
        "chevron-double-right",
        polygon([(6, 14), (24, 14), (52, 50), (24, 86), (6, 86), (34, 50)])
        + polygon([(48, 14), (66, 14), (94, 50), (66, 86), (48, 86), (76, 50)]),
    )
    add(
        pack,
        "chevrons",
        "chevron-triple-right",
        "".join(
            polygon(
                [
                    (4 + 30 * i, 18),
                    (18 + 30 * i, 18),
                    (40 + 30 * i, 50),
                    (18 + 30 * i, 82),
                    (4 + 30 * i, 82),
                    (26 + 30 * i, 50),
                ]
            )
            for i in range(3)
        ),
    )
    add(
        pack,
        "speech-bubbles",
        "bubble-round",
        ellipse(50, 42, 44, 34) + polygon([(26, 66), (20, 92), (50, 72)]),
    )
    add(
        pack,
        "speech-bubbles",
        "bubble-round-right",
        ellipse(50, 42, 44, 34) + polygon([(74, 66), (80, 92), (50, 72)]),
    )
    add(
        pack,
        "speech-bubbles",
        "bubble-rounded-rect",
        rect(6, 8, 88, 62, 16) + polygon([(22, 66), (22, 94), (48, 66)]),
    )
    add(
        pack,
        "speech-bubbles",
        "bubble-rounded-rect-right",
        rect(6, 8, 88, 62, 16) + polygon([(78, 66), (78, 94), (52, 66)]),
    )
    add(pack, "speech-bubbles", "bubble-square", rect(6, 8, 88, 60) + polygon([(20, 64), (20, 94), (46, 64)]))
    add(
        pack,
        "speech-bubbles",
        "bubble-wide",
        rect(4, 8, 192, 56, 28) + polygon([(34, 60), (26, 92), (62, 60)]),
        200,
        100,
    )
    add(
        pack,
        "speech-bubbles",
        "bubble-thought",
        ellipse(54, 38, 42, 30) + circle(26, 74, 7) + circle(14, 90, 4),
    )
    add(
        pack,
        "speech-bubbles",
        "bubble-cloud",
        circle(30, 36, 20)
        + circle(52, 26, 22)
        + circle(74, 38, 18)
        + circle(40, 54, 20)
        + circle(62, 54, 18)
        + circle(22, 70, 6)
        + circle(12, 86, 4),
    )
    add(pack, "speech-bubbles", "bubble-shout", polygon(star_points(14, 50, 50, 48, 34)))
    add(
        pack,
        "speech-bubbles",
        "bubble-oval-wide",
        ellipse(60, 40, 56, 34) + polygon([(40, 66), (28, 92), (66, 70)]),
        120,
        100,
    )
    add(
        pack,
        "banners",
        "banner-swallow",
        polygon([(4, 20), (196, 20), (178, 50), (196, 80), (4, 80)]),
        200,
        100,
    )
    add(pack, "banners", "banner-flag", polygon([(4, 20), (196, 20), (196, 80), (4, 80), (24, 50)]), 200, 100)
    add(
        pack,
        "banners",
        "banner-folded",
        polygon([(2, 34), (30, 34), (30, 84), (2, 84), (14, 59)])
        + polygon([(170, 34), (198, 34), (186, 59), (198, 84), (170, 84)])
        + rect(26, 16, 148, 56)
        + polygon([(26, 72), (40, 72), (26, 84)])
        + polygon([(174, 72), (160, 72), (174, 84)]),
        200,
        100,
    )
    add(pack, "banners", "banner-rounded", rect(4, 22, 192, 56, 28), 200, 100)
    scroll_ends = hollow(ellipse_path(24, 50, 14, 38), ellipse_path(24, 50, 6, 30)) + hollow(
        ellipse_path(176, 50, 14, 38), ellipse_path(176, 50, 6, 30)
    )
    add(pack, "banners", "banner-scroll", rect(36, 16, 128, 68) + scroll_ends, 200, 100)
    tag = Outline().M(8, 30).L(30, 8).L(92, 8).L(92, 92).L(30, 92).L(8, 70).Z()
    add(pack, "banners", "price-tag", hollow(tag, circle_path(26, 50, 6)))
    add(pack, "banners", "ribbon-bookmark", polygon([(18, 4), (82, 4), (82, 96), (50, 72), (18, 96)]))
    add(
        pack,
        "banners",
        "award-ribbon",
        circle(50, 36, 30)
        + polygon([(28, 58), (14, 98), (34, 88), (44, 98), (48, 62)])
        + polygon([(72, 58), (86, 98), (66, 88), (56, 98), (52, 62)]),
    )


def build_all() -> list[Shape]:
    SHAPES.clear()
    build_basic_shapes()
    build_lines()
    build_frames()
    build_arrows()
    return list(SHAPES)


def generate(target: FilePath) -> list[FilePath]:
    """Write every shape below `target/<pack>/<folder>/<name>.svg` and return the written paths."""
    written = []
    for shape in build_all():
        path = target / shape.pack / shape.folder / f"{shape.name}.svg"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(shape.svg(), encoding="utf-8")
        written.append(path)
    return written


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    files = generate(FilePath(argv[1]))
    print(f"Wrote {len(files)} SVG files to {argv[1]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
