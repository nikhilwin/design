"""The audio manifest: what is accepted, and the bundled library itself."""

import copy
import json

import pytest

from apps.assets.audio import parse_audio
from apps.assets.audiolib.manifest import (
    LIBRARY_DIR,
    MANIFEST_PATH,
    MOODS,
    ManifestError,
    host_allowed,
    load_manifest,
    parse_manifest,
)

from .audiolib_helpers import Library, pack_archive, pack_row, sha


@pytest.fixture
def library(tmp_path):
    return Library(tmp_path)


def build(library: Library, mutate=None, packs=None) -> dict:
    raw = copy.deepcopy(library.manifest_json(packs))
    if mutate:
        mutate(raw)
    return raw


def reject(library: Library, mutate, match: str, packs=None) -> None:
    with pytest.raises(ManifestError, match=match):
        parse_manifest(build(library, mutate, packs))


class TestTracks:
    def test_a_valid_manifest(self, library):
        manifest = parse_manifest(build(library))
        assert [t.id for t in manifest.tracks] == ["morning", "evening", "pop"]
        morning = manifest.tracks[0]
        assert morning.stored_name == f"morning-{morning.sha256[:12]}.ogg"
        assert morning.relative_path == f"music/{morning.stored_name}"
        assert manifest.license.spdx == "CC0-1.0"

    @pytest.mark.parametrize("bad", ["Morning", "-x", "a b", "", "x" * 49, "a/b", "ünï"])
    def test_ids(self, library, bad):
        reject(library, lambda m: m["tracks"][0].update(id=bad), "id must be")

    def test_ids_are_unique(self, library):
        reject(library, lambda m: m["tracks"][1].update(id="morning", file="music/morning.ogg"), "unique")

    def test_a_music_track_needs_a_known_mood(self, library):
        reject(library, lambda m: m["tracks"][0].update(mood="angry"), "mood must be one of")

    def test_an_effect_needs_a_known_category(self, library):
        reject(library, lambda m: m["tracks"][2].update(category="weather"), "category must be one of")

    @pytest.mark.parametrize(
        "file",
        [
            "../etc/passwd",
            "/music/morning.ogg",
            "music/../morning.ogg",
            "sfx/morning.ogg",
            "music/morning.exe",
            "music/other.ogg",
            "morning.ogg",
            "music/morning.ogg/x",
        ],
    )
    def test_the_file_stays_in_its_folder_and_is_named_after_the_id(self, library, file):
        reject(library, lambda m: m["tracks"][0].update(file=file), "file")

    @pytest.mark.parametrize("digest", ["", "abc", "G" * 64, "A" * 64, 5])
    def test_the_hash_is_a_lower_case_sha256(self, library, digest):
        reject(library, lambda m: m["tracks"][0].update(sha256=digest), "sha256")

    @pytest.mark.parametrize(
        ("key", "value"),
        [
            ("bytes", 0),
            ("bytes", 10**9),
            ("bytes", "5"),
            ("channels", 3),
            ("durationMs", 1),
            ("bpm", 5),
            ("bpm", 999),
            ("lufs", 3),
            ("loop", "yes"),
        ],
    )
    def test_numbers_are_bounded(self, library, key, value):
        reject(library, lambda m: m["tracks"][0].update({key: value}), key)

    @pytest.mark.parametrize("peaks", [[101], [-1], ["a"], [0] * 257, "none"])
    def test_peaks(self, library, peaks):
        reject(library, lambda m: m["tracks"][0].update(peaks=peaks), "peaks")

    @pytest.mark.parametrize("tags", [["UPPER"], ["a" * 31], list("abcdefghi"), ["<b>"], "x"])
    def test_tags(self, library, tags):
        reject(library, lambda m: m["tracks"][0].update(tags=tags), "tag")

    def test_unknown_keys_are_refused(self, library):
        reject(library, lambda m: m["tracks"][0].update(autoplay=True), "unknown key")
        reject(library, lambda m: m.update(extra=1), "unknown key")

    def test_schema_and_release(self, library):
        reject(library, lambda m: m.update(schema=2), "schema")
        reject(library, lambda m: m.update(release="latest"), "release")
        reject(library, lambda m: m.update(tracks=[]), "non-empty")

    @pytest.mark.parametrize(
        "spdx", ["MIT", "CC-BY-4.0", "CC-BY-NC-4.0", "CC-BY-SA-4.0", "GPL-3.0-only", "Apache-2.0", "custom"]
    )
    def test_only_public_domain_licences(self, library, spdx):
        reject(library, lambda m: m["license"].update(spdx=spdx), "not allowed")

    @pytest.mark.parametrize("spdx", ["CC0-1.0", "Unlicense", "LicenseRef-PublicDomain"])
    def test_public_domain_licences_pass(self, library, spdx):
        assert parse_manifest(build(library, lambda m: m["license"].update(spdx=spdx))).license.spdx == spdx


