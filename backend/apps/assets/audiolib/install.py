"""Putting the library where the web server can serve it, and writing the catalogue the editor reads.

Everything lives under `MEDIA_ROOT/audio/` on local disk (also with `USE_S3`: the editor fetches the
catalogue and the files from its own origin, which the production CSP requires):

    audio/index.json                    the catalogue (small, revalidated by the browser)
    audio/music/<id>-<hash12>.ogg       the files; the name holds the start of the hash (cached for good)
    audio/sfx/<id>-<hash12>.ogg
    audio/packs/<pack>/<id>-<hash12>.<ext>

Files are written to a `.part` name and moved into place only after size, SHA-256 and a header check
passed, so a half-written or substituted file is never served; the catalogue is replaced atomically and
only lists files that are in place. Running the command again changes nothing.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from django.conf import settings

from apps.assets.audio import AudioError, parse_audio

from .manifest import Manifest, PackSpec, TrackSpec
from .packs import PackError, PackSource, PackUnavailable, read_members, verify_archive

logger = logging.getLogger(__name__)

INDEX_NAME = "index.json"
_HASHED = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]*-[0-9a-f]{12}\.(?:ogg|mp3|m4a|wav|weba)$")


def audio_root() -> Path:
    return Path(settings.MEDIA_ROOT) / "audio"


def index_path(root: Path | None = None) -> Path:
    return (root or audio_root()) / INDEX_NAME


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def is_installed(track: TrackSpec, root: Path | None = None, *, relative: str | None = None) -> bool:
    """True when the file is in place with the pinned size (the hash was checked when it was written)."""
    path = (root or audio_root()) / (relative or track.relative_path)
    try:
        return path.is_file() and path.stat().st_size == track.bytes
    except OSError:
        return False


def _intact(path: Path, track: TrackSpec) -> bool:
    try:
        return path.is_file() and path.stat().st_size == track.bytes and _hash_file(path) == track.sha256
    except OSError:
        return False


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass
class Result:
    item: str
    status: str  # installed | up-to-date | would-install | failed
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.status != "failed"


@dataclass
class Report:
    results: list[Result] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    index_written: bool = False
    #: A pack source cannot be reached at all; the remaining packs were not tried.
    aborted: str = ""

    @property
    def failed(self) -> list[Result]:
        return [r for r in self.results if not r.ok]


@dataclass(frozen=True)
class Options:
    force: bool = False
    dry_run: bool = False
    prune: bool = False


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".part")
    try:
        with os.fdopen(handle, "wb") as out:
            out.write(data)
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def entry_json(track: TrackSpec, *, source: str, license_id: str, relative: str) -> dict:
    """One row of the catalogue the editor reads."""
    entry: dict = {"id": track.id, "kind": track.kind, "title": track.title}
    if track.kind == "music":
        entry["mood"] = track.mood
    else:
        entry["category"] = track.category
    if track.genre:
        entry["genre"] = track.genre
    entry["tags"] = list(track.tags)
    if track.bpm:
        entry["bpm"] = track.bpm
    if track.key:
        entry["key"] = track.key
    entry.update(loop=track.loop, channels=track.channels, durationMs=track.duration_ms)
    if track.lufs is not None:
        entry["lufs"] = track.lufs
    entry.update(bytes=track.bytes, peaks=list(track.peaks), file=relative, license=license_id, source=source)
    return entry


def read_index(root: Path | None = None) -> dict | None:
    try:
        data = json.loads(index_path(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and isinstance(data.get("tracks"), list) else None


def _install_bytes(
    data: bytes, track: TrackSpec, target: Path, options: Options, report: Report, name: str
) -> None:
    if options.dry_run:
        report.results.append(Result(name, "would-install"))
        return
    _atomic_write(target, data)
    report.results.append(Result(name, "installed"))


def _library_track(track: TrackSpec, source_dir: Path, root: Path, options: Options, report: Report) -> bool:
    target = root / track.relative_path
    if not options.force and _intact(target, track):
        report.results.append(Result(track.id, "up-to-date"))
        return True
    # A copy that is already in place stays in the catalogue even when the source cannot replace it right now.
    in_place = _intact(target, track)
    source = source_dir / track.file
    try:
        data = source.read_bytes()
    except OSError:
        report.results.append(Result(track.id, "failed", f"{track.file} is not in {source_dir}"))
        return in_place
    if len(data) != track.bytes or sha256_bytes(data) != track.sha256:
        report.results.append(
            Result(track.id, "failed", f"{track.file}: the content does not match the manifest")
        )
        return in_place
    try:
        parse_audio(data)
    except AudioError as exc:
        report.results.append(Result(track.id, "failed", f"{track.file}: not a valid audio file ({exc})"))
        return in_place
    _install_bytes(data, track, target, options, report, track.id)
    return True


def _pack_tracks(
    pack: PackSpec, source: PackSource, root: Path, options: Options, report: Report
) -> dict[str, str]:
    """Installs a pack; returns `{track id: relative path}` of the tracks that are in place afterwards."""
    relative = {t.id: f"packs/{pack.id}/{t.stored_name}" for t in pack.tracks}
    missing = [t for t in pack.tracks if options.force or not _intact(root / relative[t.id], t)]
    if not missing:
        report.results.extend(Result(f"{pack.id}/{t.id}", "up-to-date") for t in pack.tracks)
        return relative
    with tempfile.TemporaryDirectory(prefix="doory-pack-") as scratch:
        archive = Path(scratch) / pack.archive_name
        try:
            source.fetch(pack, archive)
            verify_archive(pack, archive)
            blobs = read_members(archive, pack, missing)
        except PackUnavailable:
            raise
        except PackError as exc:
            report.results.append(Result(pack.id, "failed", str(exc)))
            return {}
    for track in pack.tracks:
        name = f"{pack.id}/{track.id}"
        if track.id in blobs:
            _install_bytes(blobs[track.id], track, root / relative[track.id], options, report, name)
        else:
            report.results.append(Result(name, "up-to-date"))
    return relative


def _prune(root: Path, keep: set[str], options: Options, report: Report, *, packs: bool) -> None:
    folders = [root / "music", root / "sfx"]
    if packs:
        folders += [p for p in (root / "packs").glob("*") if p.is_dir()] if (root / "packs").is_dir() else []
    for folder in folders:
        if not folder.is_dir():
            continue
        for path in sorted(folder.iterdir()):
            relative = path.relative_to(root).as_posix()
            if relative in keep or not path.is_file():
                continue
            if not (_HASHED.match(path.name) or path.name.endswith(".part")):
                continue
            report.removed.append(relative)
            if not options.dry_run:
                path.unlink(missing_ok=True)


def sync(
    manifest: Manifest,
    *,
    source_dir: Path,
    packs: list[PackSpec],
    pack_source: PackSource | None,
    options: Options,
    root: Path | None = None,
    log: Callable[[str], None] = lambda _: None,
) -> Report:
    """Installs the library (and the chosen packs) and rewrites the catalogue. See the module docstring."""
    root = root or audio_root()
    report = Report()
    if not options.dry_run:
        root.mkdir(parents=True, exist_ok=True)

    entries: list[dict] = []
    keep: set[str] = set()
    license_id = manifest.license.spdx
    for track in manifest.tracks:
        usable = _library_track(track, source_dir, root, options, report)
        if not report.results[-1].ok:
            log(f"{track.id}: {report.results[-1].detail}")
        if usable:
            entries.append(
                entry_json(track, source="doory", license_id=license_id, relative=track.relative_path)
            )
            keep.add(track.relative_path)

    # Packs that were installed earlier stay in the catalogue as long as the manifest still lists them.
    previous = read_index(root) or {}
    chosen = {p.id for p in packs}
    installed: dict[str, dict[str, str]] = {}
    for pack in manifest.packs:
        if pack.id in chosen:
            if pack_source is None:
                report.results.append(Result(pack.id, "failed", "no source for the pack"))
                continue
            try:
                relative = _pack_tracks(pack, pack_source, root, options, report)
            except PackUnavailable as exc:
                report.aborted = str(exc)
                break
            if relative:
                installed[pack.id] = relative
        else:
            kept = {
                e["id"]: e["file"]
                for e in previous.get("tracks", [])
                if isinstance(e, dict) and e.get("source") == pack.id and isinstance(e.get("file"), str)
            }
            ok = {
                t.id: kept[t.id]
                for t in pack.tracks
                if t.id in kept and is_installed(t, root, relative=kept[t.id])
            }
            if ok:
                installed[pack.id] = ok
    pack_entries: list[dict] = []
    for pack in manifest.packs:
        for track in pack.tracks:
            relative = installed.get(pack.id, {}).get(track.id)
            if relative and (options.dry_run or (root / relative).is_file()):
                pack_entries.append(
                    entry_json(track, source=pack.id, license_id=pack.license.spdx, relative=relative)
                )
                keep.add(relative)

    catalogue = {
        "schema": 1,
        "release": manifest.release,
        "license": manifest.license.as_json(),
        "tracks": entries + pack_entries,
        "packs": [
            {
                "id": pack.id,
                "name": pack.name,
                "homepage": pack.homepage,
                "license": pack.license.as_json(),
                "attribution": pack.attribution,
            }
            for pack in manifest.packs
            if pack.id in installed
        ],
    }
    encoded = (json.dumps(catalogue, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    target = index_path(root)
    try:
        current = target.read_bytes()
    except OSError:
        current = None
    if entries and current != encoded and not options.dry_run:
        _atomic_write(target, encoded)
        report.index_written = True
    _prune(root, keep, options, report, packs=options.prune)
    return report
