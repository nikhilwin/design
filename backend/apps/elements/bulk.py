"""Bulk creation and refresh of elements (`Element.objects.bulk_import`).

`bulk_create` is deliberately disabled on elements because it would skip `Element.save()` and with it the
SVG sanitiser. This module is the one sanctioned bulk path and it keeps the same guarantee: every entry's
SVG goes through `apps.elements.svgdata.process_svg` (i.e. `sanitize_svg`) before anything is written, and
the stored file is the sanitised output, never the input.

Work is done in batches that each commit on their own, so an interrupted import keeps what it finished and
a repeat run only does the remainder (entries whose sanitised SVG and metadata are unchanged cost one
comparison, no file write). The upstream-derived fields (name, kind, style, tags, sort order, artwork) are
owned by the importer; `is_published` is owned by staff and is never touched on an existing element.
"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import Callable, Iterable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from django.core.files.base import ContentFile
from django.db import models, transaction
from django.utils import timezone

from apps.core.svg import SvgError

from .importer import CREATED, UNCHANGED, UPDATED, ImportSummary
from .models import Element, ElementKind, ElementPack, ElementStyle
from .search import clean_tags, search_name, search_tags
from .svgdata import ProcessedSvg, process_svg

DEFAULT_BATCH_SIZE = 500
MAX_KEY_LENGTH = Element._meta.get_field("key").max_length
MAX_NAME_LENGTH = Element._meta.get_field("name").max_length

UPDATE_FIELDS = [
    "name",
    "kind",
    "style",
    "tags",
    "sort_order",
    "search_name",
    "search_tags",
    "svg",
    "width",
    "height",
    "colors",
    "is_recolorable",
    "content_hash",
    "updated_at",
]


@dataclass(frozen=True)
class ImportEntry:
    """One element to create or refresh. `svg` is raw, untrusted SVG markup."""

    key: str
    name: str
    svg: bytes
    kind: str | None = None  # None: the pack's kind
    style: str = ""
    tags: Sequence[str] = ()
    sort_order: int = 0


@dataclass
class _Prepared:
    entry: ImportEntry
    processed: ProcessedSvg
    kind: str
    tags: list[str]
    digest: str


@dataclass
class _Plan:
    creates: list[Element] = field(default_factory=list)
    updates: list[Element] = field(default_factory=list)
    data: dict[uuid.UUID, bytes] = field(default_factory=dict)
    replaced: list[str] = field(default_factory=list)


def _prepare(entry: ImportEntry, pack: ElementPack) -> _Prepared:
    if not entry.key or len(entry.key) > MAX_KEY_LENGTH:
        raise ValueError("the key is empty or too long")
    if not entry.name.strip():
        raise ValueError("the name is empty")
    kind = entry.kind or pack.kind
    if kind not in ElementKind.values:
        raise ValueError(f"unknown kind {kind!r}")
    if entry.style and entry.style not in ElementStyle.values:
        raise ValueError(f"unknown style {entry.style!r}")
    processed = process_svg(entry.svg)
    return _Prepared(
        entry=entry,
        processed=processed,
        kind=kind,
        tags=clean_tags(entry.tags),
        digest=hashlib.sha256(processed.data).hexdigest(),
    )


def _name(entry: ImportEntry) -> str:
    return entry.name.strip()[:MAX_NAME_LENGTH]


def _is_current(element: Element, item: _Prepared) -> bool:
    return (
        element.content_hash == item.digest
        and element.name == _name(item.entry)
        and element.kind == item.kind
        and element.style == item.entry.style
        and element.tags == item.tags
        and element.sort_order == item.entry.sort_order
    )


def _apply(element: Element, item: _Prepared) -> None:
    entry = item.entry
    element.name = _name(entry)
    element.kind, element.style, element.tags = item.kind, entry.style, item.tags
    element.sort_order = entry.sort_order
    element.search_name, element.search_tags = search_name(element.name), search_tags(item.tags)
    element.width, element.height = item.processed.width, item.processed.height
    element.colors, element.is_recolorable = item.processed.colors, item.processed.is_recolorable
    element.content_hash = item.digest


def _plan_batch(
    pack: ElementPack, prepared: list[_Prepared], summary: ImportSummary, existing: dict[str, Element]
) -> _Plan:
    plan = _Plan()
    now = timezone.now()
    for item in prepared:
        element = existing.get(item.entry.key)
        if element is None:
            element = Element(pack=pack, key=item.entry.key)
            _apply(element, item)
            plan.creates.append(element)
            plan.data[element.pk] = item.processed.data
            summary.record(CREATED)
        elif _is_current(element, item):
            summary.record(UNCHANGED)
        else:
            artwork_changed = element.content_hash != item.digest
            _apply(element, item)
            element.updated_at = now
            plan.updates.append(element)
            if artwork_changed:
                plan.data[element.pk] = item.processed.data
            summary.record(UPDATED)
    return plan


def _write_files(plan: _Plan, workers: int, written: list[str]) -> None:
    """Store the planned SVG files and point each row at its file; names stored so far go into `written`."""
    field_ = Element._meta.get_field("svg")
    storage = field_.storage
    rows = {element.pk: element for element in (*plan.creates, *plan.updates)}

    def store(pk: uuid.UUID) -> tuple[uuid.UUID, str]:
        element = rows[pk]
        name = storage.save(
            field_.generate_filename(element, f"{element.key.rsplit('/', 1)[-1]}.svg"),
            ContentFile(plan.data[pk]),
        )
        written.append(name)
        return pk, name

    if workers > 1 and len(plan.data) > 1:
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="elementfile") as pool:
            results = list(pool.map(store, plan.data))
    else:
        results = [store(pk) for pk in plan.data]
    updated = {element.pk for element in plan.updates}
    for pk, name in results:
        element = rows[pk]
        if pk in updated and element.svg and element.svg.name != name:
            plan.replaced.append(element.svg.name)  # a storage that overwrites in place reuses the name
        element.svg = name


def _discard(names: Iterable[str]) -> None:
    storage = Element._meta.get_field("svg").storage
    for name in names:
        try:
            storage.delete(name)
        except OSError:
            continue


def _prepare_batch(
    pack: ElementPack, batch: Sequence[ImportEntry], summary: ImportSummary, seen: set[str]
) -> tuple[list[_Prepared], dict[str, Element]]:
    """Sanitise the entries (skipping bad ones) and load the rows that already exist for them."""
    prepared: list[_Prepared] = []
    for entry in batch:
        try:
            if entry.key in seen:
                raise ValueError("duplicate key")
            prepared.append(_prepare(entry, pack))
        except (SvgError, ValueError) as exc:
            summary.skipped.append((entry.key, str(exc)))
            continue
        seen.add(entry.key)
    existing = {
        element.key: element
        for element in Element.objects.filter(pack=pack, key__in=[p.entry.key for p in prepared])
    }
    return prepared, existing


def _import_batch(
    pack: ElementPack, batch: Sequence[ImportEntry], summary: ImportSummary, seen: set[str], *, workers: int
) -> None:
    prepared, existing = _prepare_batch(pack, batch, summary, seen)
    plan = _plan_batch(pack, prepared, summary, existing)
    if not (plan.creates or plan.updates):
        return
    written: list[str] = []
    try:
        with transaction.atomic():
            _write_files(plan, workers, written)
            if plan.creates:
                models.QuerySet.bulk_create(Element.objects.all(), plan.creates)
            if plan.updates:
                Element.objects.bulk_update(plan.updates, UPDATE_FIELDS)
    except BaseException:
        _discard(written)
        raise
    _discard(plan.replaced)


def _classify_batch(
    pack: ElementPack, batch: Sequence[ImportEntry], summary: ImportSummary, seen: set[str]
) -> None:
    """The counts a real import of `batch` would produce, without writing anything."""
    prepared, existing = _prepare_batch(pack, batch, summary, seen)
    for item in prepared:
        element = existing.get(item.entry.key)
        if element is None:
            summary.record(CREATED)
        elif _is_current(element, item):
            summary.record(UNCHANGED)
        else:
            summary.record(UPDATED)


def bulk_import(
    pack: ElementPack,
    entries: Sequence[ImportEntry],
    *,
    batch_size: int = DEFAULT_BATCH_SIZE,
    workers: int = 1,
    dry_run: bool = False,
    progress: Callable[[ImportSummary], None] | None = None,
) -> ImportSummary:
    """Create or refresh `entries` in `pack`, `batch_size` at a time. Unsafe or invalid SVGs are skipped.

    Returns what happened: created / updated / unchanged counts and the skipped `(key, reason)` pairs.
    With `dry_run` nothing is written (the SVGs are still sanitised so the counts are exact).
    """
    summary = ImportSummary()
    seen: set[str] = set()
    for start in range(0, len(entries), max(1, batch_size)):
        batch = entries[start : start + max(1, batch_size)]
        if dry_run:
            _classify_batch(pack, batch, summary, seen)
        else:
            _import_batch(pack, batch, summary, seen, workers=max(1, workers))
        if progress:
            progress(summary)
    return summary
