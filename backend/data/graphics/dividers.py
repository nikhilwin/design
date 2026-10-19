"""Dividers & Borders: rules and ornaments for separating sections, and strips and frames for edges."""

# ruff: noqa: E501  (SVG path data and coordinates are written inline, one graphic per statement)

from __future__ import annotations

import math

from .kit import (
    RED,
    ROSE_DARK,
    ROSE_SOFT,
    WHITE,
    Collector,
    Outline,
    circle,
    defs,
    heart_path,
    line,
    linear_gradient,
    path,
    polygon,
    rect,
    shifted,
    smooth,
    star_points,
    stroke,
)

W = 600  # divider width
H = 60  # divider height
MID = H / 2


def side_lines(gap: float, color: str = RED, width: float = 4) -> str:
    """Two rules running to the left and right of a centre ornament that is `gap` wide."""
    return line(16, MID, W / 2 - gap / 2, MID, color, width) + line(
        W / 2 + gap / 2, MID, W - 16, MID, color, width
    )


def heart_at(cx: float, cy: float, size: float, color: str) -> str:
    scale = size / 88
    return path(shifted(heart_path().scaled(scale, 50, 49), cx - 50, cy - 49), color)


def curl(x: float, y: float, direction: int, color: str) -> str:
    """A small spiral ending at `(x, y)`, winding outwards away from the centre."""
    pts = [
        (x + direction * r * math.cos(t), y + r * math.sin(t))
        for t, r in ((i * 0.6, 2 + i * 1.5) for i in range(14))
    ]
    return stroke(smooth(pts), color, 3.5)


