"""API errors for designs. Codes are part of the contract."""

from rest_framework import status
from rest_framework.exceptions import APIException


class InvalidDocument(APIException):
    status_code = status.HTTP_400_BAD_REQUEST
    default_code = "invalid_document"
    default_detail = "The design document is not valid."


class InlineAssetNotAllowed(APIException):
    status_code = status.HTTP_400_BAD_REQUEST
    default_code = "inline_asset_not_allowed"
    default_detail = (
        "Local (blob:, idb://) and oversized inline (data:) images must be uploaded as assets first."
    )


class DocumentTooLarge(APIException):
    status_code = status.HTTP_413_REQUEST_ENTITY_TOO_LARGE
    default_code = "document_too_large"
    default_detail = "The design document is too large."


class DesignTrashed(APIException):
    status_code = status.HTTP_409_CONFLICT
    default_code = "design_trashed"
    default_detail = "This design is in the trash. Restore it before changing it."


class NotInTrash(APIException):
    status_code = status.HTTP_400_BAD_REQUEST
    default_code = "not_in_trash"
    default_detail = "Only designs in the trash can be deleted permanently."


class RevisionConflict(Exception):
    """The saved revision moved on. The view turns it into a 409 that carries the current revision."""

    def __init__(self, revision: int, updated_at):
        super().__init__("revision_conflict")
        self.revision = revision
        self.updated_at = updated_at
