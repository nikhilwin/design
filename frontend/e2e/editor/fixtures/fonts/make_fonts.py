"""Builds the tiny test fonts used by the font specs (`e2e/editor/fonts*.spec.ts`) with fontTools.

Every glyph is a plain geometric shape, so text set in these fonts is unmistakable in a screenshot or a
pixel check (solid blocks and diamonds instead of letters). The files are generated, contain no third-party
outlines and are released under CC0.

    python make_fonts.py        # rewrites the .ttf / .woff2 files next to this script
"""

from __future__ import annotations

import string
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

HERE = Path(__file__).parent
FIXED_TIME = 3786912000  # 2024-01-01 in the font epoch: the same bytes on every run
CHARS = string.printable.strip("\x0b\x0c\t\r\n")  # printable ASCII with the space kept


def shape(kind: str, width: int, height: int):
    pen = TTGlyphPen(None)
    if kind == "block":
        points = [(0, 0), (0, height), (width, height), (width, 0)]
    elif kind == "slant":
        points = [(0, 0), (160, height), (width + 160, height), (width, 0)]
    else:  # "diamond"
        points = [(width // 2, 0), (0, height // 2), (width // 2, height), (width, height // 2)]
    pen.moveTo(points[0])
    for point in points[1:]:
        pen.lineTo(point)
    pen.closePath()
    return pen.glyph()


def build(
    path: Path,
    family: str,
    style: str,
    weight: int,
    kind: str,
    width: int,
    height: int,
    flavor: str | None = None,
) -> None:
    names = [".notdef", *(f"uni{ord(c):04X}" for c in CHARS)]
    builder = FontBuilder(1000, isTTF=True)
    builder.setupGlyphOrder(names)
    builder.setupCharacterMap({ord(c): f"uni{ord(c):04X}" for c in CHARS})
    glyph = shape(kind, width, height)
    builder.setupGlyf(dict.fromkeys(names, glyph))
    builder.setupHorizontalMetrics(dict.fromkeys(names, (width + 120, 0)))
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable({"familyName": family, "styleName": style})
    italic = "Italic" in style
    builder.setupOS2(usWeightClass=weight, fsSelection=0x01 if italic else (0x20 if weight >= 700 else 0x40))
    builder.setupPost(italicAngle=-12 if italic else 0)
    builder.updateHead(created=FIXED_TIME, modified=FIXED_TIME)
    font = builder.font
    font["head"].macStyle = (1 if weight >= 700 else 0) | (2 if italic else 0)
    if flavor:
        font.flavor = flavor
    font.save(path)


build(HERE / "DooryBlocks-Regular.ttf", "Doory Blocks", "Regular", 400, "block", 480, 700)
build(HERE / "DooryBlocks-Bold.ttf", "Doory Blocks", "Bold", 700, "block", 600, 700)
build(HERE / "DooryBlocks-Italic.ttf", "Doory Blocks", "Italic", 400, "slant", 480, 700)
build(
    HERE / "DooryDiamonds-Regular.woff2",
    "Doory Diamonds",
    "Regular",
    400,
    "diamond",
    560,
    700,
    flavor="woff2",
)
