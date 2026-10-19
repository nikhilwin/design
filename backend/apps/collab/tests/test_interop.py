"""The real `yjs` implementation as a client (apps/collab/tests/interop/yjs_client.mjs).

Needs Node and `npm ci` in apps/collab/tests/interop; skipped otherwise. The Node process and the server are
bridged in memory, no sockets.
"""

from __future__ import annotations

import asyncio
import base64
import json
import shutil
from pathlib import Path

import pytest

from apps.collab.schema import KEY_OBJECT_ORDER
from apps.designs.models import Design

from .helpers import canon
from .peer import Peer, settle
from .test_sync import add_object, first_object, page_map

INTEROP = Path(__file__).parent / "interop"
pytestmark = [
    pytest.mark.django_db,
    pytest.mark.skipif(
        shutil.which("node") is None or not (INTEROP / "node_modules" / "yjs").exists(),
        reason="run `npm ci` in apps/collab/tests/interop to enable the reference Yjs client tests",
    ),
]


class NodeYjs:
    """A Yjs client in a Node process, connected to a Channels communicator."""

    def __init__(self, peer: Peer) -> None:
        self.peer = peer
        self.process: asyncio.subprocess.Process | None = None
        self.denied: list[str] = []

    async def start(self) -> None:
        self.process = await asyncio.create_subprocess_exec(
            "node",
            str(INTEROP / "yjs_client.mjs"),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
        )

    async def call(self, **message) -> dict:
        """Send one command or frame; forward what the client emits to the server; return its answers."""
        assert self.process and self.process.stdin and self.process.stdout
        self.process.stdin.write(json.dumps(message).encode() + b"\n")
        await self.process.stdin.drain()
        answers: dict = {}
        while True:
            line = json.loads(await asyncio.wait_for(self.process.stdout.readline(), 10))
            if "out" in line:
                await self.peer.send_raw(base64.b64decode(line["out"]))
            elif "denied" in line:
                self.denied.append(line["denied"])
            elif "done" in line:
                return answers
            else:
                answers.update(line)

    async def pump(self, quiet: float = 0.1) -> None:
        """Feed everything the server sent to the Node client until the server is quiet."""
        while not await self.peer.ws.receive_nothing(quiet, 0.004):
            output = await self.peer.ws.receive_output(timeout=1)
            if output["type"] == "websocket.send" and output.get("bytes") is not None:
                await self.call(**{"in": base64.b64encode(output["bytes"]).decode()})
            else:
                await self.peer.handle(output)

    async def connect(self, auth_token: str | None = None) -> None:
        assert await self.peer.connect()
        if auth_token:
            await self.peer.auth(auth_token)
        await self.start()
        await self.call(cmd="open")
        for _ in range(4):
            await self.pump()
        assert self.peer.ready is not None, f"closed {self.peer.close_code} {self.peer.close_reason}"

    async def snapshot(self) -> dict:
        return (await self.call(cmd="snapshot"))["snapshot"]

    async def stop(self) -> None:
        if self.process and self.process.returncode is None:
            assert self.process.stdin
            self.process.stdin.close()
            await self.process.wait()


async def test_yjs_receives_the_design_and_reads_it_back(env):
    client = NodeYjs(await env.peer(env.owner))
    try:
        await client.connect()
        snapshot = await client.snapshot()
        expected = env.design.document
        assert json.dumps(canon(snapshot), sort_keys=True) == json.dumps(canon(expected), sort_keys=True)
    finally:
        await client.stop()


async def test_edits_flow_between_yjs_and_the_python_client(env):
    client = NodeYjs(await env.peer(env.owner))
    try:
        await client.connect()
        python = await env.open(env.owner)
        await client.call(cmd="setProp", page=0, object=0, prop="left", value=123.5)
        await client.call(
            cmd="addObject", page=0, id="from-js", props={"type": "rect", "label": "héllo \U0001f600"}
        )
        await python.barrier()
        await python.until(lambda: python.document["pages"][0]["objects"][-1]["id"] == "from-js")
        assert python.document["pages"][0]["objects"][0]["left"] == 123.5
        assert python.document["pages"][0]["objects"][-1]["label"] == "héllo \U0001f600"
        await python.edit(lambda doc: first_object(python).__setitem__("top", 777))
        await python.edit(lambda doc: add_object(python, "from-py", left=2))
        await settle(python)
        await client.pump(0.2)
        snapshot = await client.snapshot()
        assert snapshot["pages"][0]["objects"][0]["top"] == 777
        assert [o["id"] for o in snapshot["pages"][0]["objects"]][-2:] == ["from-js", "from-py"]
        assert json.dumps(canon(snapshot), sort_keys=True) == json.dumps(
            canon(python.document), sort_keys=True
        )
    finally:
        await client.stop()


