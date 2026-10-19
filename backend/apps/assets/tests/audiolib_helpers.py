"""A tiny library on disk for the sync tests: real (structurally valid) audio, hashes computed from the bytes."""

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from pathlib import Path

from apps.assets.audiolib.manifest import Manifest, parse_manifest

from .audio_helpers import mp3_bytes, ogg_opus_bytes, wav_bytes

LICENSE = {
    "spdx": "CC0-1.0",
    "url": "https://creativecommons.org/publicdomain/zero/1.0/",
    "holder": "Doory contributors",
}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def track_row(track_id: str, kind: str, data: bytes, ext: str = "ogg", **extra) -> dict:
    row = {
        "id": track_id,
        "kind": kind,
        "title": track_id.replace("-", " ").title(),
        "tags": ["test"],
        "channels": 2,
        "durationMs": 500,
        "loop": kind == "music",
        "lufs": -16.0,
        "file": f"{kind}/{track_id}.{ext}",
        "bytes": len(data),
        "sha256": sha(data),
        "peaks": [10, 40, 100, 60, 20],
    }
    if kind == "music":
        row.update(mood="calm", genre="test", bpm=90, key="C major")
    else:
        row["category"] = "ui"
    row.update(extra)
    return row


class Library:
    """Source files under `root` and the manifest that describes them."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.files: dict[str, bytes] = {
            "music/morning.ogg": ogg_opus_bytes(1.0),
            "music/evening.ogg": ogg_opus_bytes(1.5, channels=1),
            "sfx/pop.ogg": ogg_opus_bytes(0.2),
        }
        for name, data in self.files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)

    def rows(self) -> list[dict]:
        return [
            track_row("morning", "music", self.files["music/morning.ogg"]),
            track_row("evening", "music", self.files["music/evening.ogg"], mood="lofi"),
            track_row("pop", "sfx", self.files["sfx/pop.ogg"]),
        ]

    def manifest_json(self, packs: list[dict] | None = None, **top) -> dict:
        return {
            "schema": 1,
            "release": "2026.10.1",
            "license": LICENSE,
            "tracks": self.rows(),
            "packs": packs or [],
            **top,
        }

    def manifest(self, packs: list[dict] | None = None) -> Manifest:
        return parse_manifest(self.manifest_json(packs))

    def write_manifest(self, path: Path, packs: list[dict] | None = None) -> Path:
        path.write_text(json.dumps(self.manifest_json(packs)), encoding="utf-8")
        return path


def pack_archive(members: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    return buffer.getvalue()


PACK_MEMBERS = {
    "Sounds/chime one.ogg": ogg_opus_bytes(0.4),
    "Sounds/whoosh.wav": wav_bytes(0.3),
    "Music/theme.mp3": mp3_bytes(frames=20, id3=True),
}


def pack_row(archive: bytes, members: dict[str, bytes] | None = None, **top) -> dict:
    members = members or PACK_MEMBERS
    kinds = {"Sounds/chime one.ogg": "sfx", "Sounds/whoosh.wav": "sfx", "Music/theme.mp3": "music"}
    tracks = []
    for name, data in members.items():
        slug = name.rsplit("/", 1)[-1].rsplit(".", 1)[0].lower().replace(" ", "-")
        kind = kinds.get(name, "sfx")
        extra = {"mood": "upbeat", "bpm": 100} if kind == "music" else {"category": "magic"}
        tracks.append(
            {
                "id": slug,
                "kind": kind,
                "title": slug.title(),
                "tags": ["pack"],
                "channels": 2,
                "durationMs": 400,
                "loop": False,
                "file": name,
                "bytes": len(data),
                "sha256": sha(data),
                **extra,
            }
        )
    row = {
        "id": "open-sounds",
        "name": "Open Sounds",
        "description": "A test pack.",
        "homepage": "https://example.org/open-sounds",
        "license": {
            **LICENSE,
            "holder": "A. Author",
            "note": "Dedicated to the public domain by the author.",
        },
        "attribution": "Open Sounds by A. Author (CC0)",
        "archive": {
            "url": "https://github.com/example/open-sounds/releases/download/v1/open-sounds.zip",
            "bytes": len(archive),
            "sha256": sha(archive),
        },
        "tracks": tracks,
    }
    row.update(top)
    return row
