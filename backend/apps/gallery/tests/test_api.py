import pytest
from django.urls import reverse

from apps.gallery.models import Template

from .factories import make_category, make_document, make_template

pytestmark = pytest.mark.django_db

LIST = "/api/v1/templates/"
CATEGORIES = "/api/v1/template-categories/"


def slugs(response):
    return [row["slug"] for row in response.data["results"]]


def test_categories_are_public_unpaginated_and_count_only_published(client):
    social = make_category("Social Media", sort_order=2, icon="share-2")
    cards = make_category("Cards", sort_order=1, icon="credit-card")
    make_category("Empty", sort_order=3)
    make_template("One", category=social)
    make_template("Two", category=social)
    make_template("Hidden", category=social, is_published=False)
    make_template("Card", category=cards)

    response = client.get(CATEGORIES)

    assert response.status_code == 200
    assert isinstance(response.data, list)
    assert [(c["slug"], c["template_count"]) for c in response.data] == [
        ("cards", 1),
        ("social-media", 2),
        ("empty", 0),
    ]
    assert set(response.data[0]) == {"id", "slug", "name", "icon", "template_count", "sort_order"}
    assert response.data[1]["icon"] == "share-2"


def test_list_is_public_paginated_and_matches_the_contract_shape(client):
    category = make_category("Posters")
    make_template("Big Poster", category=category, width=1200, height=1800, tags=["party"], preset="poster")

    response = client.get(LIST)

    assert response.status_code == 200
    assert set(response.data) == {"count", "next", "previous", "results"}
    row = response.data["results"][0]
    assert set(row) == {
        "id",
        "slug",
        "title",
        "category",
        "tags",
        "width",
        "height",
        "orientation",
        "preset",
        "page_count",
        "thumbnail_url",
        "is_featured",
        "use_count",
        "created_at",
    }
    assert row["category"] == {"id": str(category.id), "slug": "posters", "name": "Posters"}
    assert row["orientation"] == "portrait"
    assert row["thumbnail_url"] is None
    assert "document" not in row


def test_unpublished_templates_are_hidden_everywhere(client):
    make_template("Live")
    make_template("Draft", is_published=False)

    assert slugs(client.get(LIST)) == ["live"]
    assert client.get("/api/v1/templates/draft/").status_code == 404
    assert client.get("/api/v1/templates/live/").status_code == 200


def test_detail_returns_document_and_description(client):
    document = make_document(1920, 1080, pages=2)
    make_template("Pitch", document=document, description="A clean deck.")

    data = client.get("/api/v1/templates/pitch/").data

    assert data["description"] == "A clean deck."
    assert data["document"] == document
    assert data["page_count"] == 2
    assert data["orientation"] == "landscape"


def test_detail_unknown_slug_uses_the_error_envelope(client):
    response = client.get("/api/v1/templates/nope/")
    assert response.status_code == 404
    assert set(response.json()) == {"error"}


def test_filter_by_category_slug(client):
    a, b = make_category("A"), make_category("B")
    make_template("In A", category=a)
    make_template("In B", category=b)
    make_template("Nowhere")

    assert slugs(client.get(LIST, {"category": "a"})) == ["in-a"]
    assert slugs(client.get(LIST, {"category": "does-not-exist"})) == []


@pytest.mark.parametrize(
    ("orientation", "expected"),
    [("landscape", ["wide"]), ("portrait", ["tall"]), ("square", ["even"])],
)
def test_filter_by_orientation(client, orientation, expected):
    make_template("Wide", width=1920, height=1080)
    make_template("Tall", width=1080, height=1920)
    make_template("Even", width=1000, height=1000)

    assert slugs(client.get(LIST, {"orientation": orientation})) == expected


def test_invalid_orientation_is_a_validation_error(client):
    response = client.get(LIST, {"orientation": "diagonal"})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "validation_error"
    assert "orientation" in response.json()["error"]["fields"]


def test_filter_by_preset_and_featured(client):
    make_template("Post", preset="instagram-post", is_featured=True)
    make_template("Story", preset="instagram-story")

    assert slugs(client.get(LIST, {"preset": "instagram-story"})) == ["story"]
    assert slugs(client.get(LIST, {"featured": "true"})) == ["post"]
    assert slugs(client.get(LIST, {"featured": "false"})) == ["story"]


def test_search_matches_title_description_and_tags_case_insensitively(client):
    make_template("Birthday Bash", description="Balloons everywhere")
    make_template("Plain", tags=["wedding", "floral"])
    make_template("Other", description="nothing relevant")

    assert slugs(client.get(LIST, {"q": "BIRTHDAY"})) == ["birthday-bash"]
    assert slugs(client.get(LIST, {"q": "balloons"})) == ["birthday-bash"]
    assert slugs(client.get(LIST, {"q": "Floral"})) == ["plain"]


