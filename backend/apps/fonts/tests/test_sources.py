import json

import pytest
import requests

from apps.fonts.sources import (
    FamilyNotFound,
    FileNotAvailable,
    FontsourceSource,
    SourceError,
    SourceUnavailable,
    is_valid_font_id,
    normalize_category,
)

ROBOTO = {
    "id": "roboto",
    "family": "Roboto",
    "subsets": ["latin", "latin-ext"],
    "weights": [400, 700],
    "styles": ["normal", "italic"],
    "category": "sans-serif",
    "license": "OFL-1.1",
    "type": "google",
    "npmVersion": "5.3.0",
    "unicodeRange": {"latin": "U+0000-00FF", "latin-ext": "U+0100-02BA"},
    "variants": {
        "400": {"normal": {"latin": {}, "latin-ext": {}}, "italic": {"latin": {}}},
        "700": {"normal": {"latin": {}}},
    },
}


class FakeResponse:
    def __init__(self, status=200, body=b"", error_after=None):
        self.status_code = status
        self._body = body
        self._error_after = error_after

    def iter_content(self, size):
        if self._error_after is not None:
            raise requests.ConnectionError("dropped")
        for start in range(0, len(self._body), size):
            yield self._body[start : start + size]

    def close(self):
        pass


class FakeSession:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.urls = []
        self.headers = {}

    def get(self, url, **kwargs):
        self.urls.append(url)
        assert kwargs["timeout"] and kwargs["stream"] is True
        item = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        if isinstance(item, Exception):
            raise item
        return item


def source(*responses, attempts=3):
    sleeps = []
    session = FakeSession(*responses)
    return FontsourceSource(session, sleep=sleeps.append, attempts=attempts), session, sleeps


def json_response(payload, status=200):
    return FakeResponse(status, json.dumps(payload).encode())


def test_metadata_is_parsed_and_the_url_is_fixed_to_the_api_host():
    src, session, _ = source(json_response(ROBOTO))
    meta = src.metadata("roboto")

    assert session.urls == ["https://api.fontsource.org/v1/fonts/roboto"]
    assert (meta.id, meta.family, meta.category, meta.license, meta.version) == (
        "roboto",
        "Roboto",
        "sans-serif",
        "OFL-1.1",
        "5.3.0",
    )
    assert meta.subsets == ("latin", "latin-ext") and meta.weights == (400, 700)
    assert meta.styles == ("italic", "normal")
    assert meta.available == {
        (400, "normal", "latin"),
        (400, "normal", "latin-ext"),
        (400, "italic", "latin"),
        (700, "normal", "latin"),
    }
    assert meta.unicode_ranges["latin"] == "U+0000-00FF"


def test_license_objects_and_unknown_categories_are_normalised():
    src, _, _ = source(
        json_response({**ROBOTO, "license": {"type": "Apache-2.0", "url": "x"}, "category": "weird"})
    )
    meta = src.metadata("roboto")
    assert (meta.license, meta.category) == ("Apache-2.0", "display")
    assert normalize_category("serif") == "serif"


def test_missing_variant_map_means_availability_is_unknown():
    src, _, _ = source(json_response({k: v for k, v in ROBOTO.items() if k != "variants"}))
    assert src.metadata("roboto").available is None


def test_unknown_family_and_invalid_ids_never_reach_the_network():
    src, session, _ = source(FakeResponse(404))
    with pytest.raises(FamilyNotFound):
        src.metadata("no-such-font")
    assert session.urls == ["https://api.fontsource.org/v1/fonts/no-such-font"]
    for bad in ("../etc/passwd", "Roboto", "a b", "", "x" * 100, "-lead", "evil.com/x"):
        assert not is_valid_font_id(bad)
        with pytest.raises(FamilyNotFound):
            src.metadata(bad)
    assert len(session.urls) == 1


def test_fetch_builds_the_pinned_jsdelivr_url():
    src, session, _ = source(json_response(ROBOTO), FakeResponse(200, b"wOF2payload"))
    meta = src.metadata("roboto")
    assert src.fetch(meta, "latin-ext", 700, "italic") == b"wOF2payload"
    assert session.urls[-1] == (
        "https://cdn.jsdelivr.net/npm/@fontsource/roboto@5.3.0/files/roboto-latin-ext-700-italic.woff2"
    )


