"""Version history: every edit through the MCP server keeps the state before it, so it can be undone."""

from __future__ import annotations

from typing import Annotated, Any

from pydantic import Field

from apps.apitokens.scopes import DESIGNS_READ, DESIGNS_WRITE
from apps.designs import services
from apps.designs.models import DesignVersion

from ..context import current
from ..registry import tool
from .designs import DesignId, _design, _info, _uuid


@tool(scope=DESIGNS_READ, title="List versions", read_only=True)
def list_versions(design_id: DesignId, limit: Annotated[int, Field(ge=1, le=100)] = 20) -> dict[str, Any]:
    """A design's saved versions, newest first (automatic snapshots and named ones)."""
    design = _design(design_id, document=False)
    versions = DesignVersion.objects.filter(design=design).defer("document").order_by("-created_at")[:limit]
    return {
        "versions": [
            {
                "id": str(v.pk),
                "label": v.label,
                "automatic": v.is_auto,
                "pages": v.page_count,
                "created_at": v.created_at.isoformat(),
            }
            for v in versions
        ]
    }


@tool(scope=DESIGNS_WRITE, title="Restore a version", destructive=True)
def restore_version(
    design_id: DesignId, version_id: Annotated[str, Field(description="From list_versions.")]
) -> dict[str, Any]:
    """Put a design back to a saved version (the current state is kept as a version first, so this can be
    undone too). Anyone with the design open sees it replaced."""
    design = _design(design_id, document=False)
    restored = services.restore_version(design.pk, _uuid(version_id), current().user)
    return _info(restored)
