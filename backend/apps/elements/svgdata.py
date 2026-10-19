"""The single path every element SVG goes through before it is stored."""

from __future__ import annotations

from dataclasses import dataclass

from apps.core.svg import sanitize_svg, svg_colors, svg_info


@dataclass(frozen=True)
class ProcessedSvg:
    data: bytes
    width: float
    height: float
    colors: list[str]

    @property
    def is_recolorable(self) -> bool:
        return bool(self.colors)


def process_svg(raw: bytes) -> ProcessedSvg:
    """Sanitise `raw` and extract size and palette; `apps.core.svg.SvgError` for unsafe/invalid input."""
    clean = sanitize_svg(raw)
    info = svg_info(clean)
    return ProcessedSvg(data=clean, width=info.width, height=info.height, colors=svg_colors(clean))
