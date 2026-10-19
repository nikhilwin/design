import copy

import pytest

from apps.gallery.validators import TemplateDocumentError, normalize_tags, validate_template_document

from .factories import make_document


def test_valid_document_summary():
    document = make_document(800, 600, pages=3, meta={"presetId": "a4-landscape"})
    summary = validate_template_document(document)
    assert (summary.width, summary.height, summary.page_count, summary.preset) == (
        800,
        600,
        3,
        "a4-landscape",
    )


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: d.pop("schemaVersion"),
        lambda d: d.update(schemaVersion=0),
        lambda d: d.update(schemaVersion=True),
        lambda d: d.update(width=0),
        lambda d: d.update(height=20_001),
        lambda d: d.update(width="1080"),
        lambda d: d.update(pages=[]),
        lambda d: d.update(pages="nope"),
        lambda d: d["pages"][0].pop("id"),
        lambda d: d["pages"][0].update(objects="nope"),
        lambda d: d["pages"][0].update(objects=["not-an-object"]),
        lambda d: d["pages"][0]["objects"][0].update(src="blob:https://x/abc"),
        lambda d: d["pages"][0]["objects"][0].update(src="idb://1234"),
        lambda d: d["pages"][0]["objects"][0].update(src="data:image/png;base64," + "A" * 70_000),
    ],
)
def test_invalid_documents_are_rejected(mutate):
    document = make_document()
    mutate(document)
    with pytest.raises(TemplateDocumentError):
        validate_template_document(document)


@pytest.mark.parametrize("value", [None, [], "text", 42])
def test_document_must_be_an_object(value):
    with pytest.raises(TemplateDocumentError):
        validate_template_document(value)


def test_small_data_uris_and_https_sources_are_allowed():
    document = make_document()
    document["pages"][0]["objects"][0]["src"] = "data:image/png;base64,iVBORw0KGgo="
    document["pages"][0]["objects"].append(
        {"id": "x", "type": "image", "src": "https://cdn.example.com/a.png"}
    )
    assert validate_template_document(document).page_count == 1


def test_too_many_pages_and_too_deep_nesting_are_rejected():
    assert validate_template_document(make_document(pages=100)).page_count == 100
    with pytest.raises(TemplateDocumentError):
        validate_template_document(make_document(pages=101))
    document = make_document()
    deep: dict = {}
    cursor = deep
    for _ in range(200):
        cursor["n"] = {}
        cursor = cursor["n"]
    document["pages"][0]["objects"][0]["deep"] = deep
    with pytest.raises(TemplateDocumentError, match="nested"):
        validate_template_document(document)


def test_oversized_documents_are_rejected(settings):
    settings.MAX_DESIGN_DOCUMENT_BYTES = 200
    with pytest.raises(TemplateDocumentError, match="too large"):
        validate_template_document(copy.deepcopy(make_document()))


def test_normalize_tags():
    assert normalize_tags(["  Party ", "party", "NEW  year", ""]) == ["party", "new year"]
    assert normalize_tags("a, b ,A") == ["a", "b"]
    assert normalize_tags(None) == []
    with pytest.raises(ValueError):
        normalize_tags([1, 2])
    with pytest.raises(ValueError):
        normalize_tags(["x" * 41])
    with pytest.raises(ValueError):
        normalize_tags([str(i) for i in range(21)])
