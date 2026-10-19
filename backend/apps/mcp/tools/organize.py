"""Tools to organise designs: folders, stars and the trash (trashed designs can be restored)."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Annotated, Any

from django.shortcuts import get_object_or_404
from pydantic import Field

from apps.apitokens.scopes import DESIGNS_READ, DESIGNS_TRASH, DESIGNS_WRITE
from apps.designs import folders, services
from apps.designs.models import Design, Folder
from apps.designs.serializers import FolderWriteSerializer

from ..context import current
from ..registry import tool
from .designs import DesignId, _design, _info, _uuid

FolderId = Annotated[str, Field(description="A folder id from list_folders.")]
ParentId = Annotated[str | None, Field(description="A folder from list_folders; none = top level.")]


def _folder(folder_id: str) -> Folder:
    return get_object_or_404(Folder, owner=current().user, pk=_uuid(folder_id))


def _folder_info(folder: Folder) -> dict[str, Any]:
    return {
        "id": str(folder.pk),
        "name": folder.name,
        "parent_id": str(folder.parent_id) if folder.parent_id else None,
    }


def _folder_data(**data: Any) -> dict[str, Any]:
    """Validate like the REST API (names cleaned, parents must be the caller's)."""
    body = FolderWriteSerializer(
        data=data, partial=True, context={"request": SimpleNamespace(user=current().user)}
    )
    body.is_valid(raise_exception=True)
    return dict(body.validated_data)


@tool(scope=DESIGNS_READ, title="List folders", read_only=True)
def list_folders() -> dict[str, Any]:
    """Your folders, by name. A folder with a parent_id is inside that folder."""
    rows = Folder.objects.filter(owner=current().user).order_by("name", "id")
    return {"folders": [_folder_info(folder) for folder in rows]}


@tool(scope=DESIGNS_WRITE, title="Create a folder")
def create_folder(
    name: Annotated[str, Field(min_length=1, max_length=120)], parent_id: ParentId = None
) -> dict[str, Any]:
    """Create a folder, at the top level or inside another folder."""
    data = _folder_data(name=name, parent=parent_id)
    return _folder_info(folders.create_folder(current().user, name=data["name"], parent=data.get("parent")))


@tool(scope=DESIGNS_WRITE, title="Rename a folder", idempotent=True)
def rename_folder(
    folder_id: FolderId, name: Annotated[str, Field(min_length=1, max_length=120)]
) -> dict[str, Any]:
    """Change a folder's name."""
    folder = _folder(folder_id)
    return _folder_info(folders.update_folder(current().user, folder, _folder_data(name=name)))


@tool(scope=DESIGNS_WRITE, title="Move a folder", idempotent=True)
def move_folder(folder_id: FolderId, parent_id: ParentId) -> dict[str, Any]:
    """Put a folder inside another folder, or back at the top level."""
    folder = _folder(folder_id)
    return _folder_info(folders.update_folder(current().user, folder, _folder_data(parent=parent_id)))


@tool(scope=DESIGNS_WRITE, title="Delete a folder", destructive=True)
def delete_folder(folder_id: FolderId) -> dict[str, Any]:
    """Delete a folder. Nothing in it is deleted: its designs and subfolders move up to its parent."""
    folder = _folder(folder_id)
    folders.delete_folder(current().user, folder)
    return {"id": folder_id, "deleted": True}


@tool(scope=DESIGNS_WRITE, title="Move a design to a folder", idempotent=True)
def move_design(
    design_id: DesignId,
    folder_id: Annotated[str | None, Field(description="A folder from list_folders; none = top level.")],
) -> dict[str, Any]:
    """Put a design in a folder, or back at the top level."""
    design = _design(design_id, document=False)
    folder = _folder(folder_id) if folder_id else None
    services.bulk_apply(current().user, [design.pk], "move", folder)
    return _info(Design.objects.defer("document").get(pk=design.pk))


@tool(scope=DESIGNS_WRITE, title="Star a design", idempotent=True)
def star_design(design_id: DesignId, starred: bool = True) -> dict[str, Any]:
    """Star a design (or unstar it with starred = false); list_designs can filter on stars."""
    design = _design(design_id, document=False)
    services.bulk_apply(current().user, [design.pk], "star" if starred else "unstar", None)
    return _info(Design.objects.defer("document").get(pk=design.pk))


@tool(scope=DESIGNS_TRASH, title="Move a design to the trash", destructive=True, idempotent=True)
def trash_design(design_id: DesignId) -> dict[str, Any]:
    """Move a design to the trash. It can be brought back with restore_design until the trash is emptied."""
    design = _design(design_id, document=False)
    services.trash_design(design.pk, current().user)
    return {"id": str(design.pk), "trashed": True}


@tool(scope=DESIGNS_TRASH, title="Restore a design from the trash", idempotent=True)
def restore_design(
    design_id: Annotated[str, Field(description="A design id from list_designs(in_trash=true).")],
) -> dict[str, Any]:
    """Bring a trashed design back."""
    design = services.restore_trashed(_design(design_id, document=False, trashed=True))
    return _info(design)