class TestPacks:
    @pytest.fixture
    def pack(self):
        archive = pack_archive({})
        return pack_row(archive), archive

    def test_a_valid_pack(self, library, pack):
        row, _ = pack
        manifest = parse_manifest(build(library, packs=[row]))
        spec = manifest.pack("open-sounds")
        assert spec is not None and spec.archive_name == "open-sounds.zip"
        assert {t.id for t in spec.tracks} == {"chime-one", "whoosh", "theme"}
        assert spec.members["chime-one"] == "Sounds/chime one.ogg"

    @pytest.mark.parametrize(
        "spdx", ["CC-BY-4.0", "CC-BY-NC-4.0", "CC-BY-SA-4.0", "MIT", "GPL-2.0-only", "OFL-1.1"]
    )
    def test_a_pack_must_be_public_domain(self, library, pack, spdx):
        row, _ = pack
        row["license"]["spdx"] = spdx
        reject(library, None, "not allowed", packs=[row])

    def test_a_pack_needs_credit_text_and_a_licence_url(self, library, pack):
        row, _ = pack
        row["attribution"] = ""
        reject(library, None, "attribution", packs=[row])

    @pytest.mark.parametrize(
        "url",
        [
            "http://github.com/a.zip",
            "https://evil.example/a.zip",
            "https://user@github.com/a.zip",
            "ftp://github.com/a.zip",
            "https://github.com.evil.example/a.zip",
        ],
    )
    def test_the_archive_must_come_from_an_allowed_https_host(self, library, pack, url):
        row, _ = pack
        row["archive"]["url"] = url
        reject(library, None, "archive|host|https", packs=[row])

    def test_member_names_cannot_escape(self, library, pack):
        row, _ = pack
        row["tracks"][0]["file"] = "../../etc/passwd.ogg"
        reject(library, None, "file", packs=[row])

    def test_duplicate_pack_ids(self, library, pack):
        row, _ = pack
        reject(library, None, "pack ids must be unique", packs=[row, copy.deepcopy(row)])

    def test_host_allow_list(self):
        assert host_allowed("github.com") and host_allowed("objects.githubusercontent.com")
        assert (
            not host_allowed("evil.example") and not host_allowed(None) and not host_allowed("notgithub.com")
        )


class TestTheBundledLibrary:
    """The files in backend/data/audio are exactly what the manifest says, and they are what the brief promises."""

    @pytest.fixture(scope="class")
    def manifest(self):
        return load_manifest()

    def test_the_numbers(self, manifest):
        music = [t for t in manifest.tracks if t.kind == "music"]
        effects = [t for t in manifest.tracks if t.kind == "sfx"]
        assert len(music) >= 24 and len(effects) >= 60
        for mood in MOODS:
            assert sum(t.mood == mood for t in music) >= 3, mood
        assert all(30_000 <= t.duration_ms <= 60_000 and t.loop for t in music)
        assert all(t.duration_ms <= 6_000 and not t.loop for t in effects)

    def test_the_bundle_is_small(self, manifest):
        total = sum((LIBRARY_DIR / t.file).stat().st_size for t in manifest.tracks)
        assert total <= 15 * 1024 * 1024

    def test_every_file_matches_its_row_and_is_audio(self, manifest):
        for track in manifest.tracks:
            data = (LIBRARY_DIR / track.file).read_bytes()
            assert len(data) == track.bytes, track.id
            assert sha(data) == track.sha256, track.id
            info = parse_audio(data)
            assert (info.mime, info.codec, info.channels) == ("audio/ogg", "opus", track.channels), track.id
            assert abs((info.duration_ms or 0) - track.duration_ms) <= 2, track.id

    def test_no_stray_files(self, manifest):
        listed = {t.file for t in manifest.tracks}
        found = {p.relative_to(LIBRARY_DIR).as_posix() for p in LIBRARY_DIR.rglob("*") if p.is_file()}
        assert found == listed

    def test_the_licence_is_cc0(self, manifest):
        assert manifest.license.spdx == "CC0-1.0"
        assert all(not t.tags or len(t.tags) <= 8 for t in manifest.tracks)

    def test_the_manifest_has_stable_formatting(self):
        raw = MANIFEST_PATH.read_text(encoding="utf-8")
        assert raw == json.dumps(json.loads(raw), indent=2) + "\n"