def test_fetch_defaults_to_the_major_version_without_npm_version():
    src, session, _ = source(json_response({**ROBOTO, "npmVersion": "garbage"}), FakeResponse(200, b"x"))
    src.fetch(src.metadata("roboto"), "latin", 400, "normal")
    assert "/roboto@5/files/" in session.urls[-1]


def test_fetch_404_means_not_offered_and_bad_arguments_are_refused():
    src, session, _ = source(json_response(ROBOTO), FakeResponse(404))
    meta = src.metadata("roboto")
    with pytest.raises(FileNotAvailable):
        src.fetch(meta, "latin", 400, "normal")
    n = len(session.urls)
    for subset, style in (("../x", "normal"), ("latin", "oblique"), ("a b", "normal")):
        with pytest.raises(FileNotAvailable):
            src.fetch(meta, subset, 400, style)
    assert len(session.urls) == n


def test_server_errors_are_retried_with_backoff_then_succeed():
    src, session, sleeps = source(FakeResponse(503), FakeResponse(502), FakeResponse(200, b"ok"))
    assert src._get("https://cdn.jsdelivr.net/x", limit=100) == b"ok"
    assert len(session.urls) == 3 and sleeps == [1, 2]


def test_persistent_server_errors_raise_a_source_error():
    src, _, _ = source(FakeResponse(500))
    with pytest.raises(SourceError, match="500"):
        src._get("https://cdn.jsdelivr.net/x", limit=100)


def test_unexpected_status_is_not_retried():
    src, session, sleeps = source(FakeResponse(403))
    with pytest.raises(SourceError, match="403"):
        src._get("https://cdn.jsdelivr.net/x", limit=100)
    assert len(session.urls) == 1 and sleeps == []


def test_connection_failures_mean_the_source_is_unavailable():
    src, session, _ = source(requests.ConnectionError("proxy refused"))
    with pytest.raises(SourceUnavailable, match=r"api\.fontsource\.org"):
        src.metadata("roboto")
    assert len(session.urls) == 3
    timeout_src, _, _ = source(requests.Timeout("slow"))
    with pytest.raises(SourceUnavailable):
        timeout_src.fetch(src_meta(), "latin", 400, "normal")


def src_meta():
    from apps.fonts.sources import FamilyMeta

    return FamilyMeta("roboto", "Roboto", "sans-serif", ("latin",), (400,), ("normal",), "OFL-1.1")


def test_a_connection_dropped_mid_download_is_retried():
    src, session, _ = source(FakeResponse(200, b"x", error_after=0), FakeResponse(200, b"complete"))
    assert src._get("https://cdn.jsdelivr.net/x", limit=100) == b"complete"
    assert len(session.urls) == 2


def test_oversized_responses_are_cut_off():
    src, _, _ = source(FakeResponse(200, b"x" * 1000))
    with pytest.raises(SourceError, match="larger than"):
        src._get("https://cdn.jsdelivr.net/x", limit=100)


@pytest.mark.parametrize("body", [b"not json", b"[]", b'"string"'])
def test_garbage_metadata_is_a_source_error(body):
    src, _, _ = source(FakeResponse(200, body))
    with pytest.raises(SourceError):
        src.metadata("roboto")


def test_metadata_missing_required_fields_is_a_source_error():
    src, _, _ = source(json_response({"id": "roboto"}))
    with pytest.raises(SourceError, match="Unexpected metadata"):
        src.metadata("roboto")


def test_list_ids_keeps_google_fonts_with_safe_ids():
    rows = [
        {"id": "roboto", "type": "google"},
        {"id": "some-icons", "type": "other"},
        {"id": "../evil", "type": "google"},
        {"id": "open-sans", "type": "google"},
        "junk",
    ]
    src, session, _ = source(json_response(rows))
    assert src.list_ids() == ["roboto", "open-sans"]
    assert session.urls == ["https://api.fontsource.org/v1/fonts"]
