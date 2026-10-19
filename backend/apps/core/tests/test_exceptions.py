from __future__ import annotations

import pytest
from rest_framework.test import APIClient

pytestmark = [pytest.mark.django_db, pytest.mark.urls("apps.core.tests.urls_for_tests")]


@pytest.fixture
def api() -> APIClient:
    return APIClient(raise_request_exception=False)


def boom(api, kind, **kwargs):
    return api.post(f"/api/v1/boom/{kind}/", kwargs.pop("data", {}), format="json", **kwargs)


def envelope(res) -> dict:
    body = res.json()
    assert list(body) == ["error"]
    assert {"code", "message"} <= set(body["error"])
    return body["error"]


def test_django_404_becomes_not_found_without_leaking_the_message(api):
    res = boom(api, "http404")
    assert res.status_code == 404
    error = envelope(res)
    assert error["code"] == "not_found"
    assert "secret" not in res.content.decode()


def test_django_permission_denied_becomes_403_for_signed_in_users(api, user):
    api.force_login(user)
    res = boom(api, "django-denied")
    assert res.status_code == 403
    assert envelope(res)["code"] == "permission_denied"
    assert "secret" not in res.content.decode()


def test_anonymous_403_is_reported_as_401(api):
    res = boom(api, "denied")
    assert res.status_code == 401
    assert envelope(res)["code"] == "permission_denied"


def test_not_authenticated_is_401(api):
    res = boom(api, "unauthenticated")
    assert res.status_code == 401
    assert envelope(res)["code"] == "not_authenticated"


def test_protected_view_answers_401_to_anonymous(api):
    res = api.get("/api/v1/protected/")
    assert res.status_code == 401
    assert envelope(res)["code"] == "not_authenticated"


def test_throttled_carries_retry_after(api):
    res = boom(api, "throttled")
    assert res.status_code == 429
    error = envelope(res)
    assert error["code"] == "throttled"
    assert error["retry_after"] == 13
    assert res["Retry-After"] == "13"


def test_throttled_without_a_wait_has_no_retry_after(api):
    res = boom(api, "throttled-unknown")
    assert res.status_code == 429
    assert "retry_after" not in envelope(res)


def test_method_not_allowed_is_405(api):
    res = api.get("/api/v1/boom/anything/")
    assert res.status_code == 405
    assert envelope(res)["code"] == "method_not_allowed"
    assert "POST" in res["Allow"]


def test_malformed_json_is_a_parse_error(api):
    res = api.post("/api/v1/boom/ok/", "{broken", content_type="application/json")
    assert res.status_code == 400
    assert envelope(res)["code"] == "parse_error"


def test_unsupported_media_type_is_415(api):
    res = api.post("/api/v1/boom/ok/", "x", content_type="text/plain")
    assert res.status_code == 415
    assert envelope(res)["code"] == "unsupported_media_type"


def test_validation_errors_list_fields_and_codes(api):
    res = boom(api, "ok", data={"email": "nope", "nested": {"name": "toolong", "tags": ["x", 1, 2]}})
    assert res.status_code == 400
    error = envelope(res)
    assert error["code"] == "validation_error"
    assert error["message"] == "Invalid input."
    assert error["fields"]["email"] == ["Enter a valid email address."]
    assert error["field_codes"]["email"] == ["invalid"]
    assert error["fields"]["nested"]["name"] == ["Ensure this field has no more than 3 characters."]
    assert error["field_codes"]["nested"]["name"] == ["max_length"]
    assert error["field_codes"]["nested"]["tags"] == {"0": ["invalid"]}


def test_fields_and_field_codes_have_the_same_shape(api):
    error = envelope(boom(api, "ok", data={}))
    assert error["fields"].keys() == error["field_codes"].keys() == {"email"}
    assert error["fields"]["email"] == ["This field is required."]
    assert error["field_codes"]["email"] == ["required"]


def test_plain_string_validation_errors_use_non_field_errors(api):
    error = envelope(boom(api, "validation-string"))
    assert error["fields"] == {"non_field_errors": ["Just one message."]}
    assert error["field_codes"] == {"non_field_errors": ["invalid"]}


def test_list_validation_errors_use_non_field_errors(api):
    error = envelope(boom(api, "validation-list"))
    assert error["fields"] == {"non_field_errors": ["a", "b"]}


def test_django_validation_errors_are_converted(api):
    res = boom(api, "django-validation")
    assert res.status_code == 400
    error = envelope(res)
    assert error["code"] == "validation_error"
    assert error["fields"] == {"title": ["Too long."]}


def test_api_error_carries_its_code_message_and_status(api):
    res = boom(api, "api-error")
    assert res.status_code == 409
    assert envelope(res) == {"code": "custom_code", "message": "Custom message."}


def test_unknown_api_url_is_a_json_404(api):
    res = api.get("/api/v1/does-not-exist/")
    assert res.status_code == 404
    assert res["Content-Type"] == "application/json"
    assert envelope(res)["code"] == "not_found"


def test_unknown_non_api_url_stays_html(api):
    res = api.get("/nope/")
    assert res.status_code == 404
    assert "json" not in res["Content-Type"]


def test_unhandled_errors_are_a_json_500_without_details(api):
    res = boom(api, "boom")
    assert res.status_code == 500
    error = envelope(res)
    assert error["code"] == "server_error"
    assert "unexpected" not in res.content.decode()


def test_csrf_failure_for_an_anonymous_caller_is_403_not_401():
    client = APIClient(enforce_csrf_checks=True)
    res = client.post("/api/v1/guarded/", {}, format="json")
    assert res.status_code == 403
    assert envelope(res)["code"] == "csrf_failed"


def test_csrf_failure_for_a_signed_in_caller_is_403(user):
    client = APIClient(enforce_csrf_checks=True)
    client.force_login(user)
    res = client.post("/api/v1/protected/", {}, format="json")
    assert res.status_code == 403
    assert envelope(res)["code"] == "csrf_failed"


def test_csrf_mixin_lets_safe_methods_through():
    client = APIClient(enforce_csrf_checks=True)
    assert client.get("/api/v1/guarded/").status_code == 200


def test_csrf_mixin_accepts_a_valid_token():
    client = APIClient(enforce_csrf_checks=True)
    client.get("/api/v1/auth/csrf/")
    token = client.cookies["csrftoken"].value
    assert client.post("/api/v1/guarded/", {}, format="json", HTTP_X_CSRFTOKEN=token).status_code == 200
    assert client.post("/api/v1/guarded/", {}, format="json", HTTP_X_CSRFTOKEN="wrong").status_code == 403
