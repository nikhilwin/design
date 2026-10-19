from rest_framework.settings import api_settings
from rest_framework.throttling import BaseThrottle, ScopedRateThrottle


def client_ip(request) -> str:
    """Caller address for rate limiting.

    `X-Forwarded-For` is only honoured when `REST_FRAMEWORK["NUM_PROXIES"]` says how many trusted
    proxies sit in front of the app; otherwise the header is attacker-controlled and ignored.
    """
    if api_settings.NUM_PROXIES is None:
        return request.META.get("REMOTE_ADDR", "")
    return BaseThrottle().get_ident(request)


class UploadScopeThrottleMixin:
    """Applies the `upload` rate (on top of the default throttles) to the listed methods only."""

    throttle_scope = "upload"
    scoped_throttle_methods = frozenset({"POST"})

    def get_throttles(self):
        throttles = super().get_throttles()
        if self.request.method in self.scoped_throttle_methods:
            throttles.append(ScopedRateThrottle())
        return throttles
