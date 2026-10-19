"""Synchronous operations on Y documents. Every function here runs on the CRDT threads (see `crdt.py`).

They take and return plain data (bytes, dicts, dataclasses) so the async room code never touches the native
engine itself.
"""

from __future__ import annotations

import json
import time
from collections import Counter
from dataclasses import dataclass, field

from django.conf import settings
from pycrdt import Doc, merge_updates
from rest_framework.exceptions import APIException

from apps.designs.validators import validate_document

from . import protocol, schema
from .schema import Anomalies

ROOT_SET = frozenset(schema.ROOTS)
SMALL_UPDATE = 1024  # bytes
SLACK = 256 * 1024  # bytes the size estimate may exceed the limit by before a small update is measured

# The engine holds the interpreter lock while it applies an update, and a few shapes of update make it do
# work that grows with the square of what the document already holds (it walks the whole history of a map
# entry to place an item that names no predecessor; it compares an item with every concurrent sibling). An
# honest editor produces none of them, so the budget below turns them away before the engine sees them.
MAX_NEW_CLIENTS = 4  # client ids one connection may introduce: its own document, with room to spare
MAX_ORIGINLESS_PER_ENTRY = 32  # first writes of one map entry; one per concurrent writer is honest
MAX_TRACKED_ENTRIES = 1_000_000  # map entries the room counts first writes for (about 100 MB at the limit)
MAX_RIGHT_ONLY_PER_UPDATE = 64  # array-start insertions in one update (a batch of edits has a handful)
MAX_INSIDE_REFS_PER_UPDATE = 256  # references into long structs of the same update (an edit batch has a few)


