"""`manage.py sync_audio`: installing the library, idempotency, checksums, packs."""

import io
import json
import zipfile
from pathlib import Path

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from apps.assets.audiolib.install import audio_root, index_path, read_index
from apps.assets.audiolib.manifest import parse_manifest
from apps.assets.audiolib.packs import HttpPackSource, PackError, PackUnavailable
from apps.assets.management.commands.sync_audio import Command

from .audio_helpers import ogg_opus_bytes
from .audiolib_helpers import PACK_MEMBERS, Library, pack_archive, pack_row, sha


@pytest.fixture
def media(settings, tmp_path):
    settings.MEDIA_ROOT = str(tmp_path / "media")
    return Path(settings.MEDIA_ROOT)


@pytest.fixture
def library(tmp_path):
    return Library(tmp_path / "source")


class FakeSource:
    def __init__(self, archive: bytes | None = None, error: Exception | None = None) -> None:
        self.archive, self.error, self.calls = archive, error, 0

    def fetch(self, pack, destination):
        self.calls += 1
        if self.error:
            raise self.error
        destination.write_bytes(self.archive or b"")


def run(manifest, source_dir, *args, source=None) -> str:
    out = io.StringIO()
    command = Command(manifest=manifest, pack_source=source, stdout=out, stderr=io.StringIO())
    call_command(command, "--from-dir", str(source_dir), *args)
    return out.getvalue()


def snapshot(root: Path) -> dict[str, tuple[int, bytes]]:
    return {
        p.relative_to(root).as_posix(): (p.stat().st_mtime_ns, p.read_bytes())
        for p in root.rglob("*")
        if p.is_file()
    }


class TestInstall:
    def test_installs_files_under_hashed_names_and_writes_the_catalogue(self, media, library):
        manifest = library.manifest()
        text = run(manifest, library.root)
        assert "3 installed" in text
        root = audio_root()
        for track in manifest.tracks:
            assert (root / track.relative_path).read_bytes() == library.files[track.file]
        index = json.loads(index_path().read_text(encoding="utf-8"))
        assert (
            index["schema"] == 1 and index["release"] == "2026.10.1" and index["license"]["spdx"] == "CC0-1.0"
        )
        morning = next(t for t in index["tracks"] if t["id"] == "morning")
        assert morning["file"] == manifest.tracks[0].relative_path
        assert (morning["kind"], morning["mood"], morning["bpm"], morning["loop"]) == (
            "music",
            "calm",
            90,
            True,
        )
        assert morning["source"] == "doory" and morning["license"] == "CC0-1.0" and morning["peaks"]
        assert "sha256" not in morning and "category" not in morning
        pop = next(t for t in index["tracks"] if t["id"] == "pop")
        assert (pop["kind"], pop["category"]) == ("sfx", "ui") and "mood" not in pop

    def test_a_second_run_changes_nothing(self, media, library):
        manifest = library.manifest()
        run(manifest, library.root)
        before = snapshot(audio_root())
        text = run(manifest, library.root)
        assert "0 installed, 3 already up to date" in text and "catalogue was updated" not in text
        assert snapshot(audio_root()) == before

    def test_the_catalogue_is_deterministic(self, media, library, tmp_path, settings):
        run(library.manifest(), library.root)
        first = index_path().read_bytes()
        settings.MEDIA_ROOT = str(tmp_path / "other")
        run(library.manifest(), library.root)
        assert index_path().read_bytes() == first

    def test_a_damaged_installed_file_is_repaired(self, media, library):
        manifest = library.manifest()
        run(manifest, library.root)
        victim = audio_root() / manifest.tracks[0].relative_path
        victim.write_bytes(b"x" * victim.stat().st_size)
        assert "1 installed, 2 already up to date" in run(manifest, library.root)
        assert victim.read_bytes() == library.files["music/morning.ogg"]

    def test_force_copies_everything_again(self, media, library):
        manifest = library.manifest()
        run(manifest, library.root)
        assert "3 installed" in run(manifest, library.root, "--force")

    def test_dry_run_writes_nothing(self, media, library):
        text = run(library.manifest(), library.root, "--dry-run")
        assert "3 would be installed" in text and not media.exists()

    def test_a_new_release_replaces_the_old_file_and_tidies_up(self, media, library):
        run(library.manifest(), library.root)
        old = audio_root() / library.manifest().tracks[0].relative_path
        new_data = ogg_opus_bytes(2.0)
        (library.root / "music/morning.ogg").write_bytes(new_data)
        rows = library.rows()
        rows[0].update(bytes=len(new_data), sha256=sha(new_data))
        manifest = parse_manifest({**library.manifest_json(), "tracks": rows})
        text = run(manifest, library.root)
        assert "1 installed" in text and "1 removed" in text
        assert not old.exists() and (audio_root() / manifest.tracks[0].relative_path).is_file()

    def test_unknown_files_are_left_alone(self, media, library):
        run(library.manifest(), library.root)
        stray = audio_root() / "music" / "notes.txt"
        stray.write_text("keep me")
        run(library.manifest(), library.root)
        assert stray.read_text() == "keep me"


