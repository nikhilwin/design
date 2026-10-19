import json

import pytest
from django.core.files.storage import default_storage

from apps.elements import bulk
from apps.elements.models import Element, ElementPack
from apps.elements.normalize import DEFAULT_COLOR
from apps.elements.packsync import (
    LicenseMismatch,
    SyncOptions,
    build_entries,
    check_license,
    import_pack,
    is_up_to_date,
    sync_packs,
)
from apps.elements.sources import SourceError

from .packhelpers import FakeSource, demo_files, icon, make_pack, unreachable

pytestmark = pytest.mark.django_db


def run(packs, source, **options):
    lines: list[str] = []
    report = sync_packs(packs, source, SyncOptions(**options), lines.append)
    return report, lines


def source_for(*packs, files=None):
    return FakeSource({pack.source.label: (files or demo_files()) for pack in packs})


# ---- one pack ---------------------------------------------------------------------------------------------------


def test_a_pack_is_synced_with_licence_attribution_tags_and_recolourable_artwork():
    pack = make_pack()
    report, _ = run([pack], source_for(pack))

    assert [(r.pack_id, r.status, r.created) for r in report.results] == [("demo", "synced", 2)]
    row = ElementPack.objects.get(slug="demo")
    assert (row.name, row.kind, row.license, row.license_url, row.source_url) == (
        "Demo",
        "icon",
        "MIT",
        "https://example.com/LICENSE",
        "https://example.com/",
    )
    assert row.attribution == "Demo: Copyright (c) 2026 Example (MIT)."
    assert row.source_ref == "demo-icons@1.0.0" and row.sync_fingerprint == pack.fingerprint and row.synced_at
    home = row.elements.get(key="home")
    assert (home.name, home.kind, home.style, home.width, home.height) == ("Home", "icon", "outline", 24, 24)
    assert home.tags[:2] == ["house", "building"] and "home" in home.tags
    assert home.colors == [DEFAULT_COLOR] and home.is_recolorable
    assert row.elements.filter(is_recolorable=False).count() == 0


def test_a_second_run_downloads_nothing_and_force_checks_again():
    pack = make_pack()
    source = source_for(pack)
    run([pack], source)
    assert is_up_to_date(pack)

    report, lines = run([pack], source)
    assert [r.status for r in report.results] == ["up-to-date"] and len(source.calls) == 1
    assert any("nothing to download" in line for line in lines)

    forced, _ = run([pack], source, force=True)
    assert len(source.calls) == 2
    assert (forced.results[0].created, forced.results[0].updated, forced.results[0].unchanged) == (0, 0, 2)


def test_changing_the_manifest_entry_triggers_a_resync_that_only_updates_what_changed():
    pack = make_pack()
    run([pack], source_for(pack))

    changed = make_pack(style="filled")
    assert not is_up_to_date(changed)
    report, _ = run([changed], source_for(changed))

    assert report.results[0].updated == 2
    assert set(Element.objects.values_list("style", flat=True)) == {"filled"}


def test_staff_publication_choices_survive_a_resync():
    pack = make_pack()
    run([pack], source_for(pack))
    Element.objects.filter(key="star").update(is_published=False)

    run([pack], source_for(pack), force=True)

    assert Element.objects.get(key="star").is_published is False


def test_two_packs_sharing_one_release_download_it_once():
    outline = make_pack("demo-outline")
    filled = make_pack("demo-filled", style="filled")
    source = FakeSource({outline.source.label: demo_files()})

    report, _ = run([outline, filled], source)

    assert source.calls == ["demo-icons@1.0.0"] and all(r.status == "synced" for r in report.results)
    assert Element.objects.filter(pack__slug="demo-filled", style="filled").count() == 2


def test_a_release_whose_licence_text_changed_is_refused_and_nothing_is_imported():
    pack = make_pack()
    files = demo_files(LICENSE=b"Proprietary. All rights reserved.")

    report, lines = run([pack], source_for(pack, files=files))

    assert report.results[0].status == "failed" and "may have changed" in report.results[0].error
    assert not ElementPack.objects.exists() and not Element.objects.exists()
    with pytest.raises(LicenseMismatch):
        check_license(pack, files)
    with pytest.raises(LicenseMismatch, match="missing"):
        check_license(pack, {k: v for k, v in files.items() if k != "LICENSE"})
    assert any("FAILED" in line for line in lines)


def test_unusable_svgs_are_skipped_with_a_reason_and_the_rest_is_imported():
    pack = make_pack()
    files = demo_files(
        **{
            "icons/broken.svg": b"<svg",
            "icons/empty.svg": b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>',
        }
    )

    report, lines = run([pack], source_for(pack, files=files))

    result = report.results[0]
    assert result.created == 2 and {label for label, _ in result.skipped} == {"broken", "empty"}
    assert any("skipped broken" in line for line in lines)


