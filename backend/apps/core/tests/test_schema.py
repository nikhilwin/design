import pytest
from rest_framework.test import APIClient

from apps.accounts.models import User

pytestmark = pytest.mark.django_db


def test_openapi_schema_documents_the_auth_and_config_endpoints():
    res = APIClient().get("/api/v1/schema/", {"format": "json"})
    assert res.status_code == 200
    paths = res.json()["paths"]
    for path in (
        "/api/v1/config/",
        "/api/v1/health/",
        "/api/v1/auth/csrf/",
        "/api/v1/auth/register/",
        "/api/v1/auth/login/",
        "/api/v1/auth/logout/",
        "/api/v1/auth/me/",
        "/api/v1/auth/password/change/",
        "/api/v1/auth/password/reset/",
        "/api/v1/auth/password/reset/confirm/",
        "/api/v1/auth/email/verify/",
        "/api/v1/auth/email/resend/",
        "/api/v1/auth/google/",
    ):
        assert path in paths, path
    assert set(paths["/api/v1/auth/me/"]) >= {"get", "patch", "delete"}


def test_swagger_ui_is_for_staff_and_pins_its_script(db, settings):
    settings.DEBUG = False
    anonymous = APIClient().get("/api/v1/docs/")
    assert anonymous.status_code == 401
    ordinary = APIClient()
    ordinary.force_authenticate(User.objects.create_user("plain@example.com", "plum-umbrella-ripple-47"))
    assert ordinary.get("/api/v1/docs/").status_code == 403
    staff = APIClient()
    staff.force_authenticate(
        User.objects.create_user("staff@example.com", "plum-umbrella-ripple-47", is_staff=True)
    )
    page = staff.get("/api/v1/docs/")
    assert page.status_code == 200
    assert b"swagger-ui-dist@5.17.14" in page.content and b"@latest" not in page.content


def test_swagger_ui_is_open_on_a_development_server(settings):
    settings.DEBUG = True
    assert APIClient().get("/api/v1/docs/").status_code == 200