class TestChecksums:
    def test_a_file_that_does_not_match_is_refused_and_not_listed(self, media, library):
        (library.root / "sfx/pop.ogg").write_bytes(library.files["sfx/pop.ogg"][:-1] + b"\xff")
        with pytest.raises(CommandError, match="1 item"):
            run(library.manifest(), library.root)
        index = read_index()
        assert index is not None and [t["id"] for t in index["tracks"]] == ["morning", "evening"]
        assert not list((audio_root() / "sfx").glob("pop-*"))

    def test_a_missing_source_file(self, media, library):
        (library.root / "music/evening.ogg").unlink()
        with pytest.raises(CommandError):
            run(library.manifest(), library.root)
        assert [t["id"] for t in read_index()["tracks"]] == ["morning", "pop"]

    def test_content_that_is_not_audio_is_refused_even_with_a_matching_hash(self, media, library):
        junk = b"<html>not audio</html>" * 10
        (library.root / "sfx/pop.ogg").write_bytes(junk)
        rows = library.rows()
        rows[2].update(bytes=len(junk), sha256=sha(junk))
        with pytest.raises(CommandError):
            run(parse_manifest({**library.manifest_json(), "tracks": rows}), library.root)
        assert not list((audio_root() / "sfx").glob("*"))

    def test_a_failure_does_not_remove_what_is_installed(self, media, library):
        manifest = library.manifest()
        run(manifest, library.root)
        (library.root / "music/morning.ogg").unlink()
        with pytest.raises(CommandError):
            run(manifest, library.root, "--force")
        assert (audio_root() / manifest.tracks[0].relative_path).is_file()
        assert len(read_index()["tracks"]) == 3

    def test_nothing_is_written_when_the_source_is_empty(self, media, library, tmp_path):
        empty = tmp_path / "empty"
        empty.mkdir()
        with pytest.raises(CommandError):
            run(library.manifest(), empty)
        assert read_index() is None

    def test_the_source_directory_must_exist(self, media, library, tmp_path):
        with pytest.raises(CommandError, match="not a directory"):
            run(library.manifest(), tmp_path / "nope")

    def test_no_partial_files_are_left_behind(self, media, library):
        run(library.manifest(), library.root)
        assert not [p for p in audio_root().rglob("*") if p.name.endswith(".part")]


