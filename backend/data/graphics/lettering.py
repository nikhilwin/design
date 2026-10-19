"""A small monoline lettering set drawn as stroked paths (capitals, digits and a few symbols).

The promo and badge artwork needs words such as SALE, NEW and 50% but must not depend on any font being
installed, so the letters are drawn here as plain round-capped strokes on a 12-unit-high grid. They are
original geometric shapes made for this project. `word()` turns a string into one stroked `<path>`.
"""

from __future__ import annotations

import re

from .kit import attrs, n

HEIGHT = 12.0
GAP = 3.0

#: glyph -> (advance width in grid units, path data using absolute M L C H V Z / A commands)
GLYPHS: dict[str, tuple[float, str]] = {
    "A": (8, "M0 12 L4 0 L8 12 M1.6 8 H6.4"),
    "B": (8, "M0 0 V12 M0 0 H4 C7.8 0 7.8 6 4 6 H0 M4 6 C8.6 6 8.6 12 4 12 H0"),
    "C": (8, "M8 2.6 C5.5 -0.6 0 0 0 6 C0 12 5.5 12.6 8 9.4"),
    "D": (8, "M0 0 V12 H3 C9.6 12 9.6 0 3 0 Z"),
    "E": (8, "M8 0 H0 V12 H8 M0 6 H6"),
    "F": (8, "M8 0 H0 V12 M0 6 H6"),
    "G": (8, "M8 2.6 C5.5 -0.6 0 0 0 6 C0 12 6 12.6 8 10 V7 H4.5"),
    "H": (8, "M0 0 V12 M8 0 V12 M0 6 H8"),
    "I": (4, "M0 0 H4 M0 12 H4 M2 0 V12"),
    "J": (7, "M7 0 V8 C7 13 0.5 13 0 9"),
    "K": (8, "M0 0 V12 M8 0 L0 7 M3 5 L8 12"),
    "L": (7, "M0 0 V12 H7"),
    "M": (10, "M0 12 V0 L5 7.5 L10 0 V12"),
    "N": (8, "M0 12 V0 L8 12 V0"),
    "O": (9, "M4.5 0 C-1.5 0 -1.5 12 4.5 12 C10.5 12 10.5 0 4.5 0 Z"),
    "P": (8, "M0 12 V0 H4 C8.6 0 8.6 7 4 7 H0"),
    "Q": (9, "M4.5 0 C-1.5 0 -1.5 12 4.5 12 C10.5 12 10.5 0 4.5 0 Z M5.5 8 L9 12.5"),
    "R": (8, "M0 12 V0 H4 C8.6 0 8.6 7 4 7 H0 M4 7 L8 12"),
    "S": (8, "M8 2.2 C6.5 -0.6 0.4 -0.4 0.4 3.2 C0.4 7.2 8 5 8 9 C8 12.6 1.5 12.6 0 9.8"),
    "T": (8, "M0 0 H8 M4 0 V12"),
    "U": (8, "M0 0 V8 C0 13.6 8 13.6 8 8 V0"),
    "V": (8, "M0 0 L4 12 L8 0"),
    "W": (11, "M0 0 L2.7 12 L5.5 3.5 L8.3 12 L11 0"),
    "X": (8, "M0 0 L8 12 M8 0 L0 12"),
    "Y": (8, "M0 0 L4 6 L8 0 M4 6 V12"),
    "Z": (8, "M0 0 H8 L0 12 H8"),
    "0": (8, "M4 0 C-1.5 0 -1.5 12 4 12 C9.5 12 9.5 0 4 0 Z M2 10 L6 2"),
    "1": (5, "M0 3 L3 0 V12"),
    "2": (8, "M0.5 3 C1 -0.6 8 -0.6 7.6 3.6 C7.6 6.6 0.6 9 0 12 H8"),
    "3": (8, "M0.5 1.6 C3 -0.6 8 0 7.6 3.6 C7.6 6 5 6 3.5 6 C8.6 6 8.6 12.6 4 12 C2 12 1 11.6 0 10.6"),
    "4": (8, "M6 12 V0 L0 8.6 H8.6"),
    "5": (8, "M7.6 0 H1 L0.5 5.6 C5 3.6 8.6 6 8.6 8.6 C8.6 12.6 2 12.6 0 10.6"),
    "6": (8, "M7 1 C3 -0.6 0 3 0 7 C0 14 8.6 13 8.6 8.6 C8.6 4.6 3 4.6 0.3 8"),
    "7": (8, "M0 0 H8 L3 12"),
    "8": (8, "M4 6 C-1 6 -1 0 4 0 C9 0 9 6 4 6 C-1.6 6 -1.6 12 4 12 C9.6 12 9.6 6 4 6 Z"),
    "9": (8, "M1.6 11 C5.6 12.6 8.6 9 8.6 5 C8.6 -2 0 -1 0 3.4 C0 7.4 5.6 7.4 8.2 4"),
    "%": (
        10,
        "M9.2 0.4 L0.8 11.6 "
        "M3.6 2.4 A1.8 1.8 0 1 0 0 2.4 A1.8 1.8 0 1 0 3.6 2.4 "
        "M10 9.6 A1.8 1.8 0 1 0 6.4 9.6 A1.8 1.8 0 1 0 10 9.6",
    ),
    "!": (2, "M1 0 V8 M1 11.4 V11.6"),
    "?": (7, "M0.4 3 C0.6 -0.8 7 -0.6 7 3.2 C7 6.4 3.5 6.2 3.5 8.6 M3.5 11.4 V11.6"),
    "$": (8, "M8 2.2 C6.5 -0.6 0.4 -0.4 0.4 3.2 C0.4 7.2 8 5 8 9 C8 12.6 1.5 12.6 0 9.8 M4 -1.6 V13.6"),
    "+": (8, "M4 3 V9 M1 6 H7"),
    "-": (6, "M0 6 H6"),
    ".": (2, "M1 11.4 V11.6"),
    ",": (2, "M1 11.4 L0 13.4"),
    "&": (9, "M8.6 12 L2 4 C0.6 2 2 0 4 0 C6 0 7 2.4 5.6 4.4 L1.6 9.4 C0 12 4 13 6 10.6 L8.8 7"),
    " ": (5, ""),
}

