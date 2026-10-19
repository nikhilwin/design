"""Frames & Badges: hollow frames you place around content, and seals, medals and ribbons for labels."""

# ruff: noqa: E501  (SVG path data and coordinates are written inline, one graphic per statement)

from __future__ import annotations

from .kit import (
    RED,
    ROSE_DARK,
    ROSE_SOFT,
    SUN,
    WHITE,
    Collector,
    Outline,
    bumpy_rect,
    circle,
    circle_path,
    hollow,
    line,
    n,
    path,
    polar,
    polygon,
    rect,
    regular_polygon,
    rotate_point,
    rounded_rect,
    scallop_path,
    shapes,
    shifted,
    star_points,
    stroke,
)
from .lettering import word

C = 200  # canvas centre; every graphic is 400 x 400 unless stated


def ring(cx: float, cy: float, outer: float, inner: float, color: str) -> str:
    return hollow(circle_path(cx, cy, outer), circle_path(cx, cy, inner), color)


def star(cx: float, cy: float, outer: float, inner: float, color: str, rotation: float = -90) -> str:
    return polygon(star_points(5, cx, cy, outer, inner, rotation), color)


def leaf(x: float, y: float, angle: float, length: float, width: float, color: str) -> str:
    """A pointed leaf growing from `(x, y)` in direction `angle` (degrees)."""
    tip = rotate_point(x + length, y, x, y, angle)
    left = rotate_point(x + length / 2, y - width, x, y, angle)
    right = rotate_point(x + length / 2, y + width, x, y, angle)
    return path(
        f"M{n(x)} {n(y)} Q{n(left[0])} {n(left[1])} {n(tip[0])} {n(tip[1])} Q{n(right[0])} {n(right[1])} {n(x)} {n(y)} Z",
        color,
    )


def laurel(cx: float, cy: float, radius: float, color: str) -> str:
    """Two branches of leaves curving up both sides of a centre point."""
    out = []
    for k in range(9):
        theta = 105 + k * 17
        x, y = polar(cx, cy, radius, theta)
        angle = theta + 90 - 25
        length = 66 - k * 3
        out.append(leaf(x, y, angle, length, 17, color))
        out.append(leaf(2 * cx - x, y, 180 - angle, length, 17, color))
    return "".join(out)


