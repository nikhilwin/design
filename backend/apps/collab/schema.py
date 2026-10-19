"""Mapping between a `DoryDocument` and its Y document.

The Y document has three root types: `meta` (Y.Map of the document-level properties), `pageOrder`
(Y.Array of page ids) and `pages` (Y.Map of page id -> Y.Map holding the page properties plus `objectOrder`
and `objects`). Every property is one entry of a Y.Map holding a plain JSON value, so properties added by
later features sync without a server change.

Everything in this module is a pure function of its arguments. Reading is defensive: the state is written by
authenticated but untrusted clients, so wrong types, duplicates and dangling ids never raise and never
recurse without a bound.
"""

from __future__ import annotations

import json
import math
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

from pycrdt import Array, Doc, Map, Text

ROOT_META = "meta"
ROOT_PAGE_ORDER = "pageOrder"
ROOT_PAGES = "pages"
ROOTS = (ROOT_META, ROOT_PAGE_ORDER, ROOT_PAGES)
KEY_OBJECTS = "objects"
KEY_OBJECT_ORDER = "objectOrder"
RESERVED_PAGE_KEYS = frozenset({KEY_OBJECTS, KEY_OBJECT_ORDER})
RESTORED_PAGE_ID = "restored-page"  # the editor puts the same page back (editor/collab/schema.ts)
MAX_ID_LENGTH = 64
MAX_VALUE_DEPTH = 64
MAX_SAFE_INTEGER = 2**53


class UnrepresentableState(Exception):
    """The Y state cannot be turned into a document (for example a property nested too deeply)."""


def new_doc() -> Doc:
    """An empty Y document with the three root types defined, so a client's mismatching root is ignored."""
    ydoc = Doc()
    ydoc.get(ROOT_META, type=Map)
    ydoc.get(ROOT_PAGE_ORDER, type=Array)
    ydoc.get(ROOT_PAGES, type=Map)
    return ydoc


# ---------------------------------------------------------------------------------------------
# document -> Y
# ---------------------------------------------------------------------------------------------


def _clean(value: Any, depth: int = 0) -> Any:
    """A JSON value in the form the Y encoder accepts: finite numbers, safe integers, string keys."""
    if depth > MAX_VALUE_DEPTH:
        raise UnrepresentableState("The document is nested too deeply.")
    if value is None or isinstance(value, bool | str):
        return value
    if isinstance(value, int):
        if -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER:
            return value
        try:
            as_float = float(value)
        except OverflowError:
            return None
        return as_float if math.isfinite(as_float) else None
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, list | tuple):
        return [_clean(item, depth + 1) for item in value]
    if isinstance(value, dict):
        return {str(key): _clean(item, depth + 1) for key, item in value.items()}
    return None


def _valid_id(candidate: object) -> bool:
    return isinstance(candidate, str) and 0 < len(candidate) <= MAX_ID_LENGTH


def _unique_ids(items: list[dict]) -> list[str]:
    """The id of every item; a missing, invalid or repeated one is replaced by a fresh UUID."""
    seen: set[str] = set()
    ids: list[str] = []
    for item in items:
        candidate = item.get("id")
        if not _valid_id(candidate) or candidate in seen:
            candidate = str(uuid.uuid4())
        seen.add(candidate)
        ids.append(candidate)
    return ids


def _object_map(props: dict, object_id: str) -> Map:
    return Map({**{str(key): _clean(value) for key, value in props.items() if key != "id"}, "id": object_id})


def _page_map(page: dict, page_id: str) -> Map:
    objects = [item for item in page.get("objects", []) if isinstance(item, dict)]
    object_ids = _unique_ids(objects)
    props = {
        str(key): _clean(value)
        for key, value in page.items()
        if key not in RESERVED_PAGE_KEYS and key != "id"
    }
    children = {oid: _object_map(item, oid) for item, oid in zip(objects, object_ids, strict=True)}
    return Map({**props, "id": page_id, KEY_OBJECT_ORDER: Array(object_ids), KEY_OBJECTS: Map(children)})


