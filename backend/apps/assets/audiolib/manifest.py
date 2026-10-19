"""The audio manifest (`backend/data/audio_library.json`): what `sync_audio` installs.

Every file of the bundled library is a row with its SHA-256, size, duration and the data the editor
shows without decoding anything (title, mood or category, tags, tempo, loudness, waveform peaks).
Third-party packs are listed the same way under `packs`, each with its licence, the evidence for it, the
credit and the pinned archive. Loading validates all of it. Only public-domain dedications are accepted:
the licence rule lives in `ALLOWED_LICENSES`.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from django.conf import settings

MANIFEST_PATH = Path(settings.BASE_DIR) / "data" / "audio_library.json"
LIBRARY_DIR = Path(settings.BASE_DIR) / "data" / "audio"
SCHEMA = 1

#: Dedications to the public domain. Nothing that needs credit, forbids commercial use or demands share-alike.
ALLOWED_LICENSES = frozenset({"CC0-1.0", "Unlicense", "LicenseRef-PublicDomain"})
MOODS = ("upbeat", "calm", "cinematic", "lofi", "corporate", "playful", "romantic", "dramatic")
SFX_CATEGORIES = ("ui", "whoosh", "riser", "impact", "magic", "fun", "tech", "nature", "music", "voice")
KINDS = ("music", "sfx")
EXTENSIONS = ("ogg", "mp3", "m4a", "wav", "weba")

#: Where a pack archive may be downloaded from; a redirect is followed only to a host that matches as well.
ALLOWED_HOSTS = frozenset({"github.com", "zenodo.org", "archive.org", "opengameart.org"})
ALLOWED_HOST_SUFFIXES = (".githubusercontent.com", ".archive.org", ".zenodo.org", ".opengameart.org")

MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_TRACKS_PER_PACK = 500

_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_FILE = re.compile(r"^(?:music|sfx)/[a-z0-9][a-z0-9-]{0,47}\.(?:ogg|mp3|m4a|wav|weba)$")
_MEMBER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._()/-]{0,200}\.(?:ogg|mp3|m4a|wav|weba)$")
_TAG = re.compile(r"^[a-z0-9][a-z0-9 +&'-]{0,29}$")
_RELEASE = re.compile(r"^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,3}$")


class ManifestError(ValueError):
    """The manifest (or one of its entries) is not valid."""


def host_allowed(host: str | None) -> bool:
    return bool(host) and (host in ALLOWED_HOSTS or host.endswith(ALLOWED_HOST_SUFFIXES))


@dataclass(frozen=True)
class LicenseSpec:
    spdx: str
    url: str
    holder: str
    note: str = ""

    def as_json(self) -> dict[str, str]:
        out = {"spdx": self.spdx, "url": self.url, "holder": self.holder}
        if self.note:
            out["note"] = self.note
        return out


@dataclass(frozen=True)
class TrackSpec:
    id: str
    kind: str
    title: str
    tags: tuple[str, ...]
    file: str
    bytes: int
    sha256: str
    channels: int
    duration_ms: int
    loop: bool
    lufs: float | None
    peaks: tuple[int, ...]
    mood: str = ""
    category: str = ""
    genre: str = ""
    bpm: int | None = None
    key: str = ""

    @property
    def ext(self) -> str:
        return self.file.rsplit(".", 1)[-1]

    @property
    def stored_name(self) -> str:
        """The name on disk: it carries the start of the hash, so a changed file is a new URL."""
        stem = self.file.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        return f"{stem}-{self.sha256[:12]}.{self.ext}"

    @property
    def relative_path(self) -> str:
        return f"{self.file.split('/', 1)[0]}/{self.stored_name}"


@dataclass(frozen=True)
class PackSpec:
    id: str
    name: str
    description: str
    homepage: str
    license: LicenseSpec
    attribution: str
    archive_url: str
    archive_bytes: int
    archive_sha256: str
    archive_name: str
    tracks: tuple[TrackSpec, ...]
    #: Where each track sits inside the archive (`file` of a pack track is its path in the archive).
    members: dict[str, str]


@dataclass(frozen=True)
class Manifest:
    release: str
    license: LicenseSpec
    tracks: tuple[TrackSpec, ...]
    packs: tuple[PackSpec, ...]

    def pack(self, pack_id: str) -> PackSpec | None:
        return next((p for p in self.packs if p.id == pack_id), None)


# ---- validation --------------------------------------------------------------------------------


def _expect(cond: bool, message: str) -> None:
    if not cond:
        raise ManifestError(message)


def _only(raw: dict[str, Any], allowed: set[str], where: str) -> None:
    extra = sorted(set(raw) - allowed)
    _expect(not extra, f"{where}: unknown key(s) {', '.join(extra)}")


def _object(raw: Any, where: str) -> dict[str, Any]:
    _expect(isinstance(raw, dict), f"{where} must be an object")
    return raw


def _str(raw: dict[str, Any], key: str, where: str, *, limit: int = 200, required: bool = True) -> str:
    value = raw.get(key, "" if not required else None)
    _expect(isinstance(value, str), f"{where}: {key} must be text")
    value = value.strip()
    _expect(bool(value) or not required, f"{where}: {key} is required")
    _expect(len(value) <= limit and "\x00" not in value, f"{where}: {key} is too long")
    return value


def _int(raw: dict[str, Any], key: str, where: str, low: int, high: int) -> int:
    value = raw.get(key)
    _expect(
        isinstance(value, int) and not isinstance(value, bool) and low <= value <= high,
        f"{where}: {key} must be an integer from {low} to {high}",
    )
    return value


def _https_url(value: Any, where: str, *, hosts_only: bool) -> str:
    _expect(isinstance(value, str), f"{where}: URL must be a string")
    parsed = urlparse(value)
    _expect(
        parsed.scheme == "https" and bool(parsed.hostname) and not parsed.username and not parsed.fragment,
        f"{where}: {value!r} is not an https URL",
    )
    if hosts_only:
        _expect(host_allowed(parsed.hostname), f"{where}: host {parsed.hostname!r} is not allowed")
    return value


def _license(raw: Any, where: str, *, permitted: frozenset[str] = ALLOWED_LICENSES) -> LicenseSpec:
    raw = _object(raw, f"{where}.license")
    _only(raw, {"spdx", "url", "holder", "note", "evidence"}, f"{where}.license")
    spdx = _str(raw, "spdx", f"{where}.license", limit=60)
    _expect(
        spdx in permitted,
        f"{where}: licence {spdx!r} is not allowed (only {', '.join(sorted(permitted))})",
    )
    note = _str(raw, "note", f"{where}.license", limit=400, required=False) or _str(
        raw, "evidence", f"{where}.license", limit=400, required=False
    )
    return LicenseSpec(
        spdx=spdx,
        url=_https_url(raw.get("url"), f"{where}.license", hosts_only=False),
        holder=_str(raw, "holder", f"{where}.license", limit=120),
        note=note,
    )


def _tags(raw: dict[str, Any], where: str) -> tuple[str, ...]:
    tags = raw.get("tags", [])
    _expect(isinstance(tags, list) and len(tags) <= 8, f"{where}: tags must be a list of at most 8")
    for tag in tags:
        _expect(isinstance(tag, str) and bool(_TAG.match(tag)), f"{where}: tag {tag!r} is not valid")
    return tuple(tags)


def parse_track(raw: Any, *, in_pack: bool = False) -> TrackSpec:
    raw = _object(raw, "track entry")
    track_id = raw.get("id") if isinstance(raw.get("id"), str) else "?"
    where = f"track {track_id!r}"
    _only(
        raw,
        {
            "id", "kind", "title", "mood", "category", "genre", "tags", "bpm", "key", "loop", "channels",
            "durationMs", "lufs", "peakDb", "file", "bytes", "sha256", "peaks",
        },
        where,
    )  # fmt: skip
    _expect(bool(_ID.match(track_id)), f"{where}: id must be lower-case letters, digits and hyphens")
    kind = _str(raw, "kind", where, limit=10)
    _expect(kind in KINDS, f"{where}: kind must be music or sfx")
    file = _str(raw, "file", where, limit=240)
    _expect(
        bool(_MEMBER.match(file) if in_pack else _FILE.match(file)), f"{where}: file {file!r} is not valid"
    )
    _expect(".." not in file.split("/") and not file.startswith("/"), f"{where}: file escapes its folder")
    if not in_pack:
        _expect(file.startswith(f"{kind}/"), f"{where}: file must be under {kind}/")
        _expect(file.rsplit("/", 1)[-1].rsplit(".", 1)[0] == track_id, f"{where}: file name must be the id")
    sha256 = _str(raw, "sha256", where, limit=64)
    _expect(bool(_SHA256.match(sha256)), f"{where}: sha256 must be 64 lower-case hex digits")
    mood = _str(raw, "mood", where, limit=20, required=False)
    category = _str(raw, "category", where, limit=20, required=False)
    if kind == "music":
        _expect(mood in MOODS, f"{where}: mood must be one of {', '.join(MOODS)}")
    else:
        _expect(category in SFX_CATEGORIES, f"{where}: category must be one of {', '.join(SFX_CATEGORIES)}")
    peaks = raw.get("peaks", [])
    _expect(
        isinstance(peaks, list)
        and len(peaks) <= 256
        and all(isinstance(p, int) and not isinstance(p, bool) and 0 <= p <= 100 for p in peaks),
        f"{where}: peaks must be a list of at most 256 integers from 0 to 100",
    )
    loop = raw.get("loop", False)
    _expect(isinstance(loop, bool), f"{where}: loop must be true or false")
    lufs = raw.get("lufs")
    _expect(
        lufs is None or (isinstance(lufs, int | float) and not isinstance(lufs, bool) and -70 <= lufs <= 0),
        f"{where}: lufs must be a number from -70 to 0",
    )
    bpm = raw.get("bpm")
    _expect(
        bpm is None or (isinstance(bpm, int) and not isinstance(bpm, bool) and 30 <= bpm <= 300),
        f"{where}: bpm must be an integer from 30 to 300",
    )
    return TrackSpec(
        id=track_id,
        kind=kind,
        title=_str(raw, "title", where, limit=80),
        tags=_tags(raw, where),
        file=file,
        bytes=_int(raw, "bytes", where, 1, MAX_FILE_BYTES),
        sha256=sha256,
        channels=_int(raw, "channels", where, 1, 2),
        duration_ms=_int(raw, "durationMs", where, 20, 3_600_000),
        loop=loop,
        lufs=float(lufs) if lufs is not None else None,
        peaks=tuple(peaks),
        mood=mood,
        category=category,
        genre=_str(raw, "genre", where, limit=40, required=False),
        bpm=bpm,
        key=_str(raw, "key", where, limit=30, required=False),
    )


def parse_pack(raw: Any) -> PackSpec:
    raw = _object(raw, "pack entry")
    pack_id = raw.get("id") if isinstance(raw.get("id"), str) else "?"
    where = f"pack {pack_id!r}"
    _only(
        raw, {"id", "name", "description", "homepage", "license", "attribution", "archive", "tracks"}, where
    )
    _expect(bool(_ID.match(pack_id)), f"{where}: id must be lower-case letters, digits and hyphens")
    archive = _object(raw.get("archive"), f"{where}.archive")
    _only(archive, {"url", "bytes", "sha256", "format"}, f"{where}.archive")
    _expect(archive.get("format", "zip") == "zip", f"{where}: only zip archives are supported")
    sha256 = _str(archive, "sha256", f"{where}.archive", limit=64)
    _expect(bool(_SHA256.match(sha256)), f"{where}: archive sha256 must be 64 lower-case hex digits")
    url = _https_url(archive.get("url"), f"{where}.archive", hosts_only=True)
    items = raw.get("tracks")
    _expect(
        isinstance(items, list) and 0 < len(items) <= MAX_TRACKS_PER_PACK,
        f"{where}: tracks must be a list of 1 to {MAX_TRACKS_PER_PACK}",
    )
    tracks, members = [], {}
    for item in items:
        track = parse_track(item, in_pack=True)
        tracks.append(track)
        members[track.id] = track.file
    ids = [t.id for t in tracks]
    _expect(len(ids) == len(set(ids)), f"{where}: track ids must be unique")
    return PackSpec(
        id=pack_id,
        name=_str(raw, "name", where, limit=80),
        description=_str(raw, "description", where, limit=300),
        homepage=_https_url(raw.get("homepage"), f"{where}.homepage", hosts_only=False),
        license=_license(raw.get("license"), where),
        attribution=_str(raw, "attribution", where, limit=400),
        archive_url=url,
        archive_bytes=_int(archive, "bytes", f"{where}.archive", 1, MAX_ARCHIVE_BYTES),
        archive_sha256=sha256,
        archive_name=urlparse(url).path.rsplit("/", 1)[-1] or f"{pack_id}.zip",
        tracks=tuple(tracks),
        members=members,
    )


def parse_manifest(raw: Any) -> Manifest:
    raw = _object(raw, "the manifest")
    _only(raw, {"schema", "release", "license", "tracks", "packs"}, "manifest")
    _expect(raw.get("schema") == SCHEMA, f"manifest: schema must be {SCHEMA}")
    release = _str(raw, "release", "manifest", limit=20)
    _expect(bool(_RELEASE.match(release)), "manifest: release must look like 2026.10.1")
    items = raw.get("tracks")
    _expect(isinstance(items, list) and bool(items), "manifest: tracks must be a non-empty list")
    tracks = tuple(parse_track(item) for item in items)
    ids = [t.id for t in tracks]
    _expect(len(ids) == len(set(ids)), "manifest: track ids must be unique")
    packs = tuple(parse_pack(item) for item in raw.get("packs", []))
    pack_ids = [p.id for p in packs]
    _expect(len(pack_ids) == len(set(pack_ids)), "manifest: pack ids must be unique")
    return Manifest(
        release=release, license=_license(raw.get("license"), "manifest"), tracks=tracks, packs=packs
    )


@cache
def load_manifest(path: Path = MANIFEST_PATH) -> Manifest:
    """Read and validate the manifest; `ManifestError` explains what is wrong with it."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ManifestError(f"Cannot read {path}: {exc.strerror or exc}") from exc
    except ValueError as exc:
        raise ManifestError(f"{path} is not valid JSON: {exc}") from exc
    return parse_manifest(raw)
