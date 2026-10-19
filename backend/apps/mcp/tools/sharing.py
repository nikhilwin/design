"""Share links let anyone who has one view, comment on or edit a design, so they need a scope of their own."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from django.shortcuts import get_object_or_404
from pydantic import Field

from apps.apitokens.scopes import SHARING_WRITE
from apps.sharing.models import ShareLink
from apps.sharing.serializers import ShareLinkCreateSerializer, ShareLinkSerializer, ShareLinkUpdateSerializer
from apps.sharing.services import create_link, update_link

from ..context import current
from ..registry import tool
from .designs import DesignId, _design, _uuid

LinkId = Annotated[str, Field(description="A share link id from list_share_links.")]
Role = Literal["view", "comment", "edit"]
Expiry = Annotated[
    datetime | None, Field(description="When the link stops working (ISO 8601). Default: never.")
]
Password = Annotated[
    str | None, Field(description="Ask visitors for this password (printable ASCII).", max_length=128)
]


def _link(link: ShareLink) -> dict[str, Any]:
    return dict(ShareLinkSerializer(link).data)


def _owned_link(design_id: str, link_id: str) -> ShareLink:
    design = _design(design_id, document=False)
    return get_object_or_404(ShareLink, design=design, pk=_uuid(link_id))


@tool(scope=SHARING_WRITE, title="List share links", read_only=True)
def list_share_links(design_id: DesignId) -> dict[str, Any]:
    """A design's share links, newest first, with their URL, role and whether they still work."""
    design = _design(design_id, document=False)
    links = ShareLink.objects.filter(design=design).order_by("-created_at", "id")
    return {"share_links": [_link(link) for link in links]}


# Creating or changing a link can let people outside the account in, so both are marked destructive: clients
# ask the user before running them.
@tool(scope=SHARING_WRITE, title="Create a share link", destructive=True)
def create_share_link(
    design_id: DesignId,
    role: Annotated[Role, Field(description="What people with the link may do.")] = "view",
    expires_at: Expiry = None,
    password: Password = None,
) -> dict[str, Any]:
    """Create a link that lets anyone who has it view, comment on or edit the design (no account needed).
    Prefer `view` unless the user asked for more."""
    design = _design(design_id, document=False)
    data = {"role": role, "expires_at": expires_at, "password": password}
    serializer = ShareLinkCreateSerializer(
        data={key: value for key, value in data.items() if value is not None}
    )
    serializer.is_valid(raise_exception=True)
    return _link(create_link(design, serializer, current().user))


@tool(scope=SHARING_WRITE, title="Change a share link", destructive=True, idempotent=True)
def update_share_link(
    design_id: DesignId,
    link_id: LinkId,
    role: Role | None = None,
    active: Annotated[bool | None, Field(description="false pauses the link; true turns it back on.")] = None,
    expires_at: Annotated[
        datetime | Literal["never"] | None,
        Field(description='A new expiry (ISO 8601), or "never" to remove it.'),
    ] = None,
    password: Annotated[
        str | None, Field(description='A new password; "" removes it.', max_length=128)
    ] = None,
) -> dict[str, Any]:
    """Change a share link. Only what you pass changes."""
    link = _owned_link(design_id, link_id)
    data = {"role": role, "is_active": active, "expires_at": expires_at, "password": password}
    data = {key: value for key, value in data.items() if value is not None}
    if data.get("expires_at") == "never":
        data["expires_at"] = None  # here None clears the field; leaving it out keeps it
    serializer = ShareLinkUpdateSerializer(link, data=data, partial=True)
    serializer.is_valid(raise_exception=True)
    return _link(update_link(link, serializer))


@tool(scope=SHARING_WRITE, title="Revoke a share link", destructive=True, idempotent=True)
def revoke_share_link(design_id: DesignId, link_id: LinkId) -> dict[str, Any]:
    """Delete a share link: it stops working at once for everyone who has it."""
    _owned_link(design_id, link_id).delete()
    return {"id": link_id, "revoked": True}
