import pytest

from apps.elements.models import Element
from apps.elements.search import clean_tags, fold, search_name, search_tags, split_query

from .factories import make_element, make_pack

pytestmark = pytest.mark.django_db

LIST = "/api/v1/elements/"


def names(response):
    return [row["name"] for row in response.data["results"]]


# ---- text normalisation ---------------------------------------------------------------------------------


def test_fold_lowercases_removes_accents_and_collapses_spaces():
    assert fold("  Piñata   CRÈME  Brûlée ") == "pinata creme brulee"
    assert fold("\uff21\uff22\uff23") == "abc"  # full-width capitals


def test_search_columns_are_padded_so_whole_tags_can_be_matched():
    assert search_name("Right Arrow") == "right arrow"
    assert search_tags(["Arrows", "font size", "arrows", ""]) == " arrows font size "
    assert search_tags([]) == ""


def test_split_query_dedupes_folds_and_caps_the_words():
    assert split_query("  Heart   heart  LOVE ") == ["heart", "love"]
    assert split_query("a b c d e f g h i j") == list("abcdefgh")
    assert split_query("x" * 100) == ["x" * 40]
    assert split_query("   ") == []


def test_clean_tags_drops_markers_long_tags_and_duplicates():
    assert clean_tags(["Heart", " heart ", "*new*", "x" * 41, "Love  Story", 2]) == [
        "heart",
        "love story",
        "2",
    ]
    assert len(clean_tags(str(i) for i in range(100))) == 30


# ---- save() keeps the search columns in step ---------------------------------------------------------------


def test_save_derives_the_search_columns():
    element = make_element(name="Café Menu", tags=["Food", "Drinks"])
    assert (element.search_name, element.search_tags) == ("cafe menu", " food drinks ")


def test_saving_only_name_or_tags_refreshes_the_search_columns():
    element = make_element(name="Old", tags=["a"])
    element.name, element.tags = "New Name", ["b"]
    element.save(update_fields=["name", "tags"])

    element.refresh_from_db()
    assert (element.search_name, element.search_tags) == ("new name", " b ")


# ---- ranking -------------------------------------------------------------------------------------------


def test_exact_name_beats_prefix_beats_word_prefix_beats_substring_beats_tags(client):
    pack = make_pack()
    make_element(pack, name="Cheart", tags=[])  # substring of the name
    make_element(pack, name="Broken Heart", tags=[])  # word prefix
    make_element(pack, name="Heartbeat", tags=[])  # name prefix
    make_element(pack, name="Heart", tags=[])  # exact
    make_element(pack, name="Zzz Tag Exact", tags=["heart"])
    make_element(pack, name="Zzz Tag Prefix", tags=["heartfelt"])
    make_element(pack, name="Zzz Tag Inside", tags=["sweetheart"])
    make_element(pack, name="Unrelated", tags=["star"])

    assert names(client.get(LIST, {"q": "heart"})) == [
        "Heart",
        "Heartbeat",
        "Broken Heart",
        "Cheart",
        "Zzz Tag Exact",
        "Zzz Tag Prefix",
        "Zzz Tag Inside",
    ]


def test_ranking_is_the_default_with_a_query_and_can_be_overridden(client):
    pack = make_pack()
    make_element(pack, name="Alpha Heart")
    make_element(pack, name="Heart")

    assert names(client.get(LIST, {"q": "heart"})) == ["Heart", "Alpha Heart"]
    assert names(client.get(LIST, {"q": "heart", "ordering": "relevance"})) == ["Heart", "Alpha Heart"]
    assert names(client.get(LIST, {"q": "heart", "ordering": "name"})) == ["Alpha Heart", "Heart"]
    assert names(client.get(LIST, {"q": "heart", "ordering": "-name"})) == ["Heart", "Alpha Heart"]


def test_relevance_without_a_query_falls_back_to_the_pack_order(client):
    pack = make_pack()
    make_element(pack, name="B", sort_order=1)
    make_element(pack, name="A", sort_order=2)

    assert names(client.get(LIST, {"ordering": "relevance"})) == ["B", "A"]
    assert names(client.get(LIST, {"ordering": "relevance", "q": "  "})) == ["B", "A"]


def test_descending_relevance_is_not_an_ordering(client):
    assert client.get(LIST, {"ordering": "-relevance"}).status_code == 400


def test_multi_word_queries_need_every_word_in_the_name_or_the_tags(client):
    pack = make_pack()
    make_element(pack, name="Red Heart", tags=["love"])
    make_element(pack, name="Heart", tags=["love", "red"])
    make_element(pack, name="Blue Heart", tags=["love"])
    make_element(pack, name="Red Star", tags=["night"])

    assert sorted(names(client.get(LIST, {"q": "red heart"}))) == ["Heart", "Red Heart"]
    assert sorted(names(client.get(LIST, {"q": "heart love red"}))) == ["Heart", "Red Heart"]
    assert names(client.get(LIST, {"q": "red love blue"})) == []


