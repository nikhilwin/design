"""Speech Bubbles & Callouts: speech and thought bubbles, chat messages and pointer boxes (400 x 300)."""

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
    Rng,
    circle,
    ellipse,
    line,
    n,
    path,
    polygon,
    rect,
    scallop_path,
    smooth,
    star_points,
    stroke,
)
from .lettering import word

W, H = 400, 300


def speech(
    x: float,
    y: float,
    w: float,
    h: float,
    r: float,
    side: str,
    pos: float = 0.25,
    tail: float = 46,
    base: float = 40,
    lean: float = 0,
) -> str:
    """Path data of a rounded rectangle with a pointer on one side.

    `pos` is how far along that side (clockwise, 0..1) the pointer's base starts; `lean` shifts its tip sideways.
    """
    r = min(r, w / 2, h / 2)
    d: list[str] = [f"M{n(x + r)} {n(y)}"]

    def edge(name: str, start: tuple[float, float], end: tuple[float, float], corner: str) -> None:
        if name == side:
            (sx, sy), (ex, ey) = start, end
            length = math.hypot(ex - sx, ey - sy)
            ux, uy = (ex - sx) / length, (ey - sy) / length
            nx, ny = uy, -ux  # outward normal for a clockwise outline in y-down coordinates
            nx, ny = -uy * -1, ux * -1
            a = pos * (length - 2 * r) + r
            b = a + base
            p1 = (sx + ux * a, sy + uy * a)
            p2 = (sx + ux * b, sy + uy * b)
            tip = (sx + ux * (a + base / 2 + lean) + nx * tail, sy + uy * (a + base / 2 + lean) + ny * tail)
            d.append(f"L{n(p1[0])} {n(p1[1])} L{n(tip[0])} {n(tip[1])} L{n(p2[0])} {n(p2[1])}")
        d.append(f"L{n(end[0])} {n(end[1])}")
        d.append(corner)

    edge("top", (x + r, y), (x + w - r, y), f"A{n(r)} {n(r)} 0 0 1 {n(x + w)} {n(y + r)}")
    edge("right", (x + w, y + r), (x + w, y + h - r), f"A{n(r)} {n(r)} 0 0 1 {n(x + w - r)} {n(y + h)}")
    edge("bottom", (x + w - r, y + h), (x + r, y + h), f"A{n(r)} {n(r)} 0 0 1 {n(x)} {n(y + h - r)}")
    edge("left", (x, y + h - r), (x, y + r), f"A{n(r)} {n(r)} 0 0 1 {n(x + r)} {n(y)}")
    return " ".join(d) + " Z"


