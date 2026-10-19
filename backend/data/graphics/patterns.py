"""Backgrounds & Patterns: 600 x 600 backgrounds made of plain shapes (no `<pattern>` fills, filters or
noise), each in a background / main / accent colour way so they look good as they are and recolour per colour.
"""

# ruff: noqa: E501  (SVG path data and coordinates are written inline, one graphic per statement)

from __future__ import annotations

import math

from .kit import (
    COLORWAYS,
    INK,
    RED,
    ROSE_DARK,
    ROSE_LIGHT,
    ROSE_SOFT,
    SUN,
    WHITE,
    Collector,
    Rng,
    blob_path,
    circle,
    defs,
    line,
    linear_gradient,
    n,
    path,
    polar,
    polygon,
    radial_gradient,
    rect,
    regular_polygon,
    rotate_point,
    smooth,
    star_points,
    stroke,
)

S = 600
SET_ID = "backgrounds-patterns"


def clip_polygon(points: list[tuple[float, float]], size: float = S) -> list[tuple[float, float]]:
    """`points` cut to the square `[0, size]²` (Sutherland-Hodgman), so rotated bands never leave the canvas."""

    def clip(poly, inside, intersect):
        out = []
        for i, current in enumerate(poly):
            previous = poly[i - 1]
            if inside(current):
                if not inside(previous):
                    out.append(intersect(previous, current))
                out.append(current)
            elif inside(previous):
                out.append(intersect(previous, current))
        return out

    def at_x(x):
        return lambda a, b: (x, a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]))

    def at_y(y):
        return lambda a, b: (a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]), y)

    poly = points
    for inside, intersect in (
        (lambda p: p[0] >= 0, at_x(0)),
        (lambda p: p[0] <= size, at_x(size)),
        (lambda p: p[1] >= 0, at_y(0)),
        (lambda p: p[1] <= size, at_y(size)),
    ):
        if not poly:
            break
        poly = clip(poly, inside, intersect)
    return poly


def background(color: str) -> str:
    return rect(0, 0, S, S, color)


def band(c1: float, c2: float, color: str, flip: bool = False) -> str:
    """A diagonal band between the lines x + y = c1 and x + y = c2 (x - y when `flip`), cut to the canvas."""
    if flip:
        poly = [(c1 - S, -S), (c2 - S, -S), (c2 + 2 * S, 2 * S), (c1 + 2 * S, 2 * S)]
    else:
        poly = [(c1 + S, -S), (c2 + S, -S), (c2 - 2 * S, 2 * S), (c1 - 2 * S, 2 * S)]
    clipped = clip_polygon(poly)
    return polygon(clipped, color) if len(clipped) >= 3 else ""


_CLIP_ID = "canvas"


def clipped(body: str) -> str:
    """`body` cut to the canvas, for motifs that run off the edge on purpose."""
    return (
        f'<defs><clipPath id="{_CLIP_ID}"><rect width="{S}" height="{S}"/></clipPath></defs>'
        f'<g clip-path="url(#{_CLIP_ID})">{body}</g>'
    )


