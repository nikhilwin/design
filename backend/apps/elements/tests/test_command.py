from io import StringIO

import pytest
from django.core.management import CommandError, call_command

from apps.elements.management.commands.sync_element_packs import Command
from apps.elements.models import Element, ElementPack

from .packhelpers import (
    FakeSource,
    demo_files,
    icon,
    integrity_of,
    make_manifest,
    make_pack,
    make_tarball,
    pack_entry,
    unreachable,
)

pytestmark = pytest.mark.django_db


def sync(*args, source=None, manifest=None, **kwargs):
    out, err = StringIO(), StringIO()
    call_command(Command(source=source, manifest=manifest), *args, stdout=out, stderr=err, **kwargs)
    return out.getvalue()


@pytest.fixture
def manifest():
    return make_manifest(
        pack_entry("alpha", sort_order=10),
        pack_entry(
            "beta",
            sort_order=20,
            source={
                "type": "npm",
                "package": "beta-icons",
                "version": "1.0.0",
                "integrity": "sha512-" + "B" * 86 + "==",
            },
        ),
    )


@pytest.fixture
def source(manifest):
    return FakeSource({pack.source.label: demo_files() for pack in manifest.packs})


def test_the_command_syncs_every_pack_and_prints_a_summary(manifest, source):
    out = sync(source=source, manifest=manifest)

    assert "Syncing 2 pack(s)" in out and "alpha: 2 elements" in out and "beta: 2 elements" in out
    assert "Done: 2 of 2 pack(s) ok (0 up to date); 4 elements created" in out
    assert ElementPack.objects.count() == 2 and Element.objects.count() == 4


def test_pack_option_selects_packs_and_unknown_ids_are_an_error(manifest, source):
    sync("--pack", "beta", source=source, manifest=manifest)
    assert list(ElementPack.objects.values_list("slug", flat=True)) == ["beta"]
    with pytest.raises(CommandError, match=r"Unknown pack id.*nope"):
        sync("--pack", "nope", source=source, manifest=manifest)
    sync("--pack", "alpha", "--pack", "beta", source=source, manifest=manifest)
    assert ElementPack.objects.count() == 2


def test_list_shows_state_without_touching_the_network(manifest):
    out = sync("--list", manifest=manifest, source=FakeSource())
    assert "alpha" in out and "not installed" in out and "icon" in out and "MIT" in out

    sync(
        "--pack",
        "alpha",
        source=FakeSource({make_pack("alpha").source.label: demo_files()}),
        manifest=manifest,
    )
    listed = sync("--list", manifest=manifest, source=FakeSource())
    assert "[2 elements]" in listed and "[not installed]" in listed


def test_dry_run_reports_without_writing(manifest, source):
    out = sync("--dry-run", source=source, manifest=manifest)
    assert "dry run" in out and "would be created" in out and not ElementPack.objects.exists()


def test_up_to_date_packs_are_skipped_and_force_fetches_them_again(manifest, source):
    sync(source=source, manifest=manifest)
    source.calls.clear()
    assert "up to date" in sync(source=source, manifest=manifest) and source.calls == []
    sync("--force", source=source, manifest=manifest)
    assert sorted(source.calls) == ["beta-icons@1.0.0", "demo-icons@1.0.0"]


def test_failed_packs_make_the_command_fail_but_keep_the_finished_ones(manifest):
    source = FakeSource({manifest.packs[0].source.label: demo_files()})
    with pytest.raises(CommandError, match=r"1 pack.*failed: beta"):
        sync(source=source, manifest=manifest)
    assert ElementPack.objects.filter(slug="alpha").exists()


def test_an_unreachable_network_fails_with_advice_and_no_traceback(manifest):
    source = FakeSource()
    for pack in manifest.packs:
        source.failures[pack.source.label] = unreachable()
    with pytest.raises(CommandError) as raised:
        sync(source=source, manifest=manifest)
    message = str(raised.value)
    assert (
        "Cannot reach registry.npmjs.org" in message and "HTTPS_PROXY" in message and "--from-dir" in message
    )


def test_concurrency_must_be_positive(manifest, source):
    with pytest.raises(CommandError, match="positive"):
        sync("--concurrency", "0", source=source, manifest=manifest)


def test_from_dir_imports_packs_downloaded_elsewhere(tmp_path):
    tarball = make_tarball(demo_files())
    manifest = make_manifest(
        pack_entry(
            "offline",
            source={
                "type": "npm",
                "package": "demo-icons",
                "version": "1.0.0",
                "integrity": integrity_of(tarball),
            },
        )
    )
    (tmp_path / "demo-icons-1.0.0.tgz").write_bytes(tarball)

    out = sync("--from-dir", str(tmp_path), manifest=manifest)

    assert "offline: 2 elements" in out and Element.objects.filter(pack__slug="offline").count() == 2


def test_from_dir_must_be_a_directory(tmp_path, manifest):
    with pytest.raises(CommandError, match="not a directory"):
        sync("--from-dir", str(tmp_path / "missing"), manifest=manifest)


def test_from_dir_with_a_tampered_tarball_fails_the_pack(tmp_path):
    good = make_tarball(demo_files())
    manifest = make_manifest(
        pack_entry(
            "offline",
            source={
                "type": "npm",
                "package": "demo-icons",
                "version": "1.0.0",
                "integrity": integrity_of(good),
            },
        )
    )
    (tmp_path / "demo-icons-1.0.0.tgz").write_bytes(
        make_tarball(demo_files(**{"icons/x.svg": icon("M1 1h2v2z")}))
    )
    with pytest.raises(CommandError, match="failed: offline"):
        sync("--from-dir", str(tmp_path), manifest=manifest)
    assert not Element.objects.exists()


def test_the_shipped_manifest_loads_and_lists(monkeypatch):
    out = StringIO()
    call_command("sync_element_packs", "--list", stdout=out)
    assert "lucide" in out.getvalue() and "backgrounds-patterns" in out.getvalue()


def test_seed_elements_installs_shapes_and_graphics_offline():
    out = StringIO()
    call_command("seed_elements", stdout=out, stderr=StringIO())
    assert (
        ElementPack.objects.filter(slug="charts").exists()
        and ElementPack.objects.filter(slug="basic-shapes").exists()
    )


def test_brand_logos_follow_the_setting_and_the_option_overrides_it(settings):
    pack = pack_entry("alpha", naming={"brand": "^brand-"})
    manifest = make_manifest(pack)
    files = demo_files(**{"icons/brand-facebook.svg": icon("M4 4h5v5z")})
    source = FakeSource({manifest.packs[0].source.label: files})

    settings.DOORY_ELEMENTS_BRAND_LOGOS = False
    sync(source=source, manifest=manifest)
    assert not Element.objects.filter(key="brand-facebook").exists()
    assert "out of date" in sync("--list", "--brand-logos", source=source, manifest=manifest)

    settings.DOORY_ELEMENTS_BRAND_LOGOS = True
    assert "with brand logos" in sync(source=source, manifest=manifest)
    assert Element.objects.filter(key="brand-facebook").exists()

    sync("--no-brand-logos", source=source, manifest=manifest)
    assert not Element.objects.get(key="brand-facebook").is_published
