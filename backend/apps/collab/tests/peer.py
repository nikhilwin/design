"""A Yjs-compatible test client speaking the wire protocol through Channels' WebsocketCommunicator."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
from typing import Any

from channels.testing import WebsocketCommunicator
from pycrdt import Doc

from apps.collab import protocol
from apps.collab.schema import new_doc, ydoc_to_document

ORIGIN = b"http://localhost:5173"
HOST = b"localhost:5173"


class Peer:
    def __init__(
        self, app: Any, design_id: object, *, cookie: str | None = None, origin: bytes | None = ORIGIN
    ) -> None:
        headers = [(b"host", HOST)]
        if origin is not None:
            headers.append((b"origin", origin))
        if cookie:
            headers.append((b"cookie", cookie.encode()))
        self.ws = WebsocketCommunicator(app, f"/ws/designs/{design_id}/", headers=headers)
        self.doc: Doc = new_doc()
        self.texts: list[dict] = []
        self.awareness: dict[int, dict | None] = {}
        self.denied: list[str] = []
        self.close_code: int | None = None
        self.close_reason = ""
        self.synced = False
        self.step2s = 0
        self.accepted = False
        self.frames = 0

    # ---------------------------------------------------------------- connection

    async def connect(self) -> bool:
        connected, _ = await self.ws.connect()
        self.accepted = connected
        return connected

    async def send_json(self, payload: dict) -> None:
        await self.ws.send_to(text_data=json.dumps(payload))

    async def send_raw(self, data: bytes) -> None:
        await self.ws.send_to(bytes_data=data)

    async def auth(self, token: str | None = None, password: str | None = None) -> None:
        payload: dict = {"type": "auth"}
        if token is not None:
            payload["token"] = token
        if password is not None:
            payload["password"] = password
        await self.send_json(payload)

    async def disconnect(self) -> None:
        await self.ws.send_input({"type": "websocket.disconnect", "code": 1000})
        await self.ws.wait(timeout=5)

    # ---------------------------------------------------------------- receiving

    async def handle(self, output: dict) -> None:
        kind = output["type"]
        if kind == "websocket.send":
            if output.get("text") is not None:
                self.texts.append(json.loads(output["text"]))
            else:
                await self._bytes(output["bytes"])
        elif kind == "websocket.close":
            self.close_code = output.get("code", 1000)
            self.close_reason = output.get("reason", "")

    async def _bytes(self, data: bytes) -> None:
        self.frames += 1
        reader = protocol.Reader(data)
        message = reader.varuint()
        if message == protocol.MESSAGE_SYNC:
            kind = reader.varuint()
            payload = reader.varbytes()
            if kind == protocol.SYNC_STEP1:
                reply = self.doc.get_update(payload)
                await self.send_raw(protocol.sync_frame(protocol.SYNC_STEP2, reply))
            else:
                self.doc.apply_update(payload)
                if kind == protocol.SYNC_STEP2:
                    self.synced = True
                    self.step2s += 1
        elif message == protocol.MESSAGE_AWARENESS:
            for entry in protocol.decode_awareness(reader.varbytes()):
                self.awareness[entry.client_id] = json.loads(entry.state)
        elif message == protocol.MESSAGE_AUTH:
            reader.varuint()
            self.denied.append(reader.varstring())

    async def pump(self, quiet: float = 0.08, limit: float = 5.0) -> None:
        """Process everything the server sends until it has been quiet for `quiet` seconds."""
        deadline = time.monotonic() + limit
        while time.monotonic() < deadline and not await self.ws.receive_nothing(quiet, 0.004):
            await self.handle(await self.ws.receive_output(timeout=1))

    async def until(self, predicate: Callable[[], bool], timeout: float = 5.0) -> None:
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() > deadline:
                raise AssertionError(f"condition not met: {self.texts[-3:]} closed={self.close_code}")
            await self.pump(quiet=0.02, limit=0.5)
            await asyncio.sleep(0.005)

    # ---------------------------------------------------------------- protocol helpers

    @property
    def ready(self) -> dict | None:
        return next((t for t in self.texts if t.get("type") == "ready"), None)

    def texts_of(self, kind: str) -> list[dict]:
        return [t for t in self.texts if t.get("type") == kind]

    async def sync(self) -> None:
        """Client side of the y-websocket handshake: wait for `ready`, send step 1, wait for step 2."""
        await self.until(lambda: self.ready is not None or self.close_code is not None)
        assert self.ready is not None, f"closed {self.close_code} {self.close_reason}"
        await self.send_raw(protocol.sync_frame(protocol.SYNC_STEP1, self.doc.get_state()))
        await self.until(lambda: self.synced)

    async def barrier(self, timeout: float = 5.0) -> None:
        """Wait until the server has processed everything this peer sent so far (it answers in order)."""
        seen = self.step2s
        await self.send_raw(protocol.sync_frame(protocol.SYNC_STEP1, self.doc.get_state()))
        await self.until(lambda: self.step2s > seen, timeout=timeout)

    async def edit(self, change: Callable[[Doc], None]) -> bytes:
        before = self.doc.get_state()
        with self.doc.transaction():
            change(self.doc)
        update = self.doc.get_update(before)
        await self.send_raw(protocol.sync_frame(protocol.SYNC_UPDATE, update))
        return update

    async def send_awareness(self, client_id: int, clock: int, state: dict | None) -> None:
        entry = protocol.AwarenessEntry(client_id, clock, json.dumps(state))
        await self.send_raw(protocol.awareness_frame(protocol.encode_awareness([entry])))

    @property
    def document(self) -> dict:
        return ydoc_to_document(self.doc)


async def settle(*peers: Peer, rounds: int = 3) -> None:
    """Let the server deliver everything in flight to every peer."""
    for _ in range(rounds):
        for peer in peers:
            await peer.pump(quiet=0.05)