def build(add: Collector) -> None:
    # ---- frames -------------------------------------------------------------------------------------------------

    add(
        "frames",
        "frame-thin",
        hollow(rounded_rect(10, 10, 380, 380, 0), rounded_rect(15, 15, 370, 370, 0), RED),
        400,
        400,
    )
    add(
        "frames",
        "frame-bold-rounded",
        hollow(rounded_rect(10, 10, 380, 380, 44), rounded_rect(34, 34, 332, 332, 24), RED),
        400,
        400,
    )
    add(
        "frames",
        "frame-double",
        hollow(rounded_rect(10, 10, 380, 380, 6), rounded_rect(16, 16, 368, 368, 2), RED)
        + hollow(rounded_rect(30, 30, 340, 340, 2), rounded_rect(34, 34, 332, 332, 0), RED),
        400,
        400,
    )
    corners = ""
    for sx, sy in ((1, 1), (-1, 1), (1, -1), (-1, -1)):
        x, y = (14 if sx > 0 else 386), (14 if sy > 0 else 386)
        corners += stroke(
            f"M{x} {y + sy * 70} V{y} H{x + sx * 70}", RED, 8, stroke_linejoin="miter", stroke_linecap="butt"
        )
    add("frames", "frame-corner-brackets", corners, 400, 400)

    ticket = (
        Outline()
        .M(10, 10)
        .L(390, 10)
        .L(390, 160)
        .A(40, 40, 0, 0, 390, 240)
        .L(390, 390)
        .L(10, 390)
        .L(10, 240)
        .A(40, 40, 0, 0, 10, 160)
        .Z()
    )
    add("frames", "frame-ticket", hollow(ticket, rounded_rect(34, 34, 332, 332, 6), RED), 400, 400)

    add(
        "frames",
        "frame-scalloped",
        hollow(bumpy_rect(14, 14, 372, 372, 12, 12), rounded_rect(44, 44, 312, 312, 14), RED),
        400,
        400,
    )
    add(
        "frames",
        "frame-stamp",
        hollow(shapes.notched_square(10, 10, 380, 19, 7), rounded_rect(40, 40, 320, 320, 4), RED),
        400,
        400,
    )
    add(
        "frames",
        "frame-arch",
        hollow(shapes.arch_path(40, 20, 320, 370), shapes.arch_path(70, 50, 260, 340), RED),
        400,
        400,
    )
    add("frames", "frame-ring-double", ring(C, C, 190, 176, RED) + ring(C, C, 160, 120, RED), 400, 400)
    deco = Outline().polygon(
        [(40, 10), (360, 10), (390, 40), (390, 360), (360, 390), (40, 390), (10, 360), (10, 40)]
    )
    deco_in = Outline().polygon(
        [(66, 36), (334, 36), (364, 66), (364, 334), (334, 364), (66, 364), (36, 334), (36, 66)]
    )
    add("frames", "frame-cut-corners", hollow(deco, deco_in, RED), 400, 400)

    def deco_step(inset: float, thick: float) -> Outline:
        a, b, step = inset, 400 - inset, 40
        return Outline().polygon(
            [
                (a + step, a),
                (b - step, a),
                (b - step, a + step / 2),
                (b - step / 2, a + step / 2),
                (b - step / 2, a + step),
                (b, a + step),
                (b, b - step),
                (b - step / 2, b - step),
                (b - step / 2, b - step / 2),
                (b - step, b - step / 2),
                (b - step, b),
                (a + step, b),
                (a + step, b - step / 2),
                (a + step / 2, b - step / 2),
                (a + step / 2, b - step),
                (a, b - step),
                (a, a + step),
                (a + step / 2, a + step),
                (a + step / 2, a + step / 2),
                (a + step, a + step / 2),
            ]
        )

    add(
        "frames",
        "frame-art-deco",
        stroke(deco_step(14, 0), RED, 6, stroke_linejoin="miter")
        + stroke(deco_step(34, 0), ROSE_SOFT, 3, stroke_linejoin="miter"),
        400,
        400,
    )

    flourish = ""
    for sx, sy in ((1, 1), (-1, 1), (1, -1), (-1, -1)):
        x, y = (20 if sx > 0 else 380), (20 if sy > 0 else 380)
        flourish += stroke(
            f"M{x} {y + sy * 110} C{x} {y + sy * 40} {x + sx * 40} {y} {x + sx * 110} {y}", RED, 6
        )
        flourish += stroke(
            f"M{x + sx * 20} {y + sy * 60} C{x + sx * 20} {y + sy * 32} {x + sx * 32} {y + sy * 20} {x + sx * 60} {y + sy * 20}",
            ROSE_SOFT,
            4,
        )
        flourish += circle(x + sx * 8, y + sy * 8, 7, RED)
    add("frames", "frame-ornate-corners", flourish, 400, 400)

    screws = "".join(circle(x, y, 7, ROSE_DARK) for x, y in ((38, 38), (362, 38), (38, 262), (362, 262)))
    add(
        "frames",
        "frame-label-plate",
        hollow(rounded_rect(10, 10, 380, 280, 26), rounded_rect(24, 24, 352, 252, 16), RED)
        + hollow(rounded_rect(54, 54, 292, 192, 10), rounded_rect(58, 58, 284, 184, 8), ROSE_SOFT)
        + screws,
        400,
        300,
    )

    mounts = ""
    for sx, sy in ((1, 1), (-1, 1), (1, -1), (-1, -1)):
        x, y = (14 if sx > 0 else 386), (14 if sy > 0 else 386)
        mounts += polygon([(x, y), (x + sx * 90, y), (x, y + sy * 90)], RED)
    add("frames", "frame-photo-corners", mounts, 400, 400)
    add(
        "frames",
        "frame-dashed",
        stroke("M16 16 H384 V384 H16 Z", RED, 6, stroke_dasharray="22 16", stroke_linejoin="round"),
        400,
        400,
    )
    hexagon = Outline().polygon(regular_polygon(6, C, C, 190, 0))
    hexagon_in = Outline().polygon(regular_polygon(6, C, C, 160, 0))
    add("frames", "frame-hexagon", hollow(hexagon, hexagon_in, RED), 400, 400)
    add(
        "frames",
        "frame-heart",
        hollow(
            shifted(shapes.heart_path().scaled(3.9, 50, 50), 150, 154),
            shifted(shapes.heart_path().scaled(3.0, 50, 50), 150, 152),
            RED,
        ),
        400,
        400,
    )
    add(
        "frames",
        "frame-shadow-box",
        rect(26, 26, 364, 364, ROSE_SOFT)
        + hollow(rounded_rect(10, 10, 364, 364, 0), rounded_rect(30, 30, 324, 324, 0), RED),
        400,
        400,
    )

    # ---- badges -------------------------------------------------------------------------------------------------

    add(
        "badges",
        "badge-circle",
        circle(C, C, 190, RED) + ring(C, C, 168, 160, WHITE) + star(C, C, 70, 28, WHITE),
        400,
        400,
    )
    add(
        "badges",
        "badge-seal-wavy",
        path(scallop_path(C, C, 170, 24, 0.5), RED) + ring(C, C, 128, 120, WHITE) + star(C, C, 60, 24, WHITE),
        400,
        400,
    )
    add(
        "badges",
        "badge-starburst",
        polygon(star_points(24, C, C, 192, 158, -90), RED)
        + circle(C, C, 120, ROSE_DARK)
        + ring(C, C, 110, 104, WHITE)
        + star(C, C, 64, 26, WHITE),
        400,
        400,
    )
    shield = (
        Outline()
        .M(200, 10)
        .L(360, 60)
        .L(360, 200)
        .C(360, 290, 290, 350, 200, 390)
        .C(110, 350, 40, 290, 40, 200)
        .L(40, 60)
        .Z()
    )
    shield_in = (
        Outline()
        .M(200, 42)
        .L(330, 82)
        .L(330, 200)
        .C(330, 270, 272, 322, 200, 356)
        .C(128, 322, 70, 270, 70, 200)
        .L(70, 82)
        .Z()
    )
    add(
        "badges",
        "badge-shield",
        path(shield, RED) + path(shield_in, ROSE_DARK) + star(C, 190, 80, 32, WHITE),
        400,
        400,
    )
    hexa = regular_polygon(6, C, C, 190, 0)
    add(
        "badges",
        "badge-hexagon",
        polygon(hexa, RED)
        + polygon(
            regular_polygon(6, C, C, 156, 0), "none", stroke=WHITE, stroke_width=6, stroke_linejoin="round"
        )
        + star(C, C, 66, 26, WHITE),
        400,
        400,
    )

    tails = polygon([(130, 300), (80, 395), (130, 372), (160, 395), (190, 300)], ROSE_DARK) + polygon(
        [(270, 300), (320, 395), (270, 372), (240, 395), (210, 300)], ROSE_DARK
    )
    add(
        "badges",
        "badge-rosette",
        tails
        + path(scallop_path(C, 180, 150, 20, 0.5), RED)
        + ring(C, 180, 108, 100, WHITE)
        + star(C, 180, 52, 21, WHITE),
        400,
        400,
    )

    medal_ribbon = polygon([(110, 10), (170, 10), (230, 200), (170, 200)], ROSE_DARK) + polygon(
        [(290, 10), (230, 10), (170, 200), (230, 200)], RED
    )
    add(
        "badges",
        "badge-medal",
        medal_ribbon
        + circle(C, 270, 112, SUN)
        + ring(C, 270, 112, 96, "#d97706")
        + star(C, 270, 56, 23, WHITE),
        400,
        400,
    )
    add(
        "badges",
        "badge-laurel",
        laurel(C, C, 128, ROSE_DARK) + circle(C, C, 88, RED) + star(C, C, 52, 21, WHITE),
        400,
        400,
    )

    stamp = (
        ring(C, C, 190, 176, RED)
        + stroke(circle_path(C, C, 150), RED, 5, stroke_dasharray="4 14")
        + ring(C, C, 126, 120, RED)
        + star(C, C, 60, 24, RED)
    )
    add("badges", "badge-stamp-round", stamp, 400, 400)

    add(
        "badges",
        "badge-diamond",
        polygon([(C, 8), (392, C), (C, 392), (8, C)], RED)
        + polygon(
            [(C, 52), (348, C), (C, 348), (52, C)],
            "none",
            stroke=WHITE,
            stroke_width=6,
            stroke_linejoin="round",
        )
        + star(C, C, 62, 25, WHITE),
        400,
        400,
    )
    tick = stroke("M140 205 L185 250 L265 150", WHITE, 26)
    add("badges", "badge-check-seal", path(scallop_path(C, C, 170, 16, 0.55), RED) + tick, 400, 400)
    add(
        "badges",
        "badge-star-circle",
        circle(C, C, 190, ROSE_DARK) + circle(C, C, 172, RED) + star(C, 205, 130, 54, WHITE),
        400,
        400,
    )

    crest = (
        Outline()
        .M(60, 20)
        .L(340, 20)
        .L(340, 200)
        .C(340, 300, 270, 360, 200, 392)
        .C(130, 360, 60, 300, 60, 200)
        .Z()
    )
    add(
        "badges",
        "badge-crest",
        path(crest, RED)
        + polygon([(60, 20), (340, 20), (340, 90), (200, 150), (60, 90)], ROSE_DARK)
        + star(C, 245, 66, 27, WHITE),
        400,
        400,
    )

    add(
        "badges",
        "badge-ribbon-banner",
        polygon([(10, 130), (80, 130), (80, 250), (10, 250), (40, 190)], ROSE_DARK)
        + polygon([(390, 130), (320, 130), (320, 250), (390, 250), (360, 190)], ROSE_DARK)
        + rect(60, 100, 280, 160, RED)
        + polygon([(60, 260), (100, 260), (60, 300)], "#4c0519")
        + polygon([(340, 260), (300, 260), (340, 300)], "#4c0519")
        + line(84, 124, 316, 124, WHITE, 3, stroke_dasharray="8 8")
        + line(84, 236, 316, 236, WHITE, 3, stroke_dasharray="8 8"),
        400,
        320,
    )
    add(
        "badges",
        "badge-pill-label",
        rect(10, 110, 380, 120, RED, 60)
        + circle(60, 170, 14, WHITE)
        + circle(340, 170, 14, WHITE)
        + stroke("M110 170 H290", WHITE, 6, stroke_dasharray="2 16"),
        400,
        340,
    )
    add(
        "badges",
        "badge-pennant",
        polygon([(14, 40), (386, 200), (14, 360)], RED)
        + line(14, 40, 14, 392, ROSE_DARK, 14)
        + star(110, 200, 44, 18, WHITE),
        400,
        400,
    )
    add(
        "badges",
        "badge-number-one",
        circle(C, C, 190, RED)
        + ring(C, C, 168, 160, WHITE)
        + word("1", C, 218, 150, WHITE, 24)
        + word("NO", C, 82, 34, WHITE, 6),
        400,
        400,
    )

    crown = polygon(
        [(100, 250), (80, 140), (146, 190), (200, 110), (254, 190), (320, 140), (300, 250)], WHITE
    ) + rect(100, 266, 200, 26, WHITE, 6)
    add("badges", "badge-premium", circle(C, C, 190, ROSE_DARK) + circle(C, C, 168, RED) + crown, 400, 400)
    add(
        "badges",
        "badge-guarantee",
        circle(C, C, 190, RED)
        + ring(C, C, 168, 162, WHITE)
        + stroke("M120 205 L175 258 L285 142", WHITE, 24)
        + word("100%", C, 330, 36, WHITE, 5),
        400,
        400,
    )
    add(
        "badges",
        "badge-heart-seal",
        path(scallop_path(C, C, 170, 20, 0.5), RED)
        + path(shifted(shapes.heart_path().scaled(2.0, 50, 50), 150, 154), WHITE),
        400,
        400,
    )