def write_document(ydoc: Doc, document: dict) -> None:
    """Write `document` into the roots of `ydoc`, replacing whatever they hold, in the open transaction."""
    meta = ydoc.get(ROOT_META, type=Map)
    order = ydoc.get(ROOT_PAGE_ORDER, type=Array)
    pages = ydoc.get(ROOT_PAGES, type=Map)
    for key in list(meta.keys()):
        del meta[key]
    for key in list(pages.keys()):
        del pages[key]
    if len(order):
        del order[0 : len(order)]
    for key, value in document.items():
        if key != "pages":
            meta[str(key)] = _clean(value)
    page_items = [page for page in document.get("pages", []) if isinstance(page, dict)]
    page_ids = _unique_ids(page_items)
    order.extend(page_ids)
    for page, page_id in zip(page_items, page_ids, strict=True):
        pages[page_id] = _page_map(page, page_id)


def document_to_ydoc(document: dict, ydoc: Doc | None = None) -> Doc:
    """Build (or fill) a Y document from a `DoryDocument`. Documents the server accepts round-trip exactly."""
    target = ydoc if ydoc is not None else new_doc()
    with target.transaction():
        write_document(target, document)
    return target


# ---------------------------------------------------------------------------------------------
# Y -> document
# ---------------------------------------------------------------------------------------------


def _number(value: float) -> int | float | None:
    if not math.isfinite(value):
        return None
    if value.is_integer() and abs(value) <= MAX_SAFE_INTEGER:
        return int(value)
    return value


def array_values(array: Array) -> list:
    """The entries of a shared array as plain JSON, read with one native call.

    pycrdt reads an array item by item (`array[i]`, `for x in array`, `array[a:b]`), and each read walks the
    array from its start: reading n entries costs n squared steps. A writer can make an array hundreds of
    thousands of entries long with one frame, which then kept the engine thread busy for minutes.
    """
    with array.doc.transaction() as transaction:
        text = array.integrated.to_json(transaction._txn)
    try:
        return json.loads(text)
    except RecursionError:
        return _top_level_entries(text)


_JSON_TOKEN = re.compile(r'"(?:[^"\\]|\\.)*"|[\[\]{}]|[^\s,\[\]{}"]+')
NESTED = object()  # stands for an entry of an array that is itself an array or an object


def _top_level_entries(text: str) -> list:
    """The entries of a JSON array read without recursion: nested ones are `NESTED`, the rest as they are.

    Used when an entry is nested so deeply that `json.loads` gives up. Such an entry is no id, which is all
    the callers need to know about it.
    """
    entries: list = []
    depth = 0
    for token in _JSON_TOKEN.finditer(text):
        value = token.group()
        if value in "[{":
            if depth == 1:
                entries.append(NESTED)
            depth += 1
        elif value in "]}":
            depth -= 1
        elif depth == 1:
            entries.append(json.loads(value))
    return entries


def _plain(value: Any, depth: int) -> Any:
    """Plain JSON read from a shared array: integral floats become ints, nesting stays bounded."""
    if depth > MAX_VALUE_DEPTH or value is NESTED:
        raise UnrepresentableState("A property is nested too deeply.")
    if isinstance(value, float):
        return _number(value)
    if isinstance(value, list):
        return [_plain(item, depth + 1) for item in value]
    if isinstance(value, dict):
        return {str(key): _plain(item, depth + 1) for key, item in value.items()}
    return value


def to_json(value: Any, depth: int = 0) -> Any:
    """A Y value as plain JSON: shared types (a future `Y.Text`) are flattened, integral floats int."""
    if depth > MAX_VALUE_DEPTH:
        raise UnrepresentableState("A property is nested too deeply.")
    if value is None or isinstance(value, bool | str):
        return value
    if isinstance(value, float):
        return _number(value)
    if isinstance(value, int):
        return value
    if isinstance(value, Text):
        return str(value)
    if isinstance(value, Map):
        return {str(key): to_json(item, depth + 1) for key, item in value.items()}
    if isinstance(value, Array):
        return _plain(array_values(value), depth + 1)
    if isinstance(value, list | tuple):
        return [to_json(item, depth + 1) for item in value]
    if isinstance(value, dict):
        return {str(key): to_json(item, depth + 1) for key, item in value.items()}
    return None


