"""Stand-alone font probe, run as `python -I probe_worker.py` with the font bytes on stdin.

Parsing untrusted binary fonts is the riskiest part of accepting uploads: a crafted WOFF/WOFF2 can
decompress to gigabytes and a malformed table can make a parser spin. The web process therefore never
parses user fonts itself. This script does, in a throw-away interpreter with hard CPU and memory limits (the
parent also enforces a wall-clock timeout), and prints one JSON object: either `{"error": "..."}` or the
facts the catalog needs. It imports nothing from Django.
"""

from __future__ import annotations

import io
import json
import sys

MEMORY_LIMIT_BYTES = 1024 * 1024 * 1024
CPU_LIMIT_SECONDS = 10
MAX_NAME_CHARS = 200

# Representative code points a font must cover (>= the given share) to be listed for a script.
SCRIPT_PROBES: dict[str, tuple[range, float]] = {
    "latin": (range(0x41, 0x5B), 0.95),
    "latin-ext": (range(0x100, 0x180), 0.5),
    "cyrillic": (range(0x410, 0x450), 0.9),
    "greek": (range(0x3B1, 0x3CA), 0.9),
    "devanagari": (range(0x905, 0x93A), 0.7),
    "bengali": (range(0x985, 0x9BA), 0.6),
    "arabic": (range(0x621, 0x64B), 0.7),
    "hebrew": (range(0x5D0, 0x5EB), 0.9),
    "thai": (range(0xE01, 0xE3B), 0.8),
    "japanese": (range(0x3041, 0x3097), 0.9),
    "korean": (range(0xAC00, 0xD7A4, 97), 0.8),
    "chinese": (range(0x4E00, 0x9FA6, 389), 0.8),
}


def limit_resources() -> None:
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT_BYTES, MEMORY_LIMIT_BYTES))
        resource.setrlimit(resource.RLIMIT_CPU, (CPU_LIMIT_SECONDS, CPU_LIMIT_SECONDS))
    except (ImportError, ValueError, OSError):
        pass  # not available on this platform; the parent's timeout still applies


def clip(value: object) -> str | None:
    return str(value)[:MAX_NAME_CHARS] if value else None


def category_hint(font) -> str:
    post, os2 = font.get("post"), font.get("OS/2")
    if post is not None and getattr(post, "isFixedPitch", 0):
        return "monospace"
    panose = getattr(os2, "panose", None)
    family_type = getattr(panose, "bFamilyType", 0)
    if family_type == 3:
        return "handwriting"
    if family_type == 4:
        return "display"
    if family_type == 2 and 3 <= getattr(panose, "bSerifStyle", 0) <= 10:
        return "serif"
    return "sans-serif"


def weight_and_style(font) -> tuple[int, bool]:
    os2, head, post = font.get("OS/2"), font.get("head"), font.get("post")
    weight = int(getattr(os2, "usWeightClass", 0) or 0)
    mac_style = int(getattr(head, "macStyle", 0) or 0)
    if not 1 <= weight <= 1000:
        weight = 700 if mac_style & 1 else 400
    weight = min(900, max(100, round(weight / 100) * 100))
    italic = bool((getattr(os2, "fsSelection", 0) & 1) or (mac_style & 2) or getattr(post, "italicAngle", 0))
    return weight, italic


def probe(data: bytes) -> dict:
    from fontTools.ttLib import TTFont

    font = TTFont(io.BytesIO(data), lazy=True, recalcBBoxes=False, recalcTimestamp=False)
    if not any(tag in font for tag in ("glyf", "CFF ", "CFF2")):
        return {"error": "The font has no vector outlines."}
    name_table = font["name"]
    family = clip(name_table.getBestFamilyName())
    cmap = font.getBestCmap() or {}
    if not cmap:
        return {"error": "The font has no character map."}
    weight, italic = weight_and_style(font)
    scripts = [
        script
        for script, (codes, share) in SCRIPT_PROBES.items()
        if sum(code in cmap for code in codes) >= share * len(codes)
    ]
    return {
        "family": family,
        "subfamily": clip(name_table.getBestSubFamilyName()),
        "weight": weight,
        "italic": italic,
        "is_variable": "fvar" in font,
        "scripts": scripts,
        "category": category_hint(font),
        "glyphs": int(font["maxp"].numGlyphs),
    }


def main() -> int:
    limit_resources()
    data = sys.stdin.buffer.read()
    try:
        result = probe(data)
    except MemoryError:
        result = {"error": "The font is too large to read."}
    except Exception:  # parsers raise many unrelated types on corrupt input
        result = {"error": "The file could not be parsed as a font."}
    sys.stdout.write(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
