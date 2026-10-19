"""Resources: designs addressable by URI, so clients can attach one to a conversation."""

from __future__ import annotations

from typing import Any

from apps.apitokens.scopes import DESIGNS_READ

from .registry import resource
from .tools.designs import _design, _with_summary


@resource("doory://designs/{design_id}", scope=DESIGNS_READ, title="Design")
def design_summary(design_id: str) -> dict[str, Any]:
    """A design's pages and objects, as get_design returns them."""
    return _with_summary(_design(design_id))
