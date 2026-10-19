"""What `GET /api/v1/config/` tells the browser about the installed models."""

from __future__ import annotations

from typing import Any

from django.conf import settings

from .install import installed_models, model_url
from .manifest import ManifestError, ModelSpec, load_manifest


def best_installed(task: str) -> ModelSpec | None:
    """The model the editor should use for `task`: the one pinned by `BACKGROUND_REMOVAL_MODEL`, else the
    installed model with the highest priority. None when nothing usable is installed."""
    try:
        manifest = load_manifest()
    except ManifestError:
        return None
    candidates = [m for m in installed_models(manifest) if m.task == task]
    pinned = getattr(settings, "BACKGROUND_REMOVAL_MODEL", "")
    if pinned:
        candidates = [m for m in candidates if m.id == pinned]
    return max(candidates, key=lambda m: (m.priority, m.id), default=None)


def describe(spec: ModelSpec) -> dict[str, Any]:
    """The public description a browser needs to download and run `spec`."""
    return {
        "id": spec.id,
        "name": spec.name,
        "url": model_url(spec),
        "bytes": spec.bytes,
        "sha256": spec.sha256,
        "input": {
            "name": spec.input.name,
            "size": spec.input.size,
            "mean": list(spec.input.mean),
            "std": list(spec.input.std),
            "rescale": spec.input.rescale,
        },
        "output": spec.output,
    }


def background_removal_model() -> dict[str, Any] | None:
    """The description of the model to use, or None when background removal is off or not installed."""
    if not getattr(settings, "BACKGROUND_REMOVAL_ENABLED", True):
        return None
    spec = best_installed("background-removal")
    return describe(spec) if spec else None