@dataclass
class Anomalies:
    """What `read_document` found wrong; `repair` removes exactly this."""

    page_order_remove: list[int] = field(default_factory=list)
    pages_unlisted: list[str] = field(default_factory=list)
    object_order_remove: dict[str, list[int]] = field(default_factory=dict)
    objects_unlisted: dict[str, list[str]] = field(default_factory=dict)
    bad_props: list[tuple[str, ...]] = field(default_factory=list)
    no_pages: bool = False  # every page was removed at once; a blank one goes back

    def __bool__(self) -> bool:
        return bool(
            self.page_order_remove
            or self.pages_unlisted
            or self.object_order_remove
            or self.objects_unlisted
            or self.bad_props
            or self.no_pages
        )


def _ordered(order: Any, entries: Any) -> tuple[list[str], list[int], list[str]]:
    """Section 4.4: ids in order, first occurrence wins, dangling ids skipped.

    Returns (ids to use, indices of the entries to remove, keys of `entries` that the order does not list).
    """
    use: list[str] = []
    remove: list[int] = []
    seen: set[str] = set()
    listed: set[str] = set()
    keys = set(entries.keys()) if isinstance(entries, Map) else set()
    if isinstance(order, Array):
        for index, raw in enumerate(array_values(order)):
            if not isinstance(raw, str) or raw in seen or raw not in keys:
                remove.append(index)
                continue
            seen.add(raw)
            use.append(raw)
        listed = seen
    unlisted = sorted(key for key in keys if key not in listed)
    return use, remove, unlisted


def _props(source: Any, path: tuple[str, ...], skip: frozenset[str], anomalies: Anomalies) -> dict:
    result: dict = {}
    if not isinstance(source, Map):
        return result
    for key, value in source.items():
        if key in skip:
            continue
        try:
            result[str(key)] = to_json(value)
        except UnrepresentableState:
            anomalies.bad_props.append((*path, str(key)))
    return result


def read_document(ydoc: Doc) -> tuple[dict, Anomalies]:
    """The `DoryDocument` held by `ydoc` (rules of section 4.4) and the anomalies found on the way."""
    anomalies = Anomalies()
    meta = ydoc.get(ROOT_META, type=Map)
    document = _props(meta, (ROOT_META,), frozenset({"pages"}), anomalies)
    page_ids, anomalies.page_order_remove, anomalies.pages_unlisted = _ordered(
        ydoc.get(ROOT_PAGE_ORDER, type=Array), ydoc.get(ROOT_PAGES, type=Map)
    )
    pages_map = ydoc.get(ROOT_PAGES, type=Map)
    pages: list[dict] = []
    for page_id in page_ids:
        page_map = pages_map.get(page_id)
        if not isinstance(page_map, Map):
            anomalies.pages_unlisted.append(page_id)
            continue
        page = _props(page_map, (ROOT_PAGES, page_id), RESERVED_PAGE_KEYS, anomalies)
        page["id"] = page_id
        objects_map = page_map.get(KEY_OBJECTS)
        object_ids, remove, unlisted = _ordered(page_map.get(KEY_OBJECT_ORDER), objects_map)
        if remove:
            anomalies.object_order_remove[page_id] = remove
        if unlisted:
            anomalies.objects_unlisted[page_id] = unlisted
        objects: list[dict] = []
        for object_id in object_ids:
            object_map = objects_map.get(object_id) if isinstance(objects_map, Map) else None
            if not isinstance(object_map, Map):
                continue
            item = _props(object_map, (ROOT_PAGES, page_id, KEY_OBJECTS, object_id), frozenset(), anomalies)
            item["id"] = object_id
            objects.append(item)
        page["objects"] = objects
        pages.append(page)
    document["pages"] = pages
    anomalies.no_pages = not pages
    return document, anomalies


def has_no_pages(ydoc: Doc) -> bool:
    """True when no page is left (a design always has one)."""
    pages_map = ydoc.get(ROOT_PAGES, type=Map)
    use, _, _ = _ordered(ydoc.get(ROOT_PAGE_ORDER, type=Array), pages_map)
    return not any(isinstance(pages_map.get(page_id), Map) for page_id in use)


