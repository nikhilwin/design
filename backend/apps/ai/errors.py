"""The errors a call to a provider can end in. Codes are part of the API contract; messages are short, safe to
show to the user, and never contain a provider's URL, secret or answer."""

from __future__ import annotations

from rest_framework import status
from rest_framework.exceptions import APIException, Throttled

# code → HTTP status of the API answer
STATUS = {
    "timeout": status.HTTP_504_GATEWAY_TIMEOUT,
    "unreachable": status.HTTP_502_BAD_GATEWAY,
    "bad_response": status.HTTP_502_BAD_GATEWAY,
    "not_image": status.HTTP_502_BAD_GATEWAY,
    "auth_failed": status.HTTP_502_BAD_GATEWAY,
    "busy": status.HTTP_503_SERVICE_UNAVAILABLE,
    "too_large": status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
    "refused_address": status.HTTP_502_BAD_GATEWAY,
    "secret_unreadable": status.HTTP_502_BAD_GATEWAY,
    "not_supported": status.HTTP_400_BAD_REQUEST,
}


class AIProviderError(APIException):
    """A provider call failed or was refused. `code` is one of `STATUS`."""

    default_code = "provider_error"
    default_detail = "The AI provider failed."

    def __init__(self, code: str, message: str):
        super().__init__(detail=message, code=f"ai_{code}")
        self.code = code
        self.message = message
        self.status_code = STATUS.get(code, status.HTTP_502_BAD_GATEWAY)

    def __str__(self) -> str:
        return self.message


class ModelNotAvailable(APIException):
    status_code = status.HTTP_404_NOT_FOUND
    default_code = "ai_model_not_found"
    default_detail = "That option does not exist or is not available to you."


class RunsOnDevice(APIException):
    status_code = status.HTTP_400_BAD_REQUEST
    default_code = "ai_runs_on_device"
    default_detail = "That option runs in the browser, not on the server."


class UnsupportedAsset(APIException):
    status_code = status.HTTP_400_BAD_REQUEST
    default_code = "ai_unsupported_asset"
    default_detail = "Only raster images (PNG, JPEG, WebP, GIF, AVIF) can be processed."


class QuotaReached(Throttled):
    """429 with Retry-After: the user's daily calls of this provider are used up."""

    default_code = "ai_quota"
    default_detail = (
        "You have used all of today's calls of this option. Pick another option or try again tomorrow."
    )
    extra_detail_singular = "It resets in {wait} second."
    extra_detail_plural = "It resets in {wait} seconds."


class UserProvidersDisabled(APIException):
    status_code = status.HTTP_403_FORBIDDEN
    default_code = "ai_user_providers_disabled"
    default_detail = "Adding your own AI servers is not enabled on this installation."
