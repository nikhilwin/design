"""What a writer may do to the engine: shapes of update that made one apply take minutes."""

from __future__ import annotations

import time

from django.core.cache import cache
from pycrdt import Array, Map

from apps.collab import engine, protocol, schema
from apps.collab.limits import allow_connection_attempt
from apps.collab.models import YUpdate

from . import hostile
from .helpers import sample_document
from .peer import settle

CLIENT = 777_001


def fresh_doc():
    return schema.document_to_ydoc(sample_document(1, 2))


def run(updates, budget=None, introduced=None, doc=None):
    doc = doc or fresh_doc()
    sv = protocol.decode_state_vector(doc.get_state())
    owners = introduced if introduced is not None else [set() for _ in updates]
    return engine.apply_client_updates(doc, sv, updates, 1000, budget or engine.UpdateBudget(), owners)


def writes_to_one_key(count: int, client: int = CLIENT) -> bytes:
    """`count` first writes of the same map entry, none naming a predecessor (honest clients name one)."""
    return hostile.update(
        {client: (0, [hostile.item(root="meta", key="shared", value=i) for i in range(count)])}
    )


def test_a_handful_of_first_writes_of_one_entry_is_honest_concurrency():
    result = run([writes_to_one_key(engine.MAX_ORIGINLESS_PER_ENTRY)])
    assert [o.kind for o in result.outcomes] == ["applied"]


def test_thousands_of_first_writes_of_one_entry_are_refused_before_the_engine_sees_them():
    started = time.perf_counter()
    result = run([writes_to_one_key(30_000)])
    assert [(o.kind, o.reason) for o in result.outcomes] == [("rejected", "bad_frame")]
    assert "first writes" in result.outcomes[0].detail
    assert time.perf_counter() - started < 5  # applying them takes minutes


def test_first_writes_are_counted_for_the_life_of_the_room_not_per_update():
    budget = engine.UpdateBudget()
    doc = fresh_doc()
    results = []
    for number in range(engine.MAX_ORIGINLESS_PER_ENTRY + 3):
        update = hostile.update({CLIENT + number: (0, [hostile.item(root="meta", key="shared")])})
        introduced = {CLIENT + number - 1}  # a new connection each time: the clients limit does not interfere
        results.append(run([update], budget, [introduced], doc).outcomes[0].kind)
    assert results.count("applied") == engine.MAX_ORIGINLESS_PER_ENTRY
    assert results[-3:] == ["rejected"] * 3


def test_many_distinct_entries_are_fine():
    updates = [hostile.update({CLIENT: (0, [hostile.item(root="meta", key=f"key-{i}") for i in range(500)])})]
    assert run(updates).outcomes[0].kind == "applied"


def test_a_connection_may_introduce_only_a_few_clients():
    many = hostile.update({1000 + i: (0, [hostile.item(root="meta", key=f"k{i}")]) for i in range(50)})
    started = time.perf_counter()
    result = run([many])
    assert result.outcomes[0].kind == "rejected" and "new clients" in result.outcomes[0].detail
    assert time.perf_counter() - started < 5
    few = hostile.update(
        {1000 + i: (0, [hostile.item(root="meta", key=f"k{i}")]) for i in range(engine.MAX_NEW_CLIENTS)}
    )
    assert run([few]).outcomes[0].kind == "applied"


def test_clients_are_counted_per_connection_over_its_life():
    budget, mine, doc = engine.UpdateBudget(), set(), fresh_doc()
    kinds = [
        run([hostile.update({2000 + i: (0, [hostile.item(root="meta", key=f"c{i}")])})], budget, [mine], doc)
        .outcomes[0]
        .kind
        for i in range(engine.MAX_NEW_CLIENTS + 2)
    ]
    assert kinds == ["applied"] * engine.MAX_NEW_CLIENTS + ["rejected"] * 2


def test_an_update_may_not_hold_a_swarm_of_array_start_insertions():
    doc = fresh_doc()
    first_client = next(iter(protocol.decode_state_vector(doc.get_state())))
    swarm = hostile.update(
        {
            CLIENT: (
                0,
                [hostile.item(right=(first_client, 0)) for _ in range(engine.MAX_RIGHT_ONLY_PER_UPDATE + 1)],
            )
        }
    )
    assert run([swarm], doc=doc).outcomes[0].kind == "rejected"


def test_thousands_of_references_into_one_long_run_are_refused():
    """20 000 splits of one 20 000-value run made the engine allocate gigabytes and abort the process."""
    count = 20_000
    structs = [hostile.run_of_values(root="pageOrder", count=count)]
    structs += [
        hostile.item(origin=(CLIENT, 1 + index % (count - 1)), right=(CLIENT, 1 + index))
        for index in range(count)
    ]
    swarm = hostile.update({CLIENT: (0, structs)})
    started = time.perf_counter()
    result = run([swarm])
    assert result.outcomes[0].kind == "rejected" and "middle of a long run" in result.outcomes[0].detail
    assert time.perf_counter() - started < 5


def test_a_few_references_into_a_run_of_the_same_update_are_honest():
    structs = [hostile.run_of_values(root="pageOrder", count=50)]
    structs += [hostile.item(origin=(CLIENT, 10 + index), right=(CLIENT, 11 + index)) for index in range(20)]
    assert run([hostile.update({CLIENT: (0, structs)})]).outcomes[0].kind == "applied"


def test_an_ordinary_editing_session_stays_inside_the_budget():
    """A pycrdt peer typing, moving and re-ordering: the shapes honest clients produce."""
    doc = fresh_doc()
    peer = schema.new_doc()
    peer.apply_update(doc.get_update())
    budget, mine = engine.UpdateBudget(), set()
    for step in range(60):
        before = peer.get_state()
        with peer.transaction():
            page = next(iter(peer.get(schema.ROOT_PAGES, type=Map).values()))
            page["objects"][next(iter(page["objects"].keys()))]["left"] = step
            peer.get(schema.ROOT_META, type=Map)[f"note-{step % 5}"] = step
            peer.get(schema.ROOT_PAGE_ORDER, type=Array).insert(0, f"p-{step}")
        outcome = run([peer.get_update(before)], budget, [mine], doc).outcomes[0]
        assert outcome.kind == "applied", (step, outcome)


async def test_an_update_that_takes_too_long_drops_the_room_and_blocks_the_sender(env, settings):
    from .test_sync import first_object

    cache.clear()
    victim = await env.open(env.owner)
    watcher = await env.open(env.owner)
    stored_before = await env.db(lambda: YUpdate.objects.filter(design=env.design).count())
    settings.REALTIME_SLOW_APPLY_SECONDS = 0.0  # from now on every apply counts as too slow

    await victim.edit(lambda doc: first_object(victim).__setitem__("left", 99))
    await victim.until(lambda: victim.close_code is not None)
    await watcher.until(lambda: watcher.close_code is not None)
    assert victim.close_code in (1011, 4400)
    assert env.registry.counters["rejected_update_too_costly"] == 1
    assert await env.db(lambda: YUpdate.objects.filter(design=env.design).count()) == stored_before
    assert allow_connection_attempt(env.owner.pk) is False  # blocked for REALTIME_BLOCK_SECONDS

    settings.REALTIME_SLOW_APPLY_SECONDS = 2.0
    cache.clear()
    again = await env.open(env.owner)
    await settle(again)
    assert (
        again.document["pages"][0]["objects"][0]["left"] != 99
    )  # the poisoned update never reached the store
