"""Social Media: generic like, comment, share and profile glyphs and post layouts.

All of these are original drawings of everyday interface ideas (a heart, a speech bubble, a paper plane).
None of them copies or imitates the logo or the trademarked symbols of any service.
"""

# ruff: noqa: E501  (SVG path data and coordinates are written inline, one graphic per statement)

from __future__ import annotations

import math

from .kit import (
    AMBER,
    RED,
    ROSE_SOFT,
    SUN,
    WHITE,
    Collector,
    Outline,
    circle,
    defs,
    ellipse,
    heart_path,
    line,
    linear_gradient,
    n,
    path,
    polygon,
    rect,
    scallop_path,
    shifted,
    star_points,
    stroke,
)
from .lettering import word

S = 200


def heart(cx: float, cy: float, size: float) -> Outline:
    """The heart outline `size` wide, centred on `(cx, cy)`."""
    return shifted(heart_path().scaled(size / 88, 50, 49), cx - 50, cy - 49)


def person(cx: float, cy: float, size: float, color: str) -> str:
    """A head-and-shoulders silhouette about `size` tall."""
    head = circle(cx, cy - size * 0.2, size * 0.24, color)
    shoulders = path(
        f"M{n(cx - size * 0.42)} {n(cy + size * 0.5)} C{n(cx - size * 0.42)} {n(cy + size * 0.12)} {n(cx + size * 0.42)} {n(cy + size * 0.12)} {n(cx + size * 0.42)} {n(cy + size * 0.5)} Z",
        color,
    )
    return head + shoulders


