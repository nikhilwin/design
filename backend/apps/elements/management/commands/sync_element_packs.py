import argparse
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from apps.elements.manifest import Manifest, ManifestError, PackSpec, load_manifest
from apps.elements.models import ElementPack
from apps.elements.packsync import SyncOptions, SyncReport, sync_packs
from apps.elements.sources import DirectorySource, HttpPackSource, PackSource

MAX_CONCURRENCY = 8


class Command(BaseCommand):
    help = (
        "Install the element packs listed in backend/data/element_packs.json: icon, emoji and illustration "
        "sets that are fetched from their upstream release (npm tarballs and pinned files, verified against "
        "the hashes in the manifest), plus Doory's own generated packs. Every SVG is normalised so it can be "
        "recolourable and sanitised before it is stored. Idempotent and resumable: a pack that is up to date "
        "is skipped without a download, and after an interruption the same command carries on."
    )

    def __init__(self, *args, source: PackSource | None = None, manifest: Manifest | None = None, **kwargs):
        super().__init__(*args, **kwargs)
        self._source = source
        self._manifest = manifest

    def add_arguments(self, parser):
        parser.add_argument(
            "--pack",
            nargs="+",
            action="extend",
            metavar="ID",
            help="Only these packs (ids as shown by --list). Default: every pack in the manifest.",
        )
        parser.add_argument("--list", action="store_true", help="List the packs and their state, then exit.")
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Download and check everything, report what would change, write nothing.",
        )
        parser.add_argument(
            "--force",
            action="store_true",
            help="Fetch and re-check packs even when they are up to date.",
        )
        parser.add_argument(
            "--prune",
            action="store_true",
            help="Unpublish elements that are no longer part of a pack (they are only reported otherwise).",
        )
        parser.add_argument(
            "--brand-logos",
            action=argparse.BooleanOptionalAction,
            default=None,
            help="Keep the brand logos (trademarks) the icon sets contain, tagged 'brand' and 'logo'. "
            "Default: DOORY_ELEMENTS_BRAND_LOGOS (off). Off again: the next sync unpublishes them.",
        )
        parser.add_argument(
            "--concurrency",
            type=int,
            default=4,
            help=f"Simultaneous downloads and file writes (default 4, max {MAX_CONCURRENCY}).",
        )
        parser.add_argument(
            "--from-dir",
            metavar="DIR",
            help="Take the packs from DIR instead of the network: npm tarballs "
            "('npm pack <package>@<version>') or unpacked folders named after the package.",
        )

    def handle(self, *args, pack=None, list=False, dry_run=False, force=False, prune=False, **options):
        brand_logos = options.get("brand_logos")
        if brand_logos is None:
            brand_logos = settings.DOORY_ELEMENTS_BRAND_LOGOS
        try:
            manifest = self._manifest or load_manifest()
            packs = manifest.select(pack)
        except ManifestError as exc:
            raise CommandError(str(exc)) from exc
        if list:
            return self._list(packs, brand_logos)
        if options["concurrency"] < 1:
            raise CommandError("--concurrency needs a positive number.")
        concurrency = min(options["concurrency"], MAX_CONCURRENCY)
        source = self._source or self._make_source(options["from_dir"], concurrency)

        self.stdout.write(
            f"Syncing {len(packs)} pack(s) ({concurrency} at a time)"
            + (", with brand logos" if brand_logos else "")
            + (" - dry run, nothing is written" if dry_run else "")
            + "."
        )
        report = sync_packs(
            packs,
            source,
            SyncOptions(
                concurrency=concurrency, force=force, dry_run=dry_run, prune=prune, brand_logos=brand_logos
            ),
            log=self.stdout.write,
        )
        self._summarise(report, dry_run)
        if report.aborted:
            raise CommandError(
                f"{report.aborted}. Check your network or proxy settings (HTTPS_PROXY), or download the "
                "releases on a machine with internet access and import them with --from-dir DIR "
                "(see THIRD_PARTY.md). Packs that finished are kept; run the command again to resume."
            )
        if report.failed:
            raise CommandError(
                f"{len(report.failed)} pack(s) failed: {', '.join(r.pack_id for r in report.failed)}. "
                "Packs that finished are kept; run the command again to retry the others."
            )

    def _make_source(self, from_dir: str | None, concurrency: int) -> PackSource:
        if not from_dir:
            return HttpPackSource(concurrency=concurrency)
        directory = Path(from_dir)
        if not directory.is_dir():
            raise CommandError(f"{from_dir}: not a directory.")
        return DirectorySource(directory)

    def _list(self, packs: list[PackSpec], brand_logos: bool) -> None:
        rows = {row.slug: row for row in ElementPack.objects.filter(slug__in=[p.id for p in packs])}
        width = max(len(p.id) for p in packs)
        for spec in packs:
            row = rows.get(spec.id)
            if row is None:
                state = "not installed"
            else:
                count = row.elements.count()
                current = row.sync_fingerprint == spec.fingerprint_for(brand_logos)
                state = f"{count} elements" + ("" if current else ", out of date")
            self.stdout.write(
                f"{spec.id:<{width}}  {spec.kind:<12} {spec.style or '-':<8} {spec.license.spdx:<14} "
                f"{spec.source_ref}  [{state}]"
            )

    def _summarise(self, report: SyncReport, dry_run: bool) -> None:
        results = report.results
        created = sum(r.created for r in results)
        updated = sum(r.updated for r in results)
        unchanged = sum(r.unchanged for r in results)
        skipped = sum(len(r.skipped) for r in results)
        current = sum(r.status == "up-to-date" for r in results)
        line = (
            f"Done: {sum(r.ok for r in results)} of {len(results)} pack(s) ok ({current} up to date); "
            f"{created} elements {'would be ' if dry_run else ''}created, {updated} updated, "
            f"{unchanged} unchanged, {skipped} files skipped."
        )
        self.stdout.write(self.style.SUCCESS(line) if not report.failed else self.style.WARNING(line))