def test_hostile_svg_content_is_neutralised():
    pack = make_pack()
    evil = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script>alert(1)</script><path onclick="x()" d="M1 1h9v9z"/></svg>'
    run([pack], source_for(pack, files=demo_files(**{"icons/evil.svg": evil})))

    text = Element.objects.get(key="evil").svg.read().decode()
    assert "script" not in text and "onclick" not in text and "<path" in text


def test_identical_icons_are_merged_and_the_alias_name_becomes_a_tag():
    pack = make_pack()
    files = demo_files(**{"icons/house.svg": icon("M3 12l9-9 9 9")})  # same drawing as home.svg

    report, _ = run([pack], source_for(pack, files=files))

    assert report.results[0].duplicates == 1 and report.results[0].created == 2
    home = Element.objects.get(key="home")  # `home` has tag data, `house` does not
    assert "house" in home.tags and not Element.objects.filter(key="house").exists()


def test_missing_or_unreadable_tag_data_degrades_to_name_words_with_a_warning():
    pack = make_pack()
    without = {k: v for k, v in demo_files().items() if k != "tags.json"}
    report, _ = run([pack], source_for(pack, files=without))
    assert "tags.json not found" in report.results[0].warnings[0]
    assert Element.objects.get(key="home").tags == ["home"]

    Element.objects.all().delete()
    broken = demo_files(**{"tags.json": b"not json"})
    report, _ = run([pack], source_for(pack, files=broken), force=True)
    assert "not valid JSON" in report.results[0].warnings[0]


def test_naming_rules_strip_suffixes_and_skip_unwanted_icons():
    pack = make_pack(
        "weights",
        files={"include": ["icons/*.svg"]},
        naming={"strip_suffix": "-bold", "skip": "-logo$"},
        tags={"format": "json-map", "file": "tags.json"},
    )
    files = demo_files(
        **{
            "icons/home-bold.svg": icon("M1 1h5v5z"),
            "icons/star-bold.svg": icon("M2 2h5v5z"),
            "icons/acme-logo-bold.svg": icon("M3 3h5v5z"),
        }
    )
    for name in ("icons/home.svg", "icons/star.svg"):
        files.pop(name)

    run([pack], FakeSource({pack.source.label: files}))

    assert sorted(Element.objects.values_list("key", flat=True)) == ["home", "star"]
    assert "house" in Element.objects.get(key="home").tags  # tag data keyed by the stripped name


def brand_pack_and_source():
    pack = make_pack(naming={"brand": "^brand-", "skip": "-dark$"})
    files = demo_files(
        **{"icons/brand-facebook.svg": icon("M4 4h5v5z"), "icons/home-dark.svg": icon("M5 5h5v5z")}
    )
    return pack, FakeSource({pack.source.label: files})


def test_brand_logos_are_left_out_unless_turned_on_and_then_tagged_with_a_trademark_notice():
    pack, source = brand_pack_and_source()
    run([pack], source)
    assert sorted(Element.objects.values_list("key", flat=True)) == ["home", "star"]
    assert "trademark" not in ElementPack.objects.get(slug="demo").attribution
    assert is_up_to_date(pack) and not is_up_to_date(pack, brand_logos=True)

    report, _ = run([pack], source, brand_logos=True)
    assert report.results[0].status == "synced" and report.results[0].created == 1
    assert sorted(Element.objects.values_list("key", flat=True)) == ["brand-facebook", "home", "star"]
    logo = Element.objects.get(key="brand-facebook")
    assert logo.tags[:2] == ["brand", "logo"] and "facebook" in logo.tags
    row = ElementPack.objects.get(slug="demo")
    assert row.attribution.endswith("use them according to their brand guidelines.")
    assert row.sync_fingerprint == pack.fingerprint_for(True) and is_up_to_date(pack, brand_logos=True)


def test_turning_brand_logos_off_again_unpublishes_them_on_the_next_sync_without_pruning():
    pack, source = brand_pack_and_source()
    run([pack], source, brand_logos=True)

    report, lines = run([pack], source)
    assert report.results[0].logos_unpublished == 1 and report.results[0].stale == 0
    assert not Element.objects.get(key="brand-facebook").is_published
    assert Element.objects.filter(key="home", is_published=True).exists()
    assert ElementPack.objects.get(slug="demo").attribution == "Demo: Copyright (c) 2026 Example (MIT)."
    assert any("1 brand logo(s) unpublished" in line for line in lines)

    report, _ = run([pack], source, prune=True)  # already done: nothing left for --prune
    assert [r.status for r in report.results] == ["up-to-date"]


def test_packs_without_brand_patterns_are_not_resynced_when_brand_logos_are_turned_on():
    pack = make_pack()
    source = source_for(pack)
    run([pack], source)
    report, _ = run([pack], source, brand_logos=True)
    assert [r.status for r in report.results] == ["up-to-date"] and len(source.calls) == 1


