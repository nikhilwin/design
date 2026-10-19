from __future__ import annotations

import pytest
from django.http import HttpResponse
from django.test import RequestFactory
from rest_framework.test import APIClient

from apps.core.middleware import DEFAULT_PERMISSIONS_POLICY, PermissionsPolicyMiddleware

pytestmark = pytest.mark.django_db

DISABLED = ("camera", "microphone", "geolocation", "payment", "usb")


@pytest.mark.parametrize("url", ["/api/v1/health/", "/api/v1/config/", "/admin/login/"])
def test_security_headers_are_present(url):
    res = APIClient().get(url, follow=True)
    assert res["X-Frame-Options"] == "DENY"
    assert res["X-Content-Type-Options"] == "nosniff"
    assert res["Referrer-Policy"] == "strict-origin-when-cross-origin"
    assert res["Cross-Origin-Opener-Policy"] == "same-origin"
    policy = res["Permissions-Policy"]
    for feature in DISABLED:
        assert f"{feature}=()" in policy


def test_permissions_policy_applies_to_error_responses_too():
    res = APIClient().get("/api/v1/definitely-missing/")
    assert res.status_code == 404
    assert res["Permissions-Policy"] == DEFAULT_PERMISSIONS_POLICY


def test_permissions_policy_can_be_overridden_in_settings(settings):
    settings.PERMISSIONS_POLICY = "camera=(self)"
    res = APIClient().get("/api/v1/health/")
    assert res["Permissions-Policy"] == "camera=(self)"


def test_permissions_policy_does_not_clobber_a_header_set_by_the_view():
    def view(request):
        response = HttpResponse("ok")
        response["Permissions-Policy"] = "fullscreen=(self)"
        return response

    response = PermissionsPolicyMiddleware(view)(RequestFactory().get("/"))
    assert response["Permissions-Policy"] == "fullscreen=(self)"


def test_admin_still_works_under_the_headers(user):
    admin = user.__class__.objects.create_superuser("root@example.com", "plum-umbrella-ripple-47")
    client = APIClient()
    client.force_login(admin)
    assert client.get("/admin/").status_code == 200


def test_private_api_answers_are_not_cacheable_unless_the_view_says_so(user):
    signed_in = APIClient()
    signed_in.force_authenticate(user)
    assert signed_in.get("/api/v1/auth/me/")["Cache-Control"] == "no-store"
    assert signed_in.get("/api/v1/designs/")["Cache-Control"] == "no-store"
    assert APIClient().get("/api/v1/definitely-missing/")["Cache-Control"] == "no-store"
    assert APIClient().get("/api/v1/config/")["Cache-Control"] == "public, max-age=60"  # a view's own choice
    assert "no-store" in APIClient().get("/api/v1/shared/" + "x" * 32 + "/")["Cache-Control"]
