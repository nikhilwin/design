"""Small security middleware.

Content-Security-Policy note: the Django admin (django-unfold) relies on inline scripts and styles, so
Django itself does not send a CSP header. The SPA's CSP is set by the bundled nginx (see
`frontend/nginx/security-headers.conf`); keep `/admin/` and `/api/` out of that policy.
"""

from __future__ import annotations

from django.conf import settings

DEFAULT_PERMISSIONS_POLICY = (
    "accelerometer=(), bluetooth=(), browsing-topics=(), camera=(), geolocation=(), gyroscope=(), "
    "magnetometer=(), microphone=(), payment=(), serial=(), usb=()"
)


class PermissionsPolicyMiddleware:
    """Disable powerful browser features Doory never uses (`settings.PERMISSIONS_POLICY` overrides)."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        response.headers.setdefault(
            "Permissions-Policy", getattr(settings, "PERMISSIONS_POLICY", DEFAULT_PERMISSIONS_POLICY)
        )
        return response


class PrivateApiCacheMiddleware:
    """Answers of the API depend on who asks, so unless a view says otherwise nothing may keep them.

    The responses already `Vary: Cookie`, which a correct shared cache honours; `no-store` also covers a
    careless one and the browser's own cache on a computer the next person uses after a sign-out.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if request.path.startswith("/api/") and "Cache-Control" not in response.headers:
            response.headers["Cache-Control"] = "no-store"
        return response