def test_a_name_phrase_match_ranks_above_the_same_words_in_another_order(client):
    pack = make_pack()
    make_element(pack, name="Heart Big Red", tags=[])
    make_element(pack, name="Big Red Heart", tags=[])
    make_element(pack, name="Red Heart", tags=[])

    assert names(client.get(LIST, {"q": "red heart"})) == ["Red Heart", "Big Red Heart", "Heart Big Red"]


def test_search_ignores_accents_and_case(client):
    pack = make_pack()
    make_element(pack, name="Piñata")
    make_element(pack, name="Cafe", tags=["Crème"])

    assert names(client.get(LIST, {"q": "PINATA"})) == ["Piñata"]
    assert names(client.get(LIST, {"q": "piñata"})) == ["Piñata"]
    assert names(client.get(LIST, {"q": "creme"})) == ["Cafe"]


def test_like_wildcards_in_a_query_are_literal(client):
    pack = make_pack()
    make_element(pack, name="Fifty Percent", tags=["50%"])
    make_element(pack, name="Under_score")
    make_element(pack, name="Underscore")

    assert names(client.get(LIST, {"q": "%"})) == ["Fifty Percent"]
    assert names(client.get(LIST, {"q": "_"})) == ["Under_score"]


def test_shorter_names_win_ties_then_pack_order(client):
    first, second = make_pack("first", sort_order=1), make_pack("second", sort_order=2)
    make_element(second, name="Star Big", tags=[])
    make_element(first, name="Star Bigger", tags=[])
    make_element(first, name="Star Big", tags=[])

    rows = client.get(LIST, {"q": "star"}).data["results"]
    assert [(r["name"], r["pack"]["slug"]) for r in rows] == [
        ("Star Big", "first"),
        ("Star Big", "second"),
        ("Star Bigger", "first"),
    ]


def test_ranked_pagination_is_stable_and_covers_every_match_once(client):
    pack = make_pack()
    for index in range(130):
        make_element(pack, name=f"Heart {index % 7}", tags=["love"])

    seen: list[str] = []
    url = f"{LIST}?q=heart&page_size=40"
    while url:
        page = client.get(url).data
        seen += [row["id"] for row in page["results"]]
        url = page["next"]

    assert len(seen) == len(set(seen)) == 130


def test_search_query_count_is_constant(client, django_assert_num_queries):
    pack = make_pack()
    for index in range(12):
        make_element(pack, name=f"Heart {index}", tags=["love", "red"])
    with django_assert_num_queries(2):  # COUNT + page, however many words
        assert len(client.get(LIST, {"q": "heart love red"}).data["results"]) == 12


# ---- style / kind / pack filters ------------------------------------------------------------------------


def test_style_filter(client):
    pack = make_pack("icons", kind="icon")
    make_element(pack, name="Heart", style="outline")
    make_element(pack, name="Heart Solid", style="filled")
    make_element(pack, name="Plain")

    assert names(client.get(LIST, {"style": "outline"})) == ["Heart"]
    assert names(client.get(LIST, {"style": "filled"})) == ["Heart Solid"]
    assert client.get(LIST, {"style": "neon"}).status_code == 400
    rows = client.get(LIST).data["results"]
    assert {r["name"]: r["style"] for r in rows} == {"Heart": "outline", "Heart Solid": "filled", "Plain": ""}


def test_filters_combine_with_a_query(client):
    icons, shapes = make_pack("icons", kind="icon"), make_pack("shapes")
    make_element(icons, name="Heart", kind="icon", style="outline")
    make_element(icons, name="Heart", kind="icon", style="filled")
    make_element(shapes, name="Heart", kind="shape")

    rows = client.get(LIST, {"q": "heart", "pack": "icons", "style": "filled"}).data["results"]
    assert [(r["pack"]["slug"], r["style"]) for r in rows] == [("icons", "filled")]
    assert len(client.get(LIST, {"q": "heart", "kind": "shape"}).data["results"]) == 1


# ---- scale -------------------------------------------------------------------------------------------


def test_a_large_catalogue_is_searched_and_paged_with_constant_queries(client, django_assert_num_queries):
    from apps.elements.bulk import ImportEntry

    pack = make_pack("big", kind="icon")
    svg = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="#e11d48"/></svg>'
    words = ["arrow", "heart", "star", "home", "mail", "cloud", "tree", "book"]
    entries = [
        ImportEntry(
            key=f"icon-{i}",
            name=f"{words[i % 8]} {words[(i // 8) % 8]} {i}",
            svg=svg.replace(b"M0 0", f"M0 {i % 5}".encode()),
            tags=[words[(i // 3) % 8]],
        )
        for i in range(2400)
    ]
    summary = Element.objects.bulk_import(pack, entries, workers=4)
    assert summary.created == 2400

    with django_assert_num_queries(2):
        response = client.get(LIST, {"q": "heart star", "page": 3, "page_size": 50})
    assert response.status_code == 200 and response.data["count"] > 100
    for row in response.data["results"]:
        haystack = f"{row['name'].lower()} {' '.join(row['tags'])}"
        assert "heart" in haystack and "star" in haystack
    with django_assert_num_queries(2):
        assert client.get(LIST, {"page": 40, "page_size": 60}).data["results"]
