"""Bearer-token authentication in front of the MCP endpoint (personal access tokens, `apps.apitokens`)."""

from __future__ import annotations

import json
import logging

from asgiref.sync import sync_to_async
from django.conf import settings
from django.db import close_old_connections, connection
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Receive, Scope, Send

from apps.apitokens import services as tokens

from . import context

log = logging.getLogger("doory.mcp")
REALM = 'Bearer realm="Doory"'


def _database_ok() -> bool:
    close_old_connections()
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
        return True
    except Exception:
        log.exception("health check failed")
        return False
    finally:
        close_old_connections()


def _authenticate(value: str):
    close_old_connections()
    try:
        return tokens.authenticate(value)
    finally:
        close_old_connections()


async def _reply(
    send: Send, status: int, body: dict, headers: list[tuple[bytes, bytes]] | None = None
) -> None:
    payload = json.dumps(body).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(payload)).encode()),
                (b"cache-control", b"no-store"),
                *(headers or []),
            ],
        }
    )
    await send({"type": "http.response.body", "body": payload})


class TokenAuthMiddleware:
    """Answers 401 unless the request carries `Authorization: Bearer <personal access token>`."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        if scope["path"] == f"{settings.MCP_PATH}/health":  # the container probe; tells nothing about users
            healthy = await sync_to_async(_database_ok)()
            await _reply(send, 200 if healthy else 503, {"status": "ok" if healthy else "unavailable"})
            return
        if not settings.MCP_ENABLED:
            await _reply(
                send, 404, {"error": "not_found", "error_description": "The MCP server is turned off."}
            )
            return
        scheme, _, value = Headers(scope=scope).get("authorization", "").partition(" ")
        token = await sync_to_async(_authenticate)(value) if scheme.lower() == "bearer" and value else None
        if token is None:
            challenge = f'{REALM}, error="invalid_token"' if value else REALM
            await _reply(
                send,
                401,
                {
                    "error": "invalid_token",
                    "error_description": "Send a Doory personal access token: Authorization: Bearer doory_…",
                },
                [(b"www-authenticate", challenge.encode())],
            )
            return
        bound = context.bind(context.Caller(token.owner, token))
        try:
            await self.app(scope, receive, send)
        finally:
            context.unbind(bound)
