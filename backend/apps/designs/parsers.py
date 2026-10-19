from django.conf import settings

from apps.assets.parsers import BoundedJSONParser

from .exceptions import DocumentTooLarge


class DesignJSONParser(BoundedJSONParser):
    """JSON bodies for designs: bounded by the document size limit, immune to nesting bombs."""

    too_large_error = DocumentTooLarge

    def limit(self) -> int:
        return settings.MAX_DESIGN_DOCUMENT_BYTES + 256 * 1024
