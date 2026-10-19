"""Where `sync_element_packs` gets artwork from.

`PackSource` is the seam: the pipeline only asks a source for the files of a pack, so tests use an in-memory
fake and never touch the network. The real implementations are

- `HttpPackSource`: an npm release as one tarball from the npm registry (verified against the integrity hash
  pinned in the manifest *before* anything is read from it), or a list of individual files, each verified
  against its pinned SHA-256;
- `DirectorySource`: the same content already on disk (`--from-dir`, for machines without internet access).

Downloads are polite by construction: fixed hosts, HTTPS only, no redirects, hard timeouts, size caps,
bounded retries with backoff and a global cap on simultaneous requests.
"""

from __future__ import annotations

import base64
import hashlib
import io
import os
import posixpath
import re
import tarfile
import threading
import time
from collections.abc import Callable, Iterable, Sequence
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Protocol
from urllib.parse import urlparse

import requests

from .manifest import ALLOWED_HOSTS, NpmSource, UrlFile, UrlsSource

USER_AGENT = "Doory-element-sync/1.0"
CONNECT_TIMEOUT = 10
READ_TIMEOUT = 60
ATTEMPTS = 3
RETRY_STATUSES = {429, 500, 502, 503, 504}
MAX_BACKOFF = 30

MAX_ARCHIVE_BYTES = 120 * 1024 * 1024  # the compressed tarball
MAX_MEMBER_BYTES = 64 * 1024 * 1024  # one file taken from an archive (the largest is a 25 MB icon-set JSON)
MAX_TOTAL_BYTES = 400 * 1024 * 1024  # everything taken from one archive
MAX_ARCHIVE_MEMBERS = 100_000
MAX_URL_FILE_BYTES = 5 * 1024 * 1024


class SourceError(Exception):
    """Something went wrong getting a pack's files; retrying later may help."""


class SourceUnavailable(SourceError):
    """The source cannot be reached at all (network, proxy or DNS): stop instead of trying every pack."""


class IntegrityError(SourceError):
    """Downloaded or supplied bytes do not match the hash pinned in the manifest."""


class _NotFound(Exception):
    """Internal: the server answered 404."""


class _Retry(Exception):
    def __init__(self, message: str, delay: float = 0) -> None:
        super().__init__(message)
        self.delay = delay


class PackSource(Protocol):
    def fetch(self, spec: NpmSource | UrlsSource, patterns: Sequence[str]) -> dict[str, bytes]:
        """The files of `spec` matching any of the globs in `patterns`, as `{path inside the archive: bytes}`.

        Raises `SourceUnavailable` when the source cannot be reached and `SourceError` for anything else
        (including `IntegrityError`).
        """


# ---- globs -------------------------------------------------------------------------------------------------


def glob_regex(pattern: str) -> re.Pattern[str]:
    """`*` (not across `/`), `**` (across `/`) and `?` — anchored at both ends."""
    out, i = [], 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out) + r"\Z")


def matcher(patterns: Iterable[str]) -> Callable[[str], bool]:
    compiled = [glob_regex(p) for p in patterns]
    return lambda path: any(rx.match(path) for rx in compiled)


def archive_path(name: str) -> str | None:
    """`package/icons/a.svg` -> `icons/a.svg` (the top-level folder is dropped); None for unsafe names."""
    parts = posixpath.normpath(name.replace("\\", "/")).split("/")
    if name.startswith("/") or ".." in parts or len(parts) < 2 or "" in parts:
        return None
    return "/".join(parts[1:])


# ---- reading archives and folders ------------------------------------------------------------------------


def verify_integrity(data: bytes, integrity: str, what: str) -> None:
    algorithm, _, expected = integrity.partition("-")
    if algorithm != "sha512":
        raise IntegrityError(f"{what}: unsupported integrity algorithm {algorithm!r}")
    actual = base64.b64encode(hashlib.sha512(data).digest()).decode()
    if actual != expected:
        raise IntegrityError(f"{what}: the content does not match the pinned integrity hash")


