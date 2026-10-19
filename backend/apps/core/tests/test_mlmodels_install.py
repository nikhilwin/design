import hashlib

import pytest

from apps.core.mlmodels.availability import background_removal_model, best_installed, describe
from apps.core.mlmodels.install import (
    NOTICE_NAME,
    InstallOptions,
    install_models,
    is_installed,
    model_path,
    model_url,
    sha256_of,
    verify_file,
)
from apps.core.mlmodels.sources import IntegrityError, SourceError

from .mlhelpers import PAYLOAD, FakeSource, make_manifest, make_spec, model_entry, unreachable


@pytest.fixture(autouse=True)
def media(settings, tmp_path):
    settings.MEDIA_ROOT = tmp_path / "media"
    settings.MEDIA_URL = "/media/"
    return tmp_path / "media"


def run(specs, source, **options):
    lines: list[str] = []
    report = install_models(specs, source, InstallOptions(**options), log=lines.append)
    return report, lines


def test_a_model_is_installed_under_media_models_with_a_hashed_name_and_a_notice(media):
    spec = make_spec()
    report, lines = run([spec], FakeSource({"demo": PAYLOAD}))
    path = media / "models" / "demo" / spec.stored_name
    assert [r.status for r in report.results] == ["installed"] and report.failed == []
    assert path.read_bytes() == PAYLOAD and oct(path.stat().st_mode & 0o777) == "0o644"
    assert (path.parent / NOTICE_NAME).read_text(encoding="utf-8") == spec.notice
    assert not list(path.parent.glob("*.part")), "no partial file is left behind"
    assert any("50%" in line or "100%" in line for line in lines)
    assert model_url(spec) == f"/media/models/demo/{spec.stored_name}"
    assert is_installed(spec)


def test_installing_again_is_a_no_op_without_touching_the_source(media):
    spec = make_spec()
    run([spec], FakeSource({"demo": PAYLOAD}))
    source = FakeSource({"demo": PAYLOAD})
    report, _ = run([spec], source)
    assert [r.status for r in report.results] == ["up-to-date"] and source.calls == []


def test_force_downloads_again(media):
    spec = make_spec()
    run([spec], FakeSource({"demo": PAYLOAD}))
    source = FakeSource({"demo": PAYLOAD})
    report, _ = run([spec], source, force=True)
    assert [r.status for r in report.results] == ["installed"] and source.calls == ["demo"]


def test_a_corrupt_installed_file_is_replaced(media):
    spec = make_spec()
    run([spec], FakeSource({"demo": PAYLOAD}))
    model_path(spec).write_bytes(b"x" * len(PAYLOAD))  # same size, wrong content
    report, _ = run([spec], FakeSource({"demo": PAYLOAD}))
    assert [r.status for r in report.results] == ["installed"]
    assert sha256_of(model_path(spec)) == spec.sha256


def test_dry_run_reports_and_writes_nothing(media):
    spec = make_spec()
    source = FakeSource({"demo": PAYLOAD})
    report, _ = run([spec], source, dry_run=True)
    assert [r.status for r in report.results] == ["would-install"] and source.calls == []
    assert not media.exists()


def test_wrong_bytes_are_never_put_in_place_and_the_partial_file_is_removed(media):
    spec = make_spec()
    report, _ = run([spec], FakeSource({"demo": b"y" * len(PAYLOAD)}))
    assert [r.status for r in report.results] == ["failed"]
    assert "SHA-256" in report.results[0].detail
    assert not model_path(spec).exists() and not list(model_path(spec).parent.glob("*"))
    assert not is_installed(spec)


def test_a_file_of_the_wrong_size_is_rejected(media):
    spec = make_spec()
    report, _ = run([spec], FakeSource({"demo": PAYLOAD[:-1]}))
    assert "pins" in report.results[0].detail and not model_path(spec).exists()


def test_a_failed_download_keeps_the_partial_file_for_the_next_run(media):
    spec = make_spec()

    class Failing(FakeSource):
        def fetch(self, spec, destination, on_progress=None, verify=None):
            destination.write_bytes(PAYLOAD[:100])
            raise SourceError("HTTP 500 from github.com")

    report, _ = run([spec], Failing({}))
    assert report.results[0].detail == "HTTP 500 from github.com"
    part = model_path(spec).with_name(model_path(spec).name + ".part")
    assert part.read_bytes() == PAYLOAD[:100]
    done, _ = run([spec], FakeSource({"demo": PAYLOAD}))
    assert [r.status for r in done.results] == ["installed"] and not part.exists()


def test_an_unreachable_source_stops_the_run(media):
    specs = [make_spec("a"), make_spec("b")]
    source = FakeSource({}, error=unreachable())
    report, _ = run(specs, source)
    assert source.calls == ["a"], "the second model is not even tried"
    assert report.aborted.startswith("Cannot reach github.com")
    assert [r.status for r in report.results] == ["failed"]


