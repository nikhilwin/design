import pytest

from apps.accounts.models import User
from apps.fonts.usage import (
    MAX_DEPTH,
    MAX_NAMES,
    font_names_in_document,
    primary_family,
    uploaded_fonts_used_by,
)

from .factories import make_family


def text(family, **extra):
    return {"id": "t", "type": "textbox", "fontFamily": family, **extra}


def doc(*objects, pages=1):
    return {"pages": [{"id": f"p{i}", "objects": list(objects)} for i in range(pages)]}


@pytest.mark.parametrize(
    ("stack", "expected"),
    [
        ('"Foo Bar", sans-serif', "Foo Bar"),
        ("'Foo', serif", "Foo"),
        ("Plain", "Plain"),
        ("  Spaced  , cursive", "Spaced"),
        ("", ""),
        (None, ""),
        (12, ""),
    ],
)
def test_primary_family(stack, expected):
    assert primary_family(stack) == expected


def test_names_come_from_text_groups_and_character_styles():
    document = doc(
        text('"Alpha", sans-serif'),
        {"type": "rect", "fill": "#fff"},
        {"type": "group", "objects": [text('"Beta", serif'), {"type": "group", "objects": [text("Gamma")]}]},
        text(
            '"Alpha", sans-serif',
            styles=[{"start": 0, "end": 2, "style": {"fontFamily": '"Delta", cursive'}}],
        ),
    )
    assert sorted(font_names_in_document(document)) == ["Alpha", "Beta", "Delta", "Gamma"]


def test_names_are_deduplicated_ignoring_case():
    assert font_names_in_document(doc(text("Foo"), text('"FOO", serif'), text("foo"))) == ["Foo"]


@pytest.mark.parametrize(
    "document",
    [
        None,
        [],
        "x",
        {},
        {"pages": "x"},
        {"pages": [None, 3, {"objects": "x"}]},
        {"pages": [{"objects": [1, "a", None, []]}]},
    ],
)
def test_malformed_documents_are_ignored(document):
    assert font_names_in_document(document) == []


def test_bad_entries_do_not_hide_good_ones():
    document = doc(
        text(7),
        text(None),
        text(""),
        text("x" * 500),
        text("Good"),
        {"type": "textbox", "styles": "no", "fontFamily": "Fine"},
    )
    assert font_names_in_document(document) == ["Good", "Fine"]


def test_the_number_of_names_is_capped():
    names = font_names_in_document(doc(*[text(f"Font {i}") for i in range(MAX_NAMES + 20)]))
    assert len(names) == MAX_NAMES


def test_nesting_beyond_the_depth_limit_is_not_followed():
    deepest = text("TooDeep")
    for _ in range(MAX_DEPTH + 2):
        deepest = {"type": "group", "objects": [deepest]}
    shallow = {"type": "group", "objects": [text("Shallow")]}
    assert font_names_in_document(doc(deepest, shallow)) == ["Shallow"]


@pytest.fixture
def owner(db):
    return User.objects.create_user("owner@example.com", "owner-pass-123")


def test_only_the_owners_uploaded_families_that_the_document_names_are_returned(owner, db):
    other = User.objects.create_user("other@example.com", "other-pass-123")
    mine = make_family("Brand Sans", owner=owner, variants=[(400, "normal", ""), (700, "normal", "")])
    make_family("Unused", owner=owner, variants=[(400, "normal", "")])
    make_family("Brand Sans Stolen", owner=other, variants=[(400, "normal", "")])
    make_family("Catalog Font", variants=[(400, "normal", "latin")])
    other_same_name = make_family("Brand Serif", owner=other, variants=[(400, "normal", "")])
    found = uploaded_fonts_used_by(
        doc(text('"brand sans", sans-serif'), text('"Catalog Font"'), text("Brand Serif")), owner
    )
    assert [f.id for f in found] == [mine.id]
    assert other_same_name.id not in [f.id for f in found]
    assert len(found[0].variants.all()) == 2


def test_no_query_when_the_document_names_no_font(owner, django_assert_num_queries):
    make_family("Brand Sans", owner=owner, variants=[(400, "normal", "")])
    with django_assert_num_queries(0):
        assert uploaded_fonts_used_by(doc({"type": "rect"}), owner) == []
