"""Who may join which room. Synchronous, run on the database thread."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from fnmatch import fnmatchcase
from urllib.parse import urlparse

from django.conf import settings
from django.http.request import validate_host

from apps.designs.models import Design
from apps.sharing.services import (
    PasswordLocked,
    PasswordRequired,
    ShareLinkNotFound,
    enforce_link_password,
    record_access,
    resolve_link,
)


@dataclass(frozen=True)
class Grant:
    role: str  # owner | edit | comment | view
    link_id: uuid.UUID | None
    title: str
    revision: int


class Forbidden(Exception):
    """Not allowed, for any reason a non-owner must not be able to tell apart."""


class DesignGone(Exception):
    """The caller's own design is trashed or deleted."""


class PasswordNeeded(Exception):
    """The link needs a password and none (or a wrong one) was given."""


class Locked(Exception):
    def __init__(self, retry_after: int) -> None:
        super().__init__(retry_after)
        self.retry_after = retry_after


def owner_grant(user, design_id: uuid.UUID) -> Grant | None:
    """The owner's grant, None when `user` does not own the design (or it does not exist)."""
    design = Design.objects.filter(pk=design_id, owner=user).defer("document").first()
    if design is None:
        return None
    if design.trashed_at is not None:
        raise DesignGone
    return Grant("owner", None, design.title, design.revision)


def link_grant(design_id: uuid.UUID, token: str, password: str | None, client_ip: str) -> Grant:
    """The grant of a share link for this design; raises `Forbidden`, `PasswordNeeded` or `Locked`."""
    try:
        link = resolve_link(token)
    except ShareLinkNotFound:
        raise Forbidden from None
    if link.design_id != design_id:
        raise Forbidden
    try:
        enforce_link_password(link, password, client_ip)
    except PasswordRequired:
        raise PasswordNeeded from None
    except PasswordLocked as exc:
        raise Locked(exc.retry_after) from None
    record_access(link)
    return Grant(link.role, link.pk, link.design.title, link.design.revision)


# ---------------------------------------------------------------------------------------------
# Handshake origin
# ---------------------------------------------------------------------------------------------


def _origin_of(url: str) -> str:
    parsed = urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}".lower()


def origin_allowed(origin: str | None, host: str | None) -> bool:
    """The page that opens the socket must be this site: same host, or a trusted origin (CSRF settings)."""
    if not origin:
        return False
    parsed = urlparse(origin)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return False
    normalised = _origin_of(origin)
    patterns = [*settings.CSRF_TRUSTED_ORIGINS, settings.SITE_URL]
    if any(fnmatchcase(normalised, _origin_of(pattern)) for pattern in patterns):
        return True
    return (
        bool(host)
        and parsed.netloc.lower() == host.lower()
        and validate_host(parsed.hostname, settings.ALLOWED_HOSTS)
    )
