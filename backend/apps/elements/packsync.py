"""The `sync_element_packs` pipeline: plan -> fetch -> normalise -> import, idempotent and resumable.

Everything network- or archive-related sits behind `PackSource`, so the pipeline is tested with an in-memory
fake; generated packs never need a source at all. The database side is boring on purpose: a pack's elements
are imported in batches that each commit on their own (`Element.objects.bulk_import`), and the pack is only
marked as synced (its `sync_fingerprint`) once every batch went through, so a run that was interrupted
simply continues where it stopped, and a pack that is up to date is skipped without any download.
"""

from __future__ import annotations

import hashlib
import posixpath
import re
import time
from collections import defaultdict
from collections.abc import Callable, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from django.db import transaction
from django.utils import timezone
from django.utils.text import slugify

from apps.core.svg import SvgError

from .bulk import DEFAULT_BATCH_SIZE, ImportEntry, bulk_import
from .generated import generated_files
from .importer import ImportSummary, element_key, element_name, element_tags, ensure_pack
from .manifest import GeneratedSource, NpmSource, PackSpec, SourceSpec, UrlsSource
from .models import Element, ElementPack
from .normalize import normalize_svg
from .readers import ReaderError, read_iconify_json
from .search import MAX_TAGS, clean_tags
from .sources import PackSource, SourceError, SourceUnavailable, matcher
from .tagdata import TagDataError, parse_tags

Log = Callable[[str], None]

MAX_SVG_BYTES = 2 * 1024 * 1024
#: Added to the attribution of a pack that was synced with its brand logos.
TRADEMARK_NOTICE = (
    "Logos are trademarks of their respective owners; use them according to their brand guidelines."
)
BRAND_TAGS = ("brand", "logo")
PRUNE_CHUNK = 500


class LicenseMismatch(SourceError):
    """The licence text shipped with the release is not the one the manifest was verified against."""


@dataclass(frozen=True)
class SyncOptions:
    concurrency: int = 4
    force: bool = False
    dry_run: bool = False
    prune: bool = False
    #: Keep the elements matching a pack's `naming.brand` (see `DOORY_ELEMENTS_BRAND_LOGOS`).
    brand_logos: bool = False
    batch_size: int = DEFAULT_BATCH_SIZE


@dataclass
class PackResult:
    pack_id: str
    status: str = ""  # synced | up-to-date | dry-run | failed | not-attempted
    source_ref: str = ""
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    skipped: list[tuple[str, str]] = field(default_factory=list)
    duplicates: int = 0
    stale: int = 0
    pruned: int = 0
    #: Brand logos unpublished because the pack was synced with `brand_logos` off.
    logos_unpublished: int = 0
    warnings: list[str] = field(default_factory=list)
    error: str = ""
    seconds: float = 0.0

    @property
    def ok(self) -> bool:
        return self.status in ("synced", "up-to-date", "dry-run")

    @property
    def total(self) -> int:
        return self.created + self.updated + self.unchanged


@dataclass
class SyncReport:
    results: list[PackResult] = field(default_factory=list)
    aborted: str = ""  # set when the source became unreachable and the run stopped early

    @property
    def failed(self) -> list[PackResult]:
        return [r for r in self.results if r.status in ("failed", "not-attempted")]


# ---- turning files into entries --------------------------------------------------------------------------


@dataclass(frozen=True)
class _Item:
    key: str
    name: str
    svg: bytes
    tags: tuple[str, ...]
    #: Upstream lists this name in its tag data (an alias of another icon usually is not).
    canonical: bool = True


def check_license(pack: PackSpec, files: dict[str, bytes]) -> None:
    """Refuse a release whose licence file no longer says what the manifest was verified against."""
    spec = pack.license
    if not spec.file:
        return
    data = files.get(spec.file)
    if data is None:
        raise LicenseMismatch(f"The licence file {spec.file} is missing from the release.")
    if not re.search(spec.match, data.decode("utf-8", errors="replace")):
        raise LicenseMismatch(
            f"{spec.file} no longer matches /{spec.match}/: the licence of this release may have changed. "
            f"Read it, then update the pack's license entry in the manifest."
        )


def _strip(stem: str, pack: PackSpec) -> str:
    naming = pack.naming
    if naming.strip_prefix and stem.startswith(naming.strip_prefix):
        stem = stem[len(naming.strip_prefix) :]
    if naming.strip_suffix and stem.endswith(naming.strip_suffix):
        stem = stem[: -len(naming.strip_suffix)]
    return stem


def _svg_paths(pack: PackSpec, files: dict[str, bytes]) -> list[str]:
    include, exclude = matcher(pack.files.include), matcher(pack.files.exclude)
    return sorted(path for path in files if include(path) and not exclude(path))


