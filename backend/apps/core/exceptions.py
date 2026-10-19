"""Uniform error envelope: {"error": {"code", "message", "fields"?, "field_codes"?, "retry_after"?}}.

* `fields` maps each invalid input field to a list of human-readable messages.
* `field_codes` mirrors `fields` with the machine-readable code of every message
  (e.g. `{"email": ["email_taken"]}`), so clients never have to match on message text.
* `retry_after` (seconds) is present on throttled responses (HTTP 429).
"""

from __future__ import annotations

import math
from typing import Any

from django.core.exceptions import PermissionDenied as DjangoPermissionDenied
from django.core.exceptions import ValidationError as DjangoValidationError
from django.http import Http404
from rest_framework import exceptions, status
from rest_framework.serializers import as_serializer_error
from rest_framework.views import exception_handler

CSRF_FAILURE_PREFIX = "CSRF Failed"


class CsrfFailed(exceptions.PermissionDenied):
    """Raised when an unsafe request is missing or fails its CSRF token."""

    default_detail = "CSRF verification failed. Reload the page and try again."
    default_code = "csrf_failed"


class ApiError(exceptions.APIException):
    """A single coded error: `raise ApiError("invalid_token", "This link is invalid or has expired.")`."""

    status_code = status.HTTP_400_BAD_REQUEST

    def __init__(self, code: str, detail: str, status_code: int | None = None):
        super().__init__(detail=detail, code=code)
        if status_code is not None:
            self.status_code = status_code


def _codes(detail: Any) -> Any:
    """Mirror the structure of a DRF error detail, replacing each message with its code."""
    if isinstance(detail, dict):
        return {key: _codes(value) for key, value in detail.items()}
    if isinstance(detail, list):
        return [_codes(item) for item in detail]
    return getattr(detail, "code", "invalid")


def _plain(detail: Any) -> Any:
    """Convert nested ErrorDetail structures to plain strings/lists/dicts."""
    if isinstance(detail, dict):
        return {key: _plain(value) for key, value in detail.items()}
    if isinstance(detail, list):
        return [_plain(item) for item in detail]
    return str(detail)


def _is_csrf_failure(exc: Exception) -> bool:
    if isinstance(exc, CsrfFailed):
        return True
    return isinstance(exc, exceptions.PermissionDenied) and str(exc.detail).startswith(CSRF_FAILURE_PREFIX)


def _normalise(exc: Exception) -> Exception:
    """Map framework-level exceptions onto their DRF equivalents so one code path renders them."""
    if isinstance(exc, Http404):
        return exceptions.NotFound()
    if isinstance(exc, DjangoPermissionDenied):
        return exceptions.PermissionDenied()
    if isinstance(exc, DjangoValidationError):
        return exceptions.ValidationError(detail=as_serializer_error(exc))
    return exc


def api_exception_handler(exc, context):
    exc = _normalise(exc)
    response = exception_handler(exc, context)
    if response is None:
        return None

    if isinstance(exc, exceptions.ValidationError):
        detail = exc.detail
        if not isinstance(detail, dict):
            detail = {"non_field_errors": detail if isinstance(detail, list) else [detail]}
        error: dict[str, Any] = {
            "code": "validation_error",
            "message": "Invalid input.",
            "fields": _plain(detail),
            "field_codes": _codes(detail),
        }
    else:
        error = {
            "code": str(exc.get_codes()) if isinstance(exc, exceptions.APIException) else "error",
            "message": str(response.data.get("detail", "")) if isinstance(response.data, dict) else "",
        }
        if isinstance(exc, exceptions.Throttled) and exc.wait is not None:
            error["retry_after"] = max(1, math.ceil(exc.wait))
    response.data = {"error": error}

    if (
        response.status_code == status.HTTP_403_FORBIDDEN
        and not _is_csrf_failure(exc)
        and not context["request"].user.is_authenticated
    ):
        response.status_code = status.HTTP_401_UNAUTHORIZED
    if _is_csrf_failure(exc):
        response.data["error"]["code"] = "csrf_failed"
    return response
