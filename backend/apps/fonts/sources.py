"""Where `sync_fonts` gets fonts from.

`FontSource` is the seam: the sync pipeline only talks to this interface, so tests use an in-memory fake and
never touch the network. `FontsourceSource` is the real implementation: family metadata from the Fontsource
API and the woff2 files from the jsDelivr copy of the `@fontsource/<id>` npm packages.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol
from urllib.parse import urlparse

import requests

API_BASE = "https://api.fontsource.org/v1"
CDN_BASE = "https://cdn.jsdelivr.net/npm/@fontsource"
USER_AGENT = "Doory-font-sync/1.0"
CONNECT_TIMEOUT = 10
READ_TIMEOUT = 30
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_JSON_BYTES = 16 * 1024 * 1024
ATTEMPTS = 3
RETRY_STATUSES = {429, 500, 502, 503, 504}

_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,80}$")
_SUBSET = re.compile(r"^[a-z0-9\[\]-]{1,40}$")
_VERSION = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
CATEGORIES = {"sans-serif", "serif", "display", "handwriting", "monospace"}


class SourceError(Exception):
    """A request to the font source failed for a reason that retrying later may fix."""


class SourceUnavailable(SourceError):
    """The font source cannot be reached at all (network, proxy or DNS)."""


class FamilyNotFound(SourceError):
    """The source has no such family."""


class _NotFound(Exception):
    """Internal: the server answered 404."""


class FileNotAvailable(SourceError):
    """The source has no such file (not every family ships every weight/style/subset)."""


@dataclass(frozen=True)
class FamilyMeta:
    id: str
    family: str
    category: str
    subsets: tuple[str, ...]
    weights: tuple[int, ...]
    styles: tuple[str, ...]
    license: str
    unicode_ranges: dict[str, str] = field(default_factory=dict)
    version: str = ""
    #: (weight, style, subset) triples known to exist; None when the source cannot say.
    available: frozenset[tuple[int, str, str]] | None = None
    is_font: bool = True


class FontSource(Protocol):
    def list_ids(self) -> list[str]:
        """Every family id the source offers (used by `--all`)."""

    def metadata(self, font_id: str) -> FamilyMeta:
        """Raises `FamilyNotFound` or `SourceError`/`SourceUnavailable`."""

    def fetch(self, meta: FamilyMeta, subset: str, weight: int, style: str) -> bytes:
        """The woff2 bytes. Raises `FileNotAvailable` or `SourceError`/`SourceUnavailable`."""


def is_valid_font_id(font_id: str) -> bool:
    return bool(_ID.match(font_id))


def normalize_category(raw: object) -> str:
    return raw if isinstance(raw, str) and raw in CATEGORIES else "display"


def _license_name(raw: object) -> str:
    if isinstance(raw, dict):
        raw = raw.get("type") or raw.get("id")
    return raw.strip() if isinstance(raw, str) and raw.strip() else ""


class FontsourceSource:
    """Fontsource API + jsDelivr. Polite by construction: bounded retries with backoff, hard timeouts and
    size caps, fixed hosts, and every path component validated before it is put in a URL."""

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

    # ---- HTTP -------------------------------------------------------------------------------------

    def _get(self, url: str, *, limit: int) -> bytes:
        last: Exception | None = None
        for attempt in range(self._attempts):
            if attempt:
                self._sleep(2 ** (attempt - 1))
            try:
                response = self.session.get(url, timeout=(CONNECT_TIMEOUT, READ_TIMEOUT), stream=True)
            except (requests.ConnectionError, requests.Timeout) as exc:
                last = exc
                continue
            try:
                if response.status_code == 404:
                    raise _NotFound(url)
                if response.status_code in RETRY_STATUSES:
                    last = SourceError(f"HTTP {response.status_code} from {url}")
                    continue
                if response.status_code != 200:
                    raise SourceError(f"HTTP {response.status_code} from {url}")
                body = b""
                for chunk in response.iter_content(65536):
                    body += chunk
                    if len(body) > limit:
                        raise SourceError(f"The response from {url} is larger than {limit} bytes.")
                return body
            except requests.RequestException as exc:  # connection dropped mid-body
                last = exc
            finally:
                response.close()
        if isinstance(last, (requests.ConnectionError, requests.Timeout)):
            host = urlparse(url).netloc
            raise SourceUnavailable(f"Cannot reach {host}: {last.__class__.__name__}") from last
        raise SourceError(str(last) if last else f"Request to {url} failed")

    # ---- FontSource ---------------------------------------------------------------------------------

    def list_ids(self) -> list[str]:
        try:
            body = self._get(f"{API_BASE}/fonts", limit=MAX_JSON_BYTES)
        except _NotFound as exc:
            raise SourceError("The Fontsource font list was not found.") from exc
        rows = self._json(body, list)
        return [
            row["id"]
            for row in rows
            if isinstance(row, dict)
            and isinstance(row.get("id"), str)
            and is_valid_font_id(row["id"])
            and row.get("type") == "google"
        ]

    def metadata(self, font_id: str) -> FamilyMeta:
        if not is_valid_font_id(font_id):
            raise FamilyNotFound(font_id)
        try:
            body = self._get(f"{API_BASE}/fonts/{font_id}", limit=MAX_JSON_BYTES)
        except _NotFound as exc:
            raise FamilyNotFound(font_id) from exc
        data: dict[str, Any] = self._json(body, dict)
        try:
            weights = tuple(sorted({int(w) for w in data["weights"]}))
            styles = tuple(sorted({s for s in data["styles"] if s in ("normal", "italic")}))
            subsets = tuple(s for s in data["subsets"] if isinstance(s, str) and _SUBSET.match(s))
            family = str(data["family"]).strip()
        except (KeyError, TypeError, ValueError) as exc:
            raise SourceError(f"Unexpected metadata for {font_id}.") from exc
        version = data.get("npmVersion")
        ranges = data.get("unicodeRange")
        return FamilyMeta(
            id=font_id,
            family=family,
            category=normalize_category(data.get("category")),
            subsets=subsets,
            weights=weights,
            styles=styles,
            license=_license_name(data.get("license")),
            unicode_ranges={k: v for k, v in ranges.items() if isinstance(k, str) and isinstance(v, str)}
            if isinstance(ranges, dict)
            else {},
            version=version if isinstance(version, str) and _VERSION.match(version) else "",
            available=self._available(data.get("variants")),
            is_font=data.get("type") != "icons" and data.get("category") != "icons",
        )

    @staticmethod
    def _available(variants: object) -> frozenset[tuple[int, str, str]] | None:
        if not isinstance(variants, dict) or not variants:
            return None
        found: set[tuple[int, str, str]] = set()
        for weight, styles in variants.items():
            for style, subsets in (styles or {}).items():
                for subset in subsets or {}:
                    if weight.isdigit():
                        found.add((int(weight), style, subset))
        return frozenset(found)

    def fetch(self, meta: FamilyMeta, subset: str, weight: int, style: str) -> bytes:
        if not (is_valid_font_id(meta.id) and _SUBSET.match(subset) and style in ("normal", "italic")):
            raise FileNotAvailable(f"{meta.id} {subset} {weight} {style}")
        version = meta.version or "5"
        url = f"{CDN_BASE}/{meta.id}@{version}/files/{meta.id}-{subset}-{int(weight)}-{style}.woff2"
        try:
            return self._get(url, limit=MAX_FILE_BYTES)
        except _NotFound as exc:
            raise FileNotAvailable(url) from exc

    @staticmethod
    def _json(body: bytes, expected: type) -> Any:
        try:
            data = json.loads(body)
        except ValueError as exc:
            raise SourceError("The font source returned invalid JSON.") from exc
        if not isinstance(data, expected):
            raise SourceError("The font source returned an unexpected response.")
        return data
