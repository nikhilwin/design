"""Install the starter templates that ship with Doory (`backend/data/templates/`).

The files are generated, reproducibly, by `npm run templates:build` in `frontend/`:
`manifest.json` lists every template, `<slug>.json` is its document and `thumbs/<slug>.webp` its
preview. The photos the templates use are in `photos/`; they are copied to media storage
(`templates/photos/<name>.webp`, where the documents point) every time the command runs. The import goes
through `apps.gallery.importer.import_template`, so a template is validated exactly
like one added in the admin or with `import_template`.

By default the command only *adds*: a template whose slug already exists is left alone (staff may have edited,
unpublished or re-ordered it). `--update` refreshes the existing ones from the files.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from django.conf import settings
from django.core.files import File
from django.core.files.storage import default_storage
from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError

from apps.designs.exceptions import DocumentTooLarge, InlineAssetNotAllowed, InvalidDocument
from apps.designs.validators import validate_document
from apps.fonts.models import FontFamily
from apps.gallery.importer import TemplateImportError, import_template
from apps.gallery.models import Template

DATA_DIR = Path(settings.BASE_DIR) / "data" / "templates"
MANIFEST_VERSION = 1
MAX_FILE_BYTES = 16 * 1024 * 1024
SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
ENTRY_KEYS = {"slug", "title", "category", "tags", "description", "preset", "is_featured", "fonts"}
PHOTO_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*\.webp$")
PHOTOS_DIR = "templates/photos/"
PHOTOS_URL = f"{settings.MEDIA_URL}{PHOTOS_DIR}"


def _read_json(path: Path) -> Any:
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            raise CommandError(f"{path.name} is larger than 16 MB.")
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise CommandError(f"{path} does not exist.") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CommandError(f"{path.name} is not valid JSON ({exc}).") from exc


def load_manifest(directory: Path) -> list[dict[str, Any]]:
    """The manifest entries, checked for shape: known keys, string fields, unique slugs."""
    manifest = _read_json(directory / "manifest.json")
    if not isinstance(manifest, dict) or manifest.get("version") != MANIFEST_VERSION:
        raise CommandError(f"manifest.json must be an object with version {MANIFEST_VERSION}.")
    entries = manifest.get("templates")
    if not isinstance(entries, list) or not entries:
        raise CommandError("manifest.json needs a non-empty list of templates.")
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise CommandError("Every manifest entry must be an object.")
        unknown = sorted(set(entry) - ENTRY_KEYS)
        if unknown:
            raise CommandError(f"Unknown manifest field(s): {', '.join(unknown)}.")
        slug = entry.get("slug")
        if not isinstance(slug, str) or not SLUG.match(slug):
            raise CommandError(f"{slug!r} is not a valid template slug.")
        if slug in seen:
            raise CommandError(f"The slug {slug} appears twice in the manifest.")
        seen.add(slug)
        for key in ("title", "category", "description"):
            if not isinstance(entry.get(key), str) or not entry[key].strip():
                raise CommandError(f"{slug}: {key} must be a non-empty string.")
        if not isinstance(entry.get("tags"), list) or not all(isinstance(tag, str) for tag in entry["tags"]):
            raise CommandError(f"{slug}: tags must be a list of strings.")
        fonts = entry.get("fonts", [])
        if not isinstance(fonts, list) or not all(isinstance(family, str) for family in fonts):
            raise CommandError(f"{slug}: fonts must be a list of family names.")
    return entries


def load_document(directory: Path, slug: str) -> dict[str, Any]:
    """The template's document, validated with the same rules the designs API applies to a saved design."""
    document = _read_json(directory / f"{slug}.json")
    try:
        validate_document(document, max_bytes=settings.MAX_DESIGN_DOCUMENT_BYTES)
    except (InvalidDocument, InlineAssetNotAllowed, DocumentTooLarge) as exc:
        raise CommandError(f"{slug}.json is not a valid design document: {exc.detail}") from exc
    return document


def photos_used(document: Any) -> set[str]:
    """File names of the starter photos a document shows (image sources under `/media/templates/photos/`)."""
    found: set[str] = set()
    stack: list[Any] = [document]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            src = node.get("src")
            if isinstance(src, str) and src.startswith(PHOTOS_URL):
                found.add(src[len(PHOTOS_URL) :])
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    return found


