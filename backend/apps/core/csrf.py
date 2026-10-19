"""CSRF enforcement for DRF views.

DRF's `SessionAuthentication` only checks the CSRF token for requests that are already authenticated,
and DRF views are `csrf_exempt` at the Django middleware level. Endpoints that accept unsafe methods
from *anonymous* callers (login, register, password reset…) are therefore open to login-CSRF unless
they enforce the token themselves. Add `CsrfProtectedMixin` to such views.
"""

from __future__ import annotations

from rest_framework.authentication import SessionAuthentication
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import SAFE_METHODS

from .exceptions import CsrfFailed


def enforce_csrf(request) -> None:
    """Raise `CsrfFailed` unless `request` carries a valid CSRF token (cookie + `X-CSRFToken` header)."""
    try:
        SessionAuthentication().enforce_csrf(request)
    except PermissionDenied as exc:
        raise CsrfFailed(detail=str(exc.detail)) from exc


class CsrfProtectedMixin:
    """Enforce CSRF on every unsafe method, whether or not the caller is logged in."""

    def initial(self, request, *args, **kwargs):
        if request.method not in SAFE_METHODS:
            enforce_csrf(request)
        super().initial(request, *args, **kwargs)