def _json_size(document: dict) -> int:
    return len(json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def document_size(doc: Doc) -> int:
    return _json_size(schema.ydoc_to_document(doc))


# ---------------------------------------------------------------------------------------------
# Opening
# ---------------------------------------------------------------------------------------------


def build_snapshot(document: dict) -> bytes:
    """The Y state of a stored `DoryDocument` (first use of the room, or after an external change)."""
    return schema.document_to_ydoc(document).get_update()


@dataclass
class OpenedDoc:
    doc: Doc
    sv: dict[int, int]
    size: int


def open_doc(snapshot: bytes, updates: list[bytes]) -> OpenedDoc:
    doc = schema.new_doc()
    doc.apply_update(snapshot)
    for update in updates:
        doc.apply_update(update)
    return OpenedDoc(doc, protocol.decode_state_vector(doc.get_state(), limit=None), document_size(doc))


def merge_state(snapshot: bytes, updates: list[bytes]) -> bytes:
    """One compacted update out of a snapshot and the rows appended since (deleted content is collected)."""
    doc = schema.new_doc()
    doc.apply_update(snapshot)
    for update in updates:
        doc.apply_update(update)
    return doc.get_update()


# ---------------------------------------------------------------------------------------------
# Applying updates
# ---------------------------------------------------------------------------------------------


@dataclass
class Outcome:
    kind: str  # "applied" | "noop" | "rejected"
    reason: str = ""
    detail: str = ""  # why the scanner or the engine refused it (never any content of the update)


class UpdateBudget:
    """What the writers of one room may do to its document, beyond what the scanner checks per update."""

    def __init__(self) -> None:
        # By hash of (parent, key): a count per entry the room has ever seen costs memory, not their names.
        self.originless: Counter[int] = Counter()

    def check(self, scan: protocol.UpdateScan, introduced: set[int]) -> str:
        """Why `scan` may not be applied (or ""); `introduced` holds the clients this connection brought."""
        if len(introduced | scan.new_clients) > MAX_NEW_CLIENTS:
            return "too many new clients"
        if scan.right_only > MAX_RIGHT_ONLY_PER_UPDATE:
            return "too many insertions at the start of an array"
        if scan.inside_refs > MAX_INSIDE_REFS_PER_UPDATE:
            return "too many references into the middle of a long run of values"
        if scan.originless:
            counts = {hash(entry): count for entry, count in scan.originless.items()}
            if (
                len(self.originless) + sum(1 for key in counts if key not in self.originless)
                > MAX_TRACKED_ENTRIES
            ):
                return "too many map entries started in this room"
            if any(self.originless[key] + count > MAX_ORIGINLESS_PER_ENTRY for key, count in counts.items()):
                return "too many first writes of one map entry"
        return ""

    def commit(self, scan: protocol.UpdateScan, introduced: set[int]) -> None:
        introduced |= scan.new_clients
        for entry, count in scan.originless.items():
            self.originless[hash(entry)] += count


@dataclass
class BatchResult:
    outcomes: list[Outcome]
    sv: dict[int, int]
    size: int
    merged: bytes | None = None
    applied: list[bytes] = field(default_factory=list)
    pages_gone: bool = False  # the applied updates left the design without a page
    poisoned: bool = False  # an update was so costly to apply that the room's state is not to be kept


def _would_exceed(doc: Doc, update: bytes, limit: int) -> tuple[bool, int]:
    """Apply `update` to a scratch copy and measure the document: exact, used only near the limit."""
    scratch = schema.new_doc()
    scratch.apply_update(doc.get_update())
    scratch.apply_update(update)
    size = document_size(scratch)
    return size > limit, size


def apply_client_updates(
    doc: Doc,
    sv: dict[int, int],
    updates: list[bytes],
    size: int,
    budget: UpdateBudget | None = None,
    introduced: list[set[int]] | None = None,
) -> BatchResult:
    """Vet and apply updates from a writer, in order. A rejected update leaves the document untouched.

    `budget` and `introduced` (one set of client ids per update, the sender's) switch on the limits of
    `UpdateBudget`. An update the engine needed more than `REALTIME_SLOW_APPLY_SECONDS` for is already in the
    document when this is noticed: the batch stops there and comes back `poisoned`, so that the room can drop
    that state instead of storing and reloading it for ever.

    `size` estimates the document's JSON size. Below `MAX_DESIGN_DOCUMENT_BYTES` the estimate (it grows by the
    size of every update) is trusted. Once it passes the limit the document is measured exactly on a scratch
    copy before the update is applied; small updates are measured only when the estimate is `SLACK` over, so a
    writer near the limit cannot make the server measure on every keystroke. A save above the limit is
    refused in any case.
    """
    limit = settings.MAX_DESIGN_DOCUMENT_BYTES
    outcomes: list[Outcome] = []
    applied: list[bytes] = []
    poisoned = False
    for position, update in enumerate(updates):
        if poisoned:
            outcomes.append(Outcome("noop"))
            continue
        try:
            scan = protocol.scan_update(update, sv, allowed_roots=ROOT_SET)
        except protocol.ProtocolError as exc:
            outcomes.append(Outcome("rejected", "bad_frame", str(exc)))
            continue
        owned = introduced[position] if budget is not None and introduced is not None else None
        if budget is not None and owned is not None and (why := budget.check(scan, owned)):
            outcomes.append(Outcome("rejected", "bad_frame", why))
            continue
        estimate = size + len(update)
        if estimate > limit and (len(update) >= SMALL_UPDATE or estimate > limit + SLACK):
            try:
                too_large, measured = _would_exceed(doc, update, limit)
            except (ValueError, TypeError, RuntimeError, OverflowError, schema.UnrepresentableState) as exc:
                outcomes.append(Outcome("rejected", "bad_frame", f"{type(exc).__name__}: {exc}"))
                continue
            if too_large:
                outcomes.append(Outcome("rejected", "document_too_large"))
                continue
            estimate = measured
        started = time.perf_counter()
        try:
            doc.apply_update(update)
        except (ValueError, TypeError, RuntimeError, OverflowError) as exc:
            outcomes.append(Outcome("rejected", "bad_frame", f"{type(exc).__name__}: {exc}"))
            continue
        if time.perf_counter() - started > settings.REALTIME_SLOW_APPLY_SECONDS:
            outcomes.append(Outcome("rejected", "update_too_costly"))
            poisoned = True
            continue
        if budget is not None and owned is not None:
            budget.commit(scan, owned)
        new_sv = protocol.decode_state_vector(doc.get_state(), limit=None)
        if new_sv == sv and not scan.has_deletes:
            outcomes.append(Outcome("noop"))
            continue
        sv, size = new_sv, estimate
        outcomes.append(Outcome("applied"))
        applied.append(update)
    merged = merge_updates(*applied) if len(applied) > 1 else (applied[0] if applied else None)
    gone = bool(applied) and not poisoned and schema.has_no_pages(doc)
    return BatchResult(outcomes, sv, size, merged, applied, pages_gone=gone, poisoned=poisoned)


def apply_trusted(doc: Doc, update: bytes) -> dict[int, int]:
    """Apply an update that another server process already vetted and stored."""
    doc.apply_update(update)
    return protocol.decode_state_vector(doc.get_state(), limit=None)


def apply_replacement(doc: Doc, delta: bytes) -> tuple[dict[int, int], int]:
    """Apply the server's own replacement update to the live document; returns its state vector and size."""
    doc.apply_update(delta)
    return protocol.decode_state_vector(doc.get_state(), limit=None), document_size(doc)


def resync(
    doc: Doc, snapshot: bytes, updates: list[bytes], before: bytes
) -> tuple[bytes, dict[int, int], int]:
    """Merge the stored state into the live document; returns what was new to it, its state and its size."""
    doc.apply_update(snapshot)
    for update in updates:
        doc.apply_update(update)
    return (
        doc.get_update(before),
        protocol.decode_state_vector(doc.get_state(), limit=None),
        document_size(doc),
    )


def diff_since(doc: Doc, state_vector: bytes) -> bytes:
    return doc.get_update(state_vector)


def full_state(doc: Doc) -> bytes:
    return doc.get_update()


def state_vector(doc: Doc) -> bytes:
    return doc.get_state()


# ---------------------------------------------------------------------------------------------
# Saving
# ---------------------------------------------------------------------------------------------


@dataclass
class Conversion:
    document: dict | None
    anomalies: Anomalies
    problem: str = ""


def convert(state: bytes) -> Conversion:
    """Turn an encoded Y state into a validated `DoryDocument` (runs on the read thread, on a copy)."""
    doc = schema.new_doc()
    doc.apply_update(state)
    try:
        document, anomalies = schema.read_document(doc)
    except schema.UnrepresentableState as exc:
        return Conversion(None, Anomalies(), str(exc))
    try:
        validate_document(document, max_bytes=settings.MAX_DESIGN_DOCUMENT_BYTES)
    except APIException as exc:
        return Conversion(None, anomalies, str(exc.default_code))
    return Conversion(document, anomalies)


def repair(doc: Doc) -> bytes | None:
    """Delete duplicate, dangling and unreadable entries from the live document; returns the delta."""
    _, anomalies = schema.read_document(doc)
    if not anomalies:
        return None
    before = doc.get_state()
    with doc.transaction():
        schema.repair(doc, anomalies)
    return doc.get_update(before)


def make_replacement(doc: Doc, document: dict) -> bytes:
    """The update that turns the live document into `document` inside the same history (version restore)."""
    scratch = schema.new_doc()
    scratch.apply_update(doc.get_update())
    before = scratch.get_state()
    with scratch.transaction():
        schema.write_document(scratch, document)
    return scratch.get_update(before)
