import copy

import pytest

from apps.core.mlmodels.manifest import (
    ALLOWED_LICENSES,
    MANIFEST_PATH,
    ManifestError,
    host_allowed,
    load_manifest,
    parse_manifest,
    parse_model,
)

from .mlhelpers import PAYLOAD, make_manifest, model_entry

# ---- the shipped manifest ---------------------------------------------------------------------------------------


def test_the_shipped_manifest_is_valid_and_has_one_default_model():
    manifest = load_manifest(MANIFEST_PATH)
    assert [m.id for m in manifest.defaults()] == ["u2netp"]
    assert {m.id for m in manifest.models} >= {"u2netp", "u2net"}


def test_every_shipped_model_is_pinned_permissive_and_documented():
    for spec in load_manifest(MANIFEST_PATH).models:
        assert spec.license.spdx in {"MIT", "Apache-2.0"}
        assert len(spec.sha256) == 64 and spec.bytes > 1_000_000
        assert len(spec.urls) >= 2, "every model has a mirror"
        assert all(u.startswith("https://") for u in spec.urls)
        assert "Verified" in spec.license.evidence and spec.license.url.startswith("https://")
        assert spec.input.size == 320 and spec.output == "1959"


def test_the_shipped_manifest_lists_no_model_known_to_be_non_commercial():
    for spec in load_manifest(MANIFEST_PATH).models:
        identity = " ".join([spec.id, spec.name, spec.file, spec.homepage, *spec.urls]).lower()
        for word in ("rmbg", "bria", "openrail"):
            assert word not in identity


# ---- validation -------------------------------------------------------------------------------------------------


def test_a_valid_entry_parses_with_derived_names():
    spec = parse_model(model_entry("demo"))
    assert spec.stored_name == f"demo-{spec.sha256[:12]}.onnx"
    assert spec.relative_path == f"models/demo/{spec.stored_name}"
    assert spec.input.mean == (0.5, 0.5, 0.5) and spec.input.rescale == "255"
    assert "Apache-2.0" in spec.notice and spec.sha256 in spec.notice


@pytest.mark.parametrize(
    "licence", ["GPL-3.0", "CC-BY-NC-4.0", "OpenRAIL-M", "CC0-1.0", "MIT OR GPL-3.0", ""]
)
def test_only_mit_and_apache_models_are_accepted(licence):
    entry = model_entry()
    entry["license"]["spdx"] = licence
    with pytest.raises(ManifestError, match=r"licen[cs]e|spdx"):
        parse_model(entry)


def test_the_allowed_licences_are_exactly_mit_and_apache():
    assert sorted(ALLOWED_LICENSES) == ["Apache-2.0", "MIT"]


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda e: e.update(id="Bad Id"), "id must be"),
        (lambda e: e.update(id="../x"), "id must be"),
        (lambda e: e.update(task="speech"), "unknown task"),
        (lambda e: e.update(file="../model.onnx"), "plain lower-case"),
        (lambda e: e.update(file="model.pt"), "plain lower-case"),
        (lambda e: e.update(sha256="ABC"), "sha256"),
        (lambda e: e.update(bytes=0), "bytes"),
        (lambda e: e.update(bytes=10**10), "bytes"),
        (lambda e: e.update(bytes=True), "bytes"),
        (lambda e: e.update(urls=[]), "non-empty"),
        (lambda e: e.update(urls=["http://github.com/a/b.onnx"]), "not an https URL"),
        (lambda e: e.update(urls=["https://evil.example/m.onnx"]), "not allowed"),
        (lambda e: e.update(urls=["https://user@github.com/a.onnx"]), "not an https URL"),
        (lambda e: e.update(urls=["https://githubusercontent.com.evil.example/a"]), "not allowed"),
        (lambda e: e.update(priority=-1), "priority"),
        (lambda e: e.update(default="yes"), "default"),
        (lambda e: e.update(surprise=1), "unknown key"),
        (lambda e: e.update(output="bad name!"), "output"),
        (lambda e: e["input"].update(size=8), "size"),
        (lambda e: e["input"].update(rescale="none"), "rescale"),
        (lambda e: e["input"].update(mean=[0.5]), "mean"),
        (lambda e: e["input"].update(std=[1, 0, 1]), "std"),
        (lambda e: e["input"].update(name="a b"), "tensor name"),
        (lambda e: e["license"].update(url="http://x.example/l"), "https"),
        (lambda e: e["license"].update(evidence=""), "evidence"),
        (lambda e: e["license"].pop("holder"), "holder"),
    ],
)
def test_invalid_entries_are_rejected(mutate, message):
    entry = copy.deepcopy(model_entry())
    mutate(entry)
    with pytest.raises(ManifestError, match=message):
        parse_model(entry)


def test_manifest_level_rules():
    with pytest.raises(ManifestError, match="schema"):
        parse_manifest({"schema": 2, "models": []})
    with pytest.raises(ManifestError, match="non-empty"):
        parse_manifest({"schema": 1, "models": []})
    with pytest.raises(ManifestError, match="unique"):
        parse_manifest({"schema": 1, "models": [model_entry("a", default=True), model_entry("a")]})
    with pytest.raises(ManifestError, match="exactly one default"):
        parse_manifest({"schema": 1, "models": [model_entry("a"), model_entry("b")]})
    with pytest.raises(ManifestError, match="exactly one default"):
        parse_manifest(
            {"schema": 1, "models": [model_entry("a", default=True), model_entry("b", default=True)]}
        )
    with pytest.raises(ManifestError, match="object"):
        parse_manifest([])


def test_select_returns_defaults_named_models_or_everything():
    manifest = make_manifest(model_entry("a", default=True), model_entry("b"), model_entry("c"))
    assert [m.id for m in manifest.select(None)] == ["a"]
    assert [m.id for m in manifest.select(["c", "b"])] == ["b", "c"]
    assert [m.id for m in manifest.select(None, everything=True)] == ["a", "b", "c"]
    with pytest.raises(ManifestError, match=r"Unknown model id.*zzz.*Known models: a, b, c"):
        manifest.select(["zzz"])


@pytest.mark.parametrize(
    ("host", "expected"),
    [
        ("github.com", True),
        ("huggingface.co", True),
        ("release-assets.githubusercontent.com", True),
        ("us.aws.cdn.hf.co", True),
        ("cas-bridge.xethub.hf.co", True),
        ("evil.example", False),
        ("githubusercontent.com.evil.example", False),
        ("notgithub.com", False),
        ("", False),
        (None, False),
    ],
)
def test_host_allow_list(host, expected):
    assert host_allowed(host) is expected


def test_load_manifest_reports_unreadable_and_invalid_files(tmp_path):
    with pytest.raises(ManifestError, match="Cannot read"):
        load_manifest(tmp_path / "missing.json")
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    with pytest.raises(ManifestError, match="not valid JSON"):
        load_manifest(bad)


def test_payload_fixture_is_self_consistent():
    assert parse_model(model_entry()).bytes == len(PAYLOAD)
