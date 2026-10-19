"""The Yjs wire protocol: framing, awareness updates and a bounded scanner for untrusted Y updates.

Frames follow y-protocols/y-websocket byte for byte. Everything that comes from a
client is parsed here before it goes near the CRDT engine: the engine is native code, and a crafted update
(a deeply nested value, a reference to history that does not exist) can crash the process or grow its memory
without bound. `scan_update` rejects such updates without applying them.
"""

from __future__ import annotations

import json
from bisect import bisect_right
from collections import Counter
from dataclasses import dataclass, field
from typing import Final

MESSAGE_SYNC: Final = 0
MESSAGE_AWARENESS: Final = 1
MESSAGE_AUTH: Final = 2
MESSAGE_QUERY_AWARENESS: Final = 3

SYNC_STEP1: Final = 0
SYNC_STEP2: Final = 1
SYNC_UPDATE: Final = 2

MAX_VARUINT_BYTES = 10
MAX_STATE_VECTOR_ENTRIES = 100_000
MAX_ANY_DEPTH = 32
ALLOWED_TYPE_REFS = frozenset({0, 1, 2})  # Y.Array, Y.Map, Y.Text; the XML types are not used by Doory

# Content references of an update item (lib0 / yjs `structs/*`)
_REF_DELETED, _REF_JSON, _REF_BINARY, _REF_STRING = 1, 2, 3, 4
_REF_EMBED, _REF_FORMAT, _REF_TYPE, _REF_ANY, _REF_DOC, _REF_SKIP = 5, 6, 7, 8, 9, 10
# lib0 `any` tags
_ANY_ARRAY, _ANY_OBJECT, _ANY_STRING, _ANY_BYTES = 117, 118, 119, 116
_ANY_FIXED = {127: 0, 126: 0, 124: 4, 123: 8, 122: 8, 121: 0, 120: 0}


class ProtocolError(Exception):
    """A frame or update is malformed or breaks a rule. Closes the connection with 4400."""


# ---------------------------------------------------------------------------------------------
# Primitive reader / writer
# ---------------------------------------------------------------------------------------------


class Reader:
    """Bounds-checked cursor over bytes (lib0 decoding)."""

    __slots__ = ("data", "pos")

    def __init__(self, data: bytes, pos: int = 0) -> None:
        self.data = data
        self.pos = pos

    def remaining(self) -> int:
        return len(self.data) - self.pos

    def uint8(self) -> int:
        if self.pos >= len(self.data):
            raise ProtocolError("Unexpected end of data.")
        value = self.data[self.pos]
        self.pos += 1
        return value

    def varuint(self) -> int:
        result = 0
        shift = 0
        for _ in range(MAX_VARUINT_BYTES):
            byte = self.uint8()
            result |= (byte & 0x7F) << shift
            if byte < 0x80:
                return result
            shift += 7
        raise ProtocolError("Integer too long.")

    def skip_varint(self) -> None:
        for _ in range(MAX_VARUINT_BYTES):
            if self.uint8() < 0x80:
                return
        raise ProtocolError("Integer too long.")

    def take(self, count: int) -> bytes:
        if count < 0 or count > self.remaining():
            raise ProtocolError("Unexpected end of data.")
        chunk = self.data[self.pos : self.pos + count]
        self.pos += count
        return chunk

    def skip(self, count: int) -> None:
        if count < 0 or count > self.remaining():
            raise ProtocolError("Unexpected end of data.")
        self.pos += count

    def varbytes(self) -> bytes:
        return self.take(self.varuint())

    def varstring(self) -> str:
        raw = self.varbytes()
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ProtocolError("Invalid UTF-8 text.") from exc

    def skip_varstring(self) -> int:
        """Skip a string and return its length in UTF-16 code units (the clock length of a text item)."""
        raw = self.varbytes()
        try:
            return len(raw.decode("utf-8").encode("utf-16-le")) // 2
        except UnicodeDecodeError as exc:
            raise ProtocolError("Invalid UTF-8 text.") from exc

    def at_end(self) -> bool:
        return self.pos == len(self.data)