_TOKEN = re.compile(r"[A-Za-z]|-?\d+(?:\.\d+)?")


def _transform(data: str, x0: float, y0: float, scale: float) -> str:
    """Scale and move absolute path data (flags and rotation of `A` commands are left alone)."""
    out: list[str] = []
    command, index = "", 0
    for token in _TOKEN.findall(data):
        if token.isalpha():
            command, index = token, 0
            out.append(token)
            continue
        value = float(token)
        if command == "A":
            slot = index % 7
            if slot in (0, 1):
                value *= scale
            elif slot == 5:
                value = x0 + value * scale
            elif slot == 6:
                value = y0 + value * scale
            elif slot in (2, 3, 4):
                out.append(token)
                index += 1
                continue
        elif command == "H":
            value = x0 + value * scale
        elif command == "V":
            value = y0 + value * scale
        else:
            value = (x0 if index % 2 == 0 else y0) + value * scale
        out.append(n(value))
        index += 1
    return " ".join(out).replace(" Z", "Z")


def text_width(text: str, height: float) -> float:
    scale = height / HEIGHT
    advances = [GLYPHS[ch][0] for ch in text]
    return (sum(advances) + GAP * (len(advances) - 1)) * scale if advances else 0.0


def word(
    text: str, cx: float, cy: float, height: float, color: str, weight: float | None = None, rotate: float = 0
) -> str:
    """`text` (capitals, digits, some symbols) centred on `(cx, cy)` as one stroked path, turned `rotate`°."""
    text = text.upper()
    unknown = [ch for ch in text if ch not in GLYPHS]
    if unknown:
        raise ValueError(f"no lettering for {unknown!r}")
    scale = height / HEIGHT
    x = cx - text_width(text, height) / 2
    top = cy - height / 2
    parts = []
    for ch in text:
        advance, data = GLYPHS[ch]
        if data:
            parts.append(_transform(data, x, top, scale))
        x += (advance + GAP) * scale
    width = weight if weight is not None else max(1.6, 2.4 * scale)
    return (
        f'<path d="{" ".join(parts)}" fill="none"'
        f"{attrs(stroke=color, stroke_width=width, stroke_linecap='round', stroke_linejoin='round')}"
        f"{attrs(transform=f'rotate({n(rotate)} {n(cx)} {n(cy)})' if rotate else None)}/>"
    )
