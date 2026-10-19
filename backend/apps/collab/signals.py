"""Hooks that make rooms react at once to changes made through the HTTP API."""

from __future__ import annotations

import contextlib
import contextvars
from collections.abc import Iterator

from django.db import transaction
from django.db.models.signals import post_delete, post_save
from django.dispatch import receiver

from apps.designs.models import Design
from apps.sharing.models import ShareLink

from .notify import notify_design

_saving_from_room = contextvars.ContextVar("collab_saving_from_room", default=False)


@contextlib.contextmanager
def saving_from_room() -> Iterator[None]:
    """Mark Design saves made by a room itself, which must not echo back to rooms."""
    token = _saving_from_room.set(True)
    try:
        yield
    finally:
        _saving_from_room.reset(token)


@receiver(post_save, sender=Design, dispatch_uid="collab.design_saved")
def design_saved(sender, instance: Design, created: bool, update_fields, **kwargs) -> None:
    if created or _saving_from_room.get():
        return
    fields = set(update_fields) if update_fields is not None else None
    design_id, title = instance.pk, instance.title
    if fields is None or "title" in fields:
        transaction.on_commit(lambda: notify_design(design_id, "collab.title", title=title))
    if fields is None or "document" in fields or "trashed_at" in fields:
        transaction.on_commit(lambda: notify_design(design_id, "collab.recheck"))


@receiver(post_delete, sender=Design, dispatch_uid="collab.design_deleted")
def design_deleted(sender, instance: Design, **kwargs) -> None:
    design_id = instance.pk
    transaction.on_commit(lambda: notify_design(design_id, "collab.recheck"))


@receiver(post_save, sender=ShareLink, dispatch_uid="collab.link_saved")
@receiver(post_delete, sender=ShareLink, dispatch_uid="collab.link_deleted")
def link_changed(sender, instance: ShareLink, **kwargs) -> None:
    design_id = instance.design_id
    transaction.on_commit(lambda: notify_design(design_id, "collab.recheck"))