def write_varuint(value: int) -> bytes:
    if value < 0:
        raise ValueError("varuint must not be negative")
    out = bytearray()
    while value > 0x7F:
        out.append(0x80 | (value & 0x7F))
        value >>= 7
    out.append(value)
    return bytes(out)


def write_varbytes(data: bytes) -> bytes:
    return write_varuint(len(data)) + data


def write_varstring(text: str) -> bytes:
    return write_varbytes(text.encode("utf-8"))


# ---------------------------------------------------------------------------------------------
# Frames
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class SyncFrame:
    kind: int  # SYNC_STEP1 | SYNC_STEP2 | SYNC_UPDATE
    payload: bytes  # a state vector for step 1, a Y update otherwise


@dataclass(frozen=True)
class AwarenessFrame:
    payload: bytes


@dataclass(frozen=True)
class QueryAwarenessFrame:
    pass


Frame = SyncFrame | AwarenessFrame | QueryAwarenessFrame


def parse_frame(data: bytes) -> Frame:
    """Decode one client frame; anything but sync, awareness and query-awareness raises `ProtocolError`."""
    reader = Reader(data)
    message = reader.varuint()
    if message == MESSAGE_SYNC:
        kind = reader.varuint()
        if kind not in (SYNC_STEP1, SYNC_STEP2, SYNC_UPDATE):
            raise ProtocolError("Unknown sync message.")
        payload = reader.varbytes()
        if not reader.at_end():
            raise ProtocolError("Trailing bytes after a sync message.")
        return SyncFrame(kind, payload)
    if message == MESSAGE_AWARENESS:
        payload = reader.varbytes()
        if not reader.at_end():
            raise ProtocolError("Trailing bytes after an awareness message.")
        return AwarenessFrame(payload)
    if message == MESSAGE_QUERY_AWARENESS:
        if not reader.at_end():
            raise ProtocolError("Trailing bytes after a query message.")
        return QueryAwarenessFrame()
    raise ProtocolError(f"Unknown message type {message}.")


def sync_frame(kind: int, payload: bytes) -> bytes:
    return write_varuint(MESSAGE_SYNC) + write_varuint(kind) + write_varbytes(payload)


def awareness_frame(update: bytes) -> bytes:
    return write_varuint(MESSAGE_AWARENESS) + write_varbytes(update)


def permission_denied_frame(reason: str) -> bytes:
    return write_varuint(MESSAGE_AUTH) + write_varuint(0) + write_varstring(reason)


# ---------------------------------------------------------------------------------------------
# State vectors and awareness updates
# ---------------------------------------------------------------------------------------------


def decode_state_vector(data: bytes, limit: int | None = MAX_STATE_VECTOR_ENTRIES) -> dict[int, int]:
    """Parse a Yjs state vector (client -> next clock). Raises `ProtocolError` when malformed.

    `limit` bounds the number of clients of a vector a peer sent; the server reads its own with `None`.
    """
    reader = Reader(data)
    count = reader.varuint()
    if (limit is not None and count > limit) or count * 2 > reader.remaining():
        raise ProtocolError("Invalid state vector.")
    vector: dict[int, int] = {}
    for _ in range(count):
        client = reader.varuint()
        vector[client] = reader.varuint()
    if not reader.at_end():
        raise ProtocolError("Trailing bytes after a state vector.")
    return vector


@dataclass(frozen=True)
class AwarenessEntry:
    client_id: int
    clock: int
    state: str  # JSON text; "null" removes the client


def decode_awareness(
    data: bytes, *, max_entries: int = 64, max_state_bytes: int = 2048
) -> list[AwarenessEntry]:
    reader = Reader(data)
    count = reader.varuint()
    if count > max_entries or count > reader.remaining():
        raise ProtocolError("Too many awareness states.")
    entries: list[AwarenessEntry] = []
    for _ in range(count):
        client_id = reader.varuint()
        clock = reader.varuint()
        raw = reader.varbytes()
        if len(raw) > max_state_bytes:
            raise ProtocolError("Awareness state too large.")
        try:
            entries.append(AwarenessEntry(client_id, clock, raw.decode("utf-8")))
        except UnicodeDecodeError as exc:
            raise ProtocolError("Invalid UTF-8 text.") from exc
    if not reader.at_end():
        raise ProtocolError("Trailing bytes after an awareness update.")
    return entries


