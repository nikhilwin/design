"""Generate Doory's original graphics (backgrounds, badges, dividers, bubbles, social glyphs, promo badges,
charts and doodles): original SVG artwork released under CC0-1.0.

Usage:  python generate_graphics.py <target-dir>

Writes `<target-dir>/<set>/<folder>/<name>.svg`. The same artwork is what `manage.py sync_element_packs` (and
`seed_elements`) imports into the catalogue, so running this by hand is only needed to look at the files.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from graphics import generate


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    files = generate(Path(argv[1]))
    print(f"Wrote {len(files)} SVG files to {argv[1]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