def build(add: Collector) -> None:
    box = (30, 30, 340, 190, 34)
    boxes = {  # leave room for the pointer on the side it sticks out of
        "top": (30, 62, 340, 190, 34),
        "left": (66, 30, 304, 190, 34),
        "right": (30, 30, 304, 190, 34),
    }
    # ---- filled speech bubbles ------------------------------------------------------------------------------
    for name, side, pos, lean in (
        ("bubble-bottom-left", "bottom", 0.78, -14),
        ("bubble-bottom-right", "bottom", 0.0, 14),
        ("bubble-bottom-center", "bottom", 0.5, 0),
        ("bubble-top-left", "top", 0.0, 14),
        ("bubble-top-right", "top", 0.78, -14),
        ("bubble-left", "left", 0.15, 14),
        ("bubble-right", "right", 0.6, -14),
    ):
        add("speech", name, path(speech(*boxes.get(side, box), side, pos, lean=lean), RED), W, H)
    for name, side, pos in (
        ("outline-bottom-left", "bottom", 0.78),
        ("outline-bottom-right", "bottom", 0.0),
        ("outline-left", "left", 0.15),
        ("outline-right", "right", 0.6),
    ):
        add("speech", f"bubble-{name}", stroke(speech(*boxes.get(side, box), side, pos), RED, 8), W, H)
    add("speech", "bubble-square", path(speech(30, 30, 340, 190, 6, "bottom", 0.78, lean=-14), RED), W, H)
    add(
        "speech",
        "bubble-pill",
        path(speech(30, 50, 340, 120, 60, "bottom", 0.72, tail=40, lean=-14), RED),
        W,
        240,
    )
    add(
        "speech",
        "bubble-soft",
        path(speech(30, 30, 340, 190, 34, "bottom", 0.78, lean=-14), ROSE_SOFT)
        + circle(106, 125, 11, WHITE)
        + circle(200, 125, 11, WHITE)
        + circle(294, 125, 11, WHITE),
        W,
        H,
    )
    add(
        "speech",
        "bubble-typing",
        path(speech(70, 50, 260, 130, 65, "bottom", 0.78, lean=-12), RED)
        + circle(150, 115, 14, WHITE)
        + circle(200, 115, 14, WHITE)
        + circle(250, 115, 14, WHITE),
        W,
        260,
    )
    add(
        "speech",
        "bubble-question",
        path(speech(*box, "bottom", 0.78, lean=-14), RED) + word("?", 200, 125, 90, WHITE, 14),
        W,
        H,
    )
    add(
        "speech",
        "bubble-exclaim",
        path(speech(*box, "bottom", 0.78, lean=-14), RED) + word("!", 200, 125, 90, WHITE, 14),
        W,
        H,
    )
    add(
        "speech",
        "bubble-oval",
        ellipse(200, 120, 170, 100, RED) + polygon([(110, 190), (86, 260), (170, 208)], RED),
        W,
        H,
    )
    add(
        "speech",
        "bubble-scalloped",
        path(scallop_path(200, 112, 106, 16, 0.55), RED) + polygon([(150, 200), (122, 280), (208, 214)], RED),
        W,
        H,
    )

    # ---- chat messages ------------------------------------------------------------------------------------------
    sent = path(speech(150, 20, 230, 70, 30, "bottom", 0.8, tail=0, base=0), RED) + rect(
        176, 48, 150, 10, WHITE, 5
    )
    received = path(speech(20, 110, 250, 70, 30, "bottom", 0.8, tail=0, base=0), ROSE_SOFT) + rect(
        46, 138, 170, 10, WHITE, 5
    )
    add(
        "chat",
        "chat-message-sent",
        path(speech(30, 40, 340, 90, 40, "right", 0.7, tail=22, base=26, lean=-8), RED)
        + rect(70, 78, 220, 12, WHITE, 6),
        W,
        170,
    )
    add(
        "chat",
        "chat-message-received",
        path(speech(30, 40, 340, 90, 40, "left", 0.3, tail=22, base=26, lean=8), ROSE_SOFT)
        + rect(70, 78, 220, 12, WHITE, 6),
        W,
        170,
    )
    add("chat", "chat-conversation", sent + received, W, 200)
    add(
        "chat",
        "chat-double-bubble",
        path(speech(20, 20, 240, 130, 30, "bottom", 0.75, lean=-12), RED)
        + path(speech(150, 110, 230, 120, 30, "bottom", 0.0, tail=40, lean=14), ROSE_SOFT),
        W,
        290,
    )

    # ---- thought and shout -------------------------------------------------------------------------------------------
    cloud = (
        circle(110, 130, 60, ROSE_SOFT)
        + circle(180, 90, 70, ROSE_SOFT)
        + circle(260, 100, 62, ROSE_SOFT)
        + circle(300, 150, 52, ROSE_SOFT)
        + rect(110, 120, 190, 80, ROSE_SOFT, 40)
        + circle(230, 150, 76, ROSE_SOFT)
    )
    add(
        "thought",
        "thought-cloud",
        cloud + circle(120, 238, 20, ROSE_SOFT) + circle(80, 272, 12, ROSE_SOFT),
        W,
        H,
    )
    add(
        "thought",
        "thought-round",
        ellipse(200, 110, 160, 90, RED) + circle(120, 236, 20, RED) + circle(86, 272, 11, RED),
        W,
        H,
    )
    add(
        "thought",
        "thought-round-outline",
        ellipse(200, 110, 158, 88, "none", stroke=RED, stroke_width=8)
        + circle(120, 236, 18, "none", stroke=RED, stroke_width=7)
        + circle(86, 270, 9, "none", stroke=RED, stroke_width=6),
        W,
        H,
    )
    add("thought", "shout-burst", polygon(star_points(16, 200, 140, 140, 98, -90), RED), W, 280)
    rng = Rng(9)
    comic = [
        (
            200
            + (rng.uniform(112, 150) if i % 2 == 0 else rng.uniform(72, 92))
            * math.cos(math.radians(360 * i / 24 - 90)),
            140
            + (rng.uniform(100, 130) if i % 2 == 0 else rng.uniform(58, 76))
            * math.sin(math.radians(360 * i / 24 - 90)),
        )
        for i in range(24)
    ]
    add("thought", "shout-comic", polygon(comic, RED), W, 280)
    add(
        "thought",
        "shout-tail",
        polygon(star_points(14, 200, 120, 150, 108, -90), RED)
        + polygon([(170, 220), (150, 285), (220, 230)], RED),
        W,
        H,
    )
    wobble = [
        (
            200 + (160 + rng.uniform(-8, 8)) * math.cos(math.radians(i * 20)),
            120 + (92 + rng.uniform(-6, 6)) * math.sin(math.radians(i * 20)),
        )
        for i in range(18)
    ]
    add(
        "thought",
        "bubble-hand-drawn",
        stroke(smooth(wobble, closed=True), RED, 7)
        + stroke("M120 195 Q104 240 84 262 Q130 248 168 214", RED, 7),
        W,
        H,
    )

    # ---- quotes ------------------------------------------------------------------------------------------------------
    def quote(cx: float, cy: float, direction: int, color: str) -> str:
        """A comma-like mark: a dot with a tail swinging down-left (closing) or up-right (opening)."""
        k = direction
        tail = (
            Outline()
            .M(cx + k * 24, cy)
            .C(cx + k * 24, cy + k * 44, cx + k * 6, cy + k * 66, cx - k * 26, cy + k * 76)
            .C(cx - k * 8, cy + k * 54, cx - k * 8, cy + k * 30, cx - k * 20, cy + k * 6)
            .Z()
        )
        return circle(cx, cy, 24, color) + path(tail, color)

    add("quotes", "quote-close", quote(120, 90, 1, RED) + quote(250, 90, 1, RED), W, 200)
    add("quotes", "quote-open", quote(150, 130, -1, RED) + quote(280, 130, -1, RED), W, 200)

    # ---- callouts ---------------------------------------------------------------------------------------------------------
    for name, side, pos in (
        ("callout-up", "top", 0.4),
        ("callout-down", "bottom", 0.4),
        ("callout-left", "left", 0.4),
        ("callout-right", "right", 0.4),
    ):
        x, y, w, h, _ = boxes.get(side, (30, 40, 340, 190, 0))
        add(
            "callouts",
            name,
            path(speech(x, y if side != "top" else 70, w, h - 20, 12, side, pos, tail=36, base=44), RED),
            W,
            H,
        )
    add(
        "callouts",
        "callout-label",
        polygon([(20, 150), (70, 90), (380, 90), (380, 210), (70, 210)], RED),
        W,
        H,
    )
    add(
        "callouts",
        "callout-banner",
        polygon([(10, 90), (390, 90), (360, 150), (390, 210), (10, 210)], RED)
        + polygon([(10, 210), (50, 210), (50, 240)], ROSE_DARK),
        W,
        H,
    )
    add(
        "callouts",
        "callout-annotation",
        circle(110, 150, 80, "none", stroke=RED, stroke_width=8)
        + line(168, 94, 300, 40, RED, 6)
        + circle(310, 36, 14, RED),
        W,
        H,
    )
    add(
        "callouts",
        "callout-leader",
        rect(30, 160, 200, 90, ROSE_SOFT, 12)
        + stroke("M230 205 H300 L350 60", RED, 6)
        + circle(350, 56, 14, RED),
        W,
        H,
    )
    add(
        "callouts",
        "callout-arrow-note",
        rect(20, 20, 250, 120, RED, 16)
        + stroke("M270 80 H330 Q370 80 370 120 V230", RED, 8)
        + polygon([(340, 226), (400, 226), (370, 272)], RED),
        W,
        H,
    )
