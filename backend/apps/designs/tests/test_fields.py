"""Template field tags: the rules, `list_fields`, document validation and the REST endpoint."""

from __future__ import annotations

import uuid

import pytest

from apps.designs.doc.fields import duplicate_keys, list_fields, read_field
from apps.designs.validators import validate_document

from .helpers import make_design, make_doc, text_object

URL = "/api/v1/designs/"


def tagged(obj: dict, key: str, field_type: str, label: str | None = None) -> dict:
    return {**obj, "field": {"key": key, "type": field_type, **({"label": label} if label else {})}}


def shape(fill: str = "#ff0000") -> dict:
    return {
        "id": str(uuid.uuid4()),
        "type": "rect",
        "fill": fill,
        "left": 0,
        "top": 0,
        "width": 10,
        "height": 10,
    }


def placeholder() -> dict:
    return {**shape("#cccccc"), "isPlaceholder": True}


def picture(asset_id: str = "a1") -> dict:
    return {"id": str(uuid.uuid4()), "type": "image", "src": "/media/x.png", "assetId": asset_id}


def two_pages(first: list, second: list) -> dict:
    doc = make_doc(pages=2)
    doc["pages"][0]["objects"], doc["pages"][1]["objects"] = first, second
    return doc


def test_only_well_formed_tags_count():
    assert read_field({"key": "name", "type": "text", "label": "Name"}) == {
        "key": "name",
        "type": "text",
        "label": "Name",
    }
    for bad in (
        {"key": "Name", "type": "text"},
        {"key": "2x", "type": "text"},
        {"key": "a", "type": "video"},
        "a",
    ):
        assert read_field(bad) is None


def test_a_key_is_used_once_per_page_and_with_one_type():
    title = text_object("Hi")
    ok = two_pages([tagged(title, "title", "text")], [tagged(text_object(), "title", "text")])
    assert duplicate_keys(ok) == []
    same_page = make_doc(
        objects=[tagged(text_object(), "title", "text"), tagged(text_object(), "title", "text")]
    )
    other_type = two_pages([tagged(picture(), "logo", "image")], [tagged(shape(), "logo", "color")])
    assert duplicate_keys(same_page) == ["title"]
    assert duplicate_keys(other_type) == ["logo"]


def test_list_fields_merges_pages_and_suggests_untagged_placeholders():
    group = {"id": "g", "type": "group", "objects": [tagged(picture("a9"), "photo", "image")]}
    title = tagged(text_object("Summer"), "title", "text", "Title")
    doc = two_pages(
        [title, group, placeholder()],
        [tagged(text_object("Summer"), "title", "text"), tagged(shape(), "accent", "color")],
    )
    fields = list_fields(doc)
    assert [(f["key"], f["type"], f["pages"]) for f in fields] == [
        ("title", "text", [1, 2]),
        ("photo", "image", [1]),
        (None, "image", [1]),
        ("accent", "color", [2]),
    ]
    assert (
        fields[0]["label"] == "Title"
        and fields[0]["current"] == "Summer"
        and len(fields[0]["object_ids"]) == 2
    )
    assert fields[1]["current"] == {"asset_id": "a9", "url": "/media/x.png"}
    assert fields[3]["current"] == "#ff0000"
    assert all(f["fit"] is None and f["overflow"] is False for f in fields)


def test_clashing_keys_remain_savable_and_list_fields_drops_later_duplicates():
    first = tagged(text_object("First"), "title", "text")
    second = tagged(text_object("Second"), "title", "text")
    clash = two_pages(
        [first, second, tagged(picture("a1"), "logo", "image")], [tagged(shape(), "logo", "color")]
    )
    validate_document(clash, max_bytes=10**6)
    assert [(f["key"], f["type"], f["pages"], f["object_ids"]) for f in list_fields(clash)] == [
        ("title", "text", [1], [first["id"]]),
        ("logo", "image", [1], [clash["pages"][0]["objects"][2]["id"]]),
    ]


def test_list_fields_reports_fit_and_overflow():
    fits = {
        **tagged(text_object("Short headline"), "headline", "text"),
        "width": 360,
        "height": 67.8,
        "fontSize": 60,
        "fit": {"mode": "shrink", "minFontSize": 24},
        "fitFontSize": 60,
    }
    overflows = {
        **tagged(
            text_object("Registration for the annual neighbourhood summer block party is open all week"),
            "subhead",
            "text",
        ),
        "width": 200,
        "height": 44.07,
        "fontSize": 39,
        "fit": {"mode": "shrink", "minFontSize": 24},
        "fitFontSize": 24,
    }
    fields = list_fields(make_doc(objects=[fits, overflows]))
    assert fields[0]["fit"] == {"mode": "shrink", "minFontSize": 24} and fields[0]["overflow"] is False
    assert fields[1]["fit"] == {"mode": "shrink", "minFontSize": 24} and fields[1]["overflow"] is True


@pytest.mark.django_db
class TestRest:
    def test_lists_the_fields_of_an_own_design(self, api, other_api, user):
        design = make_design(user, document=make_doc(objects=[tagged(text_object("Hi"), "title", "text")]))
        res = api.get(f"{URL}{design.pk}/fields/")
        assert res.status_code == 200
        assert [(f["key"], f["current"]) for f in res.json()] == [("title", "Hi")]
        assert other_api.get(f"{URL}{design.pk}/fields/").status_code == 404

    def test_a_save_with_clashing_keys_is_accepted_and_list_fields_keeps_the_first(self, api, user):
        design = make_design(user)
        first = tagged(text_object("First"), "title", "text")
        doc = make_doc(objects=[first, tagged(text_object("Second"), "title", "text")])
        res = api.patch(f"{URL}{design.pk}/", {"document": doc, "base_revision": 1}, format="json")
        assert res.status_code == 200
        fields = api.get(f"{URL}{design.pk}/fields/").json()
        assert [(f["key"], f["current"], f["object_ids"]) for f in fields] == [
            ("title", "First", [first["id"]])
        ]

    def test_tags_survive_duplicate_and_version_restore(self, api, user):
        doc = make_doc(objects=[tagged(text_object("Hi"), "title", "text", "Title")])
        design = make_design(user, document=doc)
        copy = api.post(f"{URL}{design.pk}/duplicate/").json()
        assert copy["document"]["pages"][0]["objects"][0]["field"] == {
            "key": "title",
            "type": "text",
            "label": "Title",
        }
        version = api.post(f"{URL}{design.pk}/versions/", {"label": "tagged"}, format="json").json()
        api.patch(f"{URL}{design.pk}/", {"document": make_doc(), "base_revision": 1}, format="json")
        restored = api.post(f"{URL}{design.pk}/versions/{version['id']}/restore/").json()
        assert restored["document"]["pages"][0]["objects"][0]["field"]["key"] == "title"
