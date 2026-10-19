"""Doodle Accents: hand-drawn-look underlines, circles, arrows, stars, sparkles and little symbols.

Every stroke is a smooth curve through points that are nudged by a seeded generator, so each doodle has the
slight irregularity of a pen drawing and is still exactly reproducible. All of them are one colour.
"""

# ruff: noqa: E501  (SVG path data and coordinates are written inline, one graphic per statement)

from __future__ import annotations

import math

from .kit import (
    RED,
    Collector,
    Rng,
    circle,
    heart_path,
    n,
    path,
    polar,
    polygon,
    rotate_point,
    shifted,
    smooth,
    stroke,
    wobble,
)

PEN = 7.0


def pen(d: str, width: float = PEN, **kw) -> str:
    return stroke(d, RED, width, **kw)


def head(tip: tuple[float, float], direction: float, size: float = 30, spread: float = 30) -> str:
    """Two short strokes forming an open arrowhead at `tip` for a shaft travelling along `direction` (degrees)."""
    left = rotate_point(tip[0] - size, tip[1], tip[0], tip[1], direction + spread)
    right = rotate_point(tip[0] - size, tip[1], tip[0], tip[1], direction - spread)
    return pen(f"M{n(left[0])} {n(left[1])} L{n(tip[0])} {n(tip[1])} L{n(right[0])} {n(right[1])}")


def direction_of(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))


def freehand_circle(
    cx: float,
    cy: float,
    rx: float,
    ry: float,
    rng: Rng,
    turns: float = 1.08,
    start: float = -60,
    jitter: float = 3,
) -> list[tuple[float, float]]:
    steps = int(14 * turns) + 1
    points = []
    for i in range(steps):
        angle = math.radians(start + 360 * turns * i / (steps - 1))
        grow = 1 + 0.06 * (i / (steps - 1))
        points.append(
            (
                cx + rx * grow * math.cos(angle) + rng.uniform(-jitter, jitter),
                cy + ry * grow * math.sin(angle) + rng.uniform(-jitter, jitter),
            )
        )
    return points