def encode_awareness(entries: list[AwarenessEntry]) -> bytes:
    out = bytearray(write_varuint(len(entries)))
    for entry in entries:
        out += write_varuint(entry.client_id) + write_varuint(entry.clock) + write_varstring(entry.state)
    return bytes(out)


def parse_awareness_state(text: str) -> dict | None:
    """The state object of an awareness entry, or None for a removal. Raises for anything else."""
    try:
        value = json.loads(text)
    except (ValueError, RecursionError) as exc:
        raise ProtocolError("Awareness state is not JSON.") from exc
    if value is None or isinstance(value, dict):
        return value
    raise ProtocolError("Awareness state must be an object or null.")


# ---------------------------------------------------------------------------------------------
# Update scanner
# ---------------------------------------------------------------------------------------------


@dataclass
class UpdateScan:
    structs: int = 0
    types: int = 0
    has_items: bool = False
    has_deletes: bool = False
    extents: dict[int, int] = field(default_factory=dict)
    #: Clients the document has not heard of before; an honest connection introduces one (its own).
    new_clients: set[int] = field(default_factory=set)
    #: Items that start a map entry without naming a predecessor, per (parent, key). The engine finds the head
    #: of an entry's history by walking it for such an item, so thousands of them make one apply take minutes.
    #: An honest client names its predecessor as soon as the key has ever been set.
    originless: Counter[tuple] = field(default_factory=Counter)
    #: Items that name a right neighbour but no left one. An array uses them to insert at its start; for a map
    #: entry the engine walks the whole history to place one, so the engine's budget limits them per update.
    right_only: int = 0
    #: References (origins, parents) into a struct of this same update that holds several values. Each splits
    #: that struct, and a split of a long struct copies the rest of it: 20 000 of them need gigabytes.
    inside_refs: int = 0


def _skip_any(reader: Reader, max_depth: int) -> None:
    """Skip one lib0 `any` value with an explicit stack: no recursion, depth and counts bounded."""
    remaining = [1]
    objects = [False]
    while remaining:
        if remaining[-1] == 0:
            remaining.pop()
            objects.pop()
            continue
        remaining[-1] -= 1
        if objects[-1]:
            reader.varbytes()
        tag = reader.uint8()
        if tag in (_ANY_ARRAY, _ANY_OBJECT):
            count = reader.varuint()
            if count > reader.remaining():
                raise ProtocolError("Invalid collection length.")
            if len(remaining) >= max_depth:
                raise ProtocolError("A value is nested too deeply.")
            remaining.append(count)
            objects.append(tag == _ANY_OBJECT)
        elif tag == 125:
            reader.skip_varint()
        elif tag in (_ANY_STRING, _ANY_BYTES):
            reader.varbytes()
        elif tag in _ANY_FIXED:
            reader.skip(_ANY_FIXED[tag])
        else:
            raise ProtocolError("Unknown value type.")


