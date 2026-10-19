from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.presets.importer import MODES, Catalogue, PresetImportError, read_file, write
from apps.presets.models import SizePreset, SizePresetGroup


def _json_files(paths: list[str]) -> list[Path]:
    files: list[Path] = []
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            files.extend(sorted(p for p in path.rglob("*.json") if p.is_file() and not p.is_symlink()))
        elif path.is_file():
            files.append(path)
        else:
            raise CommandError(f"{raw}: no such file or directory.")
    return files


class Command(BaseCommand):
    help = (
        'Import size presets from JSON files: {"version": 1, "groups": [...]}. Idempotent on the slug: '
        "a preset or group that already exists (a built-in one too) is overwritten by the file. "
        "A directory imports every *.json inside it."
    )

    def add_arguments(self, parser):
        parser.add_argument("paths", nargs="+", help="JSON file(s) or director(ies) containing them.")
        parser.add_argument(
            "--mode",
            choices=MODES,
            default="extend",
            help="extend (default): add to what is there. replace: also deactivate every group and preset "
            "the files do not name, so only they are offered.",
        )
        parser.add_argument("--dry-run", action="store_true", help="Check and report, but change nothing.")

    def handle(self, *args, paths, mode="extend", dry_run=False, **options):
        files = _json_files(paths)
        if not files:
            raise CommandError("No .json files found.")
        catalogue = Catalogue()
        try:
            for path in files:
                catalogue.merge(read_file(path))
            with transaction.atomic():
                report = write(catalogue, group_model=SizePresetGroup, preset_model=SizePreset, mode=mode)
                if dry_run:
                    transaction.set_rollback(True)
        except PresetImportError as exc:
            raise CommandError(str(exc))
        prefix = "Dry run, nothing changed. Would be: " if dry_run else "Size presets: "
        self.stdout.write(self.style.SUCCESS(f"{prefix}{report}."))
