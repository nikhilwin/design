from __future__ import annotations

import json

import pytest

pytestmark = pytest.mark.django_db


async def test_the_owner_connects_and_receives_the_design(env):
    peer = await env.open()
    assert peer.ready["role"] == "owner" and peer.ready["canWrite"] is True
    assert peer.ready["title"] == "Summer poster"
    assert peer.document["pages"][0]["objects"][0]["type"] == "rect"
    assert [p["id"] for p in peer.document["pages"]] == [p["id"] for p in env.design.document["pages"]]


async def test_people_without_a_display_name_are_not_named_after_their_email_address(env):
    def forget_the_name():
        env.owner.display_name = ""
        env.owner.save(update_fields=["display_name"])

    await env.db(forget_the_name)
    peer = await env.open(env.owner)
    assert peer.ready["user"]["name"] == "Doory user"
    assert "owner" not in json.dumps(peer.ready["user"])
