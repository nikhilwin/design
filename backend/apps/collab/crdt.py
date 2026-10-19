"""Dedicated threads run every call into the native CRDT engine that touches client data.

The engine (yrs) recurses while it deletes or garbage-collects nested types; a document that a client has
nested thousands of levels deep would overflow the 8 MB stack of an ordinary thread and take the whole
server process down. These threads therefore get a large stack (virtual memory, committed only when used),
which together with the document size cap bounds what a client can do. There are two: one applies updates
and serves sync requests, the other converts snapshots to documents, so a slow save never delays editing.
Each document is only ever used by one of them at a time (conversions work on a copy).
"""

from __future__ import annotations

import asyncio
import logging
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import TypeVar

log = logging.getLogger("doory.collab")

STACK_BYTES = 1024 * 1024 * 1024
T = TypeVar("T")

WRITE = "write"
READ = "read"

_lock = threading.Lock()
_executors: dict[str, ThreadPoolExecutor] = {}


class EngineFailure(Exception):
    """The native engine panicked (it raises a `BaseException`); the document it touched must be discarded."""


def _start(name: str) -> ThreadPoolExecutor:
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"doory-crdt-{name}")
    previous = threading.stack_size()
    try:
        threading.stack_size(STACK_BYTES)
    except (ValueError, RuntimeError):
        log.warning("Could not reserve a large stack for the CRDT thread; using the default.")
    try:
        pool.submit(int).result()  # starts the worker thread while the large stack size is in force
    finally:
        threading.stack_size(previous)
    return pool


def executor(kind: str = WRITE) -> ThreadPoolExecutor:
    with _lock:
        if kind not in _executors:
            _executors[kind] = _start(kind)
        return _executors[kind]


def _guarded(function: Callable[..., T], args: tuple[object, ...]) -> T:
    try:
        return function(*args)
    except Exception:
        raise
    except BaseException as exc:  # a native panic surfaces as a BaseException subclass
        if isinstance(exc, KeyboardInterrupt | SystemExit):
            raise
        raise EngineFailure(repr(exc)) from None


async def run(function: Callable[..., T], *args: object, kind: str = WRITE) -> T:
    """Run `function(*args)` on a CRDT thread and wait for the result."""
    return await asyncio.get_running_loop().run_in_executor(executor(kind), _guarded, function, args)