def read_tarball(data: bytes, patterns: Sequence[str]) -> dict[str, bytes]:
    """The regular files of a gzipped tarball that match `patterns` (paths relative to its top folder).

    Nothing is extracted to disk. Links, devices and unsafe names are ignored; sizes are capped.
    """
    wanted = matcher(patterns)
    found: dict[str, bytes] = {}
    total = 0
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            for count, member in enumerate(archive):
                if count > MAX_ARCHIVE_MEMBERS:
                    raise SourceError("The archive holds too many files.")
                if not member.isfile():
                    continue
                path = archive_path(member.name)
                if path is None or not wanted(path):
                    continue
                if member.size > MAX_MEMBER_BYTES:
                    raise SourceError(f"{path} is larger than {MAX_MEMBER_BYTES // 2**20} MB.")
                total += member.size
                if total > MAX_TOTAL_BYTES:
                    raise SourceError("The requested files add up to more than the size limit.")
                handle = archive.extractfile(member)
                if handle is not None:
                    found[path] = handle.read()
    except (tarfile.TarError, EOFError, OSError) as exc:
        raise SourceError(f"The archive could not be read: {exc}") from exc
    return found


def read_directory(root: Path, patterns: Sequence[str]) -> dict[str, bytes]:
    """The same as `read_tarball` for an unpacked folder (symbolic links are never followed)."""
    wanted = matcher(patterns)
    found: dict[str, bytes] = {}
    total = 0
    base = root.resolve()
    for folder, subfolders, names in os.walk(base, followlinks=False):
        subfolders[:] = sorted(d for d in subfolders if not (Path(folder) / d).is_symlink())
        for name in sorted(names):
            file = Path(folder) / name
            relative = file.relative_to(base).as_posix()
            if file.is_symlink() or not file.is_file() or not wanted(relative):
                continue
            size = file.stat().st_size
            if size > MAX_MEMBER_BYTES:
                raise SourceError(f"{relative} is larger than {MAX_MEMBER_BYTES // 2**20} MB.")
            total += size
            if total > MAX_TOTAL_BYTES:
                raise SourceError("The requested files add up to more than the size limit.")
            found[relative] = file.read_bytes()
    return found


# ---- the network -------------------------------------------------------------------------------------------


class NoSource:
    """A source for runs that only involve generated packs: it has nothing to download."""

    def fetch(self, spec: NpmSource | UrlsSource, patterns: Sequence[str]) -> dict[str, bytes]:
        raise SourceError(f"{spec.label} needs a download source; run sync_element_packs.")