def _tag_table(pack: PackSpec, files: dict[str, bytes], warnings: list[str]) -> dict[str, list[str]]:
    if pack.tags.format == "none":
        return {}
    data = files.get(pack.tags.file)
    if data is None:
        warnings.append(f"tag file {pack.tags.file} not found in the release; using name words only")
        return {}
    try:
        return parse_tags(pack.tags.format, data)
    except TagDataError as exc:
        warnings.append(f"tag file {pack.tags.file}: {exc}; using name words only")
        return {}


def _name_words(key: str) -> list[str]:
    return [w for w in re.split(r"[-_/\s]+", key.lower()) if len(w) > 1 and not w.isdigit()]


def _items(
    pack: PackSpec, files: dict[str, bytes], warnings: list[str], brand_logos: bool = False
) -> tuple[list[_Item], list[tuple[str, str]]]:
    """The named SVG documents of a downloaded pack (before normalisation) and the unusable files."""
    skipped: list[tuple[str, str]] = []
    table = _tag_table(pack, files, warnings)
    items: list[_Item] = []
    left_out = re.compile(pack.naming.skip).search if pack.naming.skip else (lambda _key: None)
    is_brand = re.compile(pack.naming.brand).search if pack.naming.brand else (lambda _key: None)

    def wanted(key: str) -> bool:
        return not left_out(key) and (brand_logos or not is_brand(key))

    def extra(key: str) -> list[str]:
        return list(BRAND_TAGS) if is_brand(key) else []

    if pack.files.reader == "iconify-json":
        for path in _svg_paths(pack, files):
            try:
                icons = read_iconify_json(files[path])
            except ReaderError as exc:
                skipped.append((path, str(exc)))
                continue
            for icon in icons:
                key = slugify(icon.name)
                if key and wanted(key):
                    hints = [*extra(key), *(alias.replace("-", " ") for alias in icon.aliases)]
                    items.append(_item(key, icon.name, icon.svg, table, hints))
        return items, skipped
    hints_by_stem: dict[str, list[str]] = {}
    if isinstance(pack.source, UrlsSource):
        hints_by_stem = {f.name.removesuffix(".svg"): list(f.tags) for f in pack.source.files}
    for path in _svg_paths(pack, files):
        stem = _strip(posixpath.splitext(posixpath.basename(path))[0], pack)
        key = slugify(stem)
        if not key:
            skipped.append((path, "the file name has no usable letters or digits"))
        elif not wanted(key):
            continue
        elif len(files[path]) > MAX_SVG_BYTES:
            skipped.append((path, "the file is larger than 2 MB"))
        else:
            items.append(_item(key, stem, files[path], table, [*extra(key), *hints_by_stem.get(stem, [])]))
    return items, skipped


def _item(key: str, stem: str, svg: bytes, table: dict[str, list[str]], hints: list[str]) -> _Item:
    brand = [tag for tag in hints if tag in BRAND_TAGS]
    tags = clean_tags([*brand, *table.get(stem, []), *hints, *_name_words(key)], MAX_TAGS)
    return _Item(
        key=key, name=element_name(stem), svg=svg, tags=tuple(tags), canonical=stem in table or not table
    )


def _generated_items(pack: PackSpec, files: dict[str, bytes]) -> tuple[list[_Item], list[tuple[str, str]]]:
    """Generated artwork is already in final form; names and tags come from its folders and file names."""
    items: list[_Item] = []
    skipped: list[tuple[str, str]] = []
    for path in sorted(files):
        relative = Path(path)
        try:
            key = element_key(relative)
        except ValueError as exc:
            skipped.append((path, str(exc)))
            continue
        name = element_name(relative.stem)
        items.append(
            _Item(key=key, name=name, svg=files[path], tags=tuple(element_tags(relative.parent.parts, name)))
        )
    return items, skipped


def build_entries(
    pack: PackSpec, files: dict[str, bytes], warnings: list[str], brand_logos: bool = False
) -> tuple[list[ImportEntry], list[tuple[str, str]], int]:
    """Normalise the pack's files into import entries. Returns `(entries, skipped, duplicates merged)`.

    Icons that turn out identical after normalisation (an upstream alias such as `home` for `house`) are
    merged: the first name in sorted order that has tag data wins and the others become tags of it.
    """
    check_license(pack, files)
    if pack.is_generated:
        items, skipped = _generated_items(pack, files)
    else:
        items, skipped = _items(pack, files, warnings, brand_logos)
    prepared: list[tuple[_Item, bytes]] = []
    for item in items:
        try:
            data = item.svg if pack.is_generated else normalize_svg(item.svg, pack.normalize)
        except SvgError as exc:
            skipped.append((item.key, str(exc)))
            continue
        prepared.append((item, data))

    groups: dict[str, list[tuple[_Item, bytes]]] = defaultdict(list)
    for item, data in prepared:
        groups[hashlib.sha256(data).hexdigest()].append((item, data))
    chosen: list[tuple[_Item, bytes, list[_Item]]] = []
    duplicates = 0
    for group in groups.values():
        ordered = sorted(group, key=lambda pair: (not pair[0].canonical, pair[0].key))
        chosen.append((ordered[0][0], ordered[0][1], [other for other, _ in ordered[1:]]))
        duplicates += len(ordered) - 1
    entries = [
        ImportEntry(
            key=item.key,
            name=item.name,
            svg=data,
            style=pack.style,
            tags=clean_tags(
                [*item.tags, *(word for other in merged for word in (other.name, *other.tags))], MAX_TAGS
            ),
        )
        for item, data, merged in sorted(chosen, key=lambda row: row[0].key)
    ]
    return entries, skipped, duplicates