def test_one_failing_model_does_not_stop_the_others(media):
    specs = [make_spec("a"), make_spec("b")]
    report, _ = run(specs, FakeSource({"b": PAYLOAD}))
    assert [r.status for r in report.results] == ["failed", "installed"]
    assert [r.model_id for r in report.failed] == ["a"] and report.aborted == ""


def test_an_unwritable_media_root_is_a_readable_failure(media, tmp_path):
    media.parent.mkdir(parents=True, exist_ok=True)
    media.write_text("a file where the directory should be")
    report, _ = run([make_spec()], FakeSource({"demo": PAYLOAD}))
    assert report.results[0].status == "failed" and "cannot write" in report.results[0].detail


def test_an_earlier_release_of_the_same_model_is_removed(media):
    spec = make_spec()
    folder = model_path(spec).parent
    folder.mkdir(parents=True)
    old = folder / "demo-aaaaaaaaaaaa.onnx"
    old_part = folder / "demo-bbbbbbbbbbbb.onnx.part"
    unrelated = folder / "keep-me.txt"
    for file in (old, old_part, unrelated):
        file.write_bytes(b"x")
    run([spec], FakeSource({"demo": PAYLOAD}))
    assert not old.exists() and not old_part.exists() and unrelated.exists() and model_path(spec).exists()


def test_the_notice_is_refreshed_when_the_manifest_text_changes(media):
    spec = make_spec()
    run([spec], FakeSource({"demo": PAYLOAD}))
    notice = model_path(spec).parent / NOTICE_NAME
    notice.write_text("old text", encoding="utf-8")
    run([spec], FakeSource({}))
    assert notice.read_text(encoding="utf-8") == spec.notice


def test_verify_file_checks_size_then_hash(tmp_path):
    spec = make_spec()
    good = tmp_path / "good"
    good.write_bytes(PAYLOAD)
    verify_file(spec, good)
    bad = tmp_path / "bad"
    bad.write_bytes(b"z" * len(PAYLOAD))
    with pytest.raises(IntegrityError, match="SHA-256"):
        verify_file(spec, bad)
    short = tmp_path / "short"
    short.write_bytes(b"z")
    with pytest.raises(IntegrityError, match="pins"):
        verify_file(spec, short)
    assert sha256_of(good) == hashlib.sha256(PAYLOAD).hexdigest()


def test_is_installed_requires_the_exact_size(media):
    spec = make_spec()
    assert not is_installed(spec)
    folder = model_path(spec).parent
    folder.mkdir(parents=True)
    model_path(spec).write_bytes(b"short")
    assert not is_installed(spec)


# ---- what /config/ advertises ---------------------------------------------------------------------------------


def install(*specs):
    install_models(list(specs), FakeSource({s.id: PAYLOAD for s in specs}))


@pytest.fixture
def manifest(monkeypatch):
    manifest = make_manifest(
        model_entry("small", default=True, priority=10),
        model_entry("large", priority=20),
        model_entry("unused", priority=99),
    )
    monkeypatch.setattr("apps.core.mlmodels.availability.load_manifest", lambda: manifest)
    return manifest


def test_nothing_is_advertised_until_a_model_is_installed(manifest):
    assert background_removal_model() is None and best_installed("background-removal") is None


def test_the_best_installed_model_is_advertised(manifest):
    small, large = manifest.get("small"), manifest.get("large")
    install(small)
    assert best_installed("background-removal").id == "small"
    install(large)
    assert best_installed("background-removal").id == "large"
    body = background_removal_model()
    assert body == describe(large)
    assert body["url"] == f"/media/models/large/{large.stored_name}" and body["bytes"] == len(PAYLOAD)
    assert body["input"] == {
        "name": "input",
        "size": 64,
        "mean": [0.5, 0.5, 0.5],
        "std": [1.0, 1.0, 1.0],
        "rescale": "255",
    }
    assert set(body) == {"id", "name", "url", "bytes", "sha256", "input", "output"}


def test_a_pinned_model_beats_a_higher_priority_one(manifest, settings):
    install(manifest.get("small"), manifest.get("large"))
    settings.BACKGROUND_REMOVAL_MODEL = "small"
    assert background_removal_model()["id"] == "small"
    settings.BACKGROUND_REMOVAL_MODEL = "not-installed"
    assert background_removal_model() is None


def test_the_feature_can_be_switched_off(manifest, settings):
    install(manifest.get("small"))
    settings.BACKGROUND_REMOVAL_ENABLED = False
    assert background_removal_model() is None


def test_a_broken_manifest_means_not_available_rather_than_an_error(monkeypatch):
    from apps.core.mlmodels.manifest import ManifestError

    def broken():
        raise ManifestError("bad")

    monkeypatch.setattr("apps.core.mlmodels.availability.load_manifest", broken)
    assert background_removal_model() is None
