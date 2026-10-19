from __future__ import annotations

import threading
import time
from collections.abc import Callable

from apps.fonts.sources import FamilyMeta, FamilyNotFound, FileNotAvailable, SourceError, SourceUnavailable

WOFF2 = b"wOF2" + b"\x01" * 300


def meta(
    font_id: str = "open-sans",
    family: str = "Open Sans",
    *,
    subsets=("latin", "latin-ext", "cyrillic"),
    weights=(400, 700),
    styles=("normal", "italic"),
    license: str = "OFL-1.1",
    category: str = "sans-serif",
    available=None,
    is_font: bool = True,
) -> FamilyMeta:
    return FamilyMeta(
        id=font_id,
        family=family,
        category=category,
        subsets=tuple(subsets),
        weights=tuple(weights),
        styles=tuple(styles),
        license=license,
        unicode_ranges={"latin": "U+0000-00FF", "cyrillic": "U+0400-045F"},
        version="5.0.0",
        available=available,
        is_font=is_font,
    )


class FakeSource:
    """In-memory `FontSource`. Records every call; failures can be scripted per file."""

    def __init__(self, *families: FamilyMeta, content: bytes = WOFF2, delay: float = 0.0) -> None:
        self.families = {f.id: f for f in families}
        self.content = content
        self.delay = delay
        self.fetched: list[tuple[str, str, int, str]] = []
        self.metadata_calls: list[str] = []
        self.failures: dict[tuple[str, str, int, str], Exception] = {}
        self.missing: set[tuple[str, str, int, str]] = set()
        self.unavailable_for: set[str] = set()
        self.bodies: dict[tuple[str, str, int, str], bytes] = {}
        self._lock = threading.Lock()
        self._running = 0
        self.max_running = 0
        self.on_fetch: Callable[[tuple[str, str, int, str]], None] | None = None

    def list_ids(self) -> list[str]:
        return list(self.families)

    def metadata(self, font_id: str) -> FamilyMeta:
        self.metadata_calls.append(font_id)
        if font_id in self.unavailable_for:
            raise SourceUnavailable("Cannot reach api.fontsource.org: ConnectionError")
        if font_id not in self.families:
            raise FamilyNotFound(font_id)
        return self.families[font_id]

    def fetch(self, meta: FamilyMeta, subset: str, weight: int, style: str) -> bytes:
        key = (meta.id, subset, weight, style)
        with self._lock:
            self._running += 1
            self.max_running = max(self.max_running, self._running)
            self.fetched.append(key)
        try:
            if self.delay:
                time.sleep(self.delay)
            if self.on_fetch:
                self.on_fetch(key)
            if key in self.missing:
                raise FileNotAvailable(str(key))
            failure = self.failures.get(key)
            if failure is not None:
                raise failure
            return self.bodies.get(key, self.content)
        finally:
            with self._lock:
                self._running -= 1


__all__ = ["WOFF2", "FakeSource", "SourceError", "meta"]
