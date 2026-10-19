"""Charts: bar, line, area, pie, donut, gauge and other starter graphics (400 x 300 unless noted).

They are drawn with the Doory palette and plain shapes; recolour the series colours to match a design.
"""

# ruff: noqa: E501  (SVG path data and coordinates are written inline, one graphic per statement)

from __future__ import annotations

import math

from .kit import (
    INK,
    MIST,
    RED,
    ROSE_DARK,
    ROSE_LIGHT,
    ROSE_SOFT,
    SLATE,
    WHITE,
    Collector,
    Rng,
    circle,
    line,
    n,
    path,
    polar,
    polygon,
    rect,
    smooth,
    stroke,
)

W, H = 400, 300
SERIES = [RED, ROSE_DARK, ROSE_SOFT, SLATE, ROSE_LIGHT]


def axes(left: float = 40, bottom: float = 260, right: float = 380, top: float = 30, grid: int = 4) -> str:
    out = "".join(
        line(
            left,
            bottom - (bottom - top) * i / grid,
            right,
            bottom - (bottom - top) * i / grid,
            MIST,
            2,
            stroke_linecap="butt",
        )
        for i in range(1, grid + 1)
    )
    return out + line(left, top, left, bottom, SLATE, 3) + line(left, bottom, right, bottom, SLATE, 3)


def wedge(cx: float, cy: float, r: float, a0: float, a1: float, color: str, inner: float = 0.0) -> str:
    """A pie slice (or a donut segment when `inner` > 0) between two angles in degrees, clockwise from 12 o'clock."""
    p0, p1 = polar(cx, cy, r, a0 - 90), polar(cx, cy, r, a1 - 90)
    large = 1 if a1 - a0 > 180 else 0
    if inner <= 0:
        d = f"M{n(cx)} {n(cy)} L{n(p0[0])} {n(p0[1])} A{n(r)} {n(r)} 0 {large} 1 {n(p1[0])} {n(p1[1])} Z"
    else:
        q0, q1 = polar(cx, cy, inner, a0 - 90), polar(cx, cy, inner, a1 - 90)
        d = (
            f"M{n(p0[0])} {n(p0[1])} A{n(r)} {n(r)} 0 {large} 1 {n(p1[0])} {n(p1[1])} "
            f"L{n(q1[0])} {n(q1[1])} A{n(inner)} {n(inner)} 0 {large} 0 {n(q0[0])} {n(q0[1])} Z"
        )
    return path(d, color, stroke=WHITE, stroke_width=3, stroke_linejoin="round")


def arc(cx: float, cy: float, r: float, a0: float, a1: float, color: str, width: float) -> str:
    p0, p1 = polar(cx, cy, r, a0 - 90), polar(cx, cy, r, a1 - 90)
    large = 1 if a1 - a0 > 180 else 0
    return stroke(f"M{n(p0[0])} {n(p0[1])} A{n(r)} {n(r)} 0 {large} 1 {n(p1[0])} {n(p1[1])}", color, width)


def bars(
    values: list[float],
    x0: float = 60,
    base: float = 260,
    gap: float = 20,
    width: float = 40,
    scale: float = 200,
    radius: float = 0,
    highlight: int | None = None,
) -> str:
    out = []
    for i, value in enumerate(values):
        color = RED if highlight is None or i == highlight else ROSE_SOFT
        out.append(rect(x0 + i * (width + gap), base - value * scale, width, value * scale, color, radius))
    return "".join(out)


