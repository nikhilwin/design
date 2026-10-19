"""Sale & Promo: sale, discount and promo badges, tags, ribbons and coupons (mostly 400 x 400).

Lettering is drawn as stroked paths (see `lettering.py`), so the badges need no fonts and recolour like any
other shape.
"""

# ruff: noqa: E501  (SVG path data and coordinates are written inline, one graphic per statement)

from __future__ import annotations

from .kit import (
    INK,
    RED,
    ROSE_DARK,
    ROSE_SOFT,
    SUN,
    WHITE,
    Collector,
    Outline,
    circle,
    circle_path,
    heart_path,
    hollow,
    line,
    path,
    polygon,
    rect,
    scallop_path,
    shifted,
    star_points,
    stroke,
)
from .lettering import text_width, word

C = 200


def burst(color: str = RED, points: int = 20, outer: float = 192, inner: float = 164) -> str:
    return polygon(star_points(points, C, C, outer, inner, -90), color)


def disc(color: str = RED, inner_ring: bool = True) -> str:
    out = circle(C, C, 190, color)
    if inner_ring:
        out += hollow(circle_path(C, C, 168), circle_path(C, C, 160), WHITE)
    return out


def seal(color: str = RED) -> str:
    return path(scallop_path(C, C, 172, 20, 0.5), color) + hollow(
        circle_path(C, C, 140), circle_path(C, C, 133), WHITE
    )


def text(
    value: str, y: float, height: float, color: str = WHITE, x: float = C, max_width: float = 230
) -> str:
    """`value` as lettering, scaled down when it would be wider than `max_width`."""
    width = text_width(value, height)
    if width > max_width:
        height *= max_width / width
    return word(value, x, y, height, color, max(5.0, height * 0.15))


def tag_shape(color: str, hole: bool = True) -> str:
    body = Outline().M(30, 130).L(130, 30).L(380, 30).L(380, 370).L(130, 370).L(30, 270).Z()
    shape = path(body, color)
    return shape + (circle(104, 200, 20, WHITE) if hole else "")


