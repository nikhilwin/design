"""Build tiny but real font files for tests (no binary fixtures in the repo)."""

from __future__ import annotations

import string
from io import BytesIO

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.ttGlyphPen import TTGlyphPen

LATIN = string.ascii_letters
CYRILLIC = "".join(chr(code) for code in range(0x410, 0x450))


def make_font(
    family: str | None = "Test Sans",
    *,
    weight: int = 400,
    italic: bool = False,
    flavor: str | None = None,
    chars: str = LATIN,
    outlines: str = "glyf",
    fixed_pitch: bool = False,
    style_name: str = "Regular",
) -> bytes:
    """A valid font containing one square glyph for every character in `chars`.

    `flavor` may be "woff" or "woff2"; `outlines` is "glyf" (TrueType), "cff" (OpenType/CFF) or "none".
    `family=None` leaves the name table without a family name.
    """
    names = [".notdef", *(f"uni{ord(c):04X}" for c in chars)]
    builder = FontBuilder(1000, isTTF=outlines != "cff")
    builder.setupGlyphOrder(names)
    builder.setupCharacterMap({ord(c): f"uni{ord(c):04X}" for c in chars})
    if outlines == "glyf":
        pen = TTGlyphPen(None)
        pen.moveTo((0, 0))
        pen.lineTo((0, 500))
        pen.lineTo((500, 500))
        pen.lineTo((500, 0))
        pen.closePath()
        builder.setupGlyf(dict.fromkeys(names, pen.glyph()))
    elif outlines == "cff":
        charstrings = {}
        for name in names:
            cff_pen = T2CharStringPen(600, None)
            cff_pen.moveTo((0, 0))
            cff_pen.lineTo((0, 500))
            cff_pen.lineTo((500, 500))
            cff_pen.lineTo((500, 0))
            cff_pen.closePath()
            charstrings[name] = cff_pen.getCharString()
        builder.setupCFF("TestFont-Regular", {"FullName": f"{family} {style_name}"}, charstrings, {})
    builder.setupHorizontalMetrics(dict.fromkeys(names, (600, 0)))
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    name_strings = {"styleName": style_name}
    if family is not None:
        name_strings["familyName"] = family
    builder.setupNameTable(name_strings)
    builder.setupOS2(usWeightClass=weight, fsSelection=0x01 if italic else 0x40)
    builder.setupPost(isFixedPitch=1 if fixed_pitch else 0, italicAngle=-12 if italic else 0)
    font = builder.font
    font["head"].macStyle = (1 if weight >= 700 else 0) | (2 if italic else 0)
    if flavor:
        font.flavor = flavor
    buffer = BytesIO()
    font.save(buffer)
    return buffer.getvalue()
