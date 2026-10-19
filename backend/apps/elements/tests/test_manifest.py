import copy
import json
import re

import pytest

from apps.elements.manifest import (
    ALLOWED_HOSTS,
    ALLOWED_LICENSES,
    NOTICE_LICENSES,
    GeneratedSource,
    ManifestError,
    NpmSource,
    UrlsSource,
    is_allowed_license,
    license_terms,
    load_manifest,
    parse_manifest,
    parse_pack,
)
from apps.elements.models import ElementKind, ElementStyle

from .packhelpers import pack_entry

MANIFEST = load_manifest()


# ---- the shipped manifest ----------------------------------------------------------------------------------


def test_the_shipped_manifest_has_the_planned_packs():
    ids = {pack.id for pack in MANIFEST.packs}
    assert {
        "lucide",
        "tabler-outline",
        "tabler-filled",
        "phosphor-regular",
        "phosphor-bold",
        "phosphor-fill",
        "phosphor-duotone",
        "bootstrap-outline",
        "bootstrap-fill",
        "heroicons-outline",
        "heroicons-solid",
        "material-outlined",
        "material-filled",
        "noto-emoji",
        "fluent-emoji",
        "open-doodles",
        "open-peeps",
        "backgrounds-patterns",
        "frames-badges",
        "dividers-borders",
        "speech-bubbles",
        "social-media",
        "sale-promo",
        "charts",
        "doodle-accents",
    } <= ids
    assert len(ids) == len(MANIFEST.packs)


@pytest.mark.parametrize("pack", MANIFEST.packs, ids=lambda p: p.id)
def test_every_shipped_pack_has_an_allowed_licence_and_the_notice_it_requires(pack):
    assert is_allowed_license(pack.license.spdx)
    assert pack.license.url.startswith("https://")
    if any(term in NOTICE_LICENSES for term in license_terms(pack.license.spdx)):
        assert pack.attribution.strip()
    assert pack.kind in ElementKind.values and (not pack.style or pack.style in ElementStyle.values)


@pytest.mark.parametrize(
    "pack", [p for p in MANIFEST.packs if isinstance(p.source, NpmSource)], ids=lambda p: p.id
)
def test_every_npm_pack_is_pinned_and_guards_its_licence_text(pack):
    assert pack.source.version.count(".") == 2 and pack.source.integrity.startswith("sha512-")
    assert pack.license.file and pack.license.match
    assert pack.source.tarball_url.startswith("https://registry.npmjs.org/")


@pytest.mark.parametrize(
    "pack",
    [p for p in MANIFEST.packs if p.kind == "icon" and isinstance(p.source, NpmSource)],
    ids=lambda p: p.id,
)
def test_every_downloaded_icon_pack_is_framed_so_the_editor_sizes_icons_alike(pack):
    assert pack.normalize.mode == "mono" and pack.normalize.size == 24 and pack.normalize.frame


def test_brand_logos_are_marked_as_brand_and_not_mixed_into_skip():
    brands = {p.id: p.naming.brand for p in MANIFEST.packs}
    skips = {p.id: p.naming.skip for p in MANIFEST.packs}
    assert brands["tabler-outline"] == brands["tabler-filled"] == "^brand-"
    assert all(
        brands[f"phosphor-{w}"] == "-logo(?:-simple)?$" for w in ("regular", "bold", "fill", "duotone")
    )
    assert re.search(brands["material-outlined"], "nest_audio") and re.search(
        brands["material-filled"], "android"
    )
    # The skin-tone variants stay in `skip`, so turning brand logos on cannot bring them in.
    assert {pack_id for pack_id, brand in brands.items() if brand} == {
        "tabler-outline",
        "tabler-filled",
        *(f"phosphor-{w}" for w in ("regular", "bold", "fill", "duotone")),
        "material-outlined",
        "material-filled",
        "bootstrap-outline",
        "bootstrap-fill",
    }
    assert re.search(skips["noto-emoji"], "waving-hand-dark-skin-tone") and not brands["noto-emoji"]
    assert not any(skip and re.search(skip, "brand-facebook") for skip in skips.values())
    assert brands["bootstrap-outline"] == brands["bootstrap-fill"]
    assert all(
        re.search(brands["bootstrap-fill"], name) for name in ("facebook", "github", "twitter-x", "apple")
    )
    assert not any(
        re.search(brands["bootstrap-fill"], name) for name in ("heart", "alarm", "credit-card", "git-branch")
    )


def test_the_brand_logo_choice_changes_the_fingerprint_only_of_packs_with_logos():
    for pack in MANIFEST.packs:
        assert pack.fingerprint_for(False) == pack.fingerprint
        assert (pack.fingerprint_for(True) != pack.fingerprint) == pack.has_brand


