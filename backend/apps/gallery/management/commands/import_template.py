import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from apps.gallery.importer import TemplateImportError, import_template

MAX_JSON_BYTES = 16 * 1024 * 1024


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
        "Import templates from JSON files: {title, category, tags, document, thumbnail?, ...}. "
        "Idempotent on the slug. A directory imports every *.json inside it."
    )

    def add_arguments(self, parser):
        parser.add_argument("paths", nargs="+", help="JSON file(s) or director(ies) containing them.")
        parser.add_argument(
            "--publish",
            action="store_true",
            help="Publish the imported templates (default: each file's is_published, else draft).",
        )
        parser.add_argument(
            "--create-categories",
            action="store_true",
            help="Create categories that do not exist yet instead of failing.",
        )

    def handle(self, *args, paths, publish=False, create_categories=False, **options):
        files = _json_files(paths)
        if not files:
            raise CommandError("No .json files found.")
        created = updated = 0
        failures: list[str] = []
        for path in files:
            try:
                if path.stat().st_size > MAX_JSON_BYTES:
                    raise TemplateImportError("The file is larger than 16 MB.")
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise TemplateImportError(f"Not valid JSON ({exc}).") from exc
                template, was_created = import_template(
                    data,
                    base_dir=path.parent,
                    publish=True if publish else None,
                    create_categories=create_categories,
                )
            except TemplateImportError as exc:
                failures.append(f"{path}: {exc}")
                self.stderr.write(self.style.ERROR(f"FAILED  {path}: {exc}"))
                continue
            created += was_created
            updated += not was_created
            verb = "created" if was_created else "updated"
            state = "published" if template.is_published else "draft"
            self.stdout.write(f"{verb:<8}{template.slug} ({state})")
        self.stdout.write(
            self.style.SUCCESS(f"Done: {created} created, {updated} updated, {len(failures)} failed.")
        )
        if failures:
            raise CommandError(f"{len(failures)} file(s) could not be imported.")
