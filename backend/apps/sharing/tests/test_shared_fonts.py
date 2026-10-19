import pytest

from apps.accounts.models import User
from apps.fonts.tests.factories import make_family

from .conftest import make_document


@pytest.fixture(autouse=True)
def _isolated_media_root(settings, tmp_path_factory):
    settings.MEDIA_ROOT = tmp_path_factory.mktemp("media")


def text(family):
    return {"id": f"t-{family}", "type": "textbox", "text": "Hello", "fontFamily": family, "fontSize": 40}


def use_fonts(design, *families):
    design.document = make_document()
    design.document["pages"][0]["objects"] = [text(family) for family in families]
    design.save()


def shared_url(link):
    return f"/api/v1/shared/{link.token}/"


def test_a_design_without_uploaded_fonts_has_an_empty_list(anon, view_link):
    assert anon.get(shared_url(view_link)).json()["fonts"] == []


def test_viewers_get_the_owners_uploaded_families_the_document_uses(anon, view_link, design, owner):
    make_family(
        "Brand Sans", owner=owner, category="serif", variants=[(400, "normal", ""), (700, "italic", "")]
    )
    make_family("Never Used", owner=owner, variants=[(400, "normal", "")])
    use_fonts(design, '"Brand Sans", serif', '"Catalog Font", sans-serif')
    fonts = anon.get(shared_url(view_link)).json()["fonts"]
    assert [f["family"] for f in fonts] == ["Brand Sans"]
    font = fonts[0]
    assert font["is_user_font"] is True
    assert font["category"] == "serif"
    assert [(v["weight"], v["style"]) for v in font["variants"]] == [(400, "normal"), (700, "italic")]
    assert all(v["url"].startswith("/media/fonts/user/") for v in font["variants"])


@pytest.mark.parametrize("role", ["view", "comment", "edit"])
def test_every_role_receives_the_fonts(anon, make_link, design, owner, role):
    make_family("Brand Sans", owner=owner, variants=[(400, "normal", "")])
    use_fonts(design, "Brand Sans")
    assert [f["family"] for f in anon.get(shared_url(make_link(role))).json()["fonts"]] == ["Brand Sans"]


def test_fonts_of_other_users_with_the_same_name_are_not_exposed(anon, view_link, design):
    stranger = User.objects.create_user("stranger@example.com", "stranger-pass-123")
    make_family("Brand Sans", owner=stranger, variants=[(400, "normal", "")])
    use_fonts(design, "Brand Sans")
    assert anon.get(shared_url(view_link)).json()["fonts"] == []


def test_the_owners_other_families_are_not_listed(anon, view_link, design, owner):
    make_family("Private Draft", owner=owner, variants=[(400, "normal", "")])
    use_fonts(design, "Brand Sans")
    body = anon.get(shared_url(view_link)).content.decode()
    assert "Private Draft" not in body


def test_the_number_of_queries_does_not_grow_with_the_number_of_fonts(
    anon, view_link, design, owner, django_assert_max_num_queries
):
    for index in range(8):
        make_family(f"Family {index}", owner=owner, variants=[(400, "normal", ""), (700, "normal", "")])
    use_fonts(design, *[f"Family {index}" for index in range(8)])
    with django_assert_max_num_queries(12):
        response = anon.get(shared_url(view_link))
    assert len(response.json()["fonts"]) == 8
