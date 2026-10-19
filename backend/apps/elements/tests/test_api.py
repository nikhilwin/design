import pytest

from apps.elements.models import Element

from .factories import CURRENT_COLOR, make_element, make_pack

pytestmark = pytest.mark.django_db

LIST = "/api/v1/elements/"
PACKS = "/api/v1/elements/packs/"


def names(response):
    return [row["name"] for row in response.data["results"]]


def test_list_is_public_paginated_and_matches_the_contract_shape(client):
    pack = make_pack("basic", name="Basic")
    element = make_element(pack, name="Red Box", tags=["box", "red"], kind="shape")

    response = client.get(LIST)

    assert response.status_code == 200
    assert set(response.data) == {"count", "next", "previous", "results"}
    row = response.data["results"][0]
    assert set(row) == {
        "id",
        "name",
        "kind",
        "style",
        "pack",
        "tags",
        "svg_url",
        "width",
        "height",
        "colors",
        "is_recolorable",
    }
    assert row["id"] == str(element.id)
    assert row["pack"] == {"id": str(pack.id), "slug": "basic", "name": "Basic"}
    assert row["svg_url"].startswith("/media/elements/basic/") and row["svg_url"].endswith(".svg")
    assert (row["width"], row["height"], row["colors"], row["is_recolorable"]) == (40, 20, ["#e11d48"], True)


def test_unpublished_elements_and_packs_are_hidden(client):
    live, hidden_pack = make_pack("live"), make_pack("hidden", is_published=False)
    make_element(live, name="Visible")
    make_element(live, name="Draft", is_published=False)
    make_element(hidden_pack, name="In hidden pack")

    assert names(client.get(LIST)) == ["Visible"]


def test_filter_by_pack_and_kind(client):
    icons = make_pack("icons", kind="icon")
    shapes = make_pack("shapes")
    make_element(icons, name="Home", kind="icon")
    make_element(shapes, name="Box", kind="shape")
    make_element(shapes, name="Line", kind="line")

    assert names(client.get(LIST, {"pack": "icons"})) == ["Home"]
    assert sorted(names(client.get(LIST, {"pack": "shapes"}))) == ["Box", "Line"]
    assert names(client.get(LIST, {"kind": "line"})) == ["Line"]
    assert names(client.get(LIST, {"pack": "nope"})) == []
    assert client.get(LIST, {"kind": "bogus"}).status_code == 400


def test_search_matches_name_and_tags_with_every_word(client):
    pack = make_pack()
    make_element(pack, name="Right Arrow", tags=["arrows", "direction"])
    make_element(pack, name="Heart", tags=["love", "valentine"])
    make_element(pack, name="Star", tags=["favourite"])

    assert names(client.get(LIST, {"q": "arrow"})) == ["Right Arrow"]
    assert names(client.get(LIST, {"q": "VALENTINE"})) == ["Heart"]
    assert names(client.get(LIST, {"q": "right direction"})) == ["Right Arrow"]
    assert names(client.get(LIST, {"q": "right love"})) == []
    assert names(client.get(LIST, {"q": "%"})) == []


def test_default_order_follows_pack_then_sort_order_then_name(client):
    first, second = make_pack("first", sort_order=1), make_pack("second", sort_order=2)
    make_element(second, name="Aardvark")
    make_element(first, name="Zebra", sort_order=2)
    make_element(first, name="Yak", sort_order=1)
    make_element(first, name="Ant", sort_order=1)

    assert names(client.get(LIST)) == ["Ant", "Yak", "Zebra", "Aardvark"]


def test_explicit_ordering(client):
    pack = make_pack()
    make_element(pack, name="B")
    make_element(pack, name="A")
    assert names(client.get(LIST, {"ordering": "-name"})) == ["B", "A"]
    assert names(client.get(LIST, {"ordering": "name"})) == ["A", "B"]
    assert client.get(LIST, {"ordering": "svg"}).status_code == 400


def test_pagination_defaults_to_48_and_covers_everything_once(client):
    pack = make_pack()
    for index in range(50):
        make_element(pack, name=f"E{index:02d}")

    page1 = client.get(LIST).data
    page2 = client.get(page1["next"]).data

    assert page1["count"] == 50 and len(page1["results"]) == 48 and len(page2["results"]) == 2
    assert page2["next"] is None
    seen = {row["id"] for row in page1["results"]} | {row["id"] for row in page2["results"]}
    assert len(seen) == 50
    assert len(client.get(LIST, {"page_size": 500}).data["results"]) == 50


def test_list_sends_public_cache_headers_only_on_success(client):
    make_element()
    ok = client.get(LIST)
    assert ok["Cache-Control"] == "public, max-age=300"
    assert client.get(PACKS)["Cache-Control"] == "public, max-age=300"
    assert client.get(LIST, {"kind": "bogus"})["Cache-Control"] == "no-store"  # an error is never shared


def test_catalog_reads_do_not_vary_on_the_session_cookie(client):
    make_element()
    assert "Cookie" not in client.get(LIST).get("Vary", "")


def test_list_query_count_is_constant(client, django_assert_num_queries):
    pack = make_pack()
    for index in range(10):
        make_element(pack, name=f"E{index}")
    with django_assert_num_queries(2):  # COUNT + page (pack joined)
        assert len(client.get(LIST).data["results"]) == 10


def test_packs_list_counts_only_published_elements_and_hides_empty_packs(client):
    full = make_pack("full", name="Full", sort_order=2, license="MIT", kind="icon")
    make_element(full, name="One")
    make_element(full, name="Two")
    make_element(full, name="Draft", is_published=False)
    make_pack("empty")
    only_drafts = make_pack("drafts")
    make_element(only_drafts, is_published=False)
    make_pack("hidden", is_published=False)

    response = client.get(PACKS)

    assert isinstance(response.data, list)
    assert [(p["slug"], p["element_count"]) for p in response.data] == [("full", 2)]
    assert set(response.data[0]) == {
        "id",
        "slug",
        "name",
        "kind",
        "thumbnail_url",
        "element_count",
        "license",
        "license_url",
        "attribution",
        "source_url",
    }
    assert (response.data[0]["kind"], response.data[0]["license"]) == ("icon", "MIT")


def test_pack_thumbnail_falls_back_to_the_first_published_element(client):
    pack = make_pack("full")
    make_element(pack, name="Hidden first", is_published=False, sort_order=0)
    first = make_element(pack, name="Shown", sort_order=1)
    make_element(pack, name="Later", sort_order=2)

    assert client.get(PACKS).data[0]["thumbnail_url"] == first.svg.url


def test_pack_own_thumbnail_wins(client):
    pack = make_pack("full", thumbnail="elements/packs/full.webp")
    make_element(pack)
    assert client.get(PACKS).data[0]["thumbnail_url"] == "/media/elements/packs/full.webp"


def test_packs_query_count_is_one(client, django_assert_num_queries):
    for slug in ("a", "b", "c"):
        make_element(make_pack(slug))
    with django_assert_num_queries(1):
        assert len(client.get(PACKS).data) == 3


def test_recolourable_flag_reaches_the_api(client):
    make_element(name="Mono", svg=CURRENT_COLOR)
    row = client.get(LIST).data["results"][0]
    assert row["colors"] == [] and row["is_recolorable"] is False
    assert Element.objects.get().is_recolorable is False