def build(add: Collector) -> None:
    # ---- dividers ---------------------------------------------------------------------------------------------

    add(
        "dividers",
        "divider-fade",
        defs(linear_gradient("f", [(0, RED, 0), (0.5, RED, 1), (1, RED, 0)], 0, 0, 1, 0))
        + rect(0, MID - 2, W, 4, "url(#f)"),
        W,
        H,
    )
    add(
        "dividers",
        "divider-double",
        line(16, MID - 7, W - 16, MID - 7, RED, 3) + line(16, MID + 7, W - 16, MID + 7, RED, 3),
        W,
        H,
    )
    add(
        "dividers",
        "divider-triple",
        line(16, MID - 12, W - 16, MID - 12, ROSE_SOFT, 2)
        + line(16, MID, W - 16, MID, RED, 6)
        + line(16, MID + 12, W - 16, MID + 12, ROSE_SOFT, 2),
        W,
        H,
    )
    add(
        "dividers",
        "divider-dots-fade",
        "".join(circle(W / 2 + 40 * k, MID, max(2.5, 11 - 1.4 * abs(k)), RED) for k in range(-7, 8)),
        W,
        H,
    )
    add("dividers", "divider-dashes", line(20, MID, W - 20, MID, RED, 5, stroke_dasharray="24 14"), W, H)
    add(
        "dividers",
        "divider-dot-dash",
        line(20, MID, W - 20, MID, RED, 5, stroke_dasharray="26 10 2 10"),
        W,
        H,
    )
    add(
        "dividers",
        "divider-wavy",
        stroke(smooth([(16 + 14 * i, MID + (9 if i % 2 else -9)) for i in range(42)]), RED, 4),
        W,
        H,
    )
    add(
        "dividers",
        "divider-zigzag",
        stroke(
            "M16 40 " + " ".join(f"L{16 + 18 * (i + 1)} {40 if i % 2 else 20}" for i in range(32)),
            RED,
            4,
            stroke_linejoin="miter",
        ),
        W,
        H,
    )
    add(
        "dividers",
        "divider-scallop",
        stroke("M16 38 " + " ".join(f"A14 14 0 0 1 {16 + 28 * (i + 1)} 38" for i in range(20)), RED, 4),
        W,
        H,
    )

    diamond = polygon([(300, MID - 14), (314, MID), (300, MID + 14), (286, MID)], RED)
    add("dividers", "divider-diamond", side_lines(60) + diamond, W, H)
    add("dividers", "divider-star", side_lines(70) + polygon(star_points(5, 300, MID, 17, 7, -90), RED), W, H)
    add("dividers", "divider-heart", side_lines(70) + heart_at(300, MID, 30, RED), W, H)
    add(
        "dividers",
        "divider-three-dots",
        side_lines(90) + "".join(circle(300 + 22 * k, MID, 6, RED) for k in (-1, 0, 1)),
        W,
        H,
    )
    leaves = path("M270 30 Q282 12 296 30 Q282 48 270 30 Z", RED) + path(
        "M330 30 Q318 12 304 30 Q318 48 330 30 Z", RED
    )
    add("dividers", "divider-leaves", side_lines(80, RED, 3) + leaves + circle(300, MID, 4, ROSE_DARK), W, H)
    add(
        "dividers",
        "divider-curls",
        line(70, MID, 270, MID, RED, 3.5)
        + line(330, MID, 530, MID, RED, 3.5)
        + curl(70, MID, -1, RED)
        + curl(530, MID, 1, RED)
        + circle(300, MID, 6, RED)
        + circle(280, MID, 3, ROSE_SOFT)
        + circle(320, MID, 3, ROSE_SOFT),
        W,
        H,
    )

    fleuron = (
        Outline()
        .M(300, 12)
        .C(318, 24, 338, 22, 352, 30)
        .C(338, 38, 318, 36, 300, 48)
        .C(282, 36, 262, 38, 248, 30)
        .C(262, 22, 282, 24, 300, 12)
        .Z()
    )
    add(
        "dividers",
        "divider-fleuron",
        side_lines(120, RED, 3) + path(fleuron, RED) + circle(300, MID, 5, WHITE),
        W,
        H,
    )
    add(
        "dividers",
        "divider-tapered",
        polygon([(16, MID), (300, MID - 5), (W - 16, MID), (300, MID + 5)], RED),
        W,
        H,
    )
    add(
        "dividers",
        "divider-arrows",
        line(40, MID, W - 40, MID, RED, 4)
        + stroke(f"M62 {MID - 14} L40 {MID} L62 {MID + 14}", RED, 4)
        + stroke(f"M{W - 62} {MID - 14} L{W - 40} {MID} L{W - 62} {MID + 14}", RED, 4),
        W,
        H,
    )
    add(
        "dividers",
        "divider-brackets",
        line(60, MID, W - 60, MID, RED, 3)
        + stroke(f"M44 {MID - 16} L24 {MID} L44 {MID + 16}", RED, 4)
        + stroke(f"M{W - 44} {MID - 16} L{W - 24} {MID} L{W - 44} {MID + 16}", RED, 4),
        W,
        H,
    )
    add(
        "dividers",
        "divider-circles",
        "".join(
            circle(60 + 60 * i, MID, 12, RED)
            if i % 2 == 0
            else circle(60 + 60 * i, MID, 10, "none", stroke=RED, stroke_width=4)
            for i in range(9)
        ),
        W,
        H,
    )
    add(
        "dividers",
        "divider-stars",
        "".join(
            polygon(star_points(5, 100 + 100 * i, MID, 17 if i == 2 else 12, 7 if i == 2 else 5, -90), RED)
            for i in range(5)
        ),
        W,
        H,
    )
    add(
        "dividers",
        "divider-chevrons",
        "".join(
            stroke(
                f"M{40 + 32 * i} {MID - 12} L{40 + 32 * i + 14} {MID} L{40 + 32 * i} {MID + 12}",
                RED if i % 3 else ROSE_SOFT,
                5,
            )
            for i in range(17)
        ),
        W,
        H,
    )
    add(
        "dividers",
        "divider-squiggle",
        stroke(
            "M16 30 C40 6 60 54 84 30 S128 6 152 30 S196 54 220 30 S264 6 288 30 S332 54 356 30 S400 6 424 30 S468 54 492 30 S536 6 560 30 L584 30",
            RED,
            4,
        ),
        W,
        H,
    )
    add(
        "dividers",
        "divider-ribbon",
        polygon([(10, 18), (590, 18), (572, 30), (590, 42), (10, 42), (28, 30)], RED)
        + line(40, 30, 560, 30, WHITE, 2, stroke_dasharray="6 8"),
        W,
        H,
    )
    add(
        "dividers",
        "divider-bar-dot",
        rect(16, MID - 5, 520, 10, RED, 5) + circle(566, MID, 9, ROSE_SOFT),
        W,
        H,
    )
    add(
        "dividers",
        "divider-gradient-bar",
        defs(linear_gradient("g", [(0, RED, 1), (1, ROSE_SOFT, 1)], 0, 0, 1, 0))
        + rect(16, MID - 7, W - 32, 14, "url(#g)", 7),
        W,
        H,
    )
    add(
        "dividers",
        "divider-triangles",
        "".join(
            polygon(
                [(40 + 40 * i, MID + 11), (60 + 40 * i, MID - 11), (80 + 40 * i, MID + 11)],
                RED if i % 2 else ROSE_SOFT,
            )
            for i in range(13)
            if 80 + 40 * i <= W - 20
        ),
        W,
        H,
    )
    add(
        "dividers",
        "divider-swirl",
        stroke(
            "M16 40 C70 40 90 14 150 14 C200 14 214 40 260 40 L340 40 C386 40 400 14 450 14 C510 14 530 40 584 40",
            RED,
            4,
        )
        + circle(300, 40, 5, RED),
        W,
        H,
    )

    # ---- borders: strips -----------------------------------------------------------------------------------------

    add(
        "borders",
        "strip-checker",
        "".join(
            rect(20 * i, 20 * j, 20, 20, RED if (i + j) % 2 else ROSE_SOFT)
            for i in range(30)
            for j in range(2)
        ),
        600,
        40,
    )
    teeth = [(0, 40)] + [p for i in range(30) for p in ((20 * i + 10, 6), (20 * i + 20, 40))]
    add("borders", "strip-sawtooth", polygon(teeth, RED), 600, 40)
    add(
        "borders",
        "strip-waves",
        path(
            "M0 20 "
            + " ".join(f"Q{30 + 60 * i} {2 if i % 2 == 0 else 38} {60 * (i + 1)} 20" for i in range(10))
            + " L600 40 L0 40 Z",
            RED,
        ),
        600,
        40,
    )
    add(
        "borders",
        "strip-dots",
        "".join(circle(20 + 40 * i, 20, 8 if i % 2 else 5, RED) for i in range(15)),
        600,
        40,
    )
    meander = "".join(
        stroke(
            f"M{50 * i} 36 V4 H{50 * i + 40} V28 H{50 * i + 10} V14 H{50 * i + 28}",
            RED,
            4,
            stroke_linejoin="miter",
            stroke_linecap="butt",
        )
        for i in range(12)
    )
    add("borders", "strip-greek-key", meander + line(0, 38, 600, 38, RED, 4, stroke_linecap="butt"), 600, 40)
    add(
        "borders",
        "strip-scallops",
        "".join(path(f"M{40 * i} 0 A20 20 0 0 0 {40 * (i + 1)} 0 Z", RED) for i in range(15))
        + rect(0, 0, 600, 3, RED),
        600,
        40,
    )
    add(
        "borders",
        "strip-rick-rack",
        stroke(
            "M0 28 " + " ".join(f"L{15 * (i + 1)} {28 if i % 2 else 8}" for i in range(40)),
            RED,
            8,
            stroke_linejoin="miter",
        ),
        600,
        36,
    )
    add(
        "borders",
        "strip-diamonds",
        "".join(
            polygon(
                [(20 + 40 * i, 4), (36 + 40 * i, 20), (20 + 40 * i, 36), (4 + 40 * i, 20)],
                RED if i % 2 else ROSE_SOFT,
            )
            for i in range(15)
        ),
        600,
        40,
    )
    add(
        "borders",
        "strip-candy",
        "".join(
            polygon([(24 * i, 40), (24 * i + 12, 40), (24 * i + 24, 0), (24 * i + 12, 0)], RED)
            for i in range(25)
        ),
        600,
        40,
    )
    add(
        "borders",
        "strip-chain",
        "".join(rect(10 + 50 * i, 6, 56, 28, "none", 14, stroke=RED, stroke_width=5) for i in range(12)),
        600,
        40,
    )
    add(
        "borders",
        "strip-hearts",
        "".join(heart_at(20 + 40 * i, 20, 26, RED if i % 2 else ROSE_SOFT) for i in range(15)),
        600,
        40,
    )
    add(
        "borders",
        "strip-stars",
        "".join(polygon(star_points(5, 20 + 40 * i, 20, 14, 6, -90), RED) for i in range(15)),
        600,
        40,
    )

    # ---- borders: frames and corners ---------------------------------------------------------------------------------

    def dotted_frame() -> str:
        step, count = 30, 13
        points = [(20 + step * i, 20) for i in range(count)] + [
            (20 + step * 12, 20 + step * i) for i in range(1, count)
        ]
        points += [(20 + step * (12 - i), 20 + step * 12) for i in range(1, count)] + [
            (20, 20 + step * (12 - i)) for i in range(1, count - 1)
        ]
        return "".join(circle(x, y, 6, RED) for x, y in points)

    add("borders", "frame-dotted", dotted_frame(), 400, 400)
    add(
        "borders",
        "frame-dashed-rounded",
        rect(
            18,
            18,
            364,
            364,
            "none",
            36,
            stroke=RED,
            stroke_width=6,
            stroke_dasharray="26 16",
            stroke_linecap="round",
        ),
        400,
        400,
    )
    checker = "".join(
        rect(10 + 20 * i, 10 + 20 * j, 20, 20, RED)
        for i in range(19)
        for j in range(19)
        if (i in (0, 18) or j in (0, 18)) and (i + j) % 2 == 0
    )
    add("borders", "frame-checker", checker, 400, 400)
    edge_stars = (
        [(40 + 40 * i, 22) for i in range(9)]
        + [(40 + 40 * i, 378) for i in range(9)]
        + [(22, 40 + 40 * i) for i in range(9)]
        + [(378, 40 + 40 * i) for i in range(9)]
    )
    add(
        "borders",
        "frame-stars",
        "".join(polygon(star_points(5, x, y, 12, 5, -90), RED) for x, y in edge_stars)
        + rect(40, 40, 320, 320, "none", 0, stroke=ROSE_SOFT, stroke_width=3),
        400,
        400,
    )

    corner = (
        stroke("M12 190 V60 Q12 12 60 12 H190", RED, 6)
        + stroke("M34 150 V68 Q34 34 68 34 H150", ROSE_SOFT, 4)
        + circle(12, 12, 9, RED)
        + circle(190, 12, 5, RED)
        + circle(12, 190, 5, RED)
        + path(Outline().M(60, 60).Q(80, 60, 80, 80).Q(60, 80, 60, 60).Z(), RED)
    )
    add("borders", "corner-flourish", corner, 200, 200)
    ornate = (
        stroke("M12 12 H120 M12 12 V120", RED, 8, stroke_linecap="butt")
        + stroke("M30 30 H90 M30 30 V90", ROSE_SOFT, 4)
        + polygon([(12, 12), (46, 12), (12, 46)], RED)
    )
    add("borders", "corner-bracket", ornate, 130, 130)
    add(
        "borders",
        "corner-arc",
        stroke("M12 150 A138 138 0 0 1 150 12", RED, 6)
        + stroke("M12 120 A108 108 0 0 1 120 12", ROSE_SOFT, 4)
        + circle(12, 12, 8, RED),
        160,
        160,
    )
