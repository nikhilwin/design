"""Folder tree rules: depth limit, cycle prevention, per-parent unique names, delete-and-reparent."""

from __future__ import annotations

from uuid import UUID

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.db.models.functions import Lower
from rest_framework.exceptions import ValidationError

from apps.assets.exceptions import LimitReached

from .models import Design, Folder

MAX_FOLDER_DEPTH = 5
MAX_FOLDERS_PER_USER = 500
MAX_NAME_LENGTH = 120

ParentMap = dict[UUID, UUID | None]


def _parent_map(owner) -> ParentMap:
    return dict(Folder.objects.filter(owner=owner).values_list("id", "parent_id"))


def _chain_to_root(parents: ParentMap, folder_id: UUID | None) -> list[UUID]:
    """`folder_id` followed by each ancestor, nearest first (loop-safe)."""
    chain: list[UUID] = []
    seen: set[UUID] = set()
    while folder_id is not None and folder_id not in seen:
        chain.append(folder_id)
        seen.add(folder_id)
        folder_id = parents.get(folder_id)
    return chain


def _subtree_height(parents: ParentMap, root: UUID) -> int:
    children: dict[UUID, list[UUID]] = {}
    for child, parent in parents.items():
        if parent is not None:
            children.setdefault(parent, []).append(child)
    height, frontier, seen = 0, [root], {root}
    while frontier:
        height += 1
        frontier = [c for node in frontier for c in children.get(node, []) if c not in seen]
        seen.update(frontier)
    return height


def check_placement(owner, folder: Folder | None, parent: Folder | None) -> None:
    """Ensure `folder` (None = a new, childless folder) may live under `parent` (None = top level)."""
    parents = _parent_map(owner)
    if parent is not None and folder is not None and folder.id in _chain_to_root(parents, parent.id):
        raise ValidationError({"parent": ["A folder cannot be moved into itself or one of its subfolders."]})
    above = len(_chain_to_root(parents, parent.id)) if parent is not None else 0
    below = _subtree_height(parents, folder.id) if folder is not None else 1
    if above + below > MAX_FOLDER_DEPTH:
        raise ValidationError({"parent": [f"Folders can be nested at most {MAX_FOLDER_DEPTH} levels deep."]})


def _name_taken(owner, parent_id: UUID | None, name: str, exclude_id: UUID | None = None) -> bool:
    siblings = Folder.objects.filter(owner=owner, parent_id=parent_id).annotate(lowered=Lower("name"))
    if exclude_id is not None:
        siblings = siblings.exclude(pk=exclude_id)
    return siblings.filter(lowered=name.lower()).exists()


def _duplicate_name_error() -> ValidationError:
    return ValidationError({"name": ["A folder with this name already exists here."]})


def _lock_owner(owner) -> None:
    get_user_model().objects.select_for_update().get(pk=owner.pk)


def create_folder(owner, *, name: str, parent: Folder | None) -> Folder:
    with transaction.atomic():
        _lock_owner(owner)
        if Folder.objects.filter(owner=owner).count() >= MAX_FOLDERS_PER_USER:
            raise LimitReached(f"You can have at most {MAX_FOLDERS_PER_USER} folders.")
        check_placement(owner, None, parent)
        if _name_taken(owner, parent.id if parent else None, name):
            raise _duplicate_name_error()
        try:
            with transaction.atomic():
                return Folder.objects.create(owner=owner, name=name, parent=parent)
        except IntegrityError as exc:
            raise _duplicate_name_error() from exc


def update_folder(owner, folder: Folder, data: dict) -> Folder:
    with transaction.atomic():
        _lock_owner(owner)
        name = data.get("name", folder.name)
        parent_id = folder.parent_id
        if "parent" in data:
            parent_id = data["parent"].id if data["parent"] else None
        if parent_id != folder.parent_id:
            check_placement(owner, folder, data["parent"])
        if _name_taken(owner, parent_id, name, exclude_id=folder.id):
            raise _duplicate_name_error()
        folder.name, folder.parent_id = name, parent_id
        try:
            with transaction.atomic():
                folder.save(update_fields=["name", "parent", "updated_at"])
        except IntegrityError as exc:
            raise _duplicate_name_error() from exc
    return folder


def _free_name(name: str, taken: set[str]) -> str:
    candidate, counter = name, 1
    while candidate.lower() in taken:
        counter += 1
        suffix = f" ({counter})"
        candidate = f"{name[: MAX_NAME_LENGTH - len(suffix)]}{suffix}"
    return candidate


def delete_folder(owner, folder: Folder) -> None:
    """Delete `folder`; its subfolders and designs move up to its parent (renaming on a name clash)."""
    with transaction.atomic():
        _lock_owner(owner)
        destination = folder.parent_id
        taken = {
            name.lower()
            for name in Folder.objects.filter(owner=owner, parent_id=destination)
            .exclude(pk=folder.pk)
            .values_list("name", flat=True)
        }
        for child in Folder.objects.filter(parent=folder).order_by(Lower("name"), "pk"):
            child.name = _free_name(child.name, taken)
            taken.add(child.name.lower())
            child.parent_id = destination
            child.save(update_fields=["name", "parent", "updated_at"])
        Design.objects.filter(folder=folder).update(folder_id=destination)
        folder.delete()
