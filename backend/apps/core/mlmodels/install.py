"""Putting a verified model file where the web server can serve it, and finding out what is installed.

Models live in `MEDIA_ROOT/models/<id>/<stem>-<hash>.onnx` on local disk (also when `USE_S3` is on: the editor
may only fetch from its own origin under the production CSP). The file name carries the start of the hash,
so the web server can cache it forever and a new release is a new URL. Files are written to a `.part` file
first and moved into place only after size and SHA-256 matched, so a half-written model is never served.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from django.conf import settings

from .manifest import Manifest, ModelSpec
from .sources import IntegrityError, ModelSource, SourceError, SourceUnavailable

logger = logging.getLogger(__name__)

NOTICE_NAME = "NOTICE.txt"
_HASHED = re.compile(r"^[a-z0-9][a-z0-9._-]*-[0-9a-f]{12}\.onnx(?:\.part)?$")


def models_root() -> Path:
    return Path(settings.MEDIA_ROOT) / "models"


def model_path(spec: ModelSpec, root: Path | None = None) -> Path:
    return (root or models_root()) / spec.id / spec.stored_name


def model_url(spec: ModelSpec) -> str:
    return f"{settings.MEDIA_URL}{spec.relative_path}"


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_file(spec: ModelSpec, path: Path) -> None:
    """Raises `IntegrityError` unless `path` is exactly the file the manifest pins."""
    size = path.stat().st_size
    if size != spec.bytes:
        raise IntegrityError(f"{spec.file}: {size} bytes, the manifest pins {spec.bytes}")
    if sha256_of(path) != spec.sha256:
        raise IntegrityError(f"{spec.file}: the content does not match the pinned SHA-256")


def is_installed(spec: ModelSpec, root: Path | None = None) -> bool:
    """Cheap check used on every `/config/` request: the file exists with the pinned size.

    The hash was verified when the file was installed (and is again by `sync_models`).
    """
    path = model_path(spec, root)
    try:
        return path.is_file() and path.stat().st_size == spec.bytes
    except OSError:
        return False


@dataclass
class InstallResult:
    model_id: str
    status: str  # installed | up-to-date | would-install | failed
    detail: str = ""
    #: The source cannot be reached at all (network, proxy, DNS).
    unreachable: bool = False

    @property
    def ok(self) -> bool:
        return self.status != "failed"


@dataclass
class InstallReport:
    results: list[InstallResult] = field(default_factory=list)
    #: Set when the source cannot be reached at all; the remaining models were not tried.
    aborted: str = ""

    @property
    def failed(self) -> list[InstallResult]:
        return [r for r in self.results if not r.ok]


@dataclass(frozen=True)
class InstallOptions:
    force: bool = False
    dry_run: bool = False
    root: Path | None = None


def install_models(
    specs: list[ModelSpec],
    source: ModelSource,
    options: InstallOptions | None = None,
    *,
    log: Callable[[str], None] = lambda message: None,
) -> InstallReport:
    options = options or InstallOptions()
    report = InstallReport()
    for spec in specs:
        result = _install_one(spec, source, options, log)
        report.results.append(result)
        log(f"{spec.id}: {result.status}" + (f" ({result.detail})" if result.detail else ""))
        if result.unreachable:
            report.aborted = result.detail
            break
    return report


def _install_one(
    spec: ModelSpec, source: ModelSource, options: InstallOptions, log: Callable[[str], None]
) -> InstallResult:
    final = model_path(spec, options.root)
    if not options.force and _verified(spec, final):
        _write_notice(spec, final.parent, options.dry_run)
        return InstallResult(spec.id, "up-to-date")
    if options.dry_run:
        return InstallResult(spec.id, "would-install", f"{spec.bytes / 1e6:.1f} MB")

    part = final.with_name(final.name + ".part")
    milestones = _Milestones(spec, log)
    try:
        final.parent.mkdir(parents=True, exist_ok=True)
        if options.force:
            part.unlink(missing_ok=True)
        source.fetch(spec, part, milestones, lambda path: verify_file(spec, path))
        verify_file(spec, part)
    except SourceUnavailable as exc:
        return InstallResult(spec.id, "failed", str(exc), unreachable=True)
    except IntegrityError as exc:
        part.unlink(missing_ok=True)
        return InstallResult(spec.id, "failed", str(exc))
    except SourceError as exc:
        return InstallResult(spec.id, "failed", str(exc))  # the partial file stays, the next run resumes it
    except OSError as exc:
        return InstallResult(spec.id, "failed", f"cannot write {final.parent}: {exc.strerror or exc}")
    try:
        part.chmod(0o644)
        os.replace(part, final)
        _write_notice(spec, final.parent, dry_run=False)
        _remove_stale(spec, final)
    except OSError as exc:
        return InstallResult(spec.id, "failed", f"cannot write {final.parent}: {exc.strerror or exc}")
    return InstallResult(spec.id, "installed", f"{spec.bytes / 1e6:.1f} MB")


def _verified(spec: ModelSpec, path: Path) -> bool:
    if not path.is_file():
        return False
    try:
        verify_file(spec, path)
    except (IntegrityError, OSError):
        return False
    return True


def _write_notice(spec: ModelSpec, folder: Path, dry_run: bool) -> None:
    if dry_run:
        return
    notice = folder / NOTICE_NAME
    try:
        if not notice.is_file() or notice.read_text(encoding="utf-8") != spec.notice:
            notice.write_text(spec.notice, encoding="utf-8")
    except OSError:
        logger.warning("Could not write %s", notice, exc_info=True)


def _remove_stale(spec: ModelSpec, keep: Path) -> None:
    """Delete files of an earlier release of this model (and abandoned partial downloads)."""
    stem = spec.file.rpartition(".")[0]
    for path in keep.parent.iterdir():
        if path != keep and path.name.startswith(f"{stem}-") and _HASHED.match(path.name):
            path.unlink(missing_ok=True)


class _Milestones:
    """Logs a line every 20 % so a 176 MB download shows life without flooding the output."""

    def __init__(self, spec: ModelSpec, log: Callable[[str], None]) -> None:
        self.spec, self.log, self.shown = spec, log, 0

    def __call__(self, done: int, total: int) -> None:
        step = done * 5 // max(total, 1)  # 0..5 in steps of 20 %
        if step > self.shown:
            self.shown = step
            self.log(f"{self.spec.id}: {step * 20}% ({done / 1e6:.0f} of {total / 1e6:.0f} MB)")


def installed_models(manifest: Manifest, root: Path | None = None) -> list[ModelSpec]:
    return [m for m in manifest.models if is_installed(m, root)]
