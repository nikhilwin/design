"""Builders shared by the model-sync tests: manifests, a fake `ModelSource` and a fake HTTP session."""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from pathlib import Path
from typing import Any

from apps.core.mlmodels.manifest import ModelSpec, parse_manifest, parse_model
from apps.core.mlmodels.sources import Progress, SourceError, SourceUnavailable, Verify

PAYLOAD = b"onnx-model-bytes-" * 100


def model_entry(model_id: str = "demo", payload: bytes = PAYLOAD, **overrides: Any) -> dict[str, Any]:
    """A valid manifest entry whose size and hash match `payload`; `overrides` replace top-level keys."""
    entry: dict[str, Any] = {
        "id": model_id,
        "task": "background-removal",
        "name": f"Demo {model_id}",
        "description": "A demo model.",
        "priority": 10,
        "default": False,
        "file": f"{model_id}.onnx",
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "urls": [f"https://github.com/example/{model_id}/releases/download/v1/{model_id}.onnx"],
        "homepage": "https://github.com/example/demo",
        "license": {
            "spdx": "Apache-2.0",
            "url": "https://www.apache.org/licenses/LICENSE-2.0",
            "holder": "Demo authors.",
            "evidence": "Read LICENSE in the upstream repository.",
        },
        "input": {
            "name": "input",
            "size": 64,
            "mean": [0.5, 0.5, 0.5],
            "std": [1.0, 1.0, 1.0],
            "rescale": "255",
        },
        "output": "out",
    }
    entry.update(overrides)
    return entry


def make_spec(model_id: str = "demo", payload: bytes = PAYLOAD, **overrides: Any) -> ModelSpec:
    return parse_model(model_entry(model_id, payload, **overrides))


def make_manifest(*entries: dict[str, Any]):
    return parse_manifest({"schema": 1, "models": list(entries)})


class FakeSource:
    """Writes canned bytes per model id, records what it was asked, and can fail on demand."""

    def __init__(self, files: dict[str, bytes], *, error: Exception | None = None) -> None:
        self.files = files
        self.error = error
        self.calls: list[str] = []

    def fetch(
        self,
        spec: ModelSpec,
        destination: Path,
        on_progress: Progress | None = None,
        verify: Verify | None = None,
    ) -> None:
        self.calls.append(spec.id)
        if self.error:
            raise self.error
        data = self.files.get(spec.id)
        if data is None:
            raise SourceError(f"{spec.id} was not found")
        destination.write_bytes(data)
        if on_progress:
            half = len(data) // 2
            on_progress(half, len(data))
            on_progress(len(data), len(data))
        if verify:
            verify(destination)


def unreachable(host: str = "github.com") -> SourceUnavailable:
    return SourceUnavailable(f"Cannot reach {host}: ConnectionError")


class FakeResponse:
    def __init__(self, status: int = 200, body: bytes = b"", headers: dict[str, str] | None = None) -> None:
        self.status_code = status
        self.body = body
        self.headers = headers or {}
        self.closed = False

    def iter_content(self, chunk_size: int):
        for start in range(0, len(self.body), chunk_size):
            yield self.body[start : start + chunk_size]

    def close(self) -> None:
        self.closed = True


class FakeSession:
    """`requests.Session` stand-in: `handler(url, headers)` returns a `FakeResponse` (or raises)."""

    def __init__(self, handler: Callable[[str, dict[str, str]], FakeResponse]) -> None:
        self.handler = handler
        self.headers: dict[str, str] = {}
        self.requests: list[tuple[str, dict[str, str]]] = []

    def get(self, url: str, *, headers: dict[str, str] | None = None, **kwargs: Any) -> FakeResponse:
        assert kwargs.get("allow_redirects") is False, "redirects must be followed by hand"
        self.requests.append((url, dict(headers or {})))
        return self.handler(url, dict(headers or {}))