async def test_concurrent_reorders_from_yjs_and_python_converge(env):
    client = NodeYjs(await env.peer(env.owner))
    try:
        await client.connect()
        python = await env.open(env.owner)

        def move(doc):
            order = page_map(python)[KEY_OBJECT_ORDER]
            moved = order[1]
            del order[1]
            order.insert(0, moved)

        await python.edit(move)
        await client.call(cmd="moveObject", page=0, **{"from": 1, "to": 2})
        await settle(python)
        await client.pump(0.2)
        await settle(python)
        await client.pump(0.2)
        snapshot = await client.snapshot()
        assert [o["id"] for o in snapshot["pages"][0]["objects"]] == [
            o["id"] for o in python.document["pages"][0]["objects"]
        ]
        assert len(snapshot["pages"][0]["objects"]) == 3
    finally:
        await client.stop()


async def test_awareness_works_with_the_reference_implementation(env):
    client = NodeYjs(await env.peer(env.owner))
    try:
        await client.connect()
        python = await env.open(env.owner)
        await client.call(cmd="awareness", state={"cursor": {"x": 4, "y": 5}, "user": {"name": "Impostor"}})
        await client.pump()
        await python.until(
            lambda: any(s and s.get("cursor") == {"x": 4, "y": 5} for s in python.awareness.values())
        )
        state = next(s for s in python.awareness.values() if s and s.get("cursor"))
        assert state["user"]["name"] == "Olive Owner"
        await python.send_awareness(4001, 1, {"cursor": {"x": 1}})
        await client.pump(0.2)
        states = (await client.call(cmd="awarenessStates"))["awarenessStates"]
        assert any(value and value.get("cursor") == {"x": 1} for value in states.values())
    finally:
        await client.stop()


async def test_a_view_link_user_on_yjs_is_read_only(env):
    link = await env.link("view")
    client = NodeYjs(await env.peer(env.other))
    try:
        await client.connect(auth_token=link.token)
        owner = await env.open(env.owner)
        await client.call(cmd="setProp", page=0, object=0, prop="left", value=99999)
        await client.pump(0.2)
        await owner.barrier()
        assert owner.document["pages"][0]["objects"][0]["left"] != 99999
        assert client.denied == ["read_only"]
    finally:
        await client.stop()


async def test_the_saved_design_matches_what_yjs_made(env):
    client = NodeYjs(await env.peer(env.owner))
    try:
        await client.connect()
        await client.call(cmd="setMeta", prop="width", value=1500)
        await client.call(cmd="setProp", page=1, object=0, prop="fill", value="#abcdef")
        await client.call(cmd="setProp", page=0, object=1, prop="angle", value=45)
        await client.call(cmd="setProp", page=0, object=1, prop="scale", value=0.1)
        await client.pump(0.2)
        await client.peer.barrier()
        expected = await client.snapshot()
        await client.peer.send_json({"type": "flush"})
        await client.peer.until(lambda: client.peer.texts_of("saved"))
        saved = (await env.db(lambda: Design.objects.get(pk=env.design.pk))).document
        assert saved == expected
        assert saved["width"] == 1500 and isinstance(saved["width"], int)
        assert isinstance(saved["pages"][0]["objects"][1]["angle"], int)
        assert saved["pages"][0]["objects"][1]["scale"] == 0.1
        assert saved["pages"][1]["objects"][0]["fill"] == "#abcdef"
    finally:
        await client.stop()


async def test_everything_survives_the_encoded_state_through_yjs(env):
    """A second Yjs client joining later reads the same document from the stored state."""
    first = NodeYjs(await env.peer(env.owner))
    second = NodeYjs(await env.peer(env.owner))
    try:
        await first.connect()
        await first.call(
            cmd="addObject", page=0, id="kept", props={"type": "rect", "deep": {"a": [1, 2, {"b": None}]}}
        )
        await first.peer.barrier()
        await second.connect()
        snapshot = await second.snapshot()
        assert snapshot["pages"][0]["objects"][-1]["deep"] == {"a": [1, 2, {"b": None}]}
        assert json.dumps(canon(snapshot), sort_keys=True) == json.dumps(
            canon(await first.snapshot()), sort_keys=True
        )
    finally:
        await first.stop()
        await second.stop()
