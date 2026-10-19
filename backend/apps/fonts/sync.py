"""The `sync_fonts` pipeline: plan -> download (4 at a time) -> store -> register, idempotent and resumable.

Everything network-related sits behind `FontSource`, so the pipeline is tested with an in-memory fake. The
filesystem/database side is deliberately boring: files land at deterministic paths and a variant row is
only written after its file is safely stored, so an interrupted run can simply be started again.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.db import transaction

from .catalog import curated_by_id, unicode_ranges
from .models import UNRANKED, FontFamily, FontFormat, FontOrigin, FontVariant
from .sources import (
    FamilyMeta,
    FamilyNotFound,
    FileNotAvailable,
    FontSource,
    SourceError,
    SourceUnavailable,
    is_valid_font_id,
    normalize_category,
)

MAX_WOFF2_BYTES = 5 * 1024 * 1024
MIN_WOFF2_BYTES = 64
PERMISSIVE_LICENSE = re.compile(r"^(ofl|sil|apache|ufl|ubuntu)", re.IGNORECASE)
SUBSET_ORDER = {"latin": 0, "latin-ext": 1}
SUBSET_NAMES = (
    "latin-ext|latin|cyrillic-ext|cyrillic|greek-ext|greek|vietnamese|devanagari|bengali|arabic|hebrew|thai|"
    "korean|japanese|chinese-simplified|chinese-traditional|chinese-hongkong|armenian|ethiopic|georgian|"
    "gujarati|gurmukhi|kannada|khmer|lao|malayalam|myanmar|sinhala|tamil|telugu|math|symbols"
)
FILENAME = re.compile(
    rf"^(?P<id>[a-z0-9][a-z0-9-]*?)-(?P<subset>{SUBSET_NAMES})-(?P<weight>[1-9]00)-(?P<style>normal|italic)"
    r"\.woff2$"
)

Log = Callable[[str], None]
Triple = tuple[int, str, str]  # weight, style, subset


#: `--subsets auto`: every subset a family offers except these. Chinese, Japanese and Korean faces are
#: hundreds of files each; name those subsets on purpose to install them.
AUTO_SKIPPED_SUBSETS = frozenset(
    {"japanese", "korean", "chinese-simplified", "chinese-traditional", "chinese-hongkong", "math", "symbols"}
)


@dataclass(frozen=True)
class SyncOptions:
    subsets: tuple[str, ...] = ("latin",)
    weights: tuple[int, ...] = (400, 700)
    styles: tuple[str, ...] = ("normal", "italic")
    concurrency: int = 4


@dataclass
class FamilyResult:
    font_id: str
    downloaded: int = 0
    existing: int = 0
    not_offered: int = 0
    failed: list[str] = field(default_factory=list)
    skipped: str = ""


@dataclass
class SyncReport:
    results: list[FamilyResult] = field(default_factory=list)
    not_found: list[str] = field(default_factory=list)
    aborted: str = ""  # set when the source became unreachable and the run stopped early

    @property
    def downloaded(self) -> int:
        return sum(r.downloaded for r in self.results)

    @property
    def existing(self) -> int:
        return sum(r.existing for r in self.results)

    @property
    def failures(self) -> list[str]:
        return [f"{r.font_id}: {item}" for r in self.results for item in r.failed]

    @property
    def skipped(self) -> list[tuple[str, str]]:
        return [(r.font_id, r.skipped) for r in self.results if r.skipped]


def is_permissive_license(name: str) -> bool:
    return bool(PERMISSIVE_LICENSE.match(name.strip()))


def system_file_path(font_id: str, subset: str, weight: int, style: str) -> str:
    return f"fonts/system/{font_id}/{font_id}-{subset}-{weight}-{style}.woff2"


def check_woff2(data: bytes) -> str | None:
    """Reason the bytes cannot be a usable woff2 file, else None."""
    if not MIN_WOFF2_BYTES <= len(data) <= MAX_WOFF2_BYTES:
        return "unexpected file size"
    if data[:4] != b"wOF2":
        return "not a woff2 file"
    return None


def subset_sort_key(subset: str) -> tuple[int, str]:
    return SUBSET_ORDER.get(subset, 2), subset


def resolve_ids(names: Iterable[str]) -> list[str]:
    """Family names ("Open Sans") or Fontsource ids ("open-sans") -> ids, via the curated list when known."""
    curated = curated_by_id()
    by_name = {font.family.lower(): font.id for font in curated.values()}
    ids = []
    for name in names:
        cleaned = name.strip()
        ids.append(by_name.get(cleaned.lower()) or re.sub(r"[^a-z0-9]+", "-", cleaned.lower()).strip("-"))
    return ids


def ensure_family(font_id: str, family: str, category: str, license_name: str, rank: int) -> FontFamily:
    """Get or create the built-in family `font_id`, refreshing its catalog metadata."""
    row = FontFamily.objects.filter(owner__isnull=True, slug=font_id).first()
    if row is None:
        row = FontFamily.objects.filter(owner__isnull=True, family=family).first()
    if row is None:
        row = FontFamily(slug=font_id, family=family)
    row.slug, row.family, row.category = font_id, family, category
    row.license, row.source, row.popularity = license_name or "OFL-1.1", FontOrigin.FONTSOURCE, rank
    row.save()
    return row


def refresh_scripts(family: FontFamily) -> None:
    subsets = {v for v in family.variants.values_list("subset", flat=True) if v}
    ordered = sorted(subsets, key=subset_sort_key)
    if ordered != family.scripts:
        family.scripts = ordered
        family.save(update_fields=["scripts", "updated_at"])


def store_variant(
    family: FontFamily, font_id: str, subset: str, weight: int, style: str, data: bytes, unicode_range: str
) -> None:
    """Write the file, then the row. Replaces a stale file at the same path."""
    path = system_file_path(font_id, subset, weight, style)
    if default_storage.exists(path):
        default_storage.delete(path)
    saved = default_storage.save(path, ContentFile(data))
    FontVariant.objects.update_or_create(
        family=family,
        weight=weight,
        style=style,
        subset=subset,
        defaults={
            "file": saved,
            "format": FontFormat.WOFF2,
            "size": len(data),
            "unicode_range": unicode_range,
        },
    )


def _subsets_for(meta: FamilyMeta, options: SyncOptions) -> list[str]:
    """The subsets to fetch for one family: those asked for, `auto` being every one it offers but CJK."""
    wanted: list[str] = []
    for subset in options.subsets:
        names = [s for s in meta.subsets if s not in AUTO_SKIPPED_SUBSETS] if subset == "auto" else [subset]
        wanted.extend(name for name in names if name not in wanted)
    return sorted(wanted, key=subset_sort_key)


def _plan(meta: FamilyMeta, options: SyncOptions) -> list[Triple]:
    plan = []
    for subset in _subsets_for(meta, options):
        if subset not in meta.subsets:
            continue
        for weight in options.weights:
            for style in options.styles:
                if weight not in meta.weights or style not in meta.styles:
                    continue
                if meta.available is not None and (weight, style, subset) not in meta.available:
                    continue
                plan.append((weight, style, subset))
    return plan


def _download(source: FontSource, meta: FamilyMeta, triple: Triple) -> tuple[Triple, bytes | None, str]:
    weight, style, subset = triple
    try:
        return triple, source.fetch(meta, subset, weight, style), ""
    except FileNotAvailable:
        return triple, None, "not offered"
    except SourceUnavailable:
        raise
    except SourceError as exc:
        return triple, None, str(exc)


def sync_family(
    source: FontSource, font_id: str, options: SyncOptions, executor: ThreadPoolExecutor
) -> FamilyResult:
    """Sync one family. Raises `SourceUnavailable` when the source cannot be reached."""
    result = FamilyResult(font_id)
    try:
        meta = source.metadata(font_id)
    except FamilyNotFound:
        result.skipped = "not found at the source"
        return result
    except SourceUnavailable:
        raise
    except SourceError as exc:
        result.failed.append(f"metadata: {exc}")
        return result
    if not meta.is_font:
        result.skipped = "not a text font"
        return result
    if not is_permissive_license(meta.license):
        result.skipped = f"licence {meta.license or 'unknown'!r} is not OFL/Apache/Ubuntu"
        return result

    curated = curated_by_id().get(font_id)
    category = curated.category if curated else meta.category
    rank = curated.popularity if curated else UNRANKED
    family = FontFamily.objects.filter(owner__isnull=True, slug=font_id).first()
    stored = {(v.weight, v.style, v.subset): v for v in family.variants.all()} if family else {}
    ranges = unicode_ranges()

    todo: list[Triple] = []
    for triple in _plan(meta, options):
        variant = stored.get(triple)
        if variant is not None and default_storage.exists(variant.file.name):
            result.existing += 1
        else:
            todo.append(triple)

    futures: list[Future] = [executor.submit(_download, source, meta, triple) for triple in todo]
    try:
        for future in futures:
            (weight, style, subset), data, error = future.result()
            if data is None:
                if error == "not offered":
                    result.not_offered += 1
                else:
                    result.failed.append(f"{subset} {weight} {style}: {error}")
                continue
            problem = check_woff2(data)
            if problem:
                result.failed.append(f"{subset} {weight} {style}: {problem}")
                continue
            with transaction.atomic():
                family = family or ensure_family(font_id, meta.family, category, meta.license, rank)
                unicode_range = meta.unicode_ranges.get(subset) or ranges.get(subset, "")
                store_variant(family, font_id, subset, weight, style, data, unicode_range)
            result.downloaded += 1
    except BaseException:
        for pending in futures:
            pending.cancel()
        raise
    if family is not None:
        refresh_scripts(ensure_family(font_id, meta.family, category, meta.license, rank))
    return result


def sync_families(
    source: FontSource, ids: list[str], options: SyncOptions, log: Log = lambda _: None
) -> SyncReport:
    """Sync every family in `ids`. Failures are collected per file; an unreachable source stops the run."""
    report = SyncReport()
    total = len(ids)
    width = len(str(total))
    with ThreadPoolExecutor(max_workers=max(1, options.concurrency), thread_name_prefix="fontsync") as pool:
        for index, font_id in enumerate(ids, start=1):
            if not is_valid_font_id(font_id):
                report.not_found.append(font_id)
                log(f"[{index:>{width}}/{total}] {font_id}: not a valid font id, skipped")
                continue
            try:
                result = sync_family(source, font_id, options, pool)
            except SourceUnavailable as exc:
                report.aborted = str(exc)
                log(f"[{index:>{width}}/{total}] {font_id}: {exc}. Stopping; run again to resume.")
                break
            report.results.append(result)
            if result.skipped:
                if result.skipped.startswith("not found"):
                    report.not_found.append(font_id)
                log(f"[{index:>{width}}/{total}] {font_id}: skipped ({result.skipped})")
                continue
            prefix = f"[{index:>{width}}/{total}] {font_id}"
            line = f"{prefix}: {result.downloaded} downloaded, {result.existing} already stored"
            if result.not_offered:
                line += f", {result.not_offered} not offered"
            if result.failed:
                line += f", {len(result.failed)} FAILED"
            log(line)
            for problem in result.failed:
                log(f"    ! {problem}")
    return report


def import_font_directory(
    directory: Path, *, license_name: str = "OFL-1.1", log: Log = lambda _: None
) -> SyncReport:
    """Register already-downloaded Fontsource files (`<id>-<subset>-<weight>-<style>.woff2`) offline.

    Family names, categories and ranks come from the curated list; unknown ids get a title-cased name.
    """
    curated, ranges = curated_by_id(), unicode_ranges()
    groups: dict[str, list[tuple[Path, str, int, str]]] = {}
    report = SyncReport()
    for path in sorted(p for p in directory.rglob("*.woff2") if p.is_file() and not p.is_symlink()):
        match = FILENAME.match(path.name)
        if not match:
            log(f"skipped {path.name}: does not match <id>-<subset>-<weight>-<style>.woff2")
            continue
        groups.setdefault(match["id"], []).append(
            (path, match["subset"], int(match["weight"]), match["style"])
        )
    for font_id, files in groups.items():
        result = FamilyResult(font_id)
        entry = curated.get(font_id)
        family = None
        for path, subset, weight, style in files:
            data = path.read_bytes() if path.stat().st_size <= MAX_WOFF2_BYTES else b""
            problem = check_woff2(data)
            if problem:
                result.failed.append(f"{path.name}: {problem}")
                continue
            if family is None:
                family = ensure_family(
                    font_id,
                    entry.family if entry else font_id.replace("-", " ").title(),
                    entry.category if entry else normalize_category(None),
                    license_name,
                    entry.popularity if entry else UNRANKED,
                )
            target = system_file_path(font_id, subset, weight, style)
            current = FontVariant.objects.filter(
                family=family, weight=weight, style=style, subset=subset
            ).first()
            if current is not None and default_storage.exists(target) and current.size == len(data):
                result.existing += 1
                continue
            store_variant(family, font_id, subset, weight, style, data, ranges.get(subset, ""))
            result.downloaded += 1
        if family is not None:
            refresh_scripts(family)
        report.results.append(result)
        counts = f"{result.downloaded} imported, {result.existing} already stored"
        log(f"{font_id}: {counts}, {len(result.failed)} rejected")
        for problem in result.failed:
            log(f"    ! {problem}")
    return report