def ydoc_to_document(ydoc: Doc) -> dict:
    """The `DoryDocument` held by `ydoc`. Inverse of `document_to_ydoc`."""
    return read_document(ydoc)[0]


def _remove_entries(array: Array, indices: list[int]) -> None:
    """Delete the entries at `indices`, a run of neighbours in one call (every call walks the array)."""
    runs: list[list[int]] = []
    for index in sorted(set(indices)):
        if runs and index == runs[-1][1]:
            runs[-1][1] = index + 1
        else:
            runs.append([index, index + 1])
    for start, stop in reversed(runs):
        del array[start:stop]


def repair(ydoc: Doc, anomalies: Anomalies) -> None:
    """Delete what `anomalies` lists (duplicate and dangling ids, unlisted entries, unreadable properties).

    Runs in the caller's transaction. Deleting the same entries twice, from two peers, is harmless.
    """
    pages_map = ydoc.get(ROOT_PAGES, type=Map)
    order = ydoc.get(ROOT_PAGE_ORDER, type=Array)
    _remove_entries(order, anomalies.page_order_remove)
    for key in anomalies.pages_unlisted:
        if key in pages_map:
            del pages_map[key]
    for page_id, indices in anomalies.object_order_remove.items():
        page_map = pages_map.get(page_id)
        if isinstance(page_map, Map) and isinstance(page_map.get(KEY_OBJECT_ORDER), Array):
            _remove_entries(page_map[KEY_OBJECT_ORDER], indices)
    for page_id, keys in anomalies.objects_unlisted.items():
        page_map = pages_map.get(page_id)
        if isinstance(page_map, Map) and isinstance(page_map.get(KEY_OBJECTS), Map):
            for key in keys:
                if key in page_map[KEY_OBJECTS]:
                    del page_map[KEY_OBJECTS][key]
    for path in anomalies.bad_props:
        target: Any = ydoc.get(path[0], type=Map)
        for step in path[1:-1]:
            target = target.get(step) if isinstance(target, Map) else None
        if isinstance(target, Map) and path[-1] in target:
            del target[path[-1]]
    if anomalies.no_pages:
        blank = {"background": {"type": "solid", "color": "#ffffff"}, "objects": []}
        pages_map[RESTORED_PAGE_ID] = _page_map(blank, RESTORED_PAGE_ID)
        order.append(RESTORED_PAGE_ID)


# ---------------------------------------------------------------------------------------------
# document change -> Y operations (mirror of editor/collab/diff.ts)
# ---------------------------------------------------------------------------------------------

_MISSING = object()
SKIP_ID = frozenset({"id"})
SKIP_PAGE = frozenset({"id", KEY_OBJECTS, KEY_OBJECT_ORDER})
SKIP_DOC = frozenset({"pages"})


def json_equal(left: Any, right: Any) -> bool:
    """Equality of JSON values: 1 == 1.0, but True is not 1 (Python's own == says it is)."""
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if isinstance(left, int | float) and isinstance(right, int | float):
        return left == right
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(json_equal(a, b) for a, b in zip(left, right, strict=True))
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(
            json_equal(value, right[key]) for key, value in left.items()
        )
    return type(left) is type(right) and left == right


def longest_increasing(values: list[int]) -> list[int]:
    """Positions of a longest increasing subsequence of `values`."""
    tails: list[int] = []
    previous = [-1] * len(values)
    for i, value in enumerate(values):
        low, high = 0, len(tails)
        while low < high:
            mid = (low + high) // 2
            if values[tails[mid]] < value:
                low = mid + 1
            else:
                high = mid
        if low > 0:
            previous[i] = tails[low - 1]
        if low == len(tails):
            tails.append(i)
        else:
            tails[low] = i
    out: list[int] = []
    at = tails[-1] if tails else -1
    while at >= 0:
        out.append(at)
        at = previous[at]
    return out[::-1]