def test_every_url_in_the_shipped_indexes_is_https_on_an_allowed_host_with_a_hash():
    for pack in MANIFEST.packs:
        if isinstance(pack.source, UrlsSource):
            assert len(pack.source.files) >= 30
            for item in pack.source.files:
                assert item.url.startswith("https://") and len(item.sha256) == 64
                assert item.url.split("/")[2] in ALLOWED_HOSTS


def test_generated_packs_are_cc0_without_a_notice():
    generated = [p for p in MANIFEST.packs if isinstance(p.source, GeneratedSource)]
    assert len(generated) == 8
    assert {p.license.spdx for p in generated} == {"CC0-1.0"}


def test_the_allowed_licences_are_exactly_the_permissive_ones():
    assert {
        "MIT",
        "ISC",
        "Apache-2.0",
        "OFL-1.1",
        "CC0-1.0",
        "BSD-2-Clause",
        "BSD-3-Clause",
        "Unlicense",
    } == ALLOWED_LICENSES


def test_fingerprints_are_stable_and_distinct():
    assert [p.fingerprint for p in load_manifest().packs] == [p.fingerprint for p in MANIFEST.packs]
    assert len({p.fingerprint for p in MANIFEST.packs}) == len(MANIFEST.packs)


# ---- licence rules --------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "expression",
    ["MIT", "ISC AND MIT", "Apache-2.0 OR MIT", "CC0-1.0", "BSD-3-Clause", "Unlicense", "OFL-1.1"],
)
def test_permissive_licence_expressions_are_allowed(expression):
    assert is_allowed_license(expression)


@pytest.mark.parametrize(
    "expression",
    [
        "CC-BY-4.0",
        "CC-BY-SA-4.0",
        "CC-BY-NC-4.0",
        "GPL-3.0-only",
        "MPL-2.0",
        "LicenseRef-custom",
        "MIT AND CC-BY-4.0",
        "Apache-2.0 WITH LLVM-exception",
        "",
        "mit",
    ],
)
def test_attribution_share_alike_and_custom_licences_are_rejected(expression):
    assert not is_allowed_license(expression)
    with pytest.raises(ManifestError, match=r"not allowed|spdx is required"):
        parse_pack(pack_entry(license={"spdx": expression or " ", "url": "https://x.example/L"}))


def test_a_licence_that_asks_for_a_notice_needs_attribution_text():
    with pytest.raises(ManifestError, match="requires an attribution"):
        parse_pack(pack_entry(attribution=""))
    cc0 = pack_entry(
        license={
            "spdx": "CC0-1.0",
            "url": "https://creativecommons.org/publicdomain/zero/1.0/",
            "file": "LICENSE",
            "match": "CC0",
        },
        attribution="",
    )
    assert parse_pack(cc0).attribution == ""


# ---- validation ---------------------------------------------------------------------------------------------------


def broken(**changes):
    entry = copy.deepcopy(pack_entry())
    for path, value in changes.items():
        target = entry
        *parents, last = path.split(".")
        for part in parents:
            target = target[part]
        if value is None:
            target.pop(last, None)
        else:
            target[last] = value
    return entry


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"source.version": "^1.0.0"}, "exact"),
        ({"source.version": "latest"}, "exact"),
        ({"source.integrity": "sha1-abc"}, "integrity"),
        ({"source.integrity": None}, "integrity is required"),
        ({"source.package": "Bad Name"}, "npm package name"),
        ({"source.type": "git"}, "source.type"),
        ({"id": "Bad ID"}, "id must be"),
        ({"kind": "banana"}, "kind"),
        ({"style": "neon"}, "style"),
        ({"sort_order": -1}, "sort_order"),
        ({"files.include": []}, "at least one glob"),
        ({"files.include": ["/etc/*"]}, "relative"),
        ({"files.include": ["../x/*.svg"]}, "relative"),
        ({"files.reader": "magic"}, "reader"),
        ({"tags.format": "csv"}, "tags.format"),
        ({"tags.file": None}, "tags.file"),
        ({"normalize.mode": "rainbow"}, "normalize.mode"),
        ({"normalize.color": "red"}, "#rrggbb"),
        ({"normalize.size": 0}, "between 1 and 4096"),
        ({"normalize.frame": "yes"}, "true or false"),
        ({"license.match": "(unclosed"}, "regular expression"),
        ({"license.file": None}, "go together"),
        ({"homepage": "http://example.com"}, "https"),
        ({"naming": {"skip": "(unclosed"}}, "naming.skip"),
        ({"naming": {"brand": "(unclosed"}}, "naming.brand"),
        ({"naming": {"strip_extra": "x"}}, "unknown key"),
        ({"surprise": 1}, "unknown key"),
    ],
)
def test_invalid_pack_entries_are_rejected_with_a_clear_message(changes, message):
    with pytest.raises(ManifestError, match=message):
        parse_pack(broken(**changes))