def test_the_bootstrap_packs_split_outline_and_fill_and_leave_out_brand_logos():
    from apps.elements.manifest import load_manifest

    packs = [p for p in load_manifest().packs if p.id in ("bootstrap-outline", "bootstrap-fill")]
    files = {
        "LICENSE": b"The MIT License (MIT)\n\nCopyright (c) 2019-2024 The Bootstrap Authors\n",
        "icons/heart.svg": icon("M8 2.7 7.3 2C5.6.3 2.5.9 1.4 3z"),
        "icons/heart-fill.svg": icon("M8 1.3C12.4-3.2 23.5 4.6 8 15z"),
        "icons/credit-card.svg": icon("M0 4a2 2 0 0 1 2-2h12z"),
        "icons/facebook.svg": icon("M16 8.05A8.02 8.02 0 0 0 8 0z"),
        "icons/twitter-x.svg": icon("M12.6.75h2.454l-5.36 6.142z"),
    }

    report, _ = run(packs, FakeSource({packs[0].source.label: files}))

    assert all(r.status == "synced" for r in report.results)
    keys = {
        slug: sorted(Element.objects.filter(pack__slug=slug).values_list("key", flat=True))
        for slug in ("bootstrap-outline", "bootstrap-fill")
    }
    assert keys == {"bootstrap-outline": ["credit-card", "heart"], "bootstrap-fill": ["heart"]}


def test_iconify_json_packs_are_expanded_and_skin_tone_variants_left_out():
    data = {
        "width": 32,
        "height": 32,
        "icons": {
            "waving-hand": {"body": '<path fill="#fc0" d="M0 0h20v20z"/>'},
            "waving-hand-light": {"body": '<path fill="#fda" d="M0 0h20v20z"/>'},
            "red-heart": {"body": '<path fill="rgb(255,0,0)" d="M2 2h9v9z"/>'},
        },
        "aliases": {"wave": {"parent": "waving-hand"}},
    }
    pack = make_pack(
        "emoji",
        kind="sticker",
        style="colour",
        files={"include": ["icons.json"], "reader": "iconify-json"},
        naming={"skip": "-light$"},
        tags={"format": "iconify-categories", "file": "metadata.json"},
        normalize={"mode": "colour", "size": 128},
        license={
            "spdx": "MIT",
            "url": "https://example.com/L",
            "file": "info.json",
            "match": '"spdx":\\s*"MIT"',
        },
    )
    files = {
        "icons.json": json.dumps(data).encode(),
        "metadata.json": json.dumps({"categories": {"Gestures": ["waving-hand"]}}).encode(),
        "info.json": b'{"license": {"spdx": "MIT"}}',
    }

    run([pack], FakeSource({pack.source.label: files}))

    assert sorted(Element.objects.values_list("key", flat=True)) == ["red-heart", "waving-hand"]
    wave = Element.objects.get(key="waving-hand")
    assert (
        wave.tags[:2] == ["gestures", "wave"]
        and wave.colors == ["#ffcc00"]
        and (wave.width, wave.height) == (128, 128)
    )
    assert Element.objects.get(key="red-heart").colors == ["#ff0000"]


def test_generated_packs_import_without_any_source():
    from apps.elements.manifest import load_manifest

    pack = load_manifest().get("charts")
    report, _ = run([pack], FakeSource())

    assert report.results[0].status == "synced" and report.results[0].created >= 30
    row = ElementPack.objects.get(slug="charts")
    assert (row.license, row.kind) == ("CC0-1.0", "graphic")
    assert Element.objects.filter(pack=row, is_recolorable=False).count() == 0


# ---- failure and resume ------------------------------------------------------------------------------------------


def test_a_failing_pack_does_not_stop_the_others_and_a_rerun_only_fetches_the_failed_one():
    good, bad = (
        make_pack("good"),
        make_pack(
            "bad",
            source={
                "type": "npm",
                "package": "other-icons",
                "version": "2.0.0",
                "integrity": "sha512-" + "B" * 86 + "==",
            },
        ),
    )
    source = FakeSource({good.source.label: demo_files()})

    report, _ = run([good, bad], source)

    assert [(r.pack_id, r.status) for r in report.results] == [("good", "synced"), ("bad", "failed")]
    assert report.failed and not report.aborted
    assert (
        ElementPack.objects.get(slug="good").sync_fingerprint
        and not ElementPack.objects.filter(slug="bad").exists()
    )

    source.archives[bad.source.label] = demo_files()
    source.calls.clear()
    report, _ = run([good, bad], source)
    assert [(r.pack_id, r.status) for r in report.results] == [("good", "up-to-date"), ("bad", "synced")]
    assert source.calls == ["other-icons@2.0.0"]


