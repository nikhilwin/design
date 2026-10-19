"""Where `sync_models` gets a model file from.

`ModelSource` is the seam: the installer only asks a source to put the bytes of a model into a path, so the
tests use an in-memory fake and never touch the network. The real implementations are

- `HttpModelSource`: HTTPS download from the hosts in the manifest, resumable (a partial download is
  continued with a `Range` request), with timeouts, bounded retries and backoff (honouring `Retry-After`),
  a hard size cap, and redirects followed by hand so every hop is checked against the host allow-list;
- `DirectorySource`: the same file already on disk (`--from-dir`, for machines without internet access).

The installer checks size and SHA-256 against the manifest after every fetch; `HttpModelSource` also runs that
check per mirror (the `verify` callback) so a mirror serving the wrong bytes is skipped, not fatal.
"""

from __future__ import annotations

import shutil
import time
from collections.abc import Callable
from pathlib import Path
from typing import Protocol
from urllib.parse import urljoin, urlparse

import requests

from .manifest import ModelSpec, host_allowed

USER_AGENT = "Doory-model-sync/1.0"
CONNECT_TIMEOUT = 10
READ_TIMEOUT = 60
ATTEMPTS = 3
MAX_REDIRECTS = 5
MAX_BACKOFF = 30
CHUNK = 256 * 1024
RETRY_STATUSES = {429, 500, 502, 503, 504}

#: `(bytes written so far, total bytes)`
Progress = Callable[[int, int], None]
#: Raises `IntegrityError` when the file at the path is not the pinned one.
Verify = Callable[[Path], None]


class SourceError(Exception):
    """Something went wrong getting a model file; retrying later may help."""


class SourceUnavailable(SourceError):
    """The source cannot be reached at all (network, proxy or DNS): stop instead of trying every mirror."""


class IntegrityError(SourceError):
    """The bytes do not match the size or SHA-256 the manifest pins."""


class ModelSource(Protocol):
    def fetch(
        self,
        spec: ModelSpec,
        destination: Path,
        on_progress: Progress | None = None,
        verify: Verify | None = None,
    ) -> None:
        """Write the model's bytes to `destination`. It may already hold the start of an earlier attempt
        (resume it or start over). Raises `SourceUnavailable` or `SourceError`."""


class _Retry(Exception):
    def __init__(self, message: str, delay: float = 0) -> None:
        super().__init__(message)
        self.delay = delay


class HttpModelSource:
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

    def fetch(
        self,
        spec: ModelSpec,
        destination: Path,
        on_progress: Progress | None = None,
        verify: Verify | None = None,
    ) -> None:
        errors: list[str] = []
        for url in spec.urls:
            try:
                self._fetch_url(url, spec.bytes, destination, on_progress)
                if verify:
                    verify(destination)
                return
            except SourceUnavailable:
                raise
            except SourceError as exc:
                errors.append(str(exc))
                destination.unlink(missing_ok=True)  # a different mirror must not continue this one's bytes
        raise SourceError("; ".join(errors) or f"No source for {spec.id}.")

    def _fetch_url(self, url: str, total: int, destination: Path, on_progress: Progress | None) -> None:
        last: Exception | None = None
        hint = 0.0  # a server's Retry-After for the next wait
        for attempt in range(self._attempts):
            if attempt:
                self._sleep(min(MAX_BACKOFF, max(2 ** (attempt - 1), hint)))
                hint = 0.0
            try:
                self._download(url, total, destination, on_progress)
                return
            except _Retry as retry:
                last, hint = retry, retry.delay
            except (requests.ConnectionError, requests.Timeout) as exc:
                last = exc
            except requests.RequestException as exc:  # the connection dropped half-way through the body
                last = exc
        host = urlparse(url).hostname
        if isinstance(last, (requests.ConnectionError, requests.Timeout)):
            raise SourceUnavailable(f"Cannot reach {host}: {last.__class__.__name__}") from last
        raise SourceError(f"{host}: {last}" if last else f"Download from {host} failed")

    def _open(self, url: str, offset: int) -> requests.Response:
        """The response for `url`, following redirects only to allowed hosts and keeping the `Range`."""
        headers = {"Range": f"bytes={offset}-"} if offset else {}
        for _ in range(MAX_REDIRECTS + 1):
            parsed = urlparse(url)
            if parsed.scheme != "https" or not host_allowed(parsed.hostname):
                raise SourceError(f"Refusing to download from {parsed.hostname or url}.")
            response = self.session.get(
                url,
                headers=headers,
                timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
                stream=True,
                allow_redirects=False,
            )
            if response.status_code in (301, 302, 303, 307, 308):
                location = response.headers.get("Location", "")
                response.close()
                if not location:
                    raise SourceError(f"Redirect without a target from {parsed.hostname}.")
                url = urljoin(url, location)
                continue
            return response
        raise SourceError("Too many redirects.")

    def _download(self, url: str, total: int, destination: Path, on_progress: Progress | None) -> None:
        offset = destination.stat().st_size if destination.exists() else 0
        if offset >= total:  # more than expected can only be garbage: start over
            destination.unlink()
            offset = 0
        response = self._open(url, offset)
        try:
            status = response.status_code
            if status in RETRY_STATUSES:
                header = response.headers.get("Retry-After", "")
                raise _Retry(f"HTTP {status}", float(header) if header.isdigit() else 0)
            if status == 416:  # the server holds less than we have: start over
                destination.unlink(missing_ok=True)
                raise _Retry("the partial download no longer matches")
            if status not in (200, 206):
                raise SourceError(f"HTTP {status} from {urlparse(url).hostname}")
            resumed = status == 206 and offset > 0 and self._range_start(response) == offset
            if not resumed:
                offset = 0
            written = offset
            with destination.open("ab" if resumed else "wb") as out:
                for chunk in response.iter_content(CHUNK):
                    written += len(chunk)
                    if written > total:
                        raise SourceError(f"The file is larger than the {total} bytes the manifest pins.")
                    out.write(chunk)
                    if on_progress:
                        on_progress(written, total)
        finally:
            response.close()

    @staticmethod
    def _range_start(response: requests.Response) -> int | None:
        """The first byte a 206 response carries (`Content-Range: bytes 100-999/1000`)."""
        header = response.headers.get("Content-Range", "")
        unit, _, rest = header.partition(" ")
        start = rest.partition("-")[0]
        return int(start) if unit == "bytes" and start.isdigit() else None


class DirectorySource:
    """Models downloaded elsewhere: `<dir>/<file>` or `<dir>/<id>/<file>` (the upstream file name)."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory

    def fetch(
        self,
        spec: ModelSpec,
        destination: Path,
        on_progress: Progress | None = None,
        verify: Verify | None = None,
    ) -> None:
        for candidate in (self.directory / spec.file, self.directory / spec.id / spec.file):
            if candidate.is_file() and not candidate.is_symlink():
                if candidate.stat().st_size > spec.bytes:
                    raise SourceError(f"{candidate} is larger than the {spec.bytes} bytes the manifest pins.")
                shutil.copyfile(candidate, destination)
                if on_progress:
                    on_progress(spec.bytes, spec.bytes)
                if verify:
                    verify(destination)
                return
        raise SourceError(f"Neither {spec.file} nor {spec.id}/{spec.file} was found in {self.directory}.")
