"""Third-party packs: fetching a pinned archive and taking the listed files out of it.

A pack is never trusted: the archive must be exactly the bytes the manifest pins (size and SHA-256),
only the members the manifest lists are read, each one must match its own pinned hash and size and must
parse as the audio it claims to be (`apps.assets.audio.parse_audio`), and nothing is ever extracted by
name, so a hostile archive cannot write outside the audio folder.
"""

from __future__ import annotations

import hashlib
import time
import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Protocol
from urllib.parse import urljoin, urlparse

import requests

from .manifest import MAX_FILE_BYTES, PackSpec, TrackSpec, host_allowed

USER_AGENT = "Doory-audio-sync/1.0"
CONNECT_TIMEOUT = 10
READ_TIMEOUT = 60
ATTEMPTS = 3
MAX_REDIRECTS = 5
MAX_BACKOFF = 30
CHUNK = 256 * 1024
RETRY_STATUSES = {429, 500, 502, 503, 504}
MAX_UNPACKED_BYTES = 512 * 1024 * 1024


class PackError(Exception):
    """A pack could not be fetched or does not match its manifest entry."""


class PackUnavailable(PackError):
    """The source cannot be reached at all (network, proxy or DNS): stop instead of trying every pack."""


class PackSource(Protocol):
    def fetch(self, pack: PackSpec, destination: Path) -> None:
        """Write the pack's archive to `destination`. Raises `PackUnavailable` or `PackError`."""


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_archive(pack: PackSpec, path: Path) -> None:
    size = path.stat().st_size
    if size != pack.archive_bytes:
        raise PackError(f"{pack.archive_name}: {size} bytes, the manifest pins {pack.archive_bytes}")
    if sha256_of(path) != pack.archive_sha256:
        raise PackError(f"{pack.archive_name}: the content does not match the pinned SHA-256")


class DirectoryPackSource:
    """The archive already on disk (`--from-dir`): `<dir>/<archive file name>` or `<dir>/<pack id>.zip`."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory

    def fetch(self, pack: PackSpec, destination: Path) -> None:
        for name in (pack.archive_name, f"{pack.id}.zip"):
            candidate = self.directory / name
            if candidate.is_file():
                destination.write_bytes(candidate.read_bytes())
                return
        raise PackError(f"{pack.archive_name} is not in {self.directory}")


class _Retry(Exception):
    def __init__(self, message: str, delay: float = 0) -> None:
        super().__init__(message)
        self.delay = delay


class HttpPackSource:
    """HTTPS download from the allowed hosts, with timeouts, bounded retries and a hard size cap."""

    def __init__(
        self,
        session: requests.Session | None = None,
        *,
        sleep: Callable[[float], None] = time.sleep,
        attempts: int = ATTEMPTS,
    ) -> None:
        self.session = session or requests.Session()
        self.session.headers.setdefault("User-Agent", USER_AGENT)
        self._sleep = sleep
        self._attempts = attempts

    def fetch(self, pack: PackSpec, destination: Path) -> None:
        last: Exception | None = None
        hint = 0.0
        for attempt in range(self._attempts):
            if attempt:
                self._sleep(min(MAX_BACKOFF, max(2 ** (attempt - 1), hint)))
                hint = 0.0
            try:
                self._download(pack.archive_url, pack.archive_bytes, destination)
                return
            except _Retry as retry:
                last, hint = retry, retry.delay
            except (requests.ConnectionError, requests.Timeout) as exc:
                last = exc
            except requests.RequestException as exc:
                last = exc
        host = urlparse(pack.archive_url).hostname
        if isinstance(last, requests.ConnectionError | requests.Timeout):
            raise PackUnavailable(f"Cannot reach {host}: {last.__class__.__name__}") from last
        raise PackError(f"{host}: {last}" if last else f"Download from {host} failed")

    def _open(self, url: str) -> requests.Response:
        for _ in range(MAX_REDIRECTS + 1):
            parsed = urlparse(url)
            if parsed.scheme != "https" or not host_allowed(parsed.hostname):
                raise PackError(f"Refusing to download from {parsed.hostname or url}.")
            response = self.session.get(
                url, timeout=(CONNECT_TIMEOUT, READ_TIMEOUT), stream=True, allow_redirects=False
            )
            if response.status_code in (301, 302, 303, 307, 308):
                location = response.headers.get("Location", "")
                response.close()
                if not location:
                    raise PackError(f"Redirect without a target from {parsed.hostname}.")
                url = urljoin(url, location)
                continue
            return response
        raise PackError("Too many redirects.")

    def _download(self, url: str, total: int, destination: Path) -> None:
        response = self._open(url)
        try:
            if response.status_code in RETRY_STATUSES:
                try:
                    delay = float(response.headers.get("Retry-After", "0"))
                except ValueError:
                    delay = 0.0
                raise _Retry(f"HTTP {response.status_code}", delay)
            if response.status_code != 200:
                raise PackError(f"{urlparse(url).hostname}: HTTP {response.status_code}")
            written = 0
            with destination.open("wb") as handle:
                for chunk in response.iter_content(CHUNK):
                    written += len(chunk)
                    if written > total:
                        raise PackError("The download is larger than the manifest says.")
                    handle.write(chunk)
        finally:
            response.close()


def read_members(archive: Path, pack: PackSpec, wanted: list[TrackSpec]) -> dict[str, bytes]:
    """The bytes of each wanted track, taken from the archive by exact member name and verified.

    Raises `PackError` for a missing member, a link, an oversize member, a size or hash that differs from the
    manifest, or content that is not audio.
    """
    from apps.assets.audio import AudioError, parse_audio

    out: dict[str, bytes] = {}
    try:
        zf = zipfile.ZipFile(archive)
    except (zipfile.BadZipFile, OSError) as exc:
        raise PackError(f"{pack.archive_name} is not a valid zip file") from exc
    with zf:
        infos = {info.filename: info for info in zf.infolist()}
        if sum(info.file_size for info in infos.values()) > MAX_UNPACKED_BYTES:
            raise PackError(f"{pack.archive_name} unpacks to more than {MAX_UNPACKED_BYTES // 2**20} MB")
        for track in wanted:
            info = infos.get(track.file)
            if info is None or info.is_dir():
                raise PackError(f"{track.file} is not in {pack.archive_name}")
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise PackError(f"{track.file} is a link, not a file")
            if info.file_size != track.bytes or info.file_size > MAX_FILE_BYTES:
                raise PackError(f"{track.file}: {info.file_size} bytes, the manifest pins {track.bytes}")
            with zf.open(info) as handle:
                data = handle.read(track.bytes + 1)
            if len(data) != track.bytes or hashlib.sha256(data).hexdigest() != track.sha256:
                raise PackError(f"{track.file}: the content does not match the pinned SHA-256")
            try:
                parse_audio(data)
            except AudioError as exc:
                raise PackError(f"{track.file}: not a valid audio file ({exc})") from exc
            out[track.id] = data
    return out
