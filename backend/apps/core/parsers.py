"""Request parsers shared by every API: bounded size, and nesting bombs become 400s instead of 500s."""

from io import BytesIO

from rest_framework import status
from rest_framework.exceptions import APIException, ParseError
from rest_framework.parsers import JSONParser

DEFAULT_MAX_BYTES = 256 * 1024


class PayloadTooLarge(APIException):
    status_code = status.HTTP_413_REQUEST_ENTITY_TOO_LARGE
    default_code = "payload_too_large"
    default_detail = "The request body is too large."


class BoundedJSONParser(JSONParser):
    """Rejects bodies over `limit()` bytes (413) and turns a recursion bomb into a 400 instead of a 500."""

    too_large_error: type[APIException] = PayloadTooLarge

    def limit(self) -> int:
        return DEFAULT_MAX_BYTES

    def parse(self, stream, media_type=None, parser_context=None):
        limit = self.limit()
        raw = stream.read(limit + 1)
        if len(raw) > limit:
            raise self.too_large_error("The request body is too large.")
        try:
            return super().parse(BytesIO(raw), media_type, parser_context)
        except RecursionError as exc:
            raise ParseError("The JSON document is nested too deeply.") from exc
