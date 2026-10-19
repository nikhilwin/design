"""REST guard: a design with a live room is edited through the room, not by saving whole documents.

`PATCH /designs/{id}/` and `PATCH /shared/{token}/` carrying a `document` answer 409 `use_realtime` while any
process holds a connection to the design. The guard only speaks to callers the
endpoint itself would let through, so it reveals nothing about designs a caller cannot edit.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable

from django.conf import settings
from django.core.exceptions import RequestDataTooBig
from django.http import HttpRequest, HttpResponse, JsonResponse

from apps.designs.models import Design
from apps.sharing.services import PasswordAttempts, PasswordLocked, ShareLinkNotFound, resolve_link
from apps.sharing.throttling import client_ip

from . import store

log = logging.getLogger("doory.collab")

SHARE_SECRET_HEADER = "X-Share-Password"  # noqa: S105  (a header name, not a secret)
MESSAGE = "This design is being edited live. Changes to the document go through the real-time session."


def _carries_document(request: HttpRequest) -> bool:
    if request.content_type != "application/json":
        return False
    try:
        body = request.body
    except RequestDataTooBig:
        return False
    if b'"document"' not in body:
        return False
    try:
        payload = json.loads(body)
    except ValueError:
        return False
    return isinstance(payload, dict) and "document" in payload


def _password_is_right(request: HttpRequest, link) -> bool:
    """Whether the request carries the link's password, without being a way round the guess limits.

    A wrong guess is not counted here: the view that runs next counts it. But while a guess window of the
    REST API is exhausted nothing is checked at all, otherwise "409 use_realtime" (right) against "429"
    (wrong or locked) would tell an attacker which guess was right after the window had locked them out.
    """
    try:
        PasswordAttempts.for_request(link.token, client_ip(request)).ensure_not_locked()
    except PasswordLocked:
        return False
    supplied = request.headers.get(SHARE_SECRET_HEADER, "").strip()
    return bool(supplied) and link.check_password(supplied)


class RealtimeGuardMiddleware:
    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        return self.get_response(request)

    def process_view(self, request: HttpRequest, view_func, view_args, view_kwargs) -> HttpResponse | None:
        if request.method != "PATCH" or not settings.REALTIME_ENABLED:
            return None
        match = request.resolver_match
        if match is None or match.url_name not in ("design-detail", "shared-design"):
            return None
        if not request.user.is_authenticated or not _carries_document(request):
            return None
        design_id = self._design_for(request, match.url_name, view_kwargs)
        if design_id is None or not store.room_is_live(design_id):
            return None
        return JsonResponse({"error": {"code": "use_realtime", "message": MESSAGE}}, status=409)

    @staticmethod
    def _design_for(request: HttpRequest, url_name: str, view_kwargs: dict):
        """The design the request would change, if the caller may change it; None otherwise."""
        if url_name == "design-detail":
            owned = Design.objects.filter(pk=view_kwargs["pk"], owner=request.user, trashed_at__isnull=True)
            return view_kwargs["pk"] if owned.exists() else None
        try:
            link = resolve_link(view_kwargs["token"])
        except ShareLinkNotFound:
            return None
        if link.role != "edit":
            return None
        if link.has_password and not _password_is_right(request, link):
            return None
        return link.design_id