def sync_order(array: Array, target: list[str], known: set[str]) -> None:
    """Make `array` list `target` in order with the fewest operations (`syncOrder` in diff.ts).

    Entries already in the right relative order stay; duplicates and moved entries are deleted and inserted
    again; ids neither in `target` nor in `known` are somebody else's additions and are left alone.
    """
    current = array_values(array)
    wanted = {item: index for index, item in enumerate(target)}
    first: list[int] = []
    seen: set[str] = set()
    for position, item in enumerate(current):
        if item in wanted and item not in seen:
            seen.add(item)
            first.append(position)
    kept = {first[i] for i in longest_increasing([wanted[current[p]] for p in first])}
    doomed = [
        position
        for position, item in enumerate(current)
        if position not in kept and (item in wanted or item in known)
    ]
    _remove_entries(array, doomed)
    removed = set(doomed)
    after = [item for position, item in enumerate(current) if position not in removed]
    present = set(after)
    cursor = 0
    for item in target:
        if item in present:
            cursor = after.index(item, cursor) + 1
        else:
            array.insert(cursor, item)
            after.insert(cursor, item)
            present.add(item)
            cursor += 1


def _write_props(target: Map, prev: dict | None, nxt: dict, skip: frozenset[str]) -> None:
    before = prev or {}
    for key in {*before.keys(), *nxt.keys()}:
        if key in skip:
            continue
        was, now = before.get(key, _MISSING), nxt.get(key, _MISSING)
        if prev is not None and was is not _MISSING and now is not _MISSING and json_equal(was, now):
            continue
        if now is _MISSING:
            if key in target:
                del target[key]
            continue
        value = _clean(now)
        if key in target and json_equal(to_json(target[key]), value):
            continue
        target[str(key)] = value


def _page_parts(page_map: Map) -> tuple[Map, Array]:
    objects = page_map.get(KEY_OBJECTS)
    if not isinstance(objects, Map):
        objects = page_map[KEY_OBJECTS] = Map()
    order = page_map.get(KEY_OBJECT_ORDER)
    if not isinstance(order, Array):
        order = page_map[KEY_OBJECT_ORDER] = Array()
    return objects, order


def _write_page(pages: Map, page: dict, prev: dict | None) -> None:
    page_id = page["id"]
    existing = pages.get(page_id)
    if not isinstance(existing, Map):
        if prev is None:
            pages[page_id] = _page_map(page, page_id)
        return  # the page was deleted by somebody else meanwhile: the edit goes with it
    _write_props(existing, prev, page, SKIP_PAGE)
    objects, order = _page_parts(existing)
    before = {obj["id"]: obj for obj in (prev or {}).get("objects", [])}
    ids: list[str] = []
    for obj in page.get("objects", []):
        object_id = obj.get("id")
        if not _valid_id(object_id):
            continue
        old = before.get(object_id)
        if old is None or not json_equal(old, obj):
            current = objects.get(object_id)
            if isinstance(current, Map):
                _write_props(current, old, obj, SKIP_ID)
            elif old is None:
                objects[object_id] = _object_map(obj, object_id)
        if object_id in objects:
            ids.append(object_id)
    wanted = {obj.get("id") for obj in page.get("objects", [])}
    for object_id in before:
        if object_id not in wanted and object_id in objects:
            del objects[object_id]
    sync_order(order, ids, set(before))


def write_changes(ydoc: Doc, prev: dict, nxt: dict) -> None:
    """Write only what differs between two documents into `ydoc` (`writeChanges`), in the open transaction.

    `prev` is what the writer started from (normally read from `ydoc` itself), `nxt` what it wants. A property
    is written when it differs between the two and from what the shared state holds, so changes others made
    in the meantime survive unless this edit touches the very same property.
    """
    meta = ydoc.get(ROOT_META, type=Map)
    order = ydoc.get(ROOT_PAGE_ORDER, type=Array)
    pages = ydoc.get(ROOT_PAGES, type=Map)
    _write_props(meta, prev, nxt, SKIP_DOC)
    before = {page["id"]: page for page in prev.get("pages", [])}
    ids = [page["id"] for page in nxt.get("pages", [])]
    wanted = set(ids)
    for page_id in before:
        if page_id not in wanted and page_id in pages:
            del pages[page_id]
    for page in nxt.get("pages", []):
        old = before.get(page["id"])
        if old is None or not json_equal(old, page):
            _write_page(pages, page, old)
    sync_order(order, ids, set(before))