# ---- one pack ----------------------------------------------------------------------------------------------


def is_up_to_date(pack: PackSpec, brand_logos: bool = False) -> bool:
    """True when the pack was synced from this exact manifest entry (and normaliser, and brand-logo choice)
    and has elements."""
    row = ElementPack.objects.filter(slug=pack.id).first()
    fingerprint = pack.fingerprint_for(brand_logos)
    return bool(row is not None and row.sync_fingerprint == fingerprint and row.elements.exists())


def _attribution(pack: PackSpec, brand_logos: bool) -> str:
    if not (brand_logos and pack.has_brand):
        return pack.attribution
    return f"{pack.attribution} {TRADEMARK_NOTICE}".strip()


def _unpublish(row: ElementPack, keys: list[str]) -> int:
    count = 0
    for start in range(0, len(keys), PRUNE_CHUNK):
        chunk = keys[start : start + PRUNE_CHUNK]
        count += row.elements.filter(key__in=chunk, is_published=True).update(is_published=False)
    return count


def import_pack(pack: PackSpec, files: dict[str, bytes], options: SyncOptions, log: Log) -> PackResult:
    """Import already-fetched `files` into the database. Raises `SourceError` (e.g. `LicenseMismatch`)."""
    result = PackResult(pack_id=pack.id, source_ref=pack.source_ref)
    started = time.monotonic()
    entries, skipped, duplicates = build_entries(pack, files, result.warnings, options.brand_logos)
    result.skipped, result.duplicates = skipped, duplicates
    if not entries:
        raise SourceError("the release contains no usable artwork (check the manifest's file patterns)")

    if options.dry_run:
        existing = ElementPack.objects.filter(slug=pack.id).first()
        summary = (
            bulk_import(existing, entries, dry_run=True, batch_size=options.batch_size)
            if existing
            else ImportSummary(created=len(entries))
        )
        result.status = "dry-run"
    else:
        row, _ = ensure_pack(
            pack.id,
            name=pack.name,
            kind=pack.kind,
            license=pack.license.spdx,
            source_url=pack.homepage,
            description=pack.description,
            sort_order=pack.sort_order,
            license_url=pack.license.url,
            attribution=_attribution(pack, options.brand_logos),
        )
        summary = Element.objects.bulk_import(
            row,
            entries,
            batch_size=options.batch_size,
            workers=options.concurrency,
            progress=lambda s: log(f"    {pack.id}: {s.created + s.updated + s.unchanged}/{len(entries)}"),
        )
        produced = {entry.key for entry in entries}
        stale = sorted(set(row.elements.filter(is_published=True).values_list("key", flat=True)) - produced)
        logos: list[str] = []
        if pack.has_brand and not options.brand_logos:
            # Logos left out by this sync are unpublished right away, not reported as stale: otherwise the
            # fingerprint is current again and a later `--prune` would skip the pack and keep them.
            is_brand = re.compile(pack.naming.brand).search
            logos = [key for key in stale if is_brand(key)]
            stale = [key for key in stale if not is_brand(key)]
        result.stale = len(stale)
        result.logos_unpublished = _unpublish(row, logos)
        if options.prune:
            result.pruned = _unpublish(row, stale)
        with transaction.atomic():
            row.source_ref, row.sync_fingerprint, row.synced_at = (
                pack.source_ref,
                pack.fingerprint_for(options.brand_logos),
                timezone.now(),
            )
            row.save(update_fields=["source_ref", "sync_fingerprint", "synced_at", "updated_at"])
        result.status = "synced"
    result.created, result.updated, result.unchanged = summary.created, summary.updated, summary.unchanged
    result.skipped += summary.skipped
    result.seconds = time.monotonic() - started
    return result


# ---- many packs --------------------------------------------------------------------------------------------


def _network_spec(pack: PackSpec) -> NpmSource | UrlsSource | None:
    return None if isinstance(pack.source, GeneratedSource) else pack.source