def install_photos(directory: Path) -> tuple[int, int]:
    """Copy `photos/*.webp` to media storage (same-size files are kept); returns (copied, kept)."""
    folder = directory / "photos"
    if not folder.is_dir():
        return 0, 0
    copied = kept = 0
    for path in sorted(folder.iterdir()):
        if not PHOTO_NAME.match(path.name):
            continue
        name = f"{PHOTOS_DIR}{path.name}"
        if default_storage.exists(name):
            if default_storage.size(name) == path.stat().st_size:
                kept += 1
                continue
            default_storage.delete(name)
        with path.open("rb") as handle:
            saved = default_storage.save(name, File(handle, name=path.name))
        if saved != name:
            raise CommandError(f"Could not store {path.name} at {name} (the storage chose {saved}).")
        copied += 1
    return copied, kept


def missing_fonts(families: set[str]) -> list[str]:
    """Families the templates use that the font catalogue lacks (their text falls back to a system font)."""
    installed = set(
        FontFamily.objects.filter(
            owner__isnull=True, is_published=True, family__in=families, variants__isnull=False
        ).values_list("family", flat=True)
    )
    return sorted(families - installed)


class Command(BaseCommand):
    help = (
        "Install the starter templates from backend/data/templates (published, with thumbnails). Adds the "
        "missing ones and leaves existing ones alone; --update refreshes them from the files. Idempotent."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--update",
            action="store_true",
            help="Also re-import templates that already exist (overwrites content, thumbnail and metadata).",
        )
        parser.add_argument(
            "--dir",
            dest="data_dir",
            default=str(DATA_DIR),
            help="Directory with manifest.json, <slug>.json and thumbs/ (default: backend/data/templates).",
        )

    def handle(self, *args, update: bool = False, data_dir: str = str(DATA_DIR), **options):
        directory = Path(data_dir)
        entries = load_manifest(directory)
        documents = {entry["slug"]: load_document(directory, entry["slug"]) for entry in entries}

        call_command("seed_gallery", stdout=self.stdout)
        copied, stored = install_photos(directory)
        if copied or stored:
            self.stdout.write(f"Starter photos: {copied} copied, {stored} already stored.")
        shipped = {path.name for path in (directory / "photos").glob("*.webp")}
        existing = set(Template.objects.filter(slug__in=documents).values_list("slug", flat=True))

        created = updated = kept = 0
        failures: list[str] = []
        for entry in entries:
            slug = entry["slug"]
            absent = sorted(photos_used(documents[slug]) - shipped)
            if absent:
                failures.append(f"{slug}: missing photos {', '.join(absent)}")
                self.stderr.write(self.style.ERROR(f"FAILED  {slug}: missing photos {', '.join(absent)}"))
                continue
            if slug in existing and not update:
                kept += 1
                self.stdout.write(f"kept    {slug}")
                continue
            data = {
                "slug": slug,
                "title": entry["title"],
                "category": entry["category"],
                "description": entry["description"],
                "tags": entry["tags"],
                "preset": entry.get("preset", ""),
                "is_featured": bool(entry.get("is_featured", False)),
                "is_published": True,
                "document": documents[slug],
                "thumbnail": f"thumbs/{slug}.webp",
            }
            try:
                _, was_created = import_template(data, base_dir=directory)
            except TemplateImportError as exc:
                failures.append(f"{slug}: {exc}")
                self.stderr.write(self.style.ERROR(f"FAILED  {slug}: {exc}"))
                continue
            created += was_created
            updated += not was_created
            self.stdout.write(f"{'created' if was_created else 'updated':<8}{slug}")

        self.stdout.write(
            self.style.SUCCESS(
                f"Starter templates: {created} created, {updated} updated, {kept} kept, "
                f"{len(failures)} failed."
            )
        )
        families = {family for entry in entries for family in entry.get("fonts", [])}
        absent = missing_fonts(families)
        if absent:
            quoted = " ".join(f'"{family}"' for family in absent)
            self.stdout.write(
                self.style.WARNING(
                    f"These fonts are not installed, so the templates use a fallback until they are: "
                    f"{', '.join(absent)}. Install them with: manage.py sync_fonts {quoted}"
                )
            )
        if failures:
            raise CommandError(f"{len(failures)} template(s) could not be imported.")