def build(add: Collector) -> None:
    add("reactions", "like-heart", path(heart(100, 100, 150), RED), S, S)
    add("reactions", "like-heart-outline", stroke(heart(100, 100, 138), RED, 10), S, S)
    add(
        "reactions",
        "like-heart-burst",
        path(heart(100, 112, 104), RED)
        + "".join(
            line(*(*_polar(100, 112, 78, a), *_polar(100, 112, 98, a)), RED, 7)
            for a in (-150, -120, -90, -60, -30)
        ),
        S,
        S,
    )
    thumb = "M70 92 L100 22 C124 22 128 46 120 74 H168 C182 74 188 88 184 102 L172 160 C168 176 158 180 148 180 H70 Z"
    add("reactions", "thumbs-up", rect(22, 92, 40, 88, RED, 8) + path(thumb, RED), S, S)
    add(
        "reactions",
        "thumbs-up-outline",
        stroke("M22 92 H62 V180 H22 Z", RED, 9) + stroke(thumb, RED, 9),
        S,
        S,
    )
    add(
        "reactions",
        "reaction-smile",
        circle(100, 100, 82, RED)
        + circle(72, 84, 10, WHITE)
        + circle(128, 84, 10, WHITE)
        + stroke("M62 118 Q100 164 138 118", WHITE, 10),
        S,
        S,
    )
    add(
        "reactions",
        "reaction-wow",
        circle(100, 100, 82, RED)
        + circle(72, 84, 10, WHITE)
        + circle(128, 84, 10, WHITE)
        + ellipse(100, 134, 16, 20, WHITE),
        S,
        S,
    )
    add(
        "reactions",
        "reaction-stars",
        path(heart(100, 100, 60), RED)
        + "".join(
            polygon(star_points(4, x, y, r, r / 3.5, -90), SUN)
            for x, y, r in ((40, 44, 20), (160, 54, 16), (150, 150, 22), (46, 152, 14))
        ),
        S,
        S,
    )

    bubble = "M40 28 H160 C176 28 188 40 188 56 V118 C188 134 176 146 160 146 H98 L56 184 V146 H40 C24 146 12 134 12 118 V56 C12 40 24 28 40 28 Z"
    add(
        "actions",
        "comment-bubble",
        path(bubble, RED) + "".join(circle(x, 88, 11, WHITE) for x in (60, 100, 140)),
        S,
        S,
    )
    add("actions", "comment-bubble-outline", stroke(bubble, RED, 10), S, S)
    add(
        "actions",
        "share-nodes",
        line(52, 100, 146, 50, RED, 9)
        + line(52, 100, 146, 150, RED, 9)
        + circle(48, 100, 26, RED)
        + circle(150, 46, 26, RED)
        + circle(150, 154, 26, RED),
        S,
        S,
    )
    plane = polygon([(16, 94), (186, 14), (122, 186), (96, 112)], RED)
    add("actions", "send-plane", plane + line(96, 112, 186, 14, WHITE, 6), S, S)
    add("actions", "bookmark-save", path("M48 16 H152 V186 L100 144 L48 186 Z", RED), S, S)
    add("actions", "bookmark-outline", stroke("M48 16 H152 V186 L100 144 L48 186 Z", RED, 10), S, S)
    add(
        "actions",
        "repost-loop",
        stroke("M40 98 V82 Q40 52 70 52 H150", RED, 12)
        + polygon([(142, 22), (182, 52), (142, 82)], RED)
        + stroke("M160 102 V118 Q160 148 130 148 H50", RED, 12)
        + polygon([(58, 118), (18, 148), (58, 178)], RED),
        S,
        S,
    )
    add(
        "actions",
        "share-upload",
        stroke("M60 92 H46 V176 H154 V92 H140", RED, 11)
        + stroke("M100 130 V22", RED, 11)
        + stroke("M66 54 L100 20 L134 54", RED, 11),
        S,
        S,
    )
    add(
        "actions",
        "save-collection",
        rect(40, 70, 120, 100, RED, 14)
        + rect(56, 46, 88, 14, ROSE_SOFT, 6)
        + rect(72, 24, 56, 14, ROSE_SOFT, 6)
        + stroke("M72 118 H128", WHITE, 9),
        S,
        S,
    )
    add(
        "actions",
        "swipe-up",
        stroke("M56 112 L100 68 L144 112", RED, 14) + stroke("M56 160 L100 116 L144 160", ROSE_SOFT, 14),
        S,
        S,
    )
    add(
        "actions",
        "notification-bell",
        path("M100 20 C66 20 48 48 48 86 V118 L30 148 H170 L152 118 V86 C152 48 134 20 100 20 Z", RED)
        + path("M80 160 A20 20 0 0 0 120 160 Z", RED)
        + circle(150, 40, 20, SUN),
        S,
        S,
    )
    add(
        "actions",
        "mention-at",
        stroke("M100 148 A48 48 0 1 1 100 52 A48 48 0 0 1 148 100 V112 C148 130 118 130 118 106 V84", RED, 11)
        + circle(100, 100, 26, "none", stroke=RED, stroke_width=11),
        S,
        S,
    )
    add(
        "actions",
        "hashtag",
        stroke("M78 26 L62 174 M138 26 L122 174 M34 74 H176 M24 126 H166", RED, 13, stroke_linecap="round"),
        S,
        S,
    )
    add(
        "actions",
        "link-chain",
        stroke("M84 116 L116 84", RED, 14)
        + rect(18, 74, 86, 52, "none", 26, stroke=RED, stroke_width=14, transform="rotate(-45 61 100)")
        + rect(96, 74, 86, 52, "none", 26, stroke=RED, stroke_width=14, transform="rotate(-45 139 100)"),
        S,
        S,
    )

    add("profile", "profile-avatar", circle(100, 100, 88, RED) + person(100, 108, 120, WHITE), S, S)
    add(
        "profile",
        "profile-avatar-outline",
        circle(100, 100, 86, "none", stroke=RED, stroke_width=10) + person(100, 108, 110, RED),
        S,
        S,
    )
    add(
        "profile",
        "follow-person-plus",
        person(84, 100, 124, RED) + stroke("M152 62 V118 M124 90 H180", RED, 12),
        S,
        S,
    )
    add(
        "profile",
        "verified-check",
        path(scallop_path(100, 100, 84, 12, 0.55), RED) + stroke("M62 102 L90 130 L140 72", WHITE, 15),
        S,
        S,
    )
    ring = circle(100, 100, 82, "none", stroke="url(#ring)", stroke_width=12)
    add(
        "profile",
        "avatar-ring",
        defs(linear_gradient("ring", [(0, SUN, 1), (0.5, AMBER, 1), (1, RED, 1)], 0, 0, 1, 1))
        + ring
        + circle(100, 100, 62, ROSE_SOFT)
        + person(100, 106, 84, WHITE),
        S,
        S,
    )
    add(
        "profile",
        "live-broadcast",
        circle(100, 100, 26, RED)
        + stroke("M60 60 A56 56 0 0 0 60 140", RED, 12)
        + stroke("M140 60 A56 56 0 0 1 140 140", RED, 12)
        + stroke("M34 34 A92 92 0 0 0 34 166", ROSE_SOFT, 11)
        + stroke("M166 34 A92 92 0 0 1 166 166", ROSE_SOFT, 11),
        S,
        S,
    )
    add(
        "profile",
        "audience-views",
        stroke("M14 100 C46 48 154 48 186 100 C154 152 46 152 14 100 Z", RED, 11) + circle(100, 100, 26, RED),
        S,
        S,
    )
    add(
        "profile",
        "trending-up",
        stroke("M20 150 L76 94 L110 128 L176 54", RED, 13) + stroke("M132 52 H178 V98", RED, 13),
        S,
        S,
    )
    add(
        "profile",
        "location-pin",
        path("M100 184 C100 184 36 120 36 84 A64 64 0 0 1 164 84 C164 120 100 184 100 184 Z", RED)
        + circle(100, 84, 24, WHITE),
        S,
        S,
    )

    add(
        "media",
        "play-circle",
        circle(100, 100, 88, RED) + polygon([(80, 62), (146, 100), (80, 138)], WHITE),
        S,
        S,
    )
    add(
        "media",
        "video-camera",
        rect(14, 56, 118, 90, RED, 20) + polygon([(142, 84), (188, 56), (188, 146), (142, 118)], RED),
        S,
        S,
    )
    add(
        "media",
        "photo-camera",
        path(
            "M64 40 L78 22 H122 L136 40 H168 Q186 40 186 58 V148 Q186 166 168 166 H32 Q14 166 14 148 V58 Q14 40 32 40 Z",
            RED,
        )
        + circle(100, 104, 38, WHITE)
        + circle(100, 104, 22, RED),
        S,
        S,
    )
    add(
        "media",
        "music-note",
        path("M72 30 L158 14 V132 A32 26 0 1 1 142 106 V52 L88 62 V152 A32 26 0 1 1 72 126 Z", RED),
        S,
        S,
    )
    add(
        "media",
        "mail-envelope",
        rect(14, 36, 172, 128, RED, 16) + stroke("M26 52 L100 112 L174 52", WHITE, 10),
        S,
        S,
    )
    add(
        "media",
        "gift-box",
        rect(24, 78, 152, 100, RED, 10)
        + rect(14, 52, 172, 36, ROSE_SOFT, 8)
        + rect(88, 52, 24, 126, WHITE)
        + stroke(
            "M100 52 C76 14 44 24 66 48 C80 54 96 52 100 52 C104 52 120 54 134 48 C156 24 124 14 100 52",
            RED,
            9,
        ),
        S,
        S,
    )
    add(
        "media",
        "volume-speaker",
        polygon([(20, 78), (60, 78), (102, 40), (102, 160), (60, 122), (20, 122)], RED)
        + stroke("M130 74 Q152 100 130 126", RED, 11)
        + stroke("M150 52 Q192 100 150 148", RED, 11),
        S,
        S,
    )
    add(
        "media",
        "star-rating",
        "".join(
            polygon(star_points(5, 40 + 60 * i, 40, 26, 11, -90), RED if i < 4 else ROSE_SOFT)
            for i in range(5)
        ),
        320,
        80,
    )

    # ---- counters and layouts -------------------------------------------------------------------------------------
    add(
        "layouts",
        "like-counter",
        rect(10, 10, 240, 90, RED, 45) + path(heart(60, 55, 46), WHITE) + word("1.2K", 164, 55, 40, WHITE, 6),
        260,
        110,
    )
    add(
        "layouts",
        "follower-counter",
        rect(10, 10, 240, 90, RED, 45) + person(62, 54, 56, WHITE) + word("10K", 160, 55, 40, WHITE, 6),
        260,
        110,
    )
    add(
        "layouts",
        "comment-counter",
        rect(10, 10, 240, 90, RED, 45)
        + path(
            "M40 32 H86 Q96 32 96 42 V62 Q96 72 86 72 H66 L50 86 V72 H40 Q30 72 30 62 V42 Q30 32 40 32 Z",
            WHITE,
        )
        + word("348", 168, 55, 40, WHITE, 6),
        260,
        110,
    )
    post = (
        rect(10, 10, 300, 360, WHITE, 24, stroke=RED, stroke_width=6)
        + circle(52, 52, 24, RED)
        + rect(88, 38, 120, 12, RED, 6)
        + rect(88, 58, 78, 10, ROSE_SOFT, 5)
        + rect(28, 90, 264, 190, ROSE_SOFT, 12)
        + path(heart(50, 316, 34), RED)
        + circle(104, 316, 15, "none", stroke=RED, stroke_width=6)
        + polygon([(138, 304), (164, 316), (138, 328)], RED)
        + rect(214, 304, 70, 24, ROSE_SOFT, 12)
    )
    add("layouts", "post-frame", post, 320, 380)
    story = (
        rect(10, 10, 220, 390, WHITE, 36, stroke=RED, stroke_width=6)
        + rect(28, 28, 184, 8, ROSE_SOFT, 4)
        + rect(28, 28, 100, 8, RED, 4)
        + circle(50, 74, 18, RED)
        + rect(78, 66, 80, 10, RED, 5)
        + rect(28, 120, 184, 220, ROSE_SOFT, 16)
        + rect(40, 360, 160, 22, ROSE_SOFT, 11)
    )
    add("layouts", "story-frame", story, 240, 410)
    phone = (
        rect(10, 10, 160, 320, WHITE, 30, stroke=RED, stroke_width=8)
        + rect(62, 24, 56, 12, RED, 6)
        + rect(70, 304, 40, 6, RED, 3)
        + rect(30, 60, 120, 220, ROSE_SOFT, 12)
    )
    add("layouts", "phone-frame", phone, 180, 340)
    add(
        "layouts",
        "chat-screen",
        rect(10, 10, 300, 200, WHITE, 24, stroke=RED, stroke_width=6)
        + rect(34, 34, 150, 28, ROSE_SOFT, 14)
        + rect(126, 78, 150, 28, RED, 14)
        + rect(34, 122, 120, 28, ROSE_SOFT, 14)
        + rect(34, 166, 252, 24, WHITE, 12, stroke=RED, stroke_width=4),
        320,
        220,
    )


def _polar(cx: float, cy: float, radius: float, degrees: float) -> tuple[float, float]:
    return cx + radius * math.cos(math.radians(degrees)), cy + radius * math.sin(math.radians(degrees))