class HttpPackSource:
    """npm tarballs and pinned single files over HTTPS."""

    def __init__(
        self,
        session: requests.Session | None = None,
        *,
        concurrency: int = 4,
        sleep: Callable[[float], None] = time.sleep,
        attempts: int = ATTEMPTS,
    ) -> None:
        self.session = session or requests.Session()
        self.session.headers.setdefault("User-Agent", USER_AGENT)
        self.concurrency = max(1, min(concurrency, 8))
        self._slots = threading.BoundedSemaphore(self.concurrency)
        self._sleep = sleep
        self._attempts = attempts

    def _get(self, url: str, *, limit: int) -> bytes:
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS:
            raise SourceError(f"Refusing to download from {parsed.hostname or url}.")
        last: Exception | None = None
        hint = 0.0  # a server's Retry-After for the next wait
        for attempt in range(self._attempts):
            if attempt:
                self._sleep(min(MAX_BACKOFF, max(2 ** (attempt - 1), hint)))
                hint = 0.0
            try:
                with self._slots:
                    return self._request(url, limit)
            except _NotFound:
                raise
            except _Retry as retry:
                last, hint = retry, retry.delay
            except (requests.ConnectionError, requests.Timeout) as exc:
                last = exc
            except requests.RequestException as exc:  # the connection dropped half-way through the body
                last = exc
        if isinstance(last, (requests.ConnectionError, requests.Timeout)):
            raise SourceUnavailable(f"Cannot reach {parsed.hostname}: {last.__class__.__name__}") from last
        raise SourceError(str(last) if last else f"Request to {url} failed")

    def _request(self, url: str, limit: int) -> bytes:
        response = self.session.get(
            url, timeout=(CONNECT_TIMEOUT, READ_TIMEOUT), stream=True, allow_redirects=False
        )
        try:
            if response.status_code == 404:
                raise _NotFound(url)
            if response.status_code in RETRY_STATUSES:
                header = response.headers.get("Retry-After", "")
                raise _Retry(
                    f"HTTP {response.status_code} from {url}", float(header) if header.isdigit() else 0
                )
            if response.status_code != 200:
                raise SourceError(f"HTTP {response.status_code} from {url}")
            chunks, size = [], 0
            for chunk in response.iter_content(65536):
                size += len(chunk)
                if size > limit:
                    raise SourceError(f"The response from {url} is larger than {limit // 2**20} MB.")
                chunks.append(chunk)
            return b"".join(chunks)
        finally:
            response.close()

    # ---- PackSource ------------------------------------------------------------------------------------

    def fetch(self, spec: NpmSource | UrlsSource, patterns: Sequence[str]) -> dict[str, bytes]:
        if isinstance(spec, NpmSource):
            return self._fetch_npm(spec, patterns)
        return self._fetch_urls(spec)

    def _fetch_npm(self, spec: NpmSource, patterns: Sequence[str]) -> dict[str, bytes]:
        try:
            data = self._get(spec.tarball_url, limit=MAX_ARCHIVE_BYTES)
        except _NotFound as exc:
            raise SourceError(f"{spec.label} was not found on the npm registry.") from exc
        verify_integrity(data, spec.integrity, spec.label)
        return read_tarball(data, patterns)

    def _fetch_urls(self, spec: UrlsSource) -> dict[str, bytes]:
        def one(item: UrlFile) -> tuple[str, bytes]:
            try:
                data = self._get(item.url, limit=MAX_URL_FILE_BYTES)
            except _NotFound as exc:
                raise SourceError(f"{item.name} was not found at {item.url}.") from exc
            if hashlib.sha256(data).hexdigest() != item.sha256:
                raise IntegrityError(f"{item.name}: the content does not match the pinned SHA-256")
            return item.name, data

        with ThreadPoolExecutor(max_workers=self.concurrency, thread_name_prefix="packfetch") as pool:
            return dict(pool.map(one, spec.files))


class DirectorySource:
    """Packs that were downloaded elsewhere: `<dir>/<pack id>/…` (an unpacked archive) or an npm tarball.

    Looked up by `PackSource.fetch`'s spec: npm releases as `<dir>/<name>-<version>.tgz` (what `npm pack`
    writes) or an unpacked folder `<dir>/<package name with / replaced by ->/`; URL lists as a folder
    `<dir>/<index name without .json>/` holding the SVG files.
    """

    def __init__(self, directory: Path) -> None:
        self.directory = directory

    def fetch(self, spec: NpmSource | UrlsSource, patterns: Sequence[str]) -> dict[str, bytes]:
        if isinstance(spec, NpmSource):
            tarball = self.directory / spec.tarball_name
            if tarball.is_file() and not tarball.is_symlink():
                if tarball.stat().st_size > MAX_ARCHIVE_BYTES:
                    raise SourceError(f"{tarball.name} is too large.")
                data = tarball.read_bytes()
                verify_integrity(data, spec.integrity, tarball.name)
                return read_tarball(data, patterns)
            folder = self.directory / spec.package.lstrip("@").replace("/", "-")
            if folder.is_dir() and not folder.is_symlink():
                return read_directory(folder, patterns)
            raise SourceError(
                f"Neither {spec.tarball_name} nor a folder {folder.name}/ was found in {self.directory}."
            )
        folder = self.directory / spec.index.removesuffix(".json")
        if not folder.is_dir() or folder.is_symlink():
            raise SourceError(f"The folder {folder.name}/ was not found in {self.directory}.")
        found = read_directory(folder, ["*.svg"])
        expected = {f.name: f for f in spec.files}
        missing = sorted(set(expected) - set(found))
        if missing:
            raise SourceError(
                f"{len(missing)} of {len(expected)} files are missing from {folder.name}/ "
                f"(first: {missing[0]})."
            )
        for name, item in expected.items():
            if hashlib.sha256(found[name]).hexdigest() != item.sha256:
                raise IntegrityError(f"{name}: the content does not match the pinned SHA-256")
        return {name: found[name] for name in expected}