def test_search_requires_every_word_and_escapes_wildcards(client):
    make_template("Summer Sale Flyer")
    make_template("Summer Party")

    assert slugs(client.get(LIST, {"q": "summer flyer"})) == ["summer-sale-flyer"]
    assert slugs(client.get(LIST, {"q": "%"})) == []
    assert slugs(client.get(LIST, {"q": "_"})) == []


def test_default_order_is_featured_then_most_used(client):
    make_template("Quiet", use_count=1)
    make_template("Popular", use_count=50)
    make_template("Featured", use_count=2, is_featured=True)

    assert slugs(client.get(LIST)) == ["featured", "popular", "quiet"]


def test_ordering_by_use_count_and_created_at(client):
    first = make_template("First", use_count=5)
    second = make_template("Second", use_count=9)
    Template.objects.filter(pk=first.pk).update(created_at="2024-01-01T00:00:00Z")
    Template.objects.filter(pk=second.pk).update(created_at="2025-01-01T00:00:00Z")

    assert slugs(client.get(LIST, {"ordering": "-use_count"})) == ["second", "first"]
    assert slugs(client.get(LIST, {"ordering": "use_count"})) == ["first", "second"]
    assert slugs(client.get(LIST, {"ordering": "-created_at"})) == ["second", "first"]
    assert client.get(LIST, {"ordering": "password"}).status_code == 400


def test_pagination_walks_every_template_exactly_once(client):
    for index in range(5):
        make_template(f"T{index}", use_count=0)

    seen = []
    url = f"{LIST}?page_size=2&ordering=-use_count"
    while url:
        data = client.get(url).data
        seen += [row["slug"] for row in data["results"]]
        url = data["next"]

    assert sorted(seen) == [f"t{i}" for i in range(5)]
    assert len(set(seen)) == 5


def test_list_query_count_is_constant_and_skips_the_document(client, django_assert_num_queries):
    category = make_category("Cat")
    for index in range(6):
        make_template(f"T{index}", category=category)

    with django_assert_num_queries(2):  # COUNT + page
        response = client.get(LIST)
    assert len(response.data["results"]) == 6


def test_categories_query_count_is_one(client, django_assert_num_queries):
    for index in range(4):
        make_category(f"Cat {index}")
    with django_assert_num_queries(1):
        client.get(CATEGORIES)


def test_detail_query_count_is_one(client, django_assert_num_queries):
    make_template("Solo", category=make_category("Cat"))
    with django_assert_num_queries(1):
        assert client.get("/api/v1/templates/solo/").status_code == 200


def test_reads_do_not_touch_the_session(client):
    make_template("Solo")
    response = client.get(LIST)
    assert "Vary" not in response or "Cookie" not in response["Vary"]


def test_use_requires_authentication(client):
    make_template("Solo")
    response = client.post("/api/v1/templates/solo/use/")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "not_authenticated"


def test_use_copies_the_document_into_a_new_design_and_counts_it(auth_client, user):
    from apps.designs.models import Design

    document = make_document(1920, 1080, pages=2)
    template = make_template("Pitch Deck", document=document, preset="presentation", use_count=7)

    response = auth_client.post("/api/v1/templates/pitch-deck/use/")

    assert response.status_code == 201
    body = response.json()
    design = Design.objects.get(pk=body["id"])
    assert design.owner == user
    assert (design.title, design.width, design.height, design.preset) == (
        "Pitch Deck",
        1920,
        1080,
        "presentation",
    )
    assert design.page_count == 2
    # The template's preset is stamped into the copy's meta so the design and its document agree.
    expected = {**document, "meta": {"presetId": "presentation"}}
    assert design.document == expected
    assert body["document"] == expected
    assert body["revision"] == 1
    template.refresh_from_db()
    assert template.use_count == 8


def test_use_does_not_share_state_with_the_template(auth_client):
    from apps.designs.models import Design

    template = make_template("Solo")
    body = auth_client.post("/api/v1/templates/solo/use/").json()
    design = Design.objects.get(pk=body["id"])
    design.document["pages"][0]["objects"].clear()
    design.save()

    template.refresh_from_db()
    assert template.document["pages"][0]["objects"]


def test_use_twice_creates_two_designs(auth_client, user):
    from apps.designs.models import Design

    template = make_template("Solo")
    auth_client.post("/api/v1/templates/solo/use/")
    auth_client.post("/api/v1/templates/solo/use/")

    assert Design.objects.filter(owner=user).count() == 2
    template.refresh_from_db()
    assert template.use_count == 2


def test_use_unpublished_or_unknown_template_is_404(auth_client):
    make_template("Draft", is_published=False)
    assert auth_client.post("/api/v1/templates/draft/use/").status_code == 404
    assert auth_client.post("/api/v1/templates/ghost/use/").status_code == 404


def test_use_rejects_get(auth_client):
    make_template("Solo")
    assert auth_client.get(reverse("template-use", args=["solo"])).status_code == 405