class TestPacks:
    @pytest.fixture
    def pack(self):
        archive = pack_archive(PACK_MEMBERS)
        return pack_row(archive), archive

    def test_packs_are_only_installed_when_asked_for(self, media, library, pack):
        row, archive = pack
        source = FakeSource(archive)
        run(library.manifest(packs=[row]), library.root, source=source)
        assert source.calls == 0 and {t["source"] for t in read_index()["tracks"]} == {"doory"}

    def test_install_a_pack(self, media, library, pack):
        row, archive = pack
        source = FakeSource(archive)
        manifest = library.manifest(packs=[row])
        text = run(manifest, library.root, "--pack", "open-sounds", source=source)
        assert "6 installed" in text and source.calls == 1
        index = read_index()
        added = [t for t in index["tracks"] if t["source"] == "open-sounds"]
        assert {t["id"] for t in added} == {"chime-one", "whoosh", "theme"}
        assert all(t["file"].startswith("packs/open-sounds/") and t["license"] == "CC0-1.0" for t in added)
        assert all((audio_root() / t["file"]).is_file() for t in added)
        [info] = index["packs"]
        assert (
            info["id"] == "open-sounds"
            and info["attribution"].startswith("Open Sounds")
            and info["license"]["spdx"] == "CC0-1.0"
        )

    def test_a_second_run_does_not_download_again(self, media, library, pack):
        row, archive = pack
        source = FakeSource(archive)
        manifest = library.manifest(packs=[row])
        run(manifest, library.root, "--pack", "open-sounds", source=source)
        before = snapshot(audio_root())
        run(manifest, library.root, "--pack", "open-sounds", source=source)
        assert source.calls == 1 and snapshot(audio_root()) == before

    def test_an_installed_pack_stays_in_the_catalogue_without_the_flag(self, media, library, pack):
        row, archive = pack
        manifest = library.manifest(packs=[row])
        run(manifest, library.root, "--pack", "open-sounds", source=FakeSource(archive))
        run(manifest, library.root, source=FakeSource(error=AssertionError("no download expected")))
        assert len([t for t in read_index()["tracks"] if t["source"] == "open-sounds"]) == 3

    def test_from_dir_reads_the_archive_from_the_directory(self, media, library, pack):
        row, archive = pack
        (library.root / "open-sounds.zip").write_bytes(archive)
        manifest = library.manifest(packs=[row])
        out = io.StringIO()
        call_command(
            Command(manifest=manifest, stdout=out, stderr=io.StringIO()),
            "--from-dir",
            str(library.root),
            "--all-packs",
        )
        assert "6 installed" in out.getvalue()

    def test_an_archive_with_the_wrong_hash(self, media, library, pack):
        row, archive = pack
        with pytest.raises(CommandError, match="failed"):
            run(
                library.manifest(packs=[row]),
                library.root,
                "--pack",
                "open-sounds",
                source=FakeSource(archive + b"x"),
            )
        assert [t["source"] for t in read_index()["tracks"]] == ["doory"] * 3

    def test_a_member_with_the_wrong_hash(self, media, library):
        tampered = pack_archive(
            {**PACK_MEMBERS, "Sounds/whoosh.wav": PACK_MEMBERS["Sounds/whoosh.wav"] + b"\x00"}
        )
        row = pack_row(tampered)
        row["tracks"][1]["sha256"] = sha(PACK_MEMBERS["Sounds/whoosh.wav"])
        row["tracks"][1]["bytes"] = len(PACK_MEMBERS["Sounds/whoosh.wav"]) + 1
        with pytest.raises(CommandError):
            run(
                library.manifest(packs=[row]),
                library.root,
                "--pack",
                "open-sounds",
                source=FakeSource(tampered),
            )

    def test_a_member_that_is_not_audio(self, media, library):
        members = {**PACK_MEMBERS, "Sounds/whoosh.wav": b"<script>alert(1)</script>" * 5}
        archive = pack_archive(members)
        with pytest.raises(CommandError):
            run(
                library.manifest(packs=[pack_row(archive, members)]),
                library.root,
                "--pack",
                "open-sounds",
                source=FakeSource(archive),
            )
        assert not (audio_root() / "packs").exists() or not list((audio_root() / "packs").rglob("*.wav"))

    def test_a_listed_member_missing_from_the_archive(self, media, library, pack):
        row, _ = pack
        smaller = pack_archive({k: v for k, v in PACK_MEMBERS.items() if "chime" not in k})
        row["archive"].update(bytes=len(smaller), sha256=sha(smaller))
        with pytest.raises(CommandError):
            run(
                library.manifest(packs=[row]),
                library.root,
                "--pack",
                "open-sounds",
                source=FakeSource(smaller),
            )

    def test_a_symbolic_link_member_is_refused(self, media, library):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as zf:
            info = zipfile.ZipInfo("Sounds/chime one.ogg")
            info.create_system = 3
            info.external_attr = 0o120777 << 16
            zf.writestr(info, PACK_MEMBERS["Sounds/chime one.ogg"])
        archive = buffer.getvalue()
        members = {"Sounds/chime one.ogg": PACK_MEMBERS["Sounds/chime one.ogg"]}
        with pytest.raises(CommandError):
            run(
                library.manifest(packs=[pack_row(archive, members)]),
                library.root,
                "--pack",
                "open-sounds",
                source=FakeSource(archive),
            )

    def test_not_a_zip(self, media, library, pack):
        row, _ = pack
        junk = b"this is not a zip file"
        row["archive"].update(bytes=len(junk), sha256=sha(junk))
        with pytest.raises(CommandError):
            run(library.manifest(packs=[row]), library.root, "--pack", "open-sounds", source=FakeSource(junk))

    def test_an_unreachable_network_stops_the_run_with_advice(self, media, library, pack):
        row, _ = pack
        with pytest.raises(CommandError, match="HTTPS_PROXY"):
            run(
                library.manifest(packs=[row]),
                library.root,
                "--pack",
                "open-sounds",
                source=FakeSource(error=PackUnavailable("Cannot reach github.com")),
            )

    def test_unknown_pack_ids(self, media, library, pack):
        row, _ = pack
        with pytest.raises(CommandError, match="Unknown pack"):
            run(library.manifest(packs=[row]), library.root, "--pack", "nope")

    def test_prune_removes_pack_files_that_left_the_manifest(self, media, library, pack):
        row, archive = pack
        run(library.manifest(packs=[row]), library.root, "--pack", "open-sounds", source=FakeSource(archive))
        text = run(library.manifest(), library.root, "--prune")
        assert "3 removed" in text and not list((audio_root() / "packs" / "open-sounds").glob("*"))
        assert all(t["source"] == "doory" for t in read_index()["tracks"])


