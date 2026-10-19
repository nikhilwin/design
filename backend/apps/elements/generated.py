"""Artwork that is generated from code in this repository (`backend/data/graphics/`), not downloaded."""

from __future__ import annotations

import importlib.util
import sys
from functools import cache
from pathlib import Path
from types import ModuleType

from django.conf import settings

from .manifest import GeneratedSource
from .sources import SourceError

GRAPHICS_DIR = Path(settings.BASE_DIR) / "data" / "graphics"


@cache
def load_graphics() -> ModuleType:
    """Import the `graphics` generator package by path (`data/` is not an importable package)."""
    name = "doory_graphics"
    spec = importlib.util.spec_from_file_location(
        name, GRAPHICS_DIR / "__init__.py", submodule_search_locations=[str(GRAPHICS_DIR)]
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load {GRAPHICS_DIR}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def generated_files(spec: GeneratedSource) -> dict[str, bytes]:
    """`{folder/name.svg: bytes}` of one generated set (deterministic: same call, same bytes)."""
    module = load_graphics()
    try:
        files = module.render(spec.set)
    except KeyError as exc:
        raise SourceError(f"The generator has no set called {spec.set!r}.") from exc
    return {path: text.encode("utf-8") for path, text in files.items()}
