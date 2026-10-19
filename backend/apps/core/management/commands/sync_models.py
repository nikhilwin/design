from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from apps.core.mlmodels.install import InstallOptions, InstallReport, install_models, is_installed, model_path
from apps.core.mlmodels.manifest import Manifest, ManifestError, ModelSpec, load_manifest
from apps.core.mlmodels.sources import DirectorySource, HttpModelSource, ModelSource


class Command(BaseCommand):
    help = (
        "Install the machine-learning models the editor runs in the browser (background removal) into "
        "MEDIA_ROOT/models/, from the exact files pinned in backend/data/ml_models.json (size and SHA-256 "
        "are verified before a file is put in place). Idempotent and resumable: a model that is installed "
        "is skipped, and after an interruption the same command continues the partial download."
    )

    def __init__(self, *args, source: ModelSource | None = None, manifest: Manifest | None = None, **kwargs):
        super().__init__(*args, **kwargs)
        self._source = source
        self._manifest = manifest

    def add_arguments(self, parser):
        parser.add_argument(
            "--model",
            nargs="+",
            action="extend",
            metavar="ID",
            help="Only these models (ids as shown by --list). Default: the default model of each task.",
        )
        parser.add_argument("--all", action="store_true", help="Every model in the manifest.")
        parser.add_argument("--list", action="store_true", help="List the models and their state, then exit.")
        parser.add_argument(
            "--dry-run", action="store_true", help="Report what would be downloaded; write nothing."
        )
        parser.add_argument(
            "--force", action="store_true", help="Download again even when a verified copy is installed."
        )
        parser.add_argument(
            "--from-dir",
            metavar="DIR",
            help="Take the files from DIR instead of the network: <DIR>/<file> or <DIR>/<id>/<file> with the "
            "upstream file name shown by --list (for example u2netp.onnx).",
        )

    def handle(self, *args, model=None, all=False, list=False, dry_run=False, force=False, **options):
        try:
            manifest = self._manifest or load_manifest()
            specs = manifest.select(model, everything=all)
        except ManifestError as exc:
            raise CommandError(str(exc)) from exc
        if list:
            return self._list(manifest.models)
        source = self._source or self._make_source(options["from_dir"])

        self.stdout.write(
            f"Syncing {len(specs)} model(s)" + (" - dry run, nothing is written" if dry_run else "") + "."
        )
        options = InstallOptions(force=force, dry_run=dry_run)
        report = install_models(specs, source, options, log=self.stdout.write)
        self._summarise(report, dry_run)
        if report.aborted:
            raise CommandError(
                f"{report.aborted}. Check your network or proxy settings (HTTPS_PROXY), or download the "
                "files on a machine with internet access and install them with --from-dir DIR "
                "(see THIRD_PARTY.md)."
            )
        if report.failed:
            raise CommandError(
                f"{len(report.failed)} model(s) failed: {', '.join(r.model_id for r in report.failed)}. "
                "Run the command again to retry."
            )

    def _make_source(self, from_dir: str | None) -> ModelSource:
        if not from_dir:
            return HttpModelSource()
        directory = Path(from_dir)
        if not directory.is_dir():
            raise CommandError(f"{from_dir}: not a directory.")
        return DirectorySource(directory)

    def _list(self, models: tuple[ModelSpec, ...]) -> None:
        width = max(len(m.id) for m in models)
        for spec in models:
            state = "installed" if is_installed(spec) else "not installed"
            tags = ", ".join(t for t in ("default" if spec.default else "", spec.license.spdx) if t)
            self.stdout.write(
                f"{spec.id:<{width}}  {spec.task:<18} {spec.bytes / 1e6:>7.1f} MB  {spec.file:<14} "
                f"[{state}] ({tags})"
            )
            self.stdout.write(f"{'':<{width}}  {model_path(spec)}")

    def _summarise(self, report: InstallReport, dry_run: bool) -> None:
        installed = sum(r.status == "installed" for r in report.results)
        current = sum(r.status == "up-to-date" for r in report.results)
        pending = sum(r.status == "would-install" for r in report.results)
        line = (
            f"Done: {len(report.results) - len(report.failed)} of {len(report.results)} model(s) ok; "
            f"{installed} installed, {current} already up to date"
            + (f", {pending} would be installed" if dry_run else "")
            + f", {len(report.failed)} failed."
        )
        self.stdout.write(self.style.SUCCESS(line) if not report.failed else self.style.WARNING(line))
