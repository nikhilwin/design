from __future__ import annotations

import inspect
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

import pytest
from asgiref.sync import async_to_sync, sync_to_async
from channels import DEFAULT_CHANNEL_LAYER
from channels.auth import AuthMiddlewareStack
from channels.layers import channel_layers
from channels.routing import URLRouter
from django.test import Client
from django.urls import path

from apps.accounts.models import User
from apps.collab.consumers import CollabConsumer, RealtimeOriginValidator
from apps.collab.room import RoomRegistry
from apps.designs.models import Design
from apps.sharing.models import ShareLink

from .helpers import sample_document
from .peer import Peer


@pytest.hookimpl(tryfirst=True)
def pytest_pyfunc_call(pyfuncitem):
    """Run `async def` tests on an event loop; database calls made through `sync_to_async` stay on the test thread."""
    if inspect.iscoroutinefunction(pyfuncitem.obj):
        arguments = {name: pyfuncitem.funcargs[name] for name in pyfuncitem._fixtureinfo.argnames}

        async def run() -> None:
            try:
                await pyfuncitem.obj(**arguments)
            finally:
                for value in arguments.values():
                    closer = getattr(value, "aclose", None)
                    if closer is not None:
                        await closer()

        async_to_sync(run)()
        return True
    return None


@pytest.fixture(autouse=True)
def keep_the_test_connection() -> Iterator[None]:
    """Channels closes "obsolete" connections around every consumer call. Inside the test's transaction that closes the
    shared PostgreSQL connection for good (SQLite in memory ignores it), so skip it, as Django's test client does.
    A patcher of its own, so a test's `monkeypatch.undo()` keeps it."""
    with pytest.MonkeyPatch.context() as patcher:
        patcher.setattr("channels.db.close_old_connections", lambda: None)
        yield


def build_app(registry: RoomRegistry) -> Any:
    return RealtimeOriginValidator(
        AuthMiddlewareStack(
            URLRouter([path("ws/designs/<uuid:design_id>/", CollabConsumer.as_asgi(registry=registry))])
        )
    )


@dataclass
class Env:
    """Everything a test needs: users, a design, an ASGI app on a private channel layer and helpers."""

    registry: RoomRegistry
    app: Any
    owner: User
    other: User
    design: Design
    peers: list[Peer]
    registries: list[RoomRegistry] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.registries.append(self.registry)

    @staticmethod
    def cookie_for(user: User) -> str:
        client = Client()
        client.force_login(user)
        return f"sessionid={client.cookies['sessionid'].value}"

    async def db(self, function: Any, *args: Any) -> Any:
        """Run ORM code from an async test on the test thread."""
        return await sync_to_async(function, thread_sensitive=True)(*args)

    async def peer(
        self, user: User | None = None, *, design: Design | None = None, origin: Any = ...
    ) -> Peer:
        kwargs: dict[str, Any] = {}
        if origin is not ...:
            kwargs["origin"] = origin
        cookie = await self.db(self.cookie_for, user) if user is not None else None
        built = Peer(self.app, (design or self.design).pk, cookie=cookie, **kwargs)
        self.peers.append(built)
        return built

    async def open(self, user: User | None = None, **kwargs: Any) -> Peer:
        """A connected and synced peer (owner by default)."""
        built = await self.peer(user or self.owner, **kwargs)
        assert await built.connect()
        await built.sync()
        return built

    async def link(self, role: str = "edit", **kwargs: Any) -> ShareLink:
        return await self.db(
            lambda: ShareLink.objects.create(design=self.design, role=role, created_by=self.owner, **kwargs)
        )

    async def aclose(self) -> None:
        """Disconnect every peer and stop the server instances (runs on the test's event loop)."""
        for built in self.peers:
            try:
                await built.ws.send_input({"type": "websocket.disconnect", "code": 1000})
                await built.ws.wait(timeout=2)
            except Exception:  # already closed or never connected
                pass
        for registry in self.registries:
            await registry.shutdown()

    def second_instance(self) -> tuple[RoomRegistry, Any]:
        """Another 'server process' on the same channel layer and database."""
        registry = RoomRegistry(
            instance=f"{self.registry.process_key}:{uuid.uuid4().hex[:8]}", layer=self.registry.layer
        )
        self.registries.append(registry)
        return registry, build_app(registry)


@pytest.fixture
def owner(db) -> User:
    return User.objects.create_user("owner@example.com", "owner-pass-123", display_name="Olive Owner")


@pytest.fixture
def other(db) -> User:
    return User.objects.create_user("other@example.com", "other-pass-123", display_name="Sam Stranger")


@pytest.fixture
def design(owner) -> Design:
    return Design.objects.create(
        owner=owner,
        title="Summer poster",
        width=800,
        height=600,
        document=sample_document(pages=2, objects=3),
    )


@pytest.fixture
def env(owner, other, design, db):
    """The default channel layer is a fresh in-memory one per test, so HTTP-side signals reach the rooms."""
    channel_layers.backends.clear()
    layer = channel_layers.make_backend(DEFAULT_CHANNEL_LAYER)
    channel_layers.backends[DEFAULT_CHANNEL_LAYER] = layer
    registry = RoomRegistry(layer=layer)
    yield Env(registry, build_app(registry), owner, other, design, [])
    channel_layers.backends.clear()
