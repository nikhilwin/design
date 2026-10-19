import pytest

from apps.fonts.models import FontFamily

from .factories import make_family

pytestmark = pytest.mark.django_db

LIST = "/api/v1/fonts/"


def families(response):
    return [row["family"] for row in response.data["results"]]


def test_public_list_shape_and_variant_grouping(client):
    row = make_family(
        "Open Sans",
        slug="open-sans",
        category="sans-serif",
        popularity=2,
        scripts=["latin", "latin-ext", "cyrillic"],
        variants=[
            (700, "normal", "latin"),
            (400, "italic", "latin"),
            (400, "normal", "cyrillic"),
            (400, "normal", "latin-ext"),
            (400, "normal", "latin"),
        ],
    )
    row.variants.filter(subset="cyrillic").update(unicode_range="U+0400-045F")

    response = client.get(LIST)

    assert response.status_code == 200
    assert set(response.data) == {"count", "next", "previous", "results"}
    data = response.data["results"][0]
    assert set(data) == {
        "id",
        "family",
        "category",
        "scripts",
        "is_variable",
        "is_user_font",
        "variants",
        "unicode_ranges",
        "popularity",
    }
    assert data["is_user_font"] is False and data["popularity"] == 2
    assert [(v["weight"], v["style"]) for v in data["variants"]] == [
        (400, "normal"),
        (400, "italic"),
        (700, "normal"),
    ]
    regular = data["variants"][0]
    assert "/fonts/system/open-sans/" in regular["url"]
    assert [s["subset"] for s in regular["subsets"]] == ["latin", "latin-ext", "cyrillic"]
    assert data["unicode_ranges"] == {"cyrillic": "U+0400-045F"}
    latin_url = next(s["url"] for s in regular["subsets"] if s["subset"] == "latin")
    assert regular["url"] == latin_url
    assert data["variants"][1]["subsets"] == [{"subset": "latin", "url": data["variants"][1]["url"]}]


def test_system_fonts_only_published_and_with_files(client, user):
    make_family("Visible")
    make_family("Draft", is_published=False)
    make_family("Mine", owner=user, slug="mine")
    make_family("Empty", variants=[])

    assert families(client.get(LIST)) == ["Visible"]


def test_search_is_case_insensitive_and_needs_every_word(client):
    make_family("Playfair Display")
    make_family("Open Sans")
    make_family("Roboto")

    assert families(client.get(LIST, {"q": "playfair"})) == ["Playfair Display"]
    assert families(client.get(LIST, {"q": "SANS open"})) == ["Open Sans"]
    assert families(client.get(LIST, {"q": "zzz"})) == []
    assert families(client.get(LIST, {"q": "%"})) == []


def test_category_filter_and_validation(client):
    make_family("Serif One", category="serif")
    make_family("Sans One", category="sans-serif")

    assert families(client.get(LIST, {"category": "serif"})) == ["Serif One"]
    response = client.get(LIST, {"category": "comic"})
    assert response.status_code == 400 and "category" in response.json()["error"]["fields"]


def test_script_filter_matches_whole_script_names(client):
    make_family("Latin Only", scripts=["latin"])
    make_family("Latin Extended", scripts=["latin-ext"])
    make_family("Both", scripts=["latin", "cyrillic"])
    make_family("Bangla", scripts=["bengali", "latin"])

    assert sorted(families(client.get(LIST, {"script": "latin"}))) == ["Bangla", "Both", "Latin Only"]
    assert families(client.get(LIST, {"script": "latin-ext"})) == ["Latin Extended"]
    assert families(client.get(LIST, {"script": "bengali"})) == ["Bangla"]
    assert families(client.get(LIST, {"script": "greek"})) == []
    assert client.get(LIST, {"script": 'latin"]'}).status_code == 400


def test_default_order_is_popularity_rank_then_name(client):
    make_family("Zed", popularity=1)
    make_family("Alpha", popularity=5)
    make_family("Beta", popularity=5)

    assert families(client.get(LIST)) == ["Zed", "Alpha", "Beta"]
    assert families(client.get(LIST, {"ordering": "-popularity"})) == ["Alpha", "Beta", "Zed"]
    assert families(client.get(LIST, {"ordering": "-family"})) == ["Zed", "Beta", "Alpha"]
    assert client.get(LIST, {"ordering": "owner"}).status_code == 400


def test_pagination_defaults_to_50_and_caps_at_100(client):
    for index in range(55):
        make_family(f"Font {index:02d}", popularity=index + 1)

    page1 = client.get(LIST).data
    assert page1["count"] == 55 and len(page1["results"]) == 50
    assert len(client.get(page1["next"]).data["results"]) == 5
    assert len(client.get(LIST, {"page_size": 1000}).data["results"]) == 55


def test_public_responses_are_cacheable_and_session_free(client):
    make_family()
    response = client.get(LIST)
    assert response["Cache-Control"] == "public, max-age=300"
    assert "Cookie" not in response.get("Vary", "")
    assert client.get(LIST, {"category": "bogus"})["Cache-Control"] == "no-store"  # an error is never shared


def test_list_query_count_does_not_grow_with_families(client, django_assert_num_queries):
    for index in range(8):
        make_family(f"Font {index}", variants=[(400, "normal", "latin"), (700, "normal", "latin")])
    with django_assert_num_queries(3):  # COUNT, families, variants
        assert len(client.get(LIST).data["results"]) == 8


def test_variant_urls_are_root_relative_media_paths(client):
    make_family("Open Sans", slug="open-sans")
    variant = client.get(LIST).data["results"][0]["variants"][0]
    assert variant["url"].startswith("/media/fonts/system/open-sans/") and variant["url"].endswith(".woff2")


def test_deleting_a_family_removes_its_files(db):
    row = make_family(variants=[(400, "normal", "latin"), (700, "normal", "latin")])
    storage = row.variants.first().file.storage
    names = [v.file.name for v in row.variants.all()]
    assert all(storage.exists(n) for n in names)
    row.delete()
    assert not any(storage.exists(n) for n in names)
    assert FontFamily.objects.count() == 0
