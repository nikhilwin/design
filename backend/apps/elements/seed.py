"""Built-in element packs: original shapes written by `backend/data/generate_shapes.py` (CC0-1.0)."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path
from types import ModuleType

from django.conf import settings

from .importer import ImportSummary, ensure_pack, import_directory
from .manifest import load_manifest
from .packsync import SyncOptions, SyncReport, sync_packs
from .sources import NoSource

GENERATOR_PATH = Path(settings.BASE_DIR) / "data" / "generate_shapes.py"
LICENSE = "CC0-1.0"

# (slug, name, kind, description). The generator writes one folder per slug.
BUILTIN_PACKS = [
    (
        "basic-shapes",
        "Basic Shapes",
        "shape",
        "Geometric shapes: polygons, stars, hearts, blobs, waves, badges.",
    ),
    ("lines-dividers", "Lines & Dividers", "line", "Lines, arrows, dividers, flourishes and brackets."),
    ("frames-masks", "Frames & Masks", "frame", "Photo masks and decorative frames."),
    ("arrows-callouts", "Arrows & Callouts", "shape", "Arrows, chevrons, speech bubbles and banners."),
]


def load_shape_generator() -> ModuleType:
    """Import `generate_shapes.py` by path (it is a stand-alone script, not part of an importable package)."""
    name = "doory_generate_shapes"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, GENERATOR_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load {GENERATOR_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def seed_builtin_packs(progress: Callable[[str, str], None] | None = None) -> dict[str, ImportSummary]:
    """Generate the built-in shapes into a temporary folder and import them (idempotent)."""
    generator = load_shape_generator()
    summaries: dict[str, ImportSummary] = {}
    with tempfile.TemporaryDirectory(prefix="doory-shapes-") as tmp:
        root = Path(tmp)
        generator.generate(root)
        for order, (slug, name, kind, description) in enumerate(BUILTIN_PACKS, start=1):
            pack, _ = ensure_pack(
                slug,
                name=name,
                kind=kind,
                license=LICENSE,
                description=description,
                sort_order=order * 10,
            )
            summaries[slug] = import_directory(pack, root / slug, progress=progress)
    return summaries


def seed_graphics_packs(log: Callable[[str], None] = lambda _: None) -> SyncReport:
    """Install the manifest's generated packs (backgrounds, badges, dividers, bubbles, social glyphs, promo
    badges, charts and doodles from `backend/data/graphics/`). Needs no network; idempotent."""
    packs = [pack for pack in load_manifest().packs if pack.is_generated]
    return sync_packs(packs, NoSource(), SyncOptions(), log=log)