class _Fetcher:
    """Downloads each distinct source once (several packs can share one npm release) and a few at a time."""

    def __init__(self, packs: Sequence[PackSpec], source: PackSource, concurrency: int) -> None:
        self.source = source
        self.window = max(1, concurrency)
        self.pool = ThreadPoolExecutor(max_workers=self.window, thread_name_prefix="packsync")
        self.patterns: dict[SourceSpec, set[str]] = defaultdict(set)
        self.order: list[SourceSpec] = []
        self.users: dict[SourceSpec, int] = defaultdict(int)
        for pack in packs:
            spec = _network_spec(pack)
            if spec is None:
                continue
            if spec not in self.patterns:
                self.order.append(spec)
            self.patterns[spec].update(pack.patterns)
            self.users[spec] += 1
        self.futures: dict[SourceSpec, Future[dict[str, bytes]]] = {}

    def _submit_ahead(self, spec: SourceSpec) -> None:
        position = self.order.index(spec)
        for upcoming in self.order[position : position + self.window]:
            if upcoming not in self.futures:
                self.futures[upcoming] = self.pool.submit(
                    self.source.fetch, upcoming, sorted(self.patterns[upcoming])
                )

    def files_for(self, pack: PackSpec) -> dict[str, bytes]:
        if isinstance(pack.source, GeneratedSource):
            return generated_files(pack.source)
        spec = pack.source
        self._submit_ahead(spec)
        try:
            return self.futures[spec].result()
        finally:
            self.users[spec] -= 1
            if self.users[spec] <= 0:
                self.futures.pop(spec, None)

    def skip(self, pack: PackSpec) -> None:
        spec = _network_spec(pack)
        if spec is not None:
            self.users[spec] -= 1
            if self.users[spec] <= 0:
                future = self.futures.pop(spec, None)
                if future is not None:
                    future.cancel()

    def close(self) -> None:
        self.pool.shutdown(wait=False, cancel_futures=True)


def sync_packs(
    packs: Sequence[PackSpec], source: PackSource, options: SyncOptions, log: Log = lambda _: None
) -> SyncReport:
    """Sync `packs` in order. A pack that fails is reported and the rest continue; an unreachable source
    stops the run (the packs not yet attempted are reported as such) so a dead network costs seconds, not
    a timeout per pack."""
    report = SyncReport()
    total = len(packs)
    width = len(str(total))
    todo: list[PackSpec] = []
    for index, pack in enumerate(packs, start=1):
        if not options.force and is_up_to_date(pack, options.brand_logos):
            report.results.append(
                PackResult(pack_id=pack.id, status="up-to-date", source_ref=pack.source_ref)
            )
            log(f"[{index:>{width}}/{total}] {pack.id}: up to date ({pack.source_ref}), nothing to download")
            continue
        todo.append(pack)
    fetcher = _Fetcher(todo, source, options.concurrency)
    try:
        for index, pack in enumerate(packs, start=1):
            if pack not in todo:
                continue
            prefix = f"[{index:>{width}}/{total}] {pack.id}"
            if report.aborted:
                report.results.append(PackResult(pack_id=pack.id, status="not-attempted"))
                fetcher.skip(pack)
                continue
            log(f"{prefix}: {pack.source_ref} ...")
            try:
                files = fetcher.files_for(pack)
                result = import_pack(pack, files, options, log)
            except SourceUnavailable as exc:
                report.aborted = str(exc)
                report.results.append(PackResult(pack_id=pack.id, status="failed", error=str(exc)))
                log(f"{prefix}: {exc}. Stopping; run again to resume.")
                continue
            except SourceError as exc:
                report.results.append(PackResult(pack_id=pack.id, status="failed", error=str(exc)))
                log(f"{prefix}: FAILED: {exc}")
                continue
            report.results.append(result)
            log(
                f"{prefix}: {result.total} elements ({result.created} created, {result.updated} updated, "
                f"{result.unchanged} unchanged"
                + (f", {result.duplicates} aliases merged" if result.duplicates else "")
                + (f", {len(result.skipped)} skipped" if result.skipped else "")
                + f") in {result.seconds:.1f}s"
                + (" [dry run]" if result.status == "dry-run" else "")
            )
            for warning in result.warnings:
                log(f"    ! {warning}")
            for label, reason in result.skipped[:5]:
                log(f"    skipped {label}: {reason}")
            if len(result.skipped) > 5:
                log(f"    ... and {len(result.skipped) - 5} more skipped")
            if result.logos_unpublished:
                log(f"    {result.logos_unpublished} brand logo(s) unpublished (brand logos are off).")
            if result.stale:
                log(
                    f"    {result.stale} element(s) are no longer part of this pack"
                    + (
                        f"; {result.pruned} unpublished."
                        if options.prune
                        else " (run with --prune to unpublish them)."
                    )
                )
    finally:
        fetcher.close()
    return report
