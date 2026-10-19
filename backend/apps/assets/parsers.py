"""Asset-flavoured bounded JSON parser: oversize bodies report `file_too_large`."""

from apps.core.parsers import DEFAULT_MAX_BYTES
from apps.core.parsers import BoundedJSONParser as CoreBoundedJSONParser

from .exceptions import FileTooLarge

__all__ = ["DEFAULT_MAX_BYTES", "BoundedJSONParser"]


class BoundedJSONParser(CoreBoundedJSONParser):
    too_large_error = FileTooLarge
