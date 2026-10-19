"""Doory's original graphics: eight sets of deterministic, CC0-licensed SVG artwork generated from code.

`render(set_id)` returns `{"<folder>/<name>.svg": svg text}` for one set; `generate(target)` writes every set
below `target/<set id>/`. Nothing here is derived from third-party artwork. Run
`python generate_graphics.py <dir>` from the parent folder to write the files by hand.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from . import badges, bubbles, charts, dividers, doodles, patterns, promo, social
from .kit import Collector

#: set id -> the module that draws it (its `build(add)` calls `add(folder, name, svg body, width, height)`).
SETS: dict[str, Callable[[Collector], None]] = {
    "backgrounds-patterns": patterns.build,
    "frames-badges": badges.build,
    "dividers-borders": dividers.build,
    "speech-bubbles": bubbles.build,
    "social-media": social.build,
    "sale-promo": promo.build,
    "charts": charts.build,
    "doodle-accents": doodles.build,
}


def render(set_id: str) -> dict[str, str]:
    """Every graphic of one set as `{folder/name.svg: svg}`; `KeyError` for an unknown set."""
    collector = Collector(set_id)
    SETS[set_id](collector)
    return {f"{item.folder}/{item.name}.svg": item.svg() for item in collector.items}


def generate(target: Path) -> list[Path]:
    """Write all sets to `target/<set id>/<folder>/<name>.svg`; returns the written paths."""
    written = []
    for set_id in SETS:
        for relative, svg in render(set_id).items():
            file = target / set_id / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(svg, encoding="utf-8")
            written.append(file)
    return written
