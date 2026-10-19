from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.presets.importer import PresetImportError, builtin_catalogue, write
from apps.presets.models import SizePreset, SizePresetGroup


class Command(BaseCommand):
    help = (
        "Add the built-in size presets that are missing (idempotent; the first migration already adds them). "
        "Existing groups and presets keep their edits unless --update is given."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--update",
            action="store_true",
            help="Reset the built-in groups and presets to their defaults (other presets are left alone).",
        )

    def handle(self, *args, update: bool = False, **options):
        try:
            with transaction.atomic():
                report = write(
                    builtin_catalogue(),
                    group_model=SizePresetGroup,
                    preset_model=SizePreset,
                    overwrite=update,
                )
        except PresetImportError as exc:
            raise CommandError(str(exc))
        self.stdout.write(self.style.SUCCESS(f"Built-in size presets: {report}."))