def build(add: Collector) -> None:
    # ---- SALE ---------------------------------------------------------------------------------------------------
    add("sale", "sale-starburst", burst() + text("SALE", 200, 84, max_width=270), 400, 400)
    add("sale", "sale-circle", disc() + text("SALE", 200, 80), 400, 400)
    add("sale", "sale-seal", seal() + text("SALE", 200, 76), 400, 400)
    add("sale", "sale-tag", tag_shape(RED) + text("SALE", 200, 70, x=258, max_width=190), 400, 400)
    add(
        "sale",
        "sale-ribbon",
        polygon([(10, 130), (80, 130), (80, 250), (10, 250), (36, 190)], ROSE_DARK)
        + polygon([(390, 130), (320, 130), (320, 250), (390, 250), (364, 190)], ROSE_DARK)
        + rect(50, 100, 300, 150, RED)
        + text("SALE", 175, 90, max_width=250),
        400,
        300,
    )
    add(
        "sale", "sale-pill", rect(10, 110, 380, 150, RED, 75) + text("SALE", 185, 90, max_width=320), 400, 370
    )
    add(
        "sale",
        "sale-flash",
        burst(SUN, 12, 190, 130) + path("M230 40 L120 230 H196 L170 360 L290 160 H212 Z", RED),
        400,
        400,
    )
    add("sale", "sale-today", disc(ROSE_DARK) + text("TODAY", 160, 70) + text("ONLY", 252, 70), 400, 400)

    # ---- NEW / HOT / FREE / DEAL ------------------------------------------------------------------------------------
    add("labels", "new-burst", burst(RED, 16, 192, 150) + text("NEW", 200, 100), 400, 400)
    add("labels", "new-circle", disc() + text("NEW", 200, 100), 400, 400)
    add(
        "labels", "new-pill", rect(10, 130, 380, 130, RED, 65) + text("NEW", 195, 80, max_width=320), 400, 390
    )
    add("labels", "hot-seal", seal(ROSE_DARK) + text("HOT", 200, 100), 400, 400)
    add(
        "labels",
        "hot-flame",
        path(
            "M200 20 C230 90 320 110 320 230 C320 320 260 380 200 380 C140 380 80 320 80 230 C80 170 120 140 140 100 C150 140 170 150 180 150 C170 110 180 60 200 20 Z",
            RED,
        )
        + path(
            "M200 200 C215 240 250 250 250 300 C250 340 225 360 200 360 C175 360 150 340 150 300 C150 260 190 250 200 200 Z",
            SUN,
        ),
        400,
        400,
    )
    add(
        "labels",
        "free-pill",
        rect(10, 130, 380, 130, RED, 65) + text("FREE", 195, 80, max_width=320),
        400,
        390,
    )
    add("labels", "free-burst", burst(RED, 14, 192, 150) + text("FREE", 200, 84), 400, 400)
    add("labels", "deal-circle", disc(ROSE_DARK) + text("DEAL", 200, 82), 400, 400)
    add(
        "labels",
        "best-seller",
        seal() + text("BEST", 165, 64, max_width=200) + text("SELLER", 245, 48, max_width=200),
        400,
        400,
    )
    add(
        "labels",
        "limited-offer",
        rect(10, 110, 380, 170, ROSE_DARK, 24)
        + text("LIMITED", 168, 58, max_width=320)
        + text("OFFER", 238, 52, ROSE_SOFT, max_width=320),
        400,
        390,
    )
    add("labels", "bogo-burst", burst(RED, 18, 192, 150) + text("BOGO", 200, 90), 400, 400)
    add("labels", "wow-burst", burst(SUN, 12, 192, 140) + text("WOW", 200, 110, INK), 400, 400)

    # ---- discounts --------------------------------------------------------------------------------------------------
    shapes = (lambda: burst(RED, 20), lambda: disc(), lambda: seal(), lambda: burst(ROSE_DARK, 16, 192, 156))
    for index, value in enumerate((10, 20, 30, 40, 50, 60, 70)):
        add(
            "discount",
            f"off-{value}",
            shapes[index % 4]() + text(f"{value}%", 175, 104) + text("OFF", 270, 56),
            400,
            400,
        )
    add(
        "discount",
        "up-to-50",
        disc() + text("UP TO", 120, 44) + text("50%", 205, 104) + text("OFF", 285, 48),
        400,
        400,
    )
    add("discount", "percent-burst", burst(RED, 16, 192, 150) + text("%", 200, 190, WHITE), 400, 400)
    add(
        "discount",
        "percent-tag",
        tag_shape(RED, hole=False) + circle(104, 200, 18, WHITE) + text("%", 200, 130, x=255),
        400,
        400,
    )
    add(
        "discount",
        "minus-percent",
        rect(10, 90, 380, 220, RED, 36) + text("-50%", 200, 120, max_width=320),
        400,
        400,
    )

    # ---- tags, coupons and cards ---------------------------------------------------------------------------------
    add("tags", "price-tag", tag_shape(RED), 400, 400)
    add(
        "tags",
        "price-tag-string",
        tag_shape(RED) + stroke("M104 200 C60 160 40 80 90 40", ROSE_DARK, 8),
        400,
        400,
    )
    ticket = (
        Outline()
        .M(10, 60)
        .L(390, 60)
        .L(390, 160)
        .A(40, 40, 0, 0, 390, 240)
        .L(390, 340)
        .L(10, 340)
        .L(10, 240)
        .A(40, 40, 0, 0, 10, 160)
        .Z()
    )
    add(
        "tags",
        "coupon-ticket",
        path(ticket, RED) + line(270, 76, 270, 324, WHITE, 5, stroke_dasharray="4 14") + text("%", 140, 120),
        400,
        400,
    )
    add(
        "tags",
        "coupon-dashed",
        rect(14, 70, 372, 260, "none", 24, stroke=RED, stroke_width=8, stroke_dasharray="26 16")
        + text("COUPON", 200, 64, RED),
        400,
        400,
    )
    add(
        "tags",
        "gift-card",
        rect(14, 70, 372, 260, RED, 28)
        + rect(14, 150, 372, 40, WHITE)
        + path(shifted(heart_path().scaled(0.9, 50, 49), 260, 201), WHITE),
        400,
        400,
    )
    add(
        "tags",
        "corner-ribbon",
        polygon([(80, 0), (200, 0), (0, 200), (0, 80)], RED) + word("SALE", 70, 70, 26, WHITE, 4, -45),
        200,
        200,
    )

    # ---- icons -------------------------------------------------------------------------------------------------------
    add(
        "icons",
        "shopping-bag",
        rect(60, 120, 280, 250, RED, 20)
        + stroke("M140 150 V110 A60 60 0 0 1 260 110 V150", RED, 18)
        + circle(140, 160, 12, WHITE)
        + circle(260, 160, 12, WHITE),
        400,
        400,
    )
    add(
        "icons",
        "shopping-cart",
        stroke("M30 50 H80 L120 270 H320 L350 120 H100", RED, 22)
        + circle(150, 330, 28, RED)
        + circle(300, 330, 28, RED),
        400,
        400,
    )
    add(
        "icons",
        "megaphone",
        polygon([(40, 150), (120, 150), (320, 50), (320, 310), (120, 230), (40, 230)], RED)
        + rect(80, 230, 60, 110, RED, 14)
        + stroke("M350 130 L384 110 M352 180 H392 M350 230 L384 250", ROSE_SOFT, 14),
        400,
        400,
    )
    add("icons", "lightning-bolt", path("M240 20 L90 220 H190 L150 380 L320 160 H220 Z", SUN), 400, 400)
    add(
        "icons",
        "countdown-clock",
        circle(C, C, 170, RED)
        + circle(C, C, 140, WHITE)
        + stroke("M200 110 V200 L260 240", RED, 20)
        + rect(170, 6, 60, 26, RED, 8),
        400,
        400,
    )
    add(
        "icons",
        "hourglass",
        path(
            "M90 30 H310 V80 C310 150 220 180 220 200 C220 220 310 250 310 320 V370 H90 V320 C90 250 180 220 180 200 C180 180 90 150 90 80 Z",
            RED,
        )
        + rect(70, 20, 260, 22, ROSE_DARK, 8)
        + rect(70, 358, 260, 22, ROSE_DARK, 8),
        400,
        400,
    )
    add(
        "icons",
        "party-popper",
        polygon([(40, 360), (120, 130), (270, 280)], RED)
        + stroke(
            "M170 120 C190 60 130 40 160 10 M240 150 C300 140 320 90 380 110 M290 220 C350 210 380 250 390 300",
            ROSE_SOFT,
            12,
        )
        + "".join(
            circle(x, y, 9, c)
            for x, y, c in ((230, 70, SUN), (310, 60, ROSE_DARK), (350, 170, SUN), (200, 20, RED))
        ),
        400,
        400,
    )
    add(
        "icons",
        "delivery-truck",
        rect(14, 110, 230, 180, RED, 14)
        + path("M244 150 H320 L388 220 V290 H244 Z", RED)
        + circle(100, 300, 36, WHITE, stroke=INK, stroke_width=14)
        + circle(310, 300, 36, WHITE, stroke=INK, stroke_width=14),
        400,
        340,
    )
    add(
        "icons",
        "gift-ribbon",
        rect(40, 160, 320, 210, RED, 14)
        + rect(20, 110, 360, 70, ROSE_DARK, 14)
        + rect(172, 110, 56, 260, SUN)
        + stroke(
            "M200 110 C150 30 90 60 130 100 C150 110 190 110 200 110 C210 110 250 110 270 100 C310 60 250 30 200 110",
            SUN,
            14,
        ),
        400,
        400,
    )
    add(
        "icons",
        "sparkle-stars",
        "".join(
            polygon(star_points(4, x, y, r, r / 3.2, -90), c)
            for x, y, r, c in ((140, 220, 110, RED), (290, 110, 60, SUN), (300, 300, 48, ROSE_SOFT))
        ),
        400,
        400,
    )
    add(
        "icons",
        "wallet-savings",
        rect(30, 90, 340, 240, RED, 36)
        + rect(250, 170, 130, 80, ROSE_DARK, 30)
        + circle(290, 210, 14, WHITE)
        + stroke("M70 90 L270 40 L290 90", RED, 18),
        400,
        400,
    )
