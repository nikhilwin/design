"""Stored-file housekeeping shared by the workspace apps."""

from __future__ import annotations

import logging
from collections.abc import Iterable

from django.core.files.storage import Storage
from django.db import transaction

logger = logging.getLogger(__name__)


def delete_files(storage: Storage, names: Iterable[str]) -> None:
    """Best-effort removal; a storage hiccup must never break the request that triggered it."""
    for name in names:
        if not name:
            continue
        try:
            storage.delete(name)
        except Exception:
            logger.exception("Could not delete stored file %s", name)


def delete_files_on_commit(storage: Storage, names: Iterable[str]) -> None:
    """Remove stored files once the surrounding transaction commits (never if it rolls back)."""
    stale = [name for name in names if name]
    if stale:
        transaction.on_commit(lambda: delete_files(storage, stale))
