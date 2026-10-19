from django.http import HttpResponse
from django.test import RequestFactory

from apps.assets.middleware import MEDIA_CSP, MediaSecurityHeadersMiddleware


def run(path: str, content_type: str):
    middleware = MediaSecurityHeadersMiddleware(lambda request: HttpResponse(b"x", content_type=content_type))
    return middleware(RequestFactory().get(path))


def test_svg_media_is_sandboxed_and_forced_to_download():
    response = run("/media/assets/u/a.svg", "image/svg+xml")
    assert response["Content-Security-Policy"] == MEDIA_CSP
    assert response["X-Content-Type-Options"] == "nosniff"
    assert response["Content-Disposition"] == "attachment"


def test_raster_media_gets_nosniff_but_stays_inline():
    response = run("/media/assets/u/a.png", "image/png")
    assert response["X-Content-Type-Options"] == "nosniff"
    assert response["Content-Security-Policy"] == MEDIA_CSP
    assert "Content-Disposition" not in response


def test_non_media_paths_are_untouched():
    response = run("/api/v1/health/", "application/json")
    assert "Content-Security-Policy" not in response
    assert "X-Content-Type-Options" not in response