def build(add: Collector) -> None:
    rng = Rng(101)

    # ---- underlines -------------------------------------------------------------------------------------------------
    def underline(points: list[tuple[float, float]], amount: float = 2.0, seed: int = 0) -> str:
        return smooth(wobble(points, Rng(seed + 7), amount))

    straight = [(14 + 54 * i, 30 + (i % 2) * 2) for i in range(6)]
    add("underlines", "underline-straight", pen(underline(straight, 2, 1)), 300, 60)
    add(
        "underlines",
        "underline-double",
        pen(underline([(14 + 54 * i, 18) for i in range(6)], 2, 2), 6)
        + pen(underline([(24 + 52 * i, 40) for i in range(6)], 2, 3), 6),
        300,
        60,
    )
    add(
        "underlines",
        "underline-wave",
        pen(smooth([(14 + 20 * i, 30 + (9 if i % 2 else -9)) for i in range(15)])),
        300,
        60,
    )
    add(
        "underlines",
        "underline-zigzag",
        pen(
            "M14 40 " + " ".join(f"L{14 + 17 * (i + 1)} {40 if i % 2 else 18}" for i in range(16)),
            stroke_linejoin="round",
        ),
        300,
        60,
    )
    brush = "M12 34 C70 22 140 40 288 24 C250 36 180 38 120 44 C80 48 40 44 12 34 Z"
    add("underlines", "underline-brush", path(brush, RED), 300, 60)
    add(
        "underlines",
        "underline-loop",
        pen("M14 40 C80 46 150 30 230 36 C290 40 290 14 262 16 C238 18 244 44 276 40"),
        300,
        60,
    )
    add("underlines", "underline-swoosh", pen("M14 44 C90 48 190 40 286 12"), 300, 60)
    add(
        "underlines",
        "underline-dashes",
        "".join(
            pen(f"M{16 + 56 * i} {n(30 + rng.uniform(-3, 3))} l30 {n(rng.uniform(-4, 4))}") for i in range(5)
        ),
        300,
        60,
    )
    scribble = "M14 40 L286 22 L22 36 L280 30 L40 44"
    add("underlines", "underline-scribble", pen(scribble, 5, stroke_linejoin="round"), 300, 60)
    add("underlines", "highlight-marker", pen("M16 32 C90 24 200 38 284 28", 34, opacity=0.35), 300, 64)

    # ---- circles and outlines --------------------------------------------------------------------------------------------
    r2 = Rng(11)
    add("rings", "circle-scribble", pen(smooth(freehand_circle(100, 100, 74, 72, r2))), 200, 200)
    add(
        "rings",
        "circle-double",
        pen(smooth(freehand_circle(100, 100, 78, 76, r2, 1.0)), 6)
        + pen(smooth(freehand_circle(100, 100, 62, 60, r2, 1.0, 40)), 6),
        200,
        200,
    )
    add("rings", "oval-highlight", pen(smooth(freehand_circle(150, 70, 128, 48, r2, 1.1, -30))), 300, 140)
    add(
        "rings",
        "circle-spiral",
        pen(
            smooth(
                [
                    (100 + (6 + 5.2 * t) * math.cos(t * 1.1), 100 + (6 + 5.2 * t) * math.sin(t * 1.1))
                    for t in [i * 0.5 for i in range(30)]
                ]
            )
        ),
        200,
        200,
    )
    box = [(20, 24), (150, 18), (284, 26), (278, 98), (286, 170), (150, 176), (18, 168), (24, 98), (22, 22)]
    add("rings", "rectangle-doodle", pen(smooth(wobble(box, Rng(19), 3))), 300, 190)
    hd = shifted(heart_path().scaled(1.9, 50, 49), 50, 51)
    add("rings", "heart-doodle", pen(hd), 200, 200)
    add("rings", "heart-filled-doodle", path(hd, RED), 200, 200)
    add(
        "rings",
        "squiggle-circle",
        pen(
            "M100 24 C150 18 184 60 176 104 C168 150 120 182 76 168 C30 154 14 104 32 66 C50 30 96 26 128 44"
        ),
        200,
        200,
    )

    # ---- arrows --------------------------------------------------------------------------------------------------------------
    def arrow(points: list[tuple[float, float]], seed: int, size: float = 30) -> str:
        shaft = smooth(wobble(points, Rng(seed), 1.5))
        return pen(shaft) + head(points[-1], direction_of(points[-2], points[-1]), size)

    add("arrows", "arrow-right", arrow([(16, 70), (80, 66), (150, 72), (214, 68)], 31), 240, 140)
    add("arrows", "arrow-left", arrow([(224, 70), (160, 66), (90, 72), (26, 68)], 32), 240, 140)
    add("arrows", "arrow-up", arrow([(70, 126), (66, 70), (72, 20)], 33), 140, 140)
    add("arrows", "arrow-down", arrow([(70, 14), (66, 70), (72, 120)], 34), 140, 140)
    add("arrows", "arrow-curve-up", arrow([(16, 120), (70, 118), (130, 90), (170, 20)], 35), 200, 140)
    add("arrows", "arrow-curve-down", arrow([(16, 24), (70, 22), (130, 50), (170, 120)], 36), 200, 140)
    add("arrows", "arrow-arc", arrow([(16, 110), (50, 50), (110, 26), (176, 50), (200, 100)], 37), 220, 140)
    loop = [(16, 110), (70, 100), (120, 60), (110, 26), (80, 40), (90, 80), (150, 90), (210, 60)]
    add("arrows", "arrow-loop", arrow(loop, 38), 240, 140)
    add(
        "arrows",
        "arrow-wavy",
        arrow([(14, 70), (44, 40), (74, 100), (104, 40), (134, 100), (164, 56), (214, 70)], 39),
        240,
        140,
    )
    add(
        "arrows", "arrow-s-curve", arrow([(24, 20), (80, 30), (60, 90), (120, 110), (190, 100)], 40), 220, 140
    )
    add(
        "arrows",
        "arrow-double",
        arrow([(40, 70), (100, 68), (200, 72)], 41, 28) + head((24, 70), 180, 28),
        240,
        140,
    )
    add(
        "arrows",
        "arrow-turn-back",
        arrow([(190, 30), (210, 70), (160, 110), (80, 104), (30, 70)], 42),
        240,
        140,
    )
    add("arrows", "arrow-short", arrow([(20, 60), (60, 58), (100, 60)], 43, 24), 120, 120)
    add("arrows", "arrow-diagonal", arrow([(20, 120), (80, 80), (140, 36)], 44), 170, 140)

    # ---- stars and sparkles ----------------------------------------------------------------------------------------------------
    rs = Rng(53)
    star5 = [polar(100, 104, 80 if i % 2 == 0 else 34, -90 + 36 * i) for i in range(11)]
    add(
        "stars",
        "star-outline",
        pen("M" + " L".join(f"{n(x)} {n(y)}" for x, y in wobble(star5, rs, 2)), stroke_linejoin="round"),
        200,
        200,
    )
    add("stars", "star-filled", polygon(wobble(star5[:-1], rs, 3), RED), 200, 200)
    add(
        "stars",
        "sparkle-four",
        path("M100 14 Q112 88 186 100 Q112 112 100 186 Q88 112 14 100 Q88 88 100 14 Z", RED),
        200,
        200,
    )
    add(
        "stars",
        "sparkle-outline",
        pen("M100 18 Q112 88 182 100 Q112 112 100 182 Q88 112 18 100 Q88 88 100 18 Z"),
        200,
        200,
    )

    def small(cx: float, cy: float, r: float) -> str:
        k = r * 0.16
        d = f"M{n(cx)} {n(cy - r)} Q{n(cx + k)} {n(cy - k)} {n(cx + r)} {n(cy)} Q{n(cx + k)} {n(cy + k)} {n(cx)} {n(cy + r)} "
        d += f"Q{n(cx - k)} {n(cy + k)} {n(cx - r)} {n(cy)} Q{n(cx - k)} {n(cy - k)} {n(cx)} {n(cy - r)} Z"
        return path(d, RED)

    add("stars", "sparkles-trio", small(70, 120, 56) + small(150, 56, 36) + small(156, 150, 24), 200, 200)
    add(
        "stars",
        "asterisk",
        "".join(
            pen(
                f"M{n(100 + 70 * math.cos(math.radians(a)))} {n(100 + 70 * math.sin(math.radians(a)))} L{n(100 - 70 * math.cos(math.radians(a)))} {n(100 - 70 * math.sin(math.radians(a)))}",
                9,
            )
            for a in (-90, -30, 30)
        ),
        200,
        200,
    )
    add(
        "stars",
        "emphasis-lines",
        "".join(
            pen(
                f"M{n(polar(100, 100, 52, a)[0])} {n(polar(100, 100, 52, a)[1])} L{n(polar(100, 100, 86, a)[0])} {n(polar(100, 100, 86, a)[1])}"
            )
            for a in range(-180, 0, 30)
        ),
        200,
        110,
    )
    wob = [polar(100, 100, 80 if i % 2 == 0 else 58, 360 * i / 24) for i in range(25)]
    add(
        "stars",
        "burst-doodle",
        pen(
            "M" + " L".join(f"{n(x)} {n(y)}" for x, y in wobble(wob, Rng(71), 2)), 6, stroke_linejoin="round"
        ),
        200,
        200,
    )
    add("stars", "shine", pen("M60 48 L44 22 M100 40 V6 M140 48 L156 22"), 200, 60)
    add(
        "stars",
        "dots-cluster",
        "".join(
            circle(x, y, r, RED)
            for x, y, r in (
                (50, 60, 12),
                (96, 40, 8),
                (130, 84, 14),
                (80, 120, 9),
                (150, 140, 7),
                (40, 150, 6),
            )
        ),
        200,
        200,
    )

    # ---- symbols --------------------------------------------------------------------------------------------------------------------
    add("symbols", "check-doodle", pen("M24 104 C44 120 56 140 72 158 C100 100 140 52 184 22", 12), 200, 200)
    add("symbols", "cross-doodle", pen("M34 34 L168 166", 12) + pen("M170 30 L32 168", 12), 200, 200)
    add(
        "symbols",
        "exclamation-doodle",
        pen("M100 20 C98 60 102 100 96 130", 16) + circle(98, 170, 11, RED),
        200,
        200,
    )
    add(
        "symbols",
        "question-doodle",
        pen("M56 66 C56 20 146 20 146 68 C146 108 98 106 100 142", 13) + circle(100, 176, 10, RED),
        200,
        200,
    )
    add(
        "symbols",
        "crown-doodle",
        pen("M24 150 L16 54 L70 100 L100 36 L130 100 L184 54 L176 150 Z", 8, stroke_linejoin="round")
        + pen("M30 172 H170", 8),
        200,
        200,
    )
    add(
        "symbols",
        "lightning-doodle",
        pen("M118 14 L52 110 H100 L82 188 L152 84 H106 Z", 8, stroke_linejoin="round"),
        200,
        200,
    )
    add(
        "symbols",
        "sun-doodle",
        pen(smooth(freehand_circle(100, 100, 36, 36, Rng(61), 1.02)))
        + "".join(
            pen(
                f"M{n(polar(100, 100, 56, a)[0])} {n(polar(100, 100, 56, a)[1])} L{n(polar(100, 100, 84, a)[0])} {n(polar(100, 100, 84, a)[1])}"
            )
            for a in range(0, 360, 45)
        ),
        200,
        200,
    )
    petals = "".join(
        circle(*polar(100, 100, 44, a), 24, "none", stroke=RED, stroke_width=PEN) for a in range(-90, 270, 72)
    )
    add("symbols", "flower-doodle", petals + circle(100, 100, 16, RED), 200, 200)
    add(
        "symbols",
        "swirl-doodle",
        pen("M20 150 C20 60 120 30 150 80 C176 124 110 150 96 112 C86 82 128 66 140 90"),
        200,
        200,
    )
    add(
        "symbols",
        "leaf-sprig",
        pen("M40 180 C60 120 90 70 150 20")
        + "".join(
            path(
                f"M{n(x)} {n(y)} q{n(dx)} {n(dy)} {n(ex)} {n(ey)} q{n(-dx * 0.2)} {n(dy * 1.4)} {n(-ex)} {n(-ey)} Z",
                RED,
            )
            for x, y, dx, dy, ex, ey in (
                (62, 138, -34, -8, -24, -34),
                (82, 106, 34, 6, 30, -26),
                (104, 78, -36, -4, -22, -36),
                (126, 50, 32, 4, 26, -28),
            )
        ),
        200,
        200,
    )
    add(
        "symbols",
        "cloud-doodle",
        pen("M50 140 C14 140 14 92 52 94 C50 52 112 40 130 80 C170 66 190 120 154 140 Z", 7),
        200,
        180,
    )
    add(
        "symbols",
        "music-doodle",
        pen("M70 150 V40 L150 24 V132") + circle(56, 154, 17, RED) + circle(136, 136, 17, RED),
        200,
        200,
    )
    add(
        "symbols",
        "eye-doodle",
        pen("M14 100 C50 40 150 40 186 100 C150 160 50 160 14 100 Z") + circle(100, 100, 24, RED),
        200,
        200,
    )
    add(
        "symbols",
        "smile-doodle",
        pen(smooth(freehand_circle(100, 100, 78, 76, Rng(67), 1.04)))
        + circle(70, 84, 9, RED)
        + circle(130, 84, 9, RED)
        + pen("M62 122 C80 158 122 158 140 122"),
        200,
        200,
    )