def test_an_npm_pack_must_name_a_licence_file_to_check():
    entry = pack_entry(license={"spdx": "MIT", "url": "https://example.com/LICENSE"})
    with pytest.raises(ManifestError, match="licence file"):
        parse_pack(entry)


def test_generated_packs_take_no_download_settings():
    generated = {
        "id": "made-here",
        "name": "Made here",
        "kind": "graphic",
        "source": {"type": "generated", "generator": "graphics", "set": "charts"},
        "license": {"spdx": "CC0-1.0", "url": "https://creativecommons.org/publicdomain/zero/1.0/"},
    }
    pack = parse_pack(generated)
    assert pack.is_generated and pack.patterns == ()
    with pytest.raises(ManifestError, match="take no"):
        parse_pack({**generated, "files": {"include": ["*.svg"]}})
    with pytest.raises(ManifestError, match="unknown generator"):
        parse_pack({**generated, "source": {"type": "generated", "generator": "evil", "set": "x"}})


def test_url_sources_validate_their_index(tmp_path, monkeypatch):
    from apps.elements import manifest as module

    monkeypatch.setattr(module, "INDEX_DIR", tmp_path)

    def entry(rows):
        (tmp_path / "set.json").write_text(json.dumps(rows))
        return {
            "id": "urls-pack",
            "name": "Urls",
            "kind": "illustration",
            "source": {"type": "urls", "index": "set.json"},
            "files": {"include": ["*.svg"]},
            "normalize": {"mode": "colour"},
            "license": {"spdx": "CC0-1.0", "url": "https://creativecommons.org/publicdomain/zero/1.0/"},
        }

    good = {
        "name": "a.svg",
        "url": "https://opendoodles.s3-us-west-1.amazonaws.com/a.svg",
        "sha256": "a" * 64,
    }
    assert len(parse_pack(entry([good])).source.files) == 1
    for bad, message in (
        ({**good, "url": "http://opendoodles.s3-us-west-1.amazonaws.com/a.svg"}, "https"),
        ({**good, "url": "https://evil.example/a.svg"}, "not allowed"),
        ({**good, "url": "https://user@opendoodles.s3-us-west-1.amazonaws.com/a.svg"}, "https"),
        ({**good, "sha256": "XYZ"}, "sha256"),
        ({**good, "name": "../a.svg"}, "bad file name"),
        ({**good, "extra": 1}, "unknown key"),
    ):
        with pytest.raises(ManifestError, match=message):
            parse_pack(entry([bad]))
    with pytest.raises(ManifestError, match="duplicate"):
        parse_pack(entry([good, good]))
    with pytest.raises(ManifestError, match="non-empty"):
        parse_pack(entry([]))


def test_the_manifest_as_a_whole_is_validated():
    with pytest.raises(ManifestError, match="schema"):
        parse_manifest({"schema": 2, "packs": [pack_entry()]})
    with pytest.raises(ManifestError, match="unique"):
        parse_manifest({"schema": 1, "packs": [pack_entry(), pack_entry()]})
    with pytest.raises(ManifestError, match="non-empty"):
        parse_manifest({"schema": 1, "packs": []})
    with pytest.raises(ManifestError, match="object"):
        parse_manifest([])


def test_select_returns_packs_in_manifest_order_and_names_unknown_ids():
    assert [p.id for p in MANIFEST.select(["lucide", "backgrounds-patterns"])] == [
        "backgrounds-patterns",
        "lucide",
    ]
    assert len(MANIFEST.select(None)) == len(MANIFEST.packs)
    with pytest.raises(ManifestError, match=r"Unknown pack id.*nope"):
        MANIFEST.select(["lucide", "nope"])


def test_npm_source_urls_and_names():
    plain = NpmSource("lucide-static", "1.52.0", "sha512-x")
    scoped = NpmSource("@tabler/icons", "3.48.0", "sha512-x")
    assert plain.tarball_url == "https://registry.npmjs.org/lucide-static/-/lucide-static-1.52.0.tgz"
    assert scoped.tarball_url == "https://registry.npmjs.org/@tabler/icons/-/icons-3.48.0.tgz"
    assert scoped.tarball_name == "tabler-icons-3.48.0.tgz" and plain.label == "lucide-static@1.52.0"


def test_patterns_include_tag_and_licence_files():
    pack = parse_pack(pack_entry())
    assert pack.patterns == ("icons/*.svg", "tags.json", "LICENSE")


def test_a_missing_or_broken_manifest_file_is_reported(tmp_path):
    with pytest.raises(ManifestError, match="Cannot read"):
        load_manifest.__wrapped__(tmp_path / "missing.json")
    bad = tmp_path / "bad.json"
    bad.write_text("{nope")
    with pytest.raises(ManifestError, match="not valid JSON"):
        load_manifest.__wrapped__(bad)
