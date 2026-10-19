from pathlib import Path

from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError

from apps.elements.importer import ensure_pack, import_directory
from apps.elements.models import ElementKind


class Command(BaseCommand):
    help = (
        "Import every *.svg below a directory into an element pack (created if missing). Each SVG is "
        "sanitised; invalid ones are skipped with a message. Idempotent per pack and file path: names come "
        "from file stems, tags from folder names and name words."
    )

    def add_arguments(self, parser):
        parser.add_argument("directory", help="Folder containing the SVG files (searched recursively).")
        parser.add_argument("--pack", required=True, help="Pack slug, e.g. brand-icons.")
        parser.add_argument("--name", help="Pack display name (default: derived from the slug).")
        parser.add_argument("--kind", choices=ElementKind.values, help="Pack/element kind (default: shape).")
        parser.add_argument(
            "--license", help="SPDX licence id of the artwork, e.g. CC0-1.0 (required for a new pack)."
        )
        parser.add_argument("--source-url", help="Where the artwork comes from.")

    def handle(self, *args, directory, pack, name=None, kind=None, license=None, source_url=None, **options):
        root = Path(directory)
        if not root.is_dir():
            raise CommandError(f"{directory}: not a directory.")
        try:
            pack_obj, created = ensure_pack(
                pack,
                name=name,
                kind=kind,
                license=license,
                source_url=source_url,
            )
        except (ValueError, ValidationError) as exc:
            raise CommandError(_message(exc)) from exc
        self.stdout.write(f'{"Created" if created else "Using"} pack "{pack_obj.name}" ({pack_obj.slug}).')

        summary = import_directory(pack_obj, root, progress=self._progress)
        self.stdout.write(self.style.SUCCESS(f"Done: {summary}."))

    def _progress(self, outcome: str, detail: str) -> None:
        if outcome == "skipped":
            self.stderr.write(self.style.WARNING(f"skipped  {detail}"))
        else:
            self.stdout.write(f"{outcome:<9}{detail}")


def _message(exc: Exception) -> str:
    if isinstance(exc, ValidationError):
        return "; ".join(f"{field}: {' '.join(errors)}" for field, errors in exc.message_dict.items())
    return str(exc)
