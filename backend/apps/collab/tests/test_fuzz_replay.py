"""The editor's fuzz runs replayed against the real server engine.

`frontend/src/editor/collab/fuzz` drives several editors (real bindings and undo managers over Yjs) through random
edits, a hostile network and reconnections, with a stand-in for the server in the middle. This file takes the updates
that stand-in received, in the order it received them, and feeds them to the server's own pipeline: the update scanner,
the CRDT engine, the conversion to a design and the design validator. Every update an editor produced must be accepted,
every intermediate state must be one the server could save, and the final design must be the one the editors agreed on.

Regenerate the fixture after changing the fuzz catalogue:
    cd frontend && FUZZ_FIXTURE=../backend/apps/collab/tests/fixtures/fuzz_replay.json \
        npx vitest run src/editor/collab/fuzz/fuzz.test.ts -t "records what"
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

from apps.collab import engine, schema

from .helpers import canon

FIXTURE = Path(__file__).parent / "fixtures" / "fuzz_replay.json"
CASES = json.loads(FIXTURE.read_text())


@pytest.mark.parametrize("case", CASES, ids=[f"seed-{case['seed']}" for case in CASES])
def test_the_servers_engine_accepts_every_update_and_ends_with_the_editors_design(case):
    opened = engine.open_doc(base64.b64decode(case["initial"]), [])
    doc, sv, size = opened.doc, opened.sv, opened.size
    applied = 0
    for index, encoded in enumerate(case["updates"]):
        result = engine.apply_client_updates(doc, sv, [base64.b64decode(encoded)], size)
        outcome = result.outcomes[0]
        assert outcome.kind in ("applied", "noop"), f"update {index} was rejected: {outcome.reason}"
        applied += outcome.kind == "applied"
        sv, size = result.sv, result.size
        conversion = engine.convert(doc.get_update())
        assert conversion.document is not None, (
            f"after update {index} the server could not save: {conversion.problem}"
        )
    assert applied > 0
    final = schema.ydoc_to_document(doc)
    assert canon(final) == canon(case["document"])


def test_the_fixture_covers_what_it_claims_to():
    kinds = set()
    for case in CASES:
        for page in case["document"]["pages"]:
            kinds.update(obj["type"] for obj in page["objects"])
    assert {"rect", "textbox", "group", "image"} <= kinds
    assert sum(len(case["updates"]) for case in CASES) > 200
