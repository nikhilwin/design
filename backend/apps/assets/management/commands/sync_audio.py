from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from apps.assets.audiolib.install import Options, Report, audio_root, is_installed, read_index, sync
from apps.assets.audiolib.manifest import LIBRARY_DIR, Manifest, ManifestError, load_manifest
from apps.assets.audiolib.packs import DirectoryPackSource, HttpPackSource, PackSource


class Command(BaseCommand):
    help = (
        "Install the audio library (music loops and sound effects) into MEDIA_ROOT/audio/ from the files "
        "bundled in backend/data/audio/, and write the catalogue (index.json) the editor reads. Every file "
        "is checked against the SHA-256 in backend/data/audio_library.json before it is put in place. "
        "Idempotent: a second run changes nothing. Optional CC0 packs from the manifest: --pack."
    )

    def __init__(
        self, *args, manifest: Manifest | None = None, pack_source: PackSource | None = None, **kwargs
    ):
        super().__init__(*args, **kwargs)
        self._manifest = manifest
        self._pack_source = pack_source

    def add_arguments(self, parser):
        parser.add_argument(
            "--from-dir",
            metavar="DIR",
            help="Take the files from DIR instead of backend/data/audio (music/<id>.ogg, sfx/<id>.ogg, and "
            "the pack archives by file name), for installs without the repository checkout or the network.",
        )
        parser.add_argument(
            "--pack", nargs="+", action="extend", metavar="ID", help="Also install these packs (see --list)."
        )
        parser.add_argument("--all-packs", action="store_true", help="Install every pack in the manifest.")
        parser.add_argument("--list", action="store_true", help="List the library and the packs, then exit.")
        parser.add_argument("--dry-run", action="store_true", help="Report what would change; write nothing.")
        parser.add_argument("--force", action="store_true", help="Copy every file again.")
        parser.add_argument(
            "--prune",
            action="store_true",
            help="Also remove files of packs that are no longer wanted (library files are always tidied).",
        )

    def handle(
        self,
        *args,
        from_dir=None,
        pack=None,
        all_packs=False,
        list=False,
        dry_run=False,
        force=False,
        prune=False,
        **opts,
    ):
        try:
            manifest = self._manifest or load_manifest()
        except ManifestError as exc:
            raise CommandError(str(exc)) from exc
        if list:
            return self._list(manifest)
        chosen = self._choose_packs(manifest, pack, all_packs)
        source_dir = Path(from_dir) if from_dir else LIBRARY_DIR
        if not source_dir.is_dir():
            raise CommandError(f"{source_dir}: not a directory.")
        pack_source = self._pack_source or (DirectoryPackSource(source_dir) if from_dir else HttpPackSource())

        self.stdout.write(
            f"Syncing {len(manifest.tracks)} track(s) of release {manifest.release}"
            + (f" and {len(chosen)} pack(s)" if chosen else "")
            + (" - dry run, nothing is written" if dry_run else "")
            + "."
        )
        report = sync(
            manifest,
            source_dir=source_dir,
            packs=chosen,
            pack_source=pack_source,
            options=Options(force=force, dry_run=dry_run, prune=prune),
            log=self.stderr.write,
        )
        self._summarise(report, dry_run)
        if report.aborted:
            raise CommandError(
                f"{report.aborted}. Check your network or proxy settings (HTTPS_PROXY), or download the pack "
                "archives on a machine with internet access and install them with --from-dir DIR "
                "(see THIRD_PARTY.md)."
            )
        if report.failed:
            raise CommandError(
                f"{len(report.failed)} item(s) failed: {', '.join(r.item for r in report.failed[:8])}. "
                "Nothing that failed is listed in the catalogue; run the command again to retry."
            )

    def _choose_packs(self, manifest: Manifest, ids, everything: bool):
        if everything:
            return list(manifest.packs)
        if not ids:
            return []
        unknown = [i for i in ids if manifest.pack(i) is None]
        if unknown:
            known = ", ".join(p.id for p in manifest.packs) or "none"
            raise CommandError(f"Unknown pack id(s): {', '.join(unknown)}. Packs in the manifest: {known}.")
        return [p for p in manifest.packs if p.id in set(ids)]

    def _list(self, manifest: Manifest) -> None:
        root = audio_root()
        installed = sum(is_installed(t, root) for t in manifest.tracks)
        music = [t for t in manifest.tracks if t.kind == "music"]
        self.stdout.write(
            f"Library release {manifest.release} ({manifest.license.spdx}): {len(music)} music loops, "
            f"{len(manifest.tracks) - len(music)} sound effects, {installed} installed in {root}"
        )
        index = read_index(root)
        have = {e.get("id") for e in (index or {}).get("tracks", []) if isinstance(e, dict)}
        for pack in manifest.packs:
            state = sum(t.id in have for t in pack.tracks)
            self.stdout.write(
                f"pack {pack.id}: {pack.name} - {len(pack.tracks)} track(s), {pack.license.spdx}, "
                f"{pack.archive_bytes / 1e6:.1f} MB [{state} installed]"
            )
        if not manifest.packs:
            self.stdout.write("No packs are listed in the manifest.")

    def _summarise(self, report: Report, dry_run: bool) -> None:
        count = lambda status: sum(r.status == status for r in report.results)  # noqa: E731
        line = (
            f"Done: {count('installed')} installed, {count('up-to-date')} already up to date"
            + (f", {count('would-install')} would be installed" if dry_run else "")
            + f", {len(report.removed)} removed, {len(report.failed)} failed"
            + ("; the catalogue was updated" if report.index_written else "")
            + "."
        )
        self.stdout.write(self.style.SUCCESS(line) if not report.failed else self.style.WARNING(line))
        for result in report.failed:
            self.stdout.write(self.style.ERROR(f"  {result.item}: {result.detail}"))
