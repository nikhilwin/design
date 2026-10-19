"""The model manifest (`backend/data/ml_models.json`): what `sync_models` installs.

Every model the editor can download is data in this one reviewed file: the exact upstream file (a SHA-256
and a byte size, never "latest"), where it may be fetched from, its licence with the evidence it was
verified against, and how a browser must feed it (input size, normalisation, output name). Loading
validates all of it. The licence rule lives here: only the identifiers in `ALLOWED_LICENSES` are accepted,
so a model under a non-commercial, share-alike, "responsible use" or custom licence cannot be added by
mistake.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from django.conf import settings

MANIFEST_PATH = Path(settings.BASE_DIR) / "data" / "ml_models.json"
SCHEMA = 1

#: Licences a model may be distributed under: both allow commercial use and redistribution and ask only that
#: the notice travels with the file (`sync_models` writes it next to the model).
ALLOWED_LICENSES = frozenset({"MIT", "Apache-2.0"})
TASKS = frozenset({"background-removal"})
RESCALES = frozenset({"max", "255"})

#: Hosts a model may be downloaded from. A redirect is followed only to a host that matches as well.
ALLOWED_HOSTS = frozenset({"github.com", "huggingface.co"})
ALLOWED_HOST_SUFFIXES = (".githubusercontent.com", ".huggingface.co", ".hf.co")

MAX_MODEL_BYTES = 512 * 1024 * 1024
MIN_INPUT_SIZE, MAX_INPUT_SIZE = 64, 2048

_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
_FILE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,80}\.onnx$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_TENSOR_NAME = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")


class ManifestError(ValueError):
    """The manifest (or one of its model entries) is not valid."""


def host_allowed(host: str | None) -> bool:
    return bool(host) and (host in ALLOWED_HOSTS or host.endswith(ALLOWED_HOST_SUFFIXES))


@dataclass(frozen=True)
class LicenseSpec:
    spdx: str
    url: str
    holder: str
    #: What the licence was verified against (upstream file and commit, model card, ...), kept with the entry.
    evidence: str


@dataclass(frozen=True)
class InputSpec:
    name: str
    size: int
    mean: tuple[float, float, float]
    std: tuple[float, float, float]
    #: `max`: divide by the image's largest value (the reference code of U²-Net); `255`: divide by 255.
    rescale: str


@dataclass(frozen=True)
class ModelSpec:
    id: str
    task: str
    name: str
    description: str
    #: Higher is better: `GET /config/` advertises the best installed model unless one is pinned.
    priority: int
    default: bool
    file: str
    bytes: int
    sha256: str
    urls: tuple[str, ...]
    homepage: str
    license: LicenseSpec
    input: InputSpec
    output: str

    @property
    def stored_name(self) -> str:
        """The name on disk: it carries the start of the hash, so a new release never reuses a cached URL."""
        stem, _, suffix = self.file.rpartition(".")
        return f"{stem}-{self.sha256[:12]}.{suffix}"

    @property
    def relative_path(self) -> str:
        return f"models/{self.id}/{self.stored_name}"

    @property
    def notice(self) -> str:
        return (
            f"{self.name}\n"
            f"{self.homepage}\n\n"
            f"The weights in {self.stored_name} are distributed under the {self.license.spdx} licence "
            f"({self.license.url}).\n{self.license.holder}\n\n"
            "Doory downloaded this exact file (SHA-256 "
            f"{self.sha256}) from the sources listed in backend/data/ml_models.json and did not modify it.\n"
        )


@dataclass(frozen=True)
class Manifest:
    models: tuple[ModelSpec, ...]

    def get(self, model_id: str) -> ModelSpec | None:
        return next((m for m in self.models if m.id == model_id), None)

    def defaults(self) -> list[ModelSpec]:
        return [m for m in self.models if m.default]

    def select(self, ids: list[str] | None, *, everything: bool = False) -> list[ModelSpec]:
        """The models named in `ids` (in manifest order), all of them, or the defaults."""
        if everything:
            return list(self.models)
        if not ids:
            return self.defaults()
        unknown = [i for i in ids if self.get(i) is None]
        if unknown:
            known = ", ".join(m.id for m in self.models)
            raise ManifestError(f"Unknown model id(s): {', '.join(unknown)}. Known models: {known}.")
        wanted = set(ids)
        return [m for m in self.models if m.id in wanted]


# ---- validation ------------------------------------------------------------------------------------------


def _expect(cond: bool, message: str) -> None:
    if not cond:
        raise ManifestError(message)


def _only(raw: dict[str, Any], allowed: set[str], where: str) -> None:
    extra = sorted(set(raw) - allowed)
    _expect(not extra, f"{where}: unknown key(s) {', '.join(extra)}")


def _object(raw: Any, where: str) -> dict[str, Any]:
    _expect(isinstance(raw, dict), f"{where} must be an object")
    return raw


def _str(raw: dict[str, Any], key: str, where: str) -> str:
    value = raw.get(key)
    _expect(isinstance(value, str) and bool(value.strip()), f"{where}: {key} is required")
    return value.strip()


def _int(raw: dict[str, Any], key: str, where: str, low: int, high: int) -> int:
    value = raw.get(key)
    _expect(
        isinstance(value, int) and not isinstance(value, bool) and low <= value <= high,
        f"{where}: {key} must be an integer from {low} to {high}",
    )
    return value


def _https_url(value: Any, where: str, *, hosts_only: bool) -> str:
    _expect(isinstance(value, str), f"{where}: URL must be a string")
    parsed = urlparse(value)
    _expect(
        parsed.scheme == "https" and bool(parsed.hostname) and not parsed.username and not parsed.fragment,
        f"{where}: {value!r} is not an https URL",
    )
    if hosts_only:
        _expect(host_allowed(parsed.hostname), f"{where}: host {parsed.hostname!r} is not allowed")
    return value


def _floats(raw: dict[str, Any], key: str, where: str, *, positive: bool) -> tuple[float, float, float]:
    value = raw.get(key)
    ok = (
        isinstance(value, list)
        and len(value) == 3
        and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in value)
    )
    _expect(ok, f"{where}: {key} must be three numbers")
    numbers = tuple(float(v) for v in value)
    _expect(
        all((v > 0 if positive else 0 <= v <= 1) for v in numbers),
        f"{where}: {key} out of range",
    )
    return numbers  # type: ignore[return-value]


def _license(raw: Any, where: str) -> LicenseSpec:
    raw = _object(raw, f"{where}.license")
    _only(raw, {"spdx", "url", "holder", "evidence"}, f"{where}.license")
    spdx = _str(raw, "spdx", f"{where}.license")
    _expect(
        spdx in ALLOWED_LICENSES,
        f"{where}: licence {spdx!r} is not allowed (only {', '.join(sorted(ALLOWED_LICENSES))})",
    )
    return LicenseSpec(
        spdx=spdx,
        url=_https_url(raw.get("url"), f"{where}.license", hosts_only=False),
        holder=_str(raw, "holder", f"{where}.license"),
        evidence=_str(raw, "evidence", f"{where}.license"),
    )


def _input(raw: Any, where: str) -> InputSpec:
    raw = _object(raw, f"{where}.input")
    _only(raw, {"name", "size", "mean", "std", "rescale"}, f"{where}.input")
    name = _str(raw, "name", f"{where}.input")
    _expect(bool(_TENSOR_NAME.match(name)), f"{where}.input: name {name!r} is not a tensor name")
    rescale = _str(raw, "rescale", f"{where}.input")
    _expect(rescale in RESCALES, f"{where}.input: rescale must be one of {', '.join(sorted(RESCALES))}")
    return InputSpec(
        name=name,
        size=_int(raw, "size", f"{where}.input", MIN_INPUT_SIZE, MAX_INPUT_SIZE),
        mean=_floats(raw, "mean", f"{where}.input", positive=False),
        std=_floats(raw, "std", f"{where}.input", positive=True),
        rescale=rescale,
    )


def parse_model(raw: Any) -> ModelSpec:
    raw = _object(raw, "model entry")
    model_id = raw.get("id") if isinstance(raw.get("id"), str) else "?"
    where = f"model {model_id!r}"
    _only(
        raw,
        {
            "id",
            "task",
            "name",
            "description",
            "priority",
            "default",
            "file",
            "bytes",
            "sha256",
            "urls",
            "homepage",
            "license",
            "input",
            "output",
        },
        where,
    )
    _expect(bool(_ID.match(model_id)), f"{where}: id must be lower-case letters, digits and hyphens")
    task = _str(raw, "task", where)
    _expect(task in TASKS, f"{where}: unknown task {task!r}")
    file = _str(raw, "file", where)
    _expect(bool(_FILE.match(file)), f"{where}: file must be a plain lower-case .onnx file name")
    sha256 = _str(raw, "sha256", where)
    _expect(bool(_SHA256.match(sha256)), f"{where}: sha256 must be 64 lower-case hex digits")
    urls = raw.get("urls")
    _expect(isinstance(urls, list) and bool(urls), f"{where}: urls must be a non-empty list")
    default = raw.get("default", False)
    _expect(isinstance(default, bool), f"{where}: default must be true or false")
    output = _str(raw, "output", where)
    _expect(bool(_TENSOR_NAME.match(output)), f"{where}: output {output!r} is not a tensor name")
    return ModelSpec(
        id=model_id,
        task=task,
        name=_str(raw, "name", where),
        description=_str(raw, "description", where),
        priority=_int(raw, "priority", where, 0, 1000),
        default=default,
        file=file,
        bytes=_int(raw, "bytes", where, 1, MAX_MODEL_BYTES),
        sha256=sha256,
        urls=tuple(_https_url(u, f"{where}.urls", hosts_only=True) for u in urls),
        homepage=_https_url(raw.get("homepage"), f"{where}.homepage", hosts_only=False),
        license=_license(raw.get("license"), where),
        input=_input(raw.get("input"), where),
        output=output,
    )


def parse_manifest(raw: Any) -> Manifest:
    raw = _object(raw, "the manifest")
    _only(raw, {"schema", "models"}, "manifest")
    _expect(raw.get("schema") == SCHEMA, f"manifest: schema must be {SCHEMA}")
    items = raw.get("models")
    _expect(isinstance(items, list) and bool(items), "manifest: models must be a non-empty list")
    models = tuple(parse_model(item) for item in items)
    ids = [m.id for m in models]
    _expect(len(ids) == len(set(ids)), "manifest: model ids must be unique")
    for task in {m.task for m in models}:
        defaults = [m for m in models if m.task == task and m.default]
        _expect(len(defaults) == 1, f"manifest: exactly one default model is needed for {task}")
    return Manifest(models=models)


@cache
def load_manifest(path: Path = MANIFEST_PATH) -> Manifest:
    """Read and validate the manifest; `ManifestError` explains what is wrong with it."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ManifestError(f"Cannot read {path}: {exc.strerror or exc}") from exc
    except ValueError as exc:
        raise ManifestError(f"{path} is not valid JSON: {exc}") from exc
    return parse_manifest(raw)
