"""Builders shared by the pack-sync tests: tarballs, manifests and a fake `PackSource`."""

from __future__ import annotations

import base64
import hashlib
import io
import tarfile
from collections.abc import Callable
from typing import Any

from apps.elements.manifest import NpmSource, UrlsSource, parse_manifest, parse_pack
from apps.elements.sources import SourceError, SourceUnavailable

ICON = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" '
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">'
    '<path d="{d}"/></svg>'
)
MIT_TEXT = "MIT License\n\nCopyright (c) 2026 Example\n\nPermission is hereby granted, free of charge"


def icon(d: str = "M3 3h18v18H3z") -> bytes:
    return ICON.replace("{d}", d).encode()


def integrity_of(data: bytes) -> str:
    return "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()


def make_tarball(files: dict[str, bytes], top: str = "package", extra: Callable | None = None) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, data in files.items():
            info = tarfile.TarInfo(f"{top}/{name}" if top else name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
        if extra:
            extra(archive)
    return buffer.getvalue()


def pack_entry(pack_id: str = "demo", **overrides: Any) -> dict[str, Any]:
    """A valid manifest entry for an npm pack; `overrides` replace top-level keys."""
    entry: dict[str, Any] = {
        "id": pack_id,
        "name": pack_id.replace("-", " ").title(),
        "kind": "icon",
        "style": "outline",
        "description": "Demo icons.",
        "homepage": "https://example.com/",
        "sort_order": 10,
        "source": {
            "type": "npm",
            "package": "demo-icons",
            "version": "1.0.0",
            "integrity": "sha512-" + "A" * 86 + "==",
        },
        "files": {"include": ["icons/*.svg"]},
        "tags": {"format": "json-map", "file": "tags.json"},
        "normalize": {"mode": "mono", "size": 24},
        "license": {
            "spdx": "MIT",
            "url": "https://example.com/LICENSE",
            "file": "LICENSE",
            "match": "MIT License",
        },
        "attribution": "Demo: Copyright (c) 2026 Example (MIT).",
    }
    entry.update(overrides)
    return entry


def make_pack(pack_id: str = "demo", **overrides: Any):
    return parse_pack(pack_entry(pack_id, **overrides))


def make_manifest(*entries: dict[str, Any]):
    return parse_manifest({"schema": 1, "packs": list(entries)})


def demo_files(**extra: bytes) -> dict[str, bytes]:
    files = {
        "LICENSE": MIT_TEXT.encode(),
        "tags.json": b'{"home": ["house", "building"], "star": ["favourite"]}',
        "icons/home.svg": icon("M3 12l9-9 9 9"),
        "icons/star.svg": icon("M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"),
    }
    files.update(extra)
    return files


class FakeSource:
    """In-memory `PackSource`: `archives` maps a source spec's label to its `{path: bytes}` files."""

    def __init__(self, archives: dict[str, dict[str, bytes]] | None = None) -> None:
        self.archives = archives or {}
        self.calls: list[str] = []
        self.failures: dict[str, Exception] = {}

    def fetch(self, spec: NpmSource | UrlsSource, patterns):
        from apps.elements.sources import matcher

        self.calls.append(spec.label)
        if spec.label in self.failures:
            raise self.failures[spec.label]
        if spec.label not in self.archives:
            raise SourceError(f"{spec.label} is not available")
        wanted = matcher(patterns)
        return {path: data for path, data in self.archives[spec.label].items() if wanted(path)}


def unreachable(host: str = "registry.npmjs.org") -> SourceUnavailable:
    return SourceUnavailable(f"Cannot reach {host}: ConnectionError")