def scan_update(
    update: bytes,
    known: dict[int, int],
    *,
    allowed_roots: frozenset[str],
    max_any_depth: int = MAX_ANY_DEPTH,
) -> UpdateScan:
    """Check a Y update (v1) against the state it will be applied to, without applying it.

    Rejects: malformed data, values nested deeper than `max_any_depth`, root types other than
    `allowed_roots`, XML types and sub-documents, `Skip` structs, and any reference to history the document
    does not have (`known` is its state vector): such an update would sit in the engine's pending buffer
    forever. Returns counts and the clock extents the update reaches.
    """
    reader = Reader(update)
    scan = UpdateScan()
    blocks: dict[int, tuple[int, int]] = {}
    references: list[tuple[int, int]] = []
    long_structs: dict[
        int, list[tuple[int, int]]
    ] = {}  # per client: (first clock, length) of multi-value structs
    for _ in range(_bounded_count(reader)):
        structs = _bounded_count(reader)
        client = reader.varuint()
        start = reader.varuint()
        if client in blocks or start > known.get(client, 0) or structs == 0:
            raise ProtocolError("The update has a gap in its history.")
        if client not in known:
            scan.new_clients.add(client)
        clock = start
        for _ in range(structs):
            length = _scan_struct(reader, scan, references, allowed_roots, max_any_depth)
            if length > 1:
                long_structs.setdefault(client, []).append((clock, length))
            clock += length
        blocks[client] = (start, clock)
    extents = {client: max(known.get(client, 0), end) for client, (_, end) in blocks.items()}
    scan.extents = extents

    def reaches(client: int, clock: int) -> bool:
        return clock < max(extents.get(client, 0), known.get(client, 0))

    if any(not reaches(client, clock) for client, clock in references):
        raise ProtocolError("The update refers to history the document does not have.")
    for client, clock in references:
        spans = long_structs.get(client)
        if spans:
            first, length = spans[max(0, bisect_right(spans, (clock, float("inf"))) - 1)]
            if first <= clock < first + length:
                scan.inside_refs += 1
    for _ in range(_bounded_count(reader)):
        client = reader.varuint()
        for _ in range(_bounded_count(reader)):
            clock = reader.varuint()
            length = reader.varuint()
            scan.has_deletes = True
            if length == 0 or not reaches(client, clock + length - 1):
                raise ProtocolError("The update deletes history the document does not have.")
    if not reader.at_end():
        raise ProtocolError("Trailing bytes after a Y update.")
    return scan


def _bounded_count(reader: Reader) -> int:
    count = reader.varuint()
    if count > reader.remaining():
        raise ProtocolError("Invalid count.")
    return count


def _read_id(reader: Reader) -> tuple[int, int]:
    return reader.varuint(), reader.varuint()


def _scan_struct(
    reader: Reader,
    scan: UpdateScan,
    references: list[tuple[int, int]],
    allowed_roots: frozenset[str],
    max_any_depth: int,
) -> int:
    """Scan one struct; returns how many clock ticks it occupies."""
    info = reader.uint8()
    ref = info & 0x1F
    scan.structs += 1
    if ref == 0:  # GC
        length = reader.varuint()
        if length == 0:
            raise ProtocolError("Empty struct.")
        return length
    if ref == _REF_SKIP:
        raise ProtocolError("The update has a gap in its history.")
    scan.has_items = True
    has_origin, has_right_origin = bool(info & 0x80), bool(info & 0x40)
    if has_right_origin and not has_origin:
        scan.right_only += 1
    if has_origin:
        references.append(_read_id(reader))
    if has_right_origin:
        references.append(_read_id(reader))
    if not has_origin and not has_right_origin:
        if reader.varuint() == 1:
            root = reader.varstring()
            if root not in allowed_roots:
                raise ProtocolError("The update writes to an unknown root type.")
            parent: tuple = (root,)
        else:
            parent_id = _read_id(reader)
            references.append(parent_id)
            parent = parent_id
        if info & 0x20:
            scan.originless[(parent, reader.varbytes())] += 1
    return _scan_content(reader, scan, ref, max_any_depth)


def _scan_content(reader: Reader, scan: UpdateScan, ref: int, max_any_depth: int) -> int:
    if ref == _REF_DELETED:
        return _positive(reader.varuint())
    if ref == _REF_JSON:
        count = _positive(_bounded_count(reader))
        for _ in range(count):
            reader.varbytes()
        return count
    if ref == _REF_BINARY:
        reader.varbytes()
        return 1
    if ref == _REF_STRING:
        return _positive(reader.skip_varstring())
    if ref == _REF_EMBED:
        reader.varbytes()
        return 1
    if ref == _REF_FORMAT:
        reader.varbytes()
        reader.varbytes()
        return 1
    if ref == _REF_TYPE:
        if reader.varuint() not in ALLOWED_TYPE_REFS:
            raise ProtocolError("The update creates a type that is not allowed.")
        scan.types += 1
        return 1
    if ref == _REF_ANY:
        count = _positive(_bounded_count(reader))
        for _ in range(count):
            _skip_any(reader, max_any_depth)
        return count
    raise ProtocolError("Unsupported content in the update.")


def _positive(value: int) -> int:
    if value <= 0:
        raise ProtocolError("Empty struct.")
    return value
