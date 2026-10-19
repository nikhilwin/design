"""A tiny Yjs v1 update encoder for tests that need updates no honest client would write."""

from __future__ import annotations

from collections.abc import Mapping, Sequence


def varuint(value: int) -> bytes:
    out = bytearray()
    while value > 0x7F:
        out.append(0x80 | (value & 0x7F))
        value >>= 7
    out.append(value)
    return bytes(out)


def varbytes(data: bytes) -> bytes:
    return varuint(len(data)) + data


def any_int(value: int) -> bytes:
    """lib0 `any` integer (tag 125 and a signed varint)."""
    sign, value = (0x40 if value < 0 else 0), abs(value)
    first, value = value & 0x3F, value >> 6
    out = bytearray([(0x80 if value else 0) | sign | first])
    while value:
        byte, value = value & 0x7F, value >> 7
        out.append(byte | (0x80 if value else 0))
    return b"\x7d" + bytes(out)


def item(
    *,
    root: str | None = None,
    parent: tuple[int, int] | None = None,
    key: str | None = None,
    origin: tuple[int, int] | None = None,
    right: tuple[int, int] | None = None,
    value: int = 1,
) -> bytes:
    """An item holding one `any` integer (reference 8). Without origins it names its parent: a root or an item."""
    info = 8 | (0x20 if key is not None else 0) | (0x80 if origin else 0) | (0x40 if right else 0)
    out = bytes([info])
    for ref in (origin, right):
        if ref:
            out += varuint(ref[0]) + varuint(ref[1])
    if not origin and not right:
        if root is not None:
            out += varuint(1) + varbytes(root.encode())
        else:
            assert parent is not None
            out += varuint(0) + varuint(parent[0]) + varuint(parent[1])
        if key is not None:
            out += varbytes(key.encode())
    return out + varuint(1) + any_int(value)


def run_of_values(*, root: str, count: int) -> bytes:
    """One item of `count` integers (a long array run), written to a root array."""
    return (
        bytes([8])
        + varuint(1)
        + varbytes(root.encode())
        + varuint(count)
        + b"".join(any_int(i) for i in range(count))
    )


def update(blocks: Mapping[int, tuple[int, Sequence[bytes]]]) -> bytes:
    """`{client: (first clock, [structs])}` with an empty delete set."""
    out = varuint(len(blocks))
    for client, (start, structs) in blocks.items():
        out += varuint(len(structs)) + varuint(client) + varuint(start) + b"".join(structs)
    return out + varuint(0)
