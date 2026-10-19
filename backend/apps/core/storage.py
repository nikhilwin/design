"""Helpers that keep file storage in sync with the database.

Django never deletes the files behind a `FileField`/`ImageField`. Register
`delete_files_on_delete(Model, "field", …)` (for example from `AppConfig.ready`) and the files are
removed from storage once the row's deletion has been committed — including rows removed by a
cascade. Use `delete_file_after_commit` to drop a file that has just been replaced.
"""

from __future__ import annotations

import logging
from functools import partial

from django.core.files.storage import Storage
from django.db import transaction
from django.db.models import Model
from django.db.models.signals import post_delete
from django.dispatch import receiver

logger = logging.getLogger(__name__)


def _remove(storage: Storage, name: str) -> None:
    try:
        storage.delete(name)
    except Exception:  # storage backends raise many types; a stale file must never break a request
        logger.warning("Could not delete stored file %r", name, exc_info=True)


def delete_file_after_commit(storage: Storage, name: str | None) -> None:
    """Delete `name` from `storage` when the surrounding transaction commits (now, if there is none)."""
    if name:
        transaction.on_commit(partial(_remove, storage, name))


def delete_files_on_delete(model: type[Model], *field_names: str) -> None:
    """Remove the files held by `field_names` whenever an instance of `model` is deleted."""
    if not field_names:
        raise ValueError("Name at least one file field.")
    for name in field_names:
        field = model._meta.get_field(name)
        if not hasattr(field, "storage"):
            raise ValueError(f"{model.__name__}.{name} is not a file field.")

    uid = f"delete-files:{model._meta.label_lower}:{','.join(field_names)}"

    @receiver(post_delete, sender=model, dispatch_uid=uid, weak=False)
    def _delete_files(sender, instance, **kwargs):
        for name in field_names:
            file = getattr(instance, name)
            delete_file_after_commit(file.storage, file.name)