def test_an_unreachable_source_stops_the_run_and_marks_the_rest_as_not_attempted():
    first = make_pack("first")
    second = make_pack(
        "second",
        source={
            "type": "npm",
            "package": "other-icons",
            "version": "2.0.0",
            "integrity": "sha512-" + "B" * 86 + "==",
        },
    )
    source = FakeSource({second.source.label: demo_files()})
    source.failures[first.source.label] = unreachable()

    report, lines = run([first, second], source, concurrency=1)

    assert report.aborted.startswith("Cannot reach registry.npmjs.org")
    assert [(r.pack_id, r.status) for r in report.results] == [
        ("first", "failed"),
        ("second", "not-attempted"),
    ]
    assert any("Stopping" in line for line in lines) and not Element.objects.exists()


def test_an_interrupted_import_keeps_finished_batches_and_the_rerun_completes_it(monkeypatch):
    pack = make_pack()
    files = demo_files(**{f"icons/extra-{i}.svg": icon(f"M{i} 1h5v5z") for i in range(8)})
    source = source_for(pack, files=files)
    real = bulk._write_files
    calls = []

    def flaky(plan, workers, written):
        calls.append(1)
        if len(calls) == 2:
            raise OSError("disk full")
        return real(plan, workers, written)

    monkeypatch.setattr(bulk, "_write_files", flaky)
    with pytest.raises(OSError, match="disk full"):
        sync_packs([pack], source, SyncOptions(batch_size=4), lambda _: None)

    row = ElementPack.objects.get(slug="demo")
    assert row.sync_fingerprint == "" and row.elements.count() == 4 and not is_up_to_date(pack)

    monkeypatch.setattr(bulk, "_write_files", real)
    report, _ = run([pack], source, batch_size=4)
    assert (report.results[0].created, report.results[0].unchanged) == (6, 4)
    assert ElementPack.objects.get(slug="demo").elements.count() == 10 and is_up_to_date(pack)


def test_an_empty_release_is_an_error_not_a_silent_success():
    pack = make_pack(files={"include": ["nothing/*.svg"]})
    report, _ = run([pack], source_for(pack))
    assert report.results[0].status == "failed" and "no usable artwork" in report.results[0].error


# ---- prune, dry run ------------------------------------------------------------------------------------------------


def test_elements_that_left_the_release_are_reported_and_only_unpublished_with_prune():
    pack = make_pack()
    run([pack], source_for(pack))
    smaller = {k: v for k, v in demo_files().items() if k != "icons/star.svg"}

    report, lines = run([pack], source_for(pack, files=smaller), force=True)
    assert report.results[0].stale == 1 and report.results[0].pruned == 0
    assert Element.objects.get(key="star").is_published and any("--prune" in line for line in lines)

    report, _ = run([pack], source_for(pack, files=smaller), force=True, prune=True)
    assert report.results[0].pruned == 1 and Element.objects.get(key="star").is_published is False
    assert Element.objects.get(key="home").is_published


def test_dry_run_downloads_and_checks_but_writes_nothing():
    pack = make_pack()
    source = source_for(pack)

    report, lines = run([pack], source, dry_run=True)
    assert report.results[0].status == "dry-run" and report.results[0].created == 2
    assert not ElementPack.objects.exists() and not Element.objects.exists()
    assert any("[dry run]" in line for line in lines)

    run([pack], source)
    changed = demo_files(**{"icons/home.svg": icon("M9 9h5v5z"), "icons/new.svg": icon("M4 4h5v5z")})
    report, _ = run([pack], source_for(pack, files=changed), dry_run=True, force=True)
    assert (report.results[0].created, report.results[0].updated, report.results[0].unchanged) == (1, 1, 1)
    assert Element.objects.count() == 2


# ---- building entries --------------------------------------------------------------------------------------------


def test_build_entries_is_deterministic_and_sorted():
    pack = make_pack()
    first = build_entries(pack, demo_files(), [])
    second = build_entries(pack, demo_files(), [])
    assert first == second and [e.key for e in first[0]] == ["home", "star"]
    assert all(e.style == "outline" for e in first[0])


def test_import_pack_requires_artwork_and_reports_counts():
    pack = make_pack()
    result = import_pack(pack, demo_files(), SyncOptions(), lambda _: None)
    assert (result.status, result.created, result.total, result.ok) == ("synced", 2, 2, True)
    with pytest.raises(SourceError):
        import_pack(pack, {"LICENSE": demo_files()["LICENSE"]}, SyncOptions(), lambda _: None)


def test_synced_files_are_stored_where_the_api_serves_them():
    pack = make_pack()
    run([pack], source_for(pack))
    element = Element.objects.get(key="home")
    assert element.svg.url.startswith("/media/elements/demo/") and default_storage.exists(element.svg.name)
