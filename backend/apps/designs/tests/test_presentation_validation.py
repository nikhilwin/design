"""Speaker notes and auto-advance time of a page."""

import pytest

from apps.designs.exceptions import InvalidDocument
from apps.designs.validators import MAX_NOTES_LENGTH, describe_document, validate_document

from .helpers import make_design, make_doc

URL = "/api/v1/designs/"
LIMIT = 12 * 1024 * 1024


def doc_with(**page_props) -> dict:
    doc = make_doc(pages=2)
    doc["pages"][1].update(page_props)
    return doc


def check(doc: dict) -> None:
    validate_document(doc, max_bytes=LIMIT)


class TestNotes:
    @pytest.mark.parametrize(
        "notes",
        [
            "",
            "Say hello",
            "Line one\nLine two",
            "Grüße 🎨 — notes with emoji and accents",
            "x" * MAX_NOTES_LENGTH,
            "🎨" * MAX_NOTES_LENGTH,
            None,
        ],
    )
    def test_accepted(self, notes):
        check(doc_with(notes=notes))

    def test_absent_is_fine(self):
        check(make_doc())

    @pytest.mark.parametrize("notes", ["x" * (MAX_NOTES_LENGTH + 1), "🎨" * (MAX_NOTES_LENGTH + 1)])
    def test_too_long_is_rejected(self, notes):
        with pytest.raises(InvalidDocument, match="Page 2 `notes`"):
            check(doc_with(notes=notes))

    @pytest.mark.parametrize("notes", [5, 1.5, True, ["a"], {"text": "a"}])
    def test_must_be_text(self, notes):
        with pytest.raises(InvalidDocument, match="`notes`"):
            check(doc_with(notes=notes))

    def test_nul_characters_are_still_refused_by_the_general_text_check(self):
        with pytest.raises(InvalidDocument):
            check(doc_with(notes="a\x00b"))


class TestDuration:
    @pytest.mark.parametrize("duration", [1, 5, 600, 2.5, 1.0, 599.99, None])
    def test_accepted(self, duration):
        check(doc_with(durationSec=duration))

    @pytest.mark.parametrize(
        "duration",
        [
            0,
            0.5,
            0.999,
            -1,
            601,
            600.01,
            10**9,
            10**400,
            float("nan"),
            float("inf"),
            float("-inf"),
            "5",
            True,
            False,
            [5],
            {},
        ],
    )
    def test_rejected(self, duration):
        with pytest.raises(InvalidDocument, match="Page 2 `durationSec`"):
            check(doc_with(durationSec=duration))

    def test_the_first_bad_page_is_named(self):
        doc = make_doc(pages=3)
        doc["pages"][2]["durationSec"] = 0
        with pytest.raises(InvalidDocument, match="Page 3"):
            check(doc)


def test_describe_document_applies_the_same_rules():
    with pytest.raises(InvalidDocument):
        describe_document(doc_with(durationSec=0))
    assert describe_document(doc_with(durationSec=9, notes="ok")).page_count == 2


@pytest.mark.django_db
class TestThroughTheApi:
    def test_notes_and_times_round_trip(self, api):
        doc = doc_with(notes="Welcome\neveryone", durationSec=12)
        doc["pages"][0]["durationSec"] = 3
        created = api.post(URL, {"document": doc}, format="json")
        assert created.status_code == 201
        stored = api.get(f"{URL}{created.json()['id']}/").json()["document"]
        assert [p.get("durationSec") for p in stored["pages"]] == [3, 12]
        assert stored["pages"][1]["notes"] == "Welcome\neveryone"

    @pytest.mark.parametrize(
        "props",
        [
            {"notes": "x" * (MAX_NOTES_LENGTH + 1)},
            {"notes": 7},
            {"durationSec": 0},
            {"durationSec": 601},
            {"durationSec": "9"},
        ],
    )
    def test_create_refuses_bad_values(self, api, props):
        res = api.post(URL, {"document": doc_with(**props)}, format="json")
        assert res.status_code == 400
        assert res.json()["error"]["code"] == "invalid_document"

    def test_save_refuses_bad_values_and_keeps_the_stored_document(self, api, user):
        design = make_design(user, document=doc_with(notes="keep me"))
        res = api.patch(
            f"{URL}{design.id}/",
            {"document": doc_with(notes="x" * (MAX_NOTES_LENGTH + 1)), "base_revision": design.revision},
            format="json",
        )
        assert res.status_code == 400
        assert res.json()["error"]["code"] == "invalid_document"
        design.refresh_from_db()
        assert design.document["pages"][1]["notes"] == "keep me"
