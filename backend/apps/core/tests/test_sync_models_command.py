from io import StringIO

import pytest
from django.core.management import CommandError, call_command

from apps.core.management.commands.sync_models import Command
from apps.core.mlmodels.install import model_path
from apps.core.mlmodels.manifest import load_manifest

from .mlhelpers import PAYLOAD, FakeSource, make_manifest, model_entry, unreachable


@pytest.fixture(autouse=True)
def media(settings, tmp_path):
    settings.MEDIA_ROOT = tmp_path / "media"
    return tmp_path / "media"


@pytest.fixture
def manifest():
    return make_manifest(model_entry("small", default=True), model_entry("large", priority=20))


def sync(*args, source=None, manifest=None, **kwargs):
    out = StringIO()
    call_command(Command(source=source, manifest=manifest), *args, stdout=out, stderr=StringIO(), **kwargs)
    return out.getvalue()


def test_the_default_model_is_installed_and_summarised(manifest, media):
    out = sync(source=FakeSource({"small": PAYLOAD, "large": PAYLOAD}), manifest=manifest)
    assert "Syncing 1 model(s)." in out and "small: installed" in out
    assert "Done: 1 of 1 model(s) ok; 1 installed, 0 already up to date, 0 failed." in out
    assert model_path(manifest.get("small")).is_file() and not model_path(manifest.get("large")).exists()


def test_model_and_all_select_what_is_installed(manifest):
    source = FakeSource({"small": PAYLOAD, "large": PAYLOAD})
    sync("--model", "large", source=source, manifest=manifest)
    assert source.calls == ["large"]
    sync("--all", source=source, manifest=manifest)
    assert source.calls == ["large", "small"], "large is already installed"


def test_unknown_model_ids_are_a_command_error(manifest):
    with pytest.raises(CommandError, match=r"Unknown model id.*nope.*Known models: small, large"):
        sync("--model", "nope", source=FakeSource({}), manifest=manifest)


def test_a_second_run_reports_up_to_date(manifest):
    source = FakeSource({"small": PAYLOAD})
    sync(source=source, manifest=manifest)
    out = sync(source=source, manifest=manifest)
    assert (
        "small: up-to-date" in out
        and "0 installed, 1 already up to date" in out
        and source.calls == ["small"]
    )


def test_dry_run_writes_nothing(manifest, media):
    source = FakeSource({"small": PAYLOAD})
    out = sync("--dry-run", source=source, manifest=manifest)
    assert "dry run" in out and "would-install" in out and source.calls == [] and not media.exists()


def test_force_downloads_again(manifest):
    source = FakeSource({"small": PAYLOAD})
    sync(source=source, manifest=manifest)
    sync("--force", source=source, manifest=manifest)
    assert source.calls == ["small", "small"]


def test_a_failed_model_gives_a_non_zero_exit_with_advice(manifest):
    with pytest.raises(CommandError, match=r"1 model\(s\) failed: small. Run the command again"):
        sync(source=FakeSource({"small": b"wrong"}), manifest=manifest)


def test_an_unreachable_network_explains_proxy_and_from_dir(manifest):
    with pytest.raises(CommandError) as info:
        sync("--all", source=FakeSource({}, error=unreachable()), manifest=manifest)
    message = str(info.value)
    assert "Cannot reach github.com" in message and "HTTPS_PROXY" in message and "--from-dir" in message


def test_from_dir_installs_without_the_network(manifest, tmp_path):
    folder = tmp_path / "downloads"
    folder.mkdir()
    (folder / "small.onnx").write_bytes(PAYLOAD)
    out = sync("--from-dir", str(folder), manifest=manifest)
    assert "small: installed" in out and model_path(manifest.get("small")).read_bytes() == PAYLOAD


def test_from_dir_rejects_a_file_with_the_wrong_hash(manifest, tmp_path):
    folder = tmp_path / "downloads"
    folder.mkdir()
    (folder / "small.onnx").write_bytes(b"q" * len(PAYLOAD))
    with pytest.raises(CommandError, match="failed"):
        sync("--from-dir", str(folder), manifest=manifest)
    assert not model_path(manifest.get("small")).exists()


def test_from_dir_must_be_a_directory(manifest, tmp_path):
    with pytest.raises(CommandError, match="not a directory"):
        sync("--from-dir", str(tmp_path / "missing"), manifest=manifest)


def test_list_shows_state_and_location(manifest):
    sync(source=FakeSource({"small": PAYLOAD}), manifest=manifest)
    out = sync("--list", manifest=manifest)
    assert "small" in out and "[installed]" in out and "(default, Apache-2.0)" in out
    assert "large" in out and "[not installed]" in out and "models/large/" in out


def test_the_command_works_with_the_shipped_manifest_and_a_fake_source(settings):
    manifest = load_manifest()
    default = manifest.defaults()[0]
    source = FakeSource({})
    with pytest.raises(CommandError, match="failed"):
        sync(source=source, manifest=manifest)
    assert source.calls == [default.id]
