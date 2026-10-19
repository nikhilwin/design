"""`POST /api/v1/designs/{id}/export/image/` (the browser is stubbed out; see test_chromium for the real one)."""

import pytest
from django.utils import timezone

from apps.designs.tests.helpers import make_design, make_doc
from apps.exports import views
from apps.exports.exceptions import ExportBusy, InvalidExport
from apps.exports.services import ImageResult
from apps.exports.throttling import ExportRateThrottle

IMAGE = b"\x89PNG\r\n\x1a\nfake"


def url(design) -> str:
    return f"/api/v1/designs/{design.pk}/export/image/"


@pytest.fixture
def renders(monkeypatch) -> list[dict]:
    calls: list[dict] = []

    def fake_export_image(design, **options):
        calls.append(options)
        index = options["page"] if isinstance(options["page"], int) else 0
        ext = "jpg" if options["format"] == "jpeg" else options["format"]
        return ImageResult(
            data=IMAGE,
            format=ext,
            mime={"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}[ext],
            width=10,
            height=10,
            page_id="p",
            page_index=index,
            placeholders=1,
            page_width=1080,
            page_height=1920,
            page_count=design.page_count,
            preset=design.preset,
        )

    monkeypatch.setattr(views, "export_image", fake_export_image)
    return calls


@pytest.fixture
def design(user):
    return make_design(user, title="Summer sale", document=make_doc())


def test_the_image_is_the_response(client, design, renders):
    response = client.post(url(design), {}, format="json")
    assert response.status_code == 200
    assert response.content == IMAGE
    assert response["Content-Type"] == "image/png"
    assert response["Content-Disposition"] == 'attachment; filename="Summer sale.png"'
    assert response["Cache-Control"] == "no-store" and response["X-Content-Type-Options"] == "nosniff"
    assert response["X-Doory-Placeholders"] == "1"
    assert renders == [{"page": None, "format": "png", "quality": 90, "scale": 1.0, "transparent": False}]


def test_options_are_passed_on_and_pages_count_from_one(client, user, renders):
    design = make_design(user, title="Deck", document=make_doc(pages=3))
    body = {"page": 2, "format": "webp", "quality": 40, "scale": 2, "transparent": True}
    response = client.post(url(design), body, format="json")
    assert response.status_code == 200
    assert response["Content-Disposition"] == 'attachment; filename="Deck - page 2.webp"'
    assert renders[-1] == {"page": 1, "format": "webp", "quality": 40, "scale": 2.0, "transparent": True}
    client.post(url(design), {"page": "some-page-id", "format": "jpeg"}, format="json")
    assert renders[-1]["page"] == "some-page-id"


@pytest.mark.django_db
def test_structured_names_on_request_and_by_default(client, user, renders, settings, monkeypatch):
    design = make_design(user, title="Summer Sale", document=make_doc(pages=3))
    design.preset = "instagram-story"
    design.save()
    body = {"page": 2, "filename_style": "structured"}
    response = client.post(url(design), body, format="json")
    expected = "summer-sale_instagram_instagram-story_1080x1920_p02"
    assert response["Content-Disposition"] == f'attachment; filename="{expected}.png"'
    monkeypatch.setattr(views, "unix_now", lambda: 1792259000)
    settings.EXPORT_FILENAME_STYLE = "structured"
    settings.EXPORT_FILENAME_TIMESTAMP = True
    response = client.post(url(design), {"page": 2}, format="json")
    assert response["Content-Disposition"] == f'attachment; filename="{expected}_1792259000.png"'
    response = client.post(url(design), {"page": 2, "filename_timestamp": False}, format="json")
    assert response["Content-Disposition"] == f'attachment; filename="{expected}.png"'
    response = client.post(url(design), {"page": 2, "filename_style": "simple"}, format="json")
    assert response["Content-Disposition"] == 'attachment; filename="Summer Sale - page 2.png"'


def test_an_image_comes_back_whatever_the_accept_header(client, design, renders):
    response = client.post(url(design), {}, format="json", HTTP_ACCEPT="image/png")
    assert response.status_code == 200


@pytest.mark.parametrize(
    "body",
    [
        {"page": 0},
        {"page": True},
        {"page": ""},
        {"format": "gif"},
        {"filename_style": "fancy"},
        {"quality": 0},
        {"scale": 5},
        {"scale": "NaN"},
    ],
)
def test_bad_options_are_refused(client, design, renders, body):
    response = client.post(url(design), body, format="json")
    assert response.status_code == 400
    assert renders == []


def test_only_the_owner_gets_it_and_not_from_the_trash(client, anon, design, renders, db):
    from apps.accounts.models import User

    stranger = make_design(User.objects.create_user("x@example.com", "pass-pass-123"))
    assert client.post(url(stranger), {}, format="json").status_code == 404
    assert anon.post(url(design), {}, format="json").status_code == 401
    design.trashed_at = timezone.now()
    design.save()
    assert client.post(url(design), {}, format="json").status_code == 404
    assert renders == []


def test_typed_export_errors_keep_their_status_and_code(client, design, monkeypatch):
    def refuse(error):
        def fake(design, **options):
            raise error

        return fake

    monkeypatch.setattr(views, "export_image", refuse(InvalidExport("too_large", "Too big.")))
    response = client.post(url(design), {}, format="json", HTTP_ACCEPT="image/png")
    assert response.status_code == 400 and response["Content-Type"] == "application/json"
    assert "Too big." in response.content.decode()
    monkeypatch.setattr(views, "export_image", refuse(ExportBusy()))
    response = client.post(url(design), {}, format="json")
    assert response.status_code == 503 and response["Retry-After"] == "5"


def test_renders_are_rate_limited(client, design, renders, monkeypatch):
    monkeypatch.setattr(ExportRateThrottle, "THROTTLE_RATES", {"export": "1/min"})
    assert client.post(url(design), {}, format="json").status_code == 200
    assert client.post(url(design), {}, format="json").status_code == 429
