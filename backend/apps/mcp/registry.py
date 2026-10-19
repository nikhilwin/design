"""How tools and resources are declared: `@tool(scope=…)` and `@resource(uri, scope=…)` add scope checks,
rate limits, database hygiene and error translation around a plain synchronous function, and record it for
`server.build_server`.

Tools and resources are synchronous Django code; the SDK runs them on worker threads. They call the same
services the REST API uses and never trust their arguments beyond their declared types.
"""

from __future__ import annotations

import functools
import logging
import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

from django.conf import settings
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, close_old_connections, transaction
from django.db.models import F
from django.http import Http404
from mcp.server.mcpserver.exceptions import ResourceError, ToolError
from mcp_types import ToolAnnotations
from pydantic import ValidationError as PydanticValidationError
from rest_framework.exceptions import APIException
from rest_framework.exceptions import ValidationError as DrfValidationError

from apps.designs.doc.ops import EditError
from apps.designs.exceptions import RevisionConflict

from . import context
from .models import CallWindow

log = logging.getLogger("doory.mcp")


@dataclass(frozen=True)
class ToolSpec:
    fn: Callable[..., Any]
    name: str
    title: str
    scope: str
    annotations: ToolAnnotations


@dataclass(frozen=True)
class ResourceSpec:
    fn: Callable[..., Any]
    uri: str
    name: str
    title: str
    mime_type: str


TOOLS: list[ToolSpec] = []
RESOURCES: list[ResourceSpec] = []


def _flatten(detail: Any, prefix: str = "") -> list[str]:
    if isinstance(detail, dict):
        return [line for key, value in detail.items() for line in _flatten(value, f"{prefix}{key}: ")]
    if isinstance(detail, list):
        return [line for item in detail for line in _flatten(item, prefix)]
    return [f"{prefix}{detail}"]


def explain(exc: Exception) -> str | None:
    """A message an agent can act on, for the errors the services raise; None for anything unexpected."""
    if isinstance(exc, Http404):
        return "Not found (or not yours)."
    if isinstance(exc, RevisionConflict):
        return (
            f"The design changed since the revision you sent; it is now at revision {exc.revision}. "
            "Read it again with get_design and retry."
        )
    if isinstance(exc, EditError):
        return f"{exc} Nothing was changed."
    if isinstance(exc, PydanticValidationError):
        problems = [f"{'.'.join(str(part) for part in e['loc'])}: {e['msg']}" for e in exc.errors()[:10]]
        return "Invalid input. " + "; ".join(problems)
    if isinstance(exc, DrfValidationError):
        return "Invalid input. " + "; ".join(_flatten(exc.detail))
    if isinstance(exc, APIException):
        return str(exc.detail)
    if isinstance(exc, DjangoValidationError):
        return "; ".join(exc.messages)
    return None


UNEXPECTED = (
    "Something went wrong on the server. Try again; if it keeps failing, ask the Doory administrator."
)


def throttle(rate_throttle: Any, user: Any = None) -> None:
    """Apply one of the REST API's per-user throttles (e.g. `StockRateThrottle()`) to the caller (or `user`),
    sharing its budget, so a tool cannot be used to get around the limits of the endpoint it stands in for."""
    if user is None:
        user = context.current().user
    if not rate_throttle.allow_request(SimpleNamespace(user=user), None):
        wait = math.ceil(rate_throttle.wait() or 1)
        raise ToolError(f"Too many requests of this kind. Wait {wait} s and try again.")


RATE_CLAIM_ATTEMPTS = 3


def charge_call() -> None:
    """Count one more call against the caller's per-minute budget (for tools that do many calls' work, e.g.
    one design per row); raises ToolError when the budget is spent."""
    _check_rate(context.current())


def _check_rate(caller: context.Caller) -> None:
    limit = settings.MCP_CALLS_PER_MINUTE
    if not limit:
        return
    window = int(time.time() // 60)
    # Per user, not per token: holding several tokens must not multiply the budget. Each step is one
    # conditional UPDATE (or an INSERT on the primary key), atomic on every database, so parallel calls
    # cannot both take the last slot.
    rows = CallWindow.objects.filter(user_id=caller.user.pk)
    for _ in range(RATE_CLAIM_ATTEMPTS):
        if rows.filter(window=window, calls__lt=limit).update(calls=F("calls") + 1):
            return
        if rows.filter(window=window).exists():
            raise ToolError(f"Too many calls: at most {limit} a minute. Wait {60 - int(time.time() % 60)} s.")
        if rows.exclude(window=window).update(window=window, calls=1):
            return
        try:
            with transaction.atomic():
                CallWindow.objects.create(user_id=caller.user.pk, window=window, calls=1)
            return
        except IntegrityError:  # a parallel first call made the row; count again
            continue
    raise ToolError("Too many calls at once. Try again in a moment.")


def _guarded(fn: Callable[..., Any], scope: str, error: type[Exception]) -> Callable[..., Any]:
    """`fn` behind the scope check, rate limit, database hygiene and error translation; failures raise `error`
    (ToolError for tools, ResourceError for resources)."""

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        caller = context.current()
        if caller is None:
            raise error("Not signed in.")
        if not caller.has(scope):
            raise error(
                f"This token lacks the `{scope}` scope. Create a token with it in Doory: "
                "Account settings > API tokens."
            )
        try:
            _check_rate(caller)
        except ToolError as exc:
            raise error(str(exc)) from exc
        close_old_connections()
        started = time.monotonic()
        outcome = "ok"
        try:
            return fn(*args, **kwargs)
        except error:
            outcome = "refused"
            raise
        except Exception as exc:
            message = explain(exc)
            if message is None:
                outcome = "error"
                log.exception("%s failed", fn.__name__)
                raise error(UNEXPECTED) from exc
            outcome = "refused"
            raise error(message) from exc
        finally:
            close_old_connections()
            log.info(
                "%s=%s user=%s token=%s outcome=%s ms=%d",
                "tool" if error is ToolError else "resource",
                fn.__name__,
                caller.user.pk,
                caller.token.prefix,
                outcome,
                (time.monotonic() - started) * 1000,
            )

    return wrapper


def tool(
    *, scope: str, title: str, read_only: bool = False, destructive: bool = False, idempotent: bool = False
):
    """Register a tool that needs `scope`. The function's docstring is the description agents read."""

    def decorate(fn: Callable[..., Any]) -> Callable[..., Any]:
        wrapper = _guarded(fn, scope, ToolError)
        TOOLS.append(
            ToolSpec(
                wrapper,
                fn.__name__,
                title,
                scope,
                ToolAnnotations(
                    title=title,
                    read_only_hint=read_only,
                    destructive_hint=destructive,
                    idempotent_hint=idempotent or read_only,
                    open_world_hint=False,
                ),
            )
        )
        return wrapper

    return decorate


def resource(uri: str, *, scope: str, title: str, mime_type: str = "application/json"):
    """Register a resource (or, with `{params}` in `uri`, a resource template) that needs `scope`."""

    def decorate(fn: Callable[..., Any]) -> Callable[..., Any]:
        wrapper = _guarded(fn, scope, ResourceError)
        RESOURCES.append(ResourceSpec(wrapper, uri, fn.__name__, title, mime_type))
        return wrapper

    return decorate