def build(add: Collector) -> None:
    data = [0.45, 0.7, 0.55, 0.9, 0.62]
    add("bars", "bar-vertical", axes() + bars(data), W, H)
    add("bars", "bar-rounded", axes() + bars(data, radius=10), W, H)
    add("bars", "bar-highlight", axes() + bars(data, radius=6, highlight=3), W, H)
    grouped = "".join(
        rect(58 + i * 68, 260 - v * 200, 26, v * 200, RED, 4)
        + rect(86 + i * 68, 260 - w * 200, 26, w * 200, ROSE_SOFT, 4)
        for i, (v, w) in enumerate(((0.5, 0.35), (0.7, 0.55), (0.45, 0.6), (0.85, 0.5), (0.6, 0.75)))
    )
    add("bars", "bar-grouped", axes() + grouped, W, H)
    stacked = "".join(
        rect(60 + i * 60, 260 - (a + b) * 200, 40, a * 200, RED)
        + rect(60 + i * 60, 260 - b * 200, 40, b * 200, ROSE_SOFT)
        for i, (a, b) in enumerate(((0.3, 0.2), (0.4, 0.3), (0.35, 0.25), (0.5, 0.35), (0.3, 0.4)))
    )
    add("bars", "bar-stacked", axes() + stacked, W, H)
    horizontal = "".join(
        rect(60, 40 + i * 44, v * 300, 28, RED if i == 0 else ROSE_SOFT, 6)
        for i, v in enumerate((0.95, 0.78, 0.6, 0.45, 0.3))
    ) + line(60, 30, 60, 262, SLATE, 3)
    add("bars", "bar-horizontal", horizontal, W, H)
    tracks = "".join(
        rect(40, 50 + i * 70, 320, 24, MIST, 12)
        + rect(40, 50 + i * 70, v * 320, 24, RED if i == 0 else ROSE_DARK if i == 1 else ROSE_SOFT, 12)
        for i, v in enumerate((0.8, 0.55, 0.35))
    )
    add("bars", "progress-bars", tracks, W, H)
    add(
        "bars",
        "histogram",
        axes()
        + "".join(
            rect(50 + i * 32, 260 - v * 200, 32, v * 200, RED if i % 2 else ROSE_DARK, 0)
            for i, v in enumerate((0.1, 0.25, 0.5, 0.8, 0.95, 0.7, 0.45, 0.25, 0.1, 0.05))
        ),
        W,
        H,
    )
    lollipop = "".join(
        line(80 + i * 62, 260, 80 + i * 62, 260 - v * 200, ROSE_SOFT, 6)
        + circle(80 + i * 62, 260 - v * 200, 14, RED)
        for i, v in enumerate(data)
    )
    add("bars", "lollipop", axes() + lollipop, W, H)
    add("bars", "bar-ranked", axes() + bars(sorted(data, reverse=True), highlight=0, radius=6), W, H)

    pts = [(60 + 70 * i, 260 - v * 200) for i, v in enumerate((0.2, 0.45, 0.35, 0.7, 0.6, 0.9))]
    poly = "M" + " L".join(f"{n(x)} {n(y)}" for x, y in pts)
    add(
        "lines",
        "line-simple",
        axes()
        + stroke(poly, RED, 6)
        + "".join(circle(x, y, 8, WHITE, stroke=RED, stroke_width=4) for x, y in pts),
        W,
        H,
    )
    add("lines", "line-smooth", axes() + stroke(smooth(pts), RED, 6), W, H)
    area = smooth(pts) + f" L{n(pts[-1][0])} 260 L{n(pts[0][0])} 260 Z"
    add(
        "lines",
        "area-simple",
        axes() + path(area, ROSE_SOFT, opacity=0.7) + stroke(smooth(pts), RED, 6),
        W,
        H,
    )
    second = [(60 + 70 * i, 260 - v * 200) for i, v in enumerate((0.1, 0.3, 0.5, 0.4, 0.55, 0.5))]
    add(
        "lines",
        "line-multi",
        axes() + stroke(smooth(pts), RED, 6) + stroke(smooth(second), ROSE_DARK, 6, stroke_dasharray="2 12"),
        W,
        H,
    )
    step = "M60 220 H130 V160 H200 V190 H270 V100 H340 V70 H380"
    add("lines", "line-step", axes() + stroke(step, RED, 6, stroke_linejoin="miter"), W, H)
    back = [(60 + 70 * i, 260 - v * 200) for i, v in enumerate((0.5, 0.65, 0.6, 0.85, 0.8, 0.95))]
    add(
        "lines",
        "area-stacked",
        axes()
        + path(smooth(back) + " L380 260 L60 260 Z", ROSE_SOFT)
        + path(smooth(pts) + f" L{n(pts[-1][0])} 260 L60 260 Z", RED, opacity=0.9),
        W,
        H,
    )
    spark = [(20 + 40 * i, 60 + 50 * math.sin(i * 0.9) * (1 - i / 14)) for i in range(10)]
    add(
        "lines",
        "sparkline",
        stroke(smooth(spark), RED, 7) + circle(spark[-1][0], spark[-1][1], 10, RED),
        400,
        140,
    )
    rng = Rng(5)
    scatter = "".join(
        circle(
            70 + 300 * (i / 18) + rng.uniform(-14, 14),
            230 - 170 * (i / 18) * rng.uniform(0.6, 1.1) - rng.uniform(0, 40),
            rng.uniform(5, 9),
            RED if i % 4 else ROSE_DARK,
        )
        for i in range(19)
    )
    add("lines", "scatter-plot", axes() + scatter, W, H)
    add(
        "lines",
        "bubble-chart",
        axes()
        + circle(110, 190, 34, RED, opacity=0.85)
        + circle(210, 130, 52, ROSE_SOFT, opacity=0.9)
        + circle(300, 180, 26, ROSE_DARK)
        + circle(335, 90, 38, RED, opacity=0.6),
        W,
        H,
    )
    candles = "".join(
        line(75 + i * 56, y0, 75 + i * 56, y1, SLATE, 3)
        + rect(63 + i * 56, top, 24, bottom - top, RED if up else ROSE_SOFT, 3)
        for i, (y0, y1, top, bottom, up) in enumerate(
            (
                (60, 200, 90, 160, True),
                (100, 230, 130, 200, False),
                (50, 180, 70, 140, True),
                (80, 220, 110, 190, False),
                (40, 160, 60, 120, True),
                (70, 170, 90, 150, True),
            )
        )
    )
    add("lines", "candlestick", axes() + candles, W, H)
    combo = "".join(
        rect(58 + i * 62, 260 - v * 170, 38, v * 170, ROSE_SOFT, 5) for i, v in enumerate(data)
    ) + stroke(
        smooth(
            [(77 + 62 * i, 250 - (v + 0.1) * 200 * 0.9) for i, v in enumerate((0.3, 0.5, 0.45, 0.8, 0.7))]
        ),
        RED,
        6,
    )
    add("lines", "bar-line-combo", axes() + combo, W, H)

    def pie(
        parts: list[float],
        cx: float = 200,
        cy: float = 150,
        r: float = 120,
        inner: float = 0.0,
        colors: list[str] | None = None,
    ) -> str:
        palette, out, angle = colors or SERIES, [], 0.0
        total = sum(parts)
        for i, part in enumerate(parts):
            sweep = 360 * part / total
            out.append(wedge(cx, cy, r, angle, angle + sweep, palette[i % len(palette)], inner))
            angle += sweep
        return "".join(out)

    add("circular", "pie-two", pie([70, 30]), W, H)
    add("circular", "pie-three", pie([50, 30, 20]), W, H)
    add("circular", "pie-four", pie([40, 25, 20, 15]), W, H)
    add("circular", "pie-five", pie([30, 25, 20, 15, 10]), W, H)
    add("circular", "donut-three", pie([50, 30, 20], inner=70), W, H)
    add("circular", "donut-five", pie([30, 25, 20, 15, 10], inner=84), W, H)
    for pct in (25, 50, 75, 90):
        add(
            "circular",
            f"donut-progress-{pct}",
            circle(200, 150, 100, "none", stroke=MIST, stroke_width=36)
            + arc(200, 150, 100, 0, 359.9 * pct / 100, RED, 36),
            W,
            H,
        )
    radial = "".join(
        circle(200, 150, 112 - 28 * i, "none", stroke=MIST, stroke_width=18)
        + arc(200, 150, 112 - 28 * i, 0, 359.9 * v, SERIES[i % 3], 18)
        for i, v in enumerate((0.85, 0.65, 0.45, 0.25))
    )
    add("circular", "radial-bars", radial, W, H)
    add(
        "circular",
        "gauge-semicircle",
        stroke("M70 240 A130 130 0 0 1 330 240", MIST, 34)
        + stroke("M70 240 A130 130 0 0 1 266 129", RED, 34)
        + stroke("M200 240 L266 160", INK, 8)
        + circle(200, 240, 16, INK),
        W,
        280,
    )
    add(
        "circular",
        "gauge-segments",
        stroke("M70 240 A130 130 0 0 1 135 127", ROSE_SOFT, 34, stroke_linecap="butt")
        + stroke("M142 123 A130 130 0 0 1 258 123", ROSE_DARK, 34, stroke_linecap="butt")
        + stroke("M265 127 A130 130 0 0 1 330 240", RED, 34, stroke_linecap="butt")
        + stroke("M200 240 L236 170", INK, 8)
        + circle(200, 240, 16, INK),
        W,
        280,
    )

    def spider(values: list[float], cx: float = 200, cy: float = 150, r: float = 110) -> str:
        count = len(values)
        rings = "".join(
            polygon(
                [polar(cx, cy, r * k / 4, 360 * i / count - 90) for i in range(count)],
                "none",
                stroke=MIST,
                stroke_width=2,
            )
            for k in range(1, 5)
        )
        spokes = "".join(line(cx, cy, *polar(cx, cy, r, 360 * i / count - 90), MIST, 2) for i in range(count))
        points = [polar(cx, cy, r * v, 360 * i / count - 90) for i, v in enumerate(values)]
        shape = polygon(points, RED, opacity=0.35) + polygon(
            points, "none", stroke=RED, stroke_width=4, stroke_linejoin="round"
        )
        return rings + spokes + shape

    add("circular", "radar-chart", spider([0.9, 0.6, 0.8, 0.5, 0.7]), W, H)
    add("circular", "radar-hexagon", spider([0.8, 0.9, 0.5, 0.7, 0.6, 0.85]), W, H)

    funnel = "".join(
        polygon(
            [
                (40 + 26 * i, 40 + 48 * i),
                (360 - 26 * i, 40 + 48 * i),
                (360 - 26 * (i + 1), 82 + 48 * i),
                (40 + 26 * (i + 1), 82 + 48 * i),
            ],
            SERIES[i % 3] if i < 3 else ROSE_LIGHT,
        )
        for i in range(5)
    )
    add("other", "funnel", funnel, W, H)
    add(
        "other",
        "pyramid",
        "".join(
            polygon(
                [
                    (200 - 22 * (i + 1) - 6, 40 + 50 * i + 50),
                    (200 + 22 * (i + 1) + 6, 40 + 50 * i + 50),
                    (200 + 22 * i + 6, 40 + 50 * i),
                    (200 - 22 * i - 6, 40 + 50 * i),
                ],
                [RED, ROSE_DARK, ROSE_SOFT, SLATE, ROSE_LIGHT][i],
            )
            for i in range(5)
        ),
        W,
        H,
    )
    waffle = "".join(
        rect(100 + 20 * (i % 10), 40 + 20 * (i // 10), 16, 16, RED if i < 37 else MIST, 3) for i in range(100)
    )
    add("other", "waffle-chart", waffle, W, 260)
    add(
        "other",
        "heatmap",
        "".join(
            rect(
                40 + 48 * i,
                30 + 36 * j,
                44,
                32,
                RED,
                4,
                opacity=round(0.12 + 0.88 * ((i * 7 + j * 3) % 10) / 9, 2),
            )
            for i in range(7)
            for j in range(6)
        ),
        W,
        H,
    )
    add(
        "other",
        "treemap",
        rect(20, 20, 200, 150, RED, 8)
        + rect(226, 20, 154, 90, ROSE_DARK, 8)
        + rect(226, 116, 154, 54, ROSE_SOFT, 8)
        + rect(20, 176, 120, 104, ROSE_SOFT, 8)
        + rect(146, 176, 234, 104, SLATE, 8),
        W,
        H,
    )
    add(
        "other",
        "timeline",
        line(40, 150, 360, 150, SLATE, 6)
        + "".join(
            circle(70 + 85 * i, 150, 16, RED if i % 2 == 0 else WHITE, stroke=RED, stroke_width=6)
            + line(70 + 85 * i, 150 - (60 if i % 2 == 0 else -60), 70 + 85 * i, 150, ROSE_SOFT, 4)
            + rect(40 + 85 * i, 90 - 12 if i % 2 == 0 else 220, 60, 22, ROSE_SOFT, 6)
            for i in range(4)
        ),
        W,
        H,
    )
    add(
        "other",
        "bullet-chart",
        rect(30, 100, 340, 40, ROSE_LIGHT, 4)
        + rect(30, 100, 240, 40, ROSE_SOFT, 4)
        + rect(30, 100, 160, 40, ROSE_SOFT, 4)
        + rect(30, 114, 210, 12, RED, 3)
        + rect(300, 92, 6, 56, INK, 2),
        W,
        240,
    )
    kpi = (
        rect(10, 10, 380, 230, WHITE, 24, stroke=MIST, stroke_width=4)
        + rect(40, 44, 110, 16, ROSE_SOFT, 8)
        + rect(40, 84, 170, 40, RED, 10)
        + polygon([(300, 70), (332, 110), (268, 110)], RED)
        + stroke(smooth([(40 + 38 * i, 200 - 18 * math.sin(i * 0.8) - 6 * i) for i in range(9)]), RED, 6)
    )
    add("other", "kpi-card", kpi, 400, 250)
    add(
        "other",
        "stat-blocks",
        "".join(
            rect(20 + 120 * i, 40, 100, 160, SERIES[i], 14)
            + rect(36 + 120 * i, 60, 50, 12, WHITE, 6, opacity=0.8)
            + rect(36 + 120 * i, 150 - 30 * i, 68, 40 + 30 * i, WHITE, 8, opacity=0.35)
            for i in range(3)
        ),
        W,
        240,
    )
    add(
        "other",
        "rating-bars",
        "".join(
            rect(40, 40 + 44 * i, 320, 22, MIST, 11) + rect(40, 40 + 44 * i, 320 * v, 22, RED, 11)
            for i, v in enumerate((0.9, 0.7, 0.45, 0.25, 0.1))
        ),
        W,
        H,
    )