class TestListing:
    def test_list_shows_the_state(self, media, library):
        out = io.StringIO()
        command = Command(manifest=library.manifest(), stdout=out, stderr=io.StringIO())
        call_command(command, "--list")
        assert (
            "1 music loops" not in out.getvalue()
            and "2 music loops, 1 sound effects, 0 installed" in out.getvalue()
        )
        run(library.manifest(), library.root)
        out = io.StringIO()
        call_command(Command(manifest=library.manifest(), stdout=out, stderr=io.StringIO()), "--list")
        assert "3 installed" in out.getvalue()

    def test_list_names_the_packs(self, media, library):
        archive = pack_archive(PACK_MEMBERS)
        out = io.StringIO()
        call_command(
            Command(manifest=library.manifest(packs=[pack_row(archive)]), stdout=out, stderr=io.StringIO()),
            "--list",
        )
        assert "pack open-sounds: Open Sounds - 3 track(s), CC0-1.0" in out.getvalue()


class TestHttpSource:
    class Response:
        def __init__(self, status=200, body=b"", headers=None):
            self.status_code, self.body, self.headers = status, body, headers or {}

        def iter_content(self, size):
            yield self.body

        def close(self):
            pass

    class Session:
        def __init__(self, responses):
            self.responses, self.headers, self.urls = list(responses), {}, []

        def get(self, url, **kwargs):
            self.urls.append(url)
            return self.responses.pop(0)

    def pack(self, tmp_path):
        library = Library(tmp_path / "s")
        archive = pack_archive(PACK_MEMBERS)
        return library.manifest(packs=[pack_row(archive)]).packs[0], archive

    def test_downloads_and_follows_redirects_to_allowed_hosts(self, tmp_path):
        pack, archive = self.pack(tmp_path)
        session = self.Session(
            [
                self.Response(302, headers={"Location": "https://objects.githubusercontent.com/x/pack.zip"}),
                self.Response(200, archive),
            ]
        )
        destination = tmp_path / "pack.zip"
        HttpPackSource(session, sleep=lambda _: None).fetch(pack, destination)
        assert destination.read_bytes() == archive and session.urls[1].startswith(
            "https://objects.githubusercontent.com"
        )

    def test_refuses_a_redirect_to_another_host(self, tmp_path):
        pack, _ = self.pack(tmp_path)
        session = self.Session([self.Response(302, headers={"Location": "https://evil.example/pack.zip"})])
        with pytest.raises(PackError, match="Refusing"):
            HttpPackSource(session, sleep=lambda _: None).fetch(pack, tmp_path / "pack.zip")

    def test_retries_a_server_error_then_succeeds(self, tmp_path):
        pack, archive = self.pack(tmp_path)
        session = self.Session(
            [self.Response(503, headers={"Retry-After": "1"}), self.Response(200, archive)]
        )
        sleeps = []
        HttpPackSource(session, sleep=sleeps.append).fetch(pack, tmp_path / "pack.zip")
        assert sleeps == [1.0]

    def test_a_download_larger_than_the_manifest_says_is_cut_off(self, tmp_path):
        pack, archive = self.pack(tmp_path)
        session = self.Session([self.Response(200, archive + b"x" * 100)] * 3)
        with pytest.raises(PackError, match="larger"):
            HttpPackSource(session, sleep=lambda _: None).fetch(pack, tmp_path / "pack.zip")

    def test_a_404_is_an_error_not_a_retry(self, tmp_path):
        pack, _ = self.pack(tmp_path)
        session = self.Session([self.Response(404)])
        with pytest.raises(PackError, match="404"):
            HttpPackSource(session, sleep=lambda _: None).fetch(pack, tmp_path / "pack.zip")
        assert len(session.urls) == 1

    def test_connection_failures_become_unavailable(self, tmp_path):
        import requests

        pack, _ = self.pack(tmp_path)

        class Broken:
            headers: dict = {}

            def get(self, *args, **kwargs):
                raise requests.ConnectionError("no route")

        with pytest.raises(PackUnavailable):
            HttpPackSource(Broken(), sleep=lambda _: None).fetch(pack, tmp_path / "pack.zip")


class TestTheBundledLibrary:
    def test_the_command_installs_the_real_library(self, media):
        out = io.StringIO()
        call_command("sync_audio", stdout=out, stderr=io.StringIO())
        index = read_index()
        assert index is not None
        assert (
            sum(t["kind"] == "music" for t in index["tracks"]) >= 24
            and sum(t["kind"] == "sfx" for t in index["tracks"]) >= 60
        )
        assert all((audio_root() / t["file"]).is_file() for t in index["tracks"])
        again = io.StringIO()
        call_command("sync_audio", stdout=again, stderr=io.StringIO())
        assert "0 installed" in again.getvalue() and "catalogue was updated" not in again.getvalue()
