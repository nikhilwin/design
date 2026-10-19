from rest_framework import status
from rest_framework.exceptions import APIException, NotFound, PermissionDenied


class PayloadTooLarge(APIException):
    status_code = status.HTTP_413_REQUEST_ENTITY_TOO_LARGE
    default_detail = "The request body is too large."
    default_code = "payload_too_large"


class PasswordRequiredError(APIException):
    status_code = status.HTTP_401_UNAUTHORIZED
    default_detail = "A password is required to open this link."
    default_code = "password_required"


class ShareRoleInsufficient(PermissionDenied):
    default_detail = "This link does not allow that action."
    default_code = "share_role_insufficient"


class CommentsDisabled(NotFound):
    """Raised for links whose role does not include comments.

    A 404 on purpose: the API's error handler turns every 403 for an anonymous caller into a 401,
    which would make the SPA ask a link visitor to sign in.
    """

    default_detail = "This link does not allow comments."
    default_code = "comments_disabled"


def bad_request(code: str, message: str) -> APIException:
    """A 400 carrying a machine-readable top-level error code."""
    error = APIException(detail=message, code=code)
    error.status_code = status.HTTP_400_BAD_REQUEST
    return error