def build(add: Collector) -> None:
    ways = iter(range(10**6))

    def put(folder: str, name: str, draw, way: int | None = None) -> None:
        bg, fg, accent = COLORWAYS[(next(ways) if way is None else way) % len(COLORWAYS)]
        add(folder, name, background(bg) + draw(fg, accent, bg), S, S)

    # ---- dots ----------------------------------------------------------------------------------------------

    def polka(fg, ac, bg):
        return "".join(
            circle(25 + 50 * i + (25 if j % 2 else 0), 25 + 50 * j, 9, fg)
            for j in range(12)
            for i in range(12 if j % 2 == 0 else 11)
        )

    put("dots", "polka-dots", polka)

    def dot_grid(fg, ac, bg):
        return "".join(circle(20 + 40 * i, 20 + 40 * j, 5, fg) for i in range(15) for j in range(15))

    put("dots", "dot-grid", dot_grid)

    def big_dots(fg, ac, bg):
        return "".join(
            circle(50 + 100 * i, 50 + 100 * j, 32, fg) for i in range(6) for j in range(6)
        ) + "".join(circle(100 * i, 100 * j, 9, ac) for i in range(1, 6) for j in range(1, 6))

    put("dots", "big-dots", big_dots)

    def halftone_fade(fg, ac, bg):
        out = []
        for j in range(20):
            for i in range(20):
                radius = 1 + 12.5 * j / 19
                out.append(circle(15 + 30 * i + (15 if j % 2 else 0) * (i < 19), 15 + 30 * j, radius, fg))
        return "".join(out)

    put("dots", "halftone-fade", halftone_fade)

    def halftone_radial(fg, ac, bg):
        out = []
        for j in range(20):
            for i in range(20):
                x, y = 15 + 30 * i, 15 + 30 * j
                radius = max(1.0, 14.5 * (1 - math.hypot(x - 300, y - 300) / 330))
                out.append(circle(x, y, radius, fg))
        return "".join(out)

    put("dots", "halftone-radial", halftone_radial)

    def two_tone(fg, ac, bg):
        return "".join(
            circle(30 + 60 * i, 30 + 60 * j, 18, fg if (i + j) % 2 else ac)
            for i in range(10)
            for j in range(10)
        )

    put("dots", "two-tone-dots", two_tone)

    def ring_dots(fg, ac, bg):
        return "".join(
            circle(30 + 60 * i, 30 + 60 * j, 15, "none", stroke=fg, stroke_width=4)
            + circle(30 + 60 * i, 30 + 60 * j, 4, ac)
            for i in range(10)
            for j in range(10)
        )

    put("dots", "ring-dots", ring_dots)

    def dot_confetti(fg, ac, bg):
        rng = Rng(11)
        return "".join(
            circle(
                rng.uniform(20, S - 20),
                rng.uniform(20, S - 20),
                rng.uniform(4, 16),
                fg if rng.random() < 0.6 else ac,
            )
            for _ in range(90)
        )

    put("dots", "dot-confetti", dot_confetti)

    def sunflower(fg, ac, bg):
        golden = math.pi * (3 - math.sqrt(5))
        out = []
        for k in range(1, 420):
            r = 13.4 * math.sqrt(k)
            x, y = 300 + r * math.cos(k * golden), 300 + r * math.sin(k * golden)
            if 8 < x < S - 8 and 8 < y < S - 8:
                out.append(circle(x, y, 2 + 5 * min(1, r / 280), fg if k % 5 else ac))
        return "".join(out)

    put("dots", "sunflower-dots", sunflower)

    # ---- stripes ---------------------------------------------------------------------------------------------

    def stripes(vertical: bool, width: int):
        def draw(fg, ac, bg):
            return "".join(
                rect(*((i * width, 0, width, S) if vertical else (0, i * width, S, width)), fg)
                for i in range(0, S // width, 2)
            )

        return draw

    put("stripes", "stripes-horizontal", stripes(False, 50))
    put("stripes", "stripes-vertical", stripes(True, 50))
    put("stripes", "stripes-wide", stripes(False, 100))

    def diagonal(width: int, flip: bool = False):
        def draw(fg, ac, bg):
            return "".join(band(c, c + width, fg, flip) for c in range(-S, 2 * S, 2 * width) if c + width > 0)

        return draw

    put("stripes", "stripes-diagonal", diagonal(40))
    put("stripes", "stripes-diagonal-thin", diagonal(14))
    put("stripes", "stripes-diagonal-wide", diagonal(90))

    def pinstripe(fg, ac, bg):
        return "".join(rect(i * 24 + 11, 0, 2, S, fg) for i in range(S // 24))

    put("stripes", "pinstripe", pinstripe)

    def double_stripes(fg, ac, bg):
        return "".join(rect(i * 100 + 20, 0, 22, S, fg) + rect(i * 100 + 58, 0, 10, S, ac) for i in range(6))

    put("stripes", "stripes-double", double_stripes)

    def chevron(fg, ac, bg):
        out = []
        for row in range(-1, 12, 2):
            y0 = row * 50
            poly = clip_polygon(
                [(0, y0), (300, y0 + 50), (600, y0), (600, y0 + 50), (300, y0 + 100), (0, y0 + 50)]
            )
            if len(poly) >= 3:
                out.append(polygon(poly, fg))
        return "".join(out)

    put("stripes", "chevron-stripes", chevron)

    # ---- checks and grids ---------------------------------------------------------------------------------

    def checker(count: int):
        size = S // count

        def draw(fg, ac, bg):
            return "".join(
                rect(i * size, j * size, size, size, fg)
                for i in range(count)
                for j in range(count)
                if (i + j) % 2
            )

        return draw

    put("checks", "checkerboard", checker(8))
    put("checks", "checkerboard-small", checker(20))

    def gingham(fg, ac, bg):
        bands = "".join(rect(i * 100, 0, 50, S, fg, opacity=0.5) for i in range(6))
        bands += "".join(rect(0, j * 100, S, 50, fg, opacity=0.5) for j in range(6))
        return bands

    put("checks", "gingham", gingham)

    def plaid(fg, ac, bg):
        out = []
        for x, w, color, opacity in (
            (60, 80, fg, 0.45),
            (230, 24, ac, 0.9),
            (330, 80, fg, 0.45),
            (500, 24, ac, 0.9),
        ):
            out.append(rect(x, 0, w, S, color, opacity=opacity))
            out.append(rect(0, x, S, w, color, opacity=opacity))
        out.extend(rect(0, 10 * k + 3, S, 1.5, WHITE, opacity=0.25) for k in range(0, 60, 2))
        return "".join(out)

    put("checks", "plaid", plaid)

    def harlequin(fg, ac, bg):
        out = []
        for i in range(0, 13):
            for j in range(0, 13):
                if (i + j) % 2:
                    continue
                cx, cy = 50 * i, 50 * j
                poly = clip_polygon([(cx, cy - 50), (cx + 50, cy), (cx, cy + 50), (cx - 50, cy)])
                if len(poly) >= 3:
                    out.append(polygon(poly, fg if i % 2 else ac))
        return "".join(out)

    put("checks", "harlequin", harlequin)

    def grid_lines(fg, ac, bg):
        return "".join(
            line(40 * i, 0, 40 * i, S, fg, 2, stroke_linecap="butt") for i in range(1, 15)
        ) + "".join(line(0, 40 * j, S, 40 * j, fg, 2, stroke_linecap="butt") for j in range(1, 15))

    put("checks", "grid-lines", grid_lines)

    def graph_paper(fg, ac, bg):
        minor = "".join(
            line(20 * i, 0, 20 * i, S, fg, 1, stroke_linecap="butt", opacity=0.35)
            + line(0, 20 * i, S, 20 * i, fg, 1, stroke_linecap="butt", opacity=0.35)
            for i in range(1, 30)
            if i % 5
        )
        major = "".join(
            line(100 * i, 0, 100 * i, S, fg, 2.5, stroke_linecap="butt")
            + line(0, 100 * i, S, 100 * i, fg, 2.5, stroke_linecap="butt")
            for i in range(1, 6)
        )
        return minor + major

    put("checks", "graph-paper", graph_paper)

    def isometric(fg, ac, bg):
        step = 40
        reach = S * 1.8
        out = [
            line(step * k * 1.732 / 2, 0, step * k * 1.732 / 2, S, fg, 1.5, stroke_linecap="butt")
            for k in range(1, 18)
        ]
        for k in range(-16, 30):
            x0 = k * step * 1.732
            out.append(line(x0, 0, x0 + reach, reach * 0.577, fg, 1.5, stroke_linecap="butt"))
            out.append(line(x0, S, x0 + reach, S - reach * 0.577, fg, 1.5, stroke_linecap="butt"))
        return clipped("".join(out))

    put("checks", "isometric-grid", isometric)

    def tiles(fg, ac, bg):
        return "".join(
            rect(14 + 72 * i, 14 + 72 * j, 60, 60, fg if (i + j) % 3 else ac, 14)
            for i in range(8)
            for j in range(8)
        )

    put("checks", "rounded-tiles", tiles)

    def mosaic(fg, ac, bg):
        rng = Rng(5)
        palette = [fg, ac, WHITE, ROSE_DARK, ROSE_LIGHT]
        return "".join(
            rect(i * 40, j * 40, 40, 40, rng.choice(palette)) for i in range(15) for j in range(15)
        )

    put("checks", "pixel-mosaic", mosaic)

    def windowpane(fg, ac, bg):
        return "".join(rect(100 * i + 46, 0, 8, S, fg) for i in range(6)) + "".join(
            rect(0, 100 * j + 46, S, 8, fg) for j in range(6)
        )

    put("checks", "windowpane", windowpane)

    # ---- waves and curves ---------------------------------------------------------------------------------

    def sine_points(y: float, amp: float, wavelength: float, phase: float = 0.0):
        return [(x, y + amp * math.sin(2 * math.pi * x / wavelength + phase)) for x in range(0, S + 1, 10)]

    def waves(fg, ac, bg):
        return "".join(
            stroke(smooth(sine_points(30 + 45 * k, 14, 150, k * 0.7)), fg if k % 3 else ac, 5)
            for k in range(13)
        )

    put("waves", "waves-lines", waves)

    def layered(fg, ac, bg):
        out = []
        shades = [ac, fg, ROSE_DARK, INK]
        for k, color in enumerate(shades):
            pts = [*sine_points(150 + 110 * k, 30, 300, k * 1.3), (S, S), (0, S)]
            out.append(path("M" + " L".join(f"{n(x)} {n(y)}" for x, y in pts) + " Z", color))
        return "".join(out)

    put("waves", "waves-layered", layered)

    def scales(fg, ac, bg):
        out = []
        r = 30
        for j in range(15, -1, -1):
            for i in range(-1, 11):
                cx, cy = 60 * i + (30 if j % 2 else 0), 30 * j
                if -r <= cx <= S + r:
                    out.append(circle(cx, cy, r, fg if (i + j) % 2 else ac, stroke=bg, stroke_width=3))
        return clipped("".join(out))

    put("waves", "fish-scales", scales)

    def zigzag(fg, ac, bg):
        out = []
        for k in range(12):
            pts = [(40 * i, 25 + 50 * k + (18 if i % 2 else -18)) for i in range(16)]
            out.append(
                stroke(
                    "M" + " L".join(f"{n(x)} {n(y)}" for x, y in pts),
                    fg if k % 2 else ac,
                    6,
                    stroke_linejoin="miter",
                )
            )
        return "".join(out)

    put("waves", "zigzag-rows", zigzag)

    def chevron_lines(fg, ac, bg):
        out = []
        for k in range(-1, 13):
            pts = [(0, 50 * k), (300, 50 * k + 50), (600, 50 * k)]
            out.append(
                stroke(
                    "M" + " L".join(f"{n(x)} {n(y)}" for x, y in pts),
                    fg,
                    8,
                    stroke_linejoin="miter",
                    stroke_linecap="butt",
                )
            )
        return clipped("".join(out))

    put("waves", "chevron-lines", chevron_lines)

    def arches(fg, ac, bg):
        out = []
        for j in range(3):
            for i in range(3):
                cx, cy = 100 + 200 * i, 200 + 200 * j
                for k, color in enumerate((fg, ac, bg, ac)):
                    r = 90 - 20 * k
                    out.append(path(f"M{cx - r} {cy} A{r} {r} 0 0 1 {cx + r} {cy} Z", color))
        return "".join(out)

    put("waves", "rainbow-arches", arches)

    def scallops(fg, ac, bg):
        out = []
        for j in range(12, -1, -1):
            for i in range(0, 8):
                cx = 75 * i + (37.5 if j % 2 else 0)
                out.append(
                    path(
                        f"M{cx - 37.5} {50 * j + 50} A37.5 37.5 0 0 1 {cx + 37.5} {50 * j + 50} Z",
                        fg if j % 2 else ac,
                        stroke=bg,
                        stroke_width=3,
                    )
                )
        return clipped("".join(out))

    put("waves", "scallop-rows", scallops)

    def spiral(fg, ac, bg):
        pts = []
        for k in range(0, 1400):
            theta = k * 0.06
            r = 4 + 3.1 * theta
            if r < 290:
                pts.append((300 + r * math.cos(theta), 300 + r * math.sin(theta)))
        return stroke("M" + " L".join(f"{n(x)} {n(y)}" for x, y in pts), fg, 8)

    put("waves", "spiral", spiral)

    def rings(fg, ac, bg):
        return "".join(
            circle(300, 300, 292 - 28 * k, "none", stroke=fg if k % 2 else ac, stroke_width=12)
            for k in range(10)
        )

    put("waves", "concentric-rings", rings)

    def ripples(fg, ac, bg):
        out = []
        for cx, cy in ((170, 170), (430, 430)):
            for k in range(1, 6):
                out.append(circle(cx, cy, 34 * k, "none", stroke=fg, stroke_width=6, opacity=1 - k * 0.14))
        return "".join(out)

    put("waves", "ripples", ripples)

    # ---- topographic ----------------------------------------------------------------------------------------

    def topo(centers, harmonics, levels):
        def draw(fg, ac, bg):
            out = []
            for cx, cy, phase in centers:
                for k in range(1, levels + 1):
                    base = 18 + k * (240 / levels)
                    pts = []
                    for step in range(36):
                        theta = 2 * math.pi * step / 36
                        wobble_ = sum(a * math.sin(f * theta + phase + k * 0.18) for f, a in harmonics)
                        r = base * (1 + wobble_)
                        x = min(S - 6, max(6, cx + r * math.cos(theta)))
                        y = min(S - 6, max(6, cy + r * math.sin(theta)))
                        pts.append((x, y))
                    out.append(
                        stroke(smooth(pts, closed=True), ac if k % 5 == 0 else fg, 5 if k % 5 == 0 else 2.5)
                    )
            return "".join(out)

        return draw

    put("topographic", "topo-hills", topo([(300, 300, 0.4)], [(2, 0.12), (3, 0.09), (5, 0.05)], 12))
    put("topographic", "topo-twin-peaks", topo([(190, 230, 1.1), (410, 380, 2.4)], [(2, 0.1), (4, 0.07)], 8))
    put("topographic", "topo-valley", topo([(300, 300, 3.0)], [(3, 0.16), (4, 0.06), (7, 0.03)], 14))

    def flow(fg, ac, bg):
        out = []
        for k in range(20):
            y = 20 + 30 * k
            pts = [
                (x, y + 14 * math.sin(x / 95 + k * 0.32) + 9 * math.sin(x / 41 + k * 0.7))
                for x in range(0, S + 1, 12)
            ]
            out.append(stroke(smooth(pts), ac if k % 6 == 0 else fg, 3))
        return "".join(out)

    put("topographic", "flow-lines", flow)

    # ---- tessellations ----------------------------------------------------------------------------------------

    def triangles(fg, ac, bg):
        out = []
        h = 86.6
        for j in range(-1, 8):
            for i in range(-1, 8):
                x, y = i * 100 + (50 if j % 2 else 0), j * h
                up = [(x, y + h), (x + 50, y), (x + 100, y + h)]
                down = [(x + 50, y), (x + 150, y), (x + 100, y + h)]
                for tri, color in ((up, fg), (down, ac)):
                    poly = clip_polygon(tri)
                    if len(poly) >= 3:
                        out.append(polygon(poly, color, stroke=bg, stroke_width=2))
        return "".join(out)

    put("tessellations", "triangle-tiles", triangles)

    def hexes(fg, ac, bg):
        out = []
        r = 36
        w = math.sqrt(3) * r
        for j in range(-1, 10):
            for i in range(-1, 10):
                cx, cy = w * i + (w / 2 if j % 2 else 0), 1.5 * r * j
                pts = regular_polygon(6, cx, cy, r - 3, 30)
                poly = clip_polygon(pts)
                if len(poly) >= 3:
                    out.append(polygon(poly, fg if (i + j) % 3 else ac))
        return "".join(out)

    put("tessellations", "honeycomb", hexes)

    def honeycomb_outline(fg, ac, bg):
        out = []
        r = 40
        w = math.sqrt(3) * r
        for j in range(-1, 10):
            for i in range(-1, 9):
                cx, cy = w * i + (w / 2 if j % 2 else 0) + 30, 1.5 * r * j + 20
                pts = regular_polygon(6, cx, cy, r, 30)
                if all(4 <= x <= S - 4 and 4 <= y <= S - 4 for x, y in pts):
                    out.append(polygon(pts, "none", stroke=fg, stroke_width=4, stroke_linejoin="round"))
        return "".join(out)

    put("tessellations", "honeycomb-outline", honeycomb_outline)

    def bricks(fg, ac, bg):
        out = []
        for j in range(12):
            for i in range(-1, 6):
                x = i * 110 + (55 if j % 2 else 0)
                x0, x1 = max(x + 4, 0), min(x + 106, S)
                if x1 > x0:
                    out.append(rect(x0, j * 50 + 4, x1 - x0, 42, fg if (i + j) % 4 else ac, 6))
        return "".join(out)

    put("tessellations", "bricks", bricks)

    def herringbone(fg, ac, bg):
        out = []
        for j in range(-1, 14):
            for i in range(-1, 8):
                x, y = i * 100 + (50 if j % 2 else 0), j * 50
                poly = clip_polygon([(x, y), (x + 100, y + 0), (x + 100, y + 44), (x, y + 44)])
                if len(poly) >= 3:
                    out.append(polygon(poly, fg if (i + j) % 2 else ac, stroke=bg, stroke_width=3))
        return "".join(out)

    put("tessellations", "plank-weave", herringbone)

    def basket(fg, ac, bg):
        out = []
        for j in range(6):
            for i in range(6):
                x, y = i * 100, j * 100
                horizontal = (i + j) % 2 == 0
                for k in range(3):
                    if horizontal:
                        out.append(rect(x + 5, y + 5 + k * 31, 90, 26, fg if k % 2 == 0 else ac, 5))
                    else:
                        out.append(rect(x + 5 + k * 31, y + 5, 26, 90, fg if k % 2 == 0 else ac, 5))
        return "".join(out)

    put("tessellations", "basket-weave", basket)

    def crosshatch(fg, ac, bg):
        return "".join(band(c, c + 3, fg) + band(c, c + 3, fg, flip=True) for c in range(-S, 2 * S, 36))

    put("tessellations", "crosshatch", crosshatch)

    def quarter_circles(fg, ac, bg):
        rng = Rng(23)
        out = []
        for j in range(6):
            for i in range(6):
                x, y = 100 * i, 100 * j
                corner = rng.integer(0, 3)
                cx, cy = x + (100 if corner in (1, 2) else 0), y + (100 if corner in (2, 3) else 0)
                sx, sy = (-1 if cx > x else 1), (-1 if cy > y else 1)
                color = fg if rng.random() < 0.6 else ac
                out.append(
                    path(
                        f"M{cx} {cy} L{cx + sx * 100} {cy} A100 100 0 0 {1 if sx * sy > 0 else 0} {cx} {cy + sy * 100} Z",
                        color,
                    )
                )
        return "".join(out)

    put("tessellations", "quarter-circles", quarter_circles)

    def diamonds(fg, ac, bg):
        out = []
        for j in range(6):
            for i in range(6):
                cx, cy = 50 + 100 * i, 50 + 100 * j
                out.append(
                    polygon(
                        [(cx, cy - 38), (cx + 38, cy), (cx, cy + 38), (cx - 38, cy)],
                        fg if (i + j) % 2 else ac,
                    )
                )
        return "".join(out)

    put("tessellations", "diamonds", diamonds)

    def sunburst(fg, ac, bg):
        out = []
        rays = 24
        for k in range(0, rays, 2):
            a0, a1 = 360 * k / rays, 360 * (k + 1) / rays
            pts = [(300, 300), polar(300, 300, 900, a0), polar(300, 300, 900, a1)]
            # Sample the arc between the rays so the clipped wedge keeps its shape.
            poly = clip_polygon(pts)
            if len(poly) >= 3:
                out.append(polygon(poly, fg))
        return "".join(out)

    put("tessellations", "sunburst", sunburst)

    def scatter_symbols(fg, ac, bg, kind: str):
        rng = Rng(31 + len(kind))
        out = []
        cells = 7
        size = S / cells
        for j in range(cells):
            for i in range(cells):
                cx = size * (i + 0.5) + rng.uniform(-8, 8)
                cy = size * (j + 0.5) + rng.uniform(-8, 8)
                color = fg if rng.random() < 0.65 else ac
                if kind == "plus":
                    out.append(
                        stroke(
                            f"M{n(cx - 14)} {n(cy)} H{n(cx + 14)} M{n(cx)} {n(cy - 14)} V{n(cy + 14)}",
                            color,
                            7,
                        )
                    )
                elif kind == "cross":
                    out.append(
                        stroke(
                            f"M{n(cx - 11)} {n(cy - 11)} L{n(cx + 11)} {n(cy + 11)} M{n(cx + 11)} {n(cy - 11)} L{n(cx - 11)} {n(cy + 11)}",
                            color,
                            6,
                        )
                    )
                elif kind == "star":
                    out.append(polygon(star_points(5, cx, cy, 18, 7.5, rng.uniform(-100, -80)), color))
                elif kind == "triangle":
                    out.append(polygon(regular_polygon(3, cx, cy, 20, rng.uniform(-110, -70)), color))
        return "".join(out)

    put("scatter", "plus-signs", lambda fg, ac, bg: scatter_symbols(fg, ac, bg, "plus"))
    put("scatter", "tiny-crosses", lambda fg, ac, bg: scatter_symbols(fg, ac, bg, "cross"))
    put("scatter", "star-field", lambda fg, ac, bg: scatter_symbols(fg, ac, bg, "star"))
    put("scatter", "scattered-triangles", lambda fg, ac, bg: scatter_symbols(fg, ac, bg, "triangle"))

    def circles_overlap(fg, ac, bg):
        out = []
        r = 50
        for j in range(0, 7):
            for i in range(0, 7):
                cx, cy = 100 * i, 100 * j
                out.append(circle(cx, cy, r, "none", stroke=fg if (i + j) % 2 else ac, stroke_width=5))
        return clipped("".join(out))

    put("scatter", "overlapping-rings", circles_overlap)

    # ---- confetti, terrazzo and memphis ------------------------------------------------------------------

    def confetti(fg, ac, bg):
        rng = Rng(41)
        out = []
        palette = [fg, ac, WHITE, SUN, ROSE_SOFT]
        for _ in range(70):
            x, y = rng.uniform(30, S - 30), rng.uniform(30, S - 30)
            color = rng.choice(palette)
            kind = rng.integer(0, 2)
            angle = rng.uniform(0, 360)
            if kind == 0:
                pts = [
                    rotate_point(x + dx, y + dy, x, y, angle)
                    for dx, dy in ((-9, -5), (9, -5), (9, 5), (-9, 5))
                ]
                out.append(polygon(pts, color))
            elif kind == 1:
                out.append(polygon(regular_polygon(3, x, y, 11, angle), color))
            else:
                out.append(circle(x, y, 6, color))
        return "".join(out)

    put("confetti", "confetti-pieces", confetti)

    def sprinkles(fg, ac, bg):
        rng = Rng(43)
        out = []
        for _ in range(110):
            x, y, angle = rng.uniform(25, S - 25), rng.uniform(25, S - 25), math.radians(rng.uniform(0, 180))
            dx, dy = 11 * math.cos(angle), 11 * math.sin(angle)
            out.append(line(x - dx, y - dy, x + dx, y + dy, rng.choice([fg, ac, WHITE, SUN]), 6))
        return "".join(out)

    put("confetti", "sprinkles", sprinkles)

    def terrazzo(fg, ac, bg):
        rng = Rng(47)
        out = []
        palette = [fg, ac, ROSE_DARK, WHITE, SUN]
        for _ in range(60):
            x, y = rng.uniform(30, S - 30), rng.uniform(30, S - 30)
            sides = rng.integer(4, 7)
            radius = rng.uniform(10, 26)
            pts = regular_polygon(sides, x, y, radius, rng.uniform(0, 360))
            pts = [(px + rng.uniform(-5, 5), py + rng.uniform(-5, 5)) for px, py in pts]
            out.append(polygon(pts, rng.choice(palette)))
        return "".join(out)

    put("confetti", "terrazzo", terrazzo)

    def squiggle(cx, cy, color, width=6):
        pts = [(cx - 30 + 15 * i, cy + (-9 if i % 2 else 9)) for i in range(5)]
        return stroke(smooth(pts), color, width)

    def memphis(fg, ac, bg):
        out = []
        rng = Rng(53)
        slots = [(75 + 150 * i, 75 + 150 * j) for i in range(4) for j in range(4)]
        for index, (cx, cy) in enumerate(slots):
            kind = index % 5
            if kind == 0:
                out.append(squiggle(cx, cy, fg))
            elif kind == 1:
                out.append(
                    polygon(
                        regular_polygon(3, cx, cy, 26, rng.uniform(-100, -80)),
                        "none",
                        stroke=ac,
                        stroke_width=6,
                        stroke_linejoin="round",
                    )
                )
            elif kind == 2:
                out.append(circle(cx, cy, 18, fg))
            elif kind == 3:
                out.append(stroke(f"M{cx - 16} {cy} H{cx + 16} M{cx} {cy - 16} V{cy + 16}", ac, 7))
            else:
                out.append(circle(cx, cy, 20, "none", stroke=fg, stroke_width=6))
        return "".join(out)

    put("memphis", "memphis-shapes", memphis)

    def memphis_squiggles(fg, ac, bg):
        return "".join(
            squiggle(75 + 150 * i + (40 if j % 2 else 0), 60 + 120 * j, fg if (i + j) % 2 else ac, 7)
            for i in range(4)
            for j in range(5)
        )

    put("memphis", "memphis-squiggles", memphis_squiggles)

    def memphis_dots_lines(fg, ac, bg):
        out = []
        for j in range(5):
            for i in range(5):
                x, y = 60 + 120 * i, 60 + 120 * j
                if (i + j) % 2:
                    out.extend(
                        circle(x + 14 * dx, y + 14 * dy, 3.5, fg) for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                    )
                else:
                    out.extend(
                        line(x - 24, y + 10 * k - 10, x + 24, y + 10 * k - 10, ac, 4) for k in range(3)
                    )
        return "".join(out)

    put("memphis", "memphis-dots-lines", memphis_dots_lines)

    def bauhaus(fg, ac, bg):
        return (
            circle(180, 180, 120, fg)
            + rect(300, 300, 240, 240, ac)
            + polygon([(60, 540), (240, 540), (150, 380)], WHITE)
            + stroke("M330 80 H540 M330 120 H540 M330 160 H540", fg, 10, stroke_linecap="butt")
            + circle(470, 220, 36, WHITE)
            + path("M60 330 A90 90 0 0 1 240 330 Z", ROSE_DARK)
        )

    put("memphis", "bauhaus-composition", bauhaus)

    # ---- blobs ------------------------------------------------------------------------------------------------------

    def blob_field(seed: int, count: int, low: float, high: float):
        def draw(fg, ac, bg):
            rng = Rng(seed)
            out = []
            for index in range(count):
                radius = rng.uniform(low, high)
                cx = rng.uniform(radius, S - radius)
                cy = rng.uniform(radius, S - radius)
                outline = blob_path(rng.integer(1, 40), cx, cy, radius, 8)
                out.append(path(outline, fg if index % 3 else ac, opacity=0.85))
            return "".join(out)

        return draw

    put("blobs", "blob-scatter", blob_field(3, 9, 40, 90))
    put("blobs", "blob-cluster", blob_field(9, 5, 80, 150))
    put("blobs", "blob-pebbles", blob_field(17, 24, 22, 44))

    def blob_corners(fg, ac, bg):
        return (
            path(blob_path(5, 110, 110, 190, 9), fg)
            + path(blob_path(12, 490, 500, 200, 9), ac)
            + path(blob_path(21, 520, 90, 70, 7), fg, opacity=0.6)
            + path(blob_path(30, 90, 520, 60, 7), ac, opacity=0.6)
        )

    put("blobs", "blob-corners", blob_corners)

    def organic_layers(fg, ac, bg):
        out = []
        for k, color in enumerate((ac, fg, ROSE_DARK)):
            pts = [
                (x, 330 + 90 * k + 50 * math.sin(x / 110 + k * 1.7) + 24 * math.sin(x / 47 + k))
                for x in range(0, S + 1, 25)
            ]
            out.append(path(smooth(pts) + f" L{S} {S} L0 {S} Z", color))
        return "".join(out)

    put("blobs", "organic-layers", organic_layers)

    # ---- gradient meshes (soft radial / linear blends, no noise) --------------------------------------------

    def mesh(
        name: str, base: list[tuple[float, str, float]], orbs: list[tuple[float, float, float, str, float]]
    ):
        defs_ = [linear_gradient("base", base, 0, 0, 1, 1)]
        shapes_ = [rect(0, 0, S, S, "url(#base)")]
        for index, (cx, cy, r, color, opacity) in enumerate(orbs):
            defs_.append(radial_gradient(f"orb{index}", cx, cy, r, [(0, color, opacity), (1, color, 0)]))
            shapes_.append(circle(cx, cy, r, f"url(#orb{index})"))
        add("gradients", name, defs(*defs_) + "".join(shapes_), S, S)

    mesh(
        "mesh-sunset",
        [(0, SUN, 1), (0.55, RED, 1), (1, ROSE_DARK, 1)],
        [(150, 470, 300, "#fb7185", 0.9), (480, 140, 260, WHITE, 0.55), (420, 520, 220, SUN, 0.7)],
    )
    mesh(
        "mesh-blush",
        [(0, "#fff1f2", 1), (1, ROSE_LIGHT, 1)],
        [(120, 120, 280, "#fb7185", 0.7), (500, 500, 300, RED, 0.55), (480, 120, 180, WHITE, 0.9)],
    )
    mesh(
        "mesh-aurora",
        [(0, INK, 1), (1, ROSE_DARK, 1)],
        [(150, 200, 280, RED, 0.85), (460, 330, 260, "#fb7185", 0.6), (260, 540, 240, SUN, 0.45)],
    )
    mesh(
        "mesh-glow-corner",
        [(0, WHITE, 1), (1, ROSE_LIGHT, 1)],
        [(0, 0, 520, RED, 0.8), (600, 600, 360, ROSE_SOFT, 0.7)],
    )
    mesh(
        "mesh-orbs",
        [(0, ROSE_DARK, 1), (1, INK, 1)],
        [(210, 220, 200, RED, 0.95), (400, 330, 220, "#fb7185", 0.8), (230, 450, 170, SUN, 0.65)],
    )
    mesh(
        "mesh-duotone",
        [(0, RED, 1), (1, ROSE_DARK, 1)],
        [(450, 150, 330, ROSE_SOFT, 0.75), (120, 520, 280, WHITE, 0.35)],
    )

    add(
        "gradients",
        "gradient-linear-soft",
        defs(linear_gradient("g", [(0, ROSE_LIGHT, 1), (0.5, ROSE_SOFT, 1), (1, RED, 1)], 0, 0, 1, 1))
        + rect(0, 0, S, S, "url(#g)"),
        S,
        S,
    )
    add(
        "gradients",
        "gradient-spotlight",
        defs(radial_gradient("g", 300, 300, 420, [(0, WHITE, 1), (0.55, ROSE_SOFT, 1), (1, RED, 1)]))
        + rect(0, 0, S, S, "url(#g)"),
        S,
        S,
    )
    add(
        "gradients",
        "gradient-dusk",
        defs(linear_gradient("g", [(0, INK, 1), (0.6, ROSE_DARK, 1), (1, RED, 1)]))
        + rect(0, 0, S, S, "url(#g)"),
        S,
        S,
    )

    # ---- scenes -----------------------------------------------------------------------------------------------------

    def night_sky(fg, ac, bg):
        rng = Rng(61)
        out = [rect(0, 0, S, S, INK)]
        for _ in range(60):
            out.append(circle(rng.uniform(10, S - 10), rng.uniform(10, S - 10), rng.uniform(1, 3.2), WHITE))
        for _ in range(7):
            out.append(
                polygon(star_points(4, rng.uniform(40, S - 40), rng.uniform(40, S - 40), 13, 3.5, -90), SUN)
            )
        out.append(circle(470, 140, 46, ROSE_LIGHT))
        return "".join(out)

    add("scenes", "night-sky", night_sky(RED, ROSE_SOFT, INK), S, S)

    def rain(fg, ac, bg):
        rng = Rng(67)
        return "".join(
            line(x, y, x - 10, y + 30, fg if rng.random() < 0.7 else ac, 4, opacity=rng.uniform(0.5, 1))
            for x, y in ((rng.uniform(20, S - 20), rng.uniform(10, S - 40)) for _ in range(80))
        )

    put("scenes", "rain", rain, way=4)

    def bubbles(fg, ac, bg):
        rng = Rng(71)
        out = []
        for _ in range(34):
            r = rng.uniform(10, 50)
            x, y = rng.uniform(r + 4, S - r - 4), rng.uniform(r + 4, S - r - 4)
            out.append(
                circle(x, y, r, "none", stroke=fg if rng.random() < 0.7 else ac, stroke_width=3 + r / 20)
            )
        return "".join(out)

    put("scenes", "bubbles", bubbles)
