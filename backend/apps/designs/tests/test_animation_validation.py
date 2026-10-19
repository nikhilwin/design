"""Animation of objects and transitions of pages."""

import copy

import pytest

from apps.designs.exceptions import InvalidDocument
from apps.designs.validators import validate_document

from .helpers import make_design, make_doc

LIMIT = 12 * 1024 * 1024
URL = "/api/v1/designs/"

ENTER = {"preset": "rise", "durationMs": 700, "delayMs": 0, "easing": "ease-out"}
TRANSITION = {"preset": "push", "durationMs": 700, "easing": "ease-in-out", "direction": "left"}


def check(doc: dict) -> None:
    validate_document(doc, max_bytes=LIMIT)


def doc_with_animation(animation) -> dict:
    doc = make_doc(pages=2)
    doc["pages"][1]["objects"] = [
        {"id": "a", "type": "rect"},
        {"id": "b", "type": "textbox", "animation": animation},
    ]
    return doc


def doc_with_transition(transition) -> dict:
    doc = make_doc(pages=2)
    doc["pages"][1]["transition"] = transition
    return doc


class TestObjectAnimation:
    def test_a_document_without_animation_is_fine(self):
        check(make_doc(pages=2))

    @pytest.mark.parametrize(
        "animation",
        [
            None,
            {},
            {"enter": ENTER},
            {
                "enter": ENTER,
                "exit": {**ENTER, "delayMs": 4000},
                "emphasis": {**ENTER, "preset": "pulse", "loop": True},
            },
            {"enter": {**ENTER, "direction": "left", "by": "word", "intensity": 0.3}},
            {"enter": {"preset": "from-the-future-2"}},
            {"enter": None, "exit": None},
            {"enter": {**ENTER, "durationMs": 100, "delayMs": 60_000}},
            {"enter": {**ENTER, "durationMs": 10_000}},
            {"enter": {**ENTER, "durationMs": 333.5, "intensity": 0}},
            {"enter": {**ENTER, "intensity": 1}},
            {"someFutureSlot": {"preset": "x"}},
            {"enter": {**ENTER, "futureSetting": [1, 2]}},
        ],
    )
    def test_accepted(self, animation):
        check(doc_with_animation(animation))

    @pytest.mark.parametrize("animation", [5, "fade", [ENTER], True])
    def test_must_be_an_object(self, animation):
        with pytest.raises(InvalidDocument, match="Page 2 object 2 `animation`"):
            check(doc_with_animation(animation))

    @pytest.mark.parametrize("entry", [5, "fade", [ENTER], True])
    def test_a_slot_must_be_an_object(self, entry):
        with pytest.raises(InvalidDocument, match="enter"):
            check(doc_with_animation({"enter": entry}))

    @pytest.mark.parametrize(
        "preset",
        [None, "", 5, "Rise", "has space", "under_score", "x" * 41, "emoji-🎨", "a/b", ["rise"], True],
    )
    def test_the_preset_must_be_a_short_slug(self, preset):
        with pytest.raises(InvalidDocument, match="`preset`"):
            check(doc_with_animation({"enter": {**ENTER, "preset": preset}}))

    def test_the_preset_may_be_missing_only_when_the_slot_is_not_set(self):
        entry = copy.deepcopy(ENTER)
        del entry["preset"]
        with pytest.raises(InvalidDocument, match="`preset`"):
            check(doc_with_animation({"enter": entry}))

    @pytest.mark.parametrize(
        ("key", "value"),
        [
            ("durationMs", 99),
            ("durationMs", 10_001),
            ("durationMs", -1),
            ("durationMs", "700"),
            ("durationMs", True),
            ("durationMs", float("nan")),
            ("durationMs", float("inf")),
            ("durationMs", 10**400),
            ("delayMs", -1),
            ("delayMs", 60_001),
            ("delayMs", "0"),
            ("delayMs", False),
            ("intensity", -0.1),
            ("intensity", 1.1),
            ("intensity", "high"),
            ("easing", "wobble"),
            ("easing", 3),
            ("direction", "sideways"),
            ("direction", 1),
            ("by", "paragraph"),
            ("by", 2),
            ("loop", "yes"),
            ("loop", 1),
        ],
    )
    def test_settings_must_be_inside_their_ranges(self, key, value):
        with pytest.raises(InvalidDocument, match=f"`{key}`"):
            check(doc_with_animation({"emphasis": {**ENTER, key: value}}))

    def test_the_message_names_the_page_the_object_and_the_slot(self):
        with pytest.raises(InvalidDocument, match=r"Page 2 object 2 `animation`\.exit `delayMs`"):
            check(doc_with_animation({"enter": ENTER, "exit": {**ENTER, "delayMs": -5}}))

    def test_only_objects_of_the_page_are_checked_not_their_children(self):
        doc = doc_with_animation(None)
        doc["pages"][1]["objects"][1] = {
            "id": "g",
            "type": "group",
            "objects": [{"id": "c", "animation": "nonsense"}],
        }
        check(doc)


class TestPageTransition:
    @pytest.mark.parametrize(
        "transition",
        [
            None,
            TRANSITION,
            {"preset": "none", "durationMs": 200, "easing": "linear"},
            {"preset": "fade", "durationMs": 3000, "easing": "spring"},
            {"preset": "fade"},
            {
                "preset": "a-transition-from-the-future",
                "durationMs": 900,
                "easing": "bounce",
                "direction": "in",
            },
            {"preset": "fade", "durationMs": 700, "easing": "linear", "futureSetting": {"a": 1}},
        ],
    )
    def test_accepted(self, transition):
        check(doc_with_transition(transition))

    @pytest.mark.parametrize("transition", [5, "fade", [TRANSITION], True])
    def test_must_be_an_object(self, transition):
        with pytest.raises(InvalidDocument, match="Page 2 `transition`"):
            check(doc_with_transition(transition))

    @pytest.mark.parametrize("preset", [None, "", "Fade", "x" * 41, "a b", 3])
    def test_the_preset_must_be_a_short_slug(self, preset):
        with pytest.raises(InvalidDocument, match="`preset`"):
            check(doc_with_transition({**TRANSITION, "preset": preset}))

    @pytest.mark.parametrize("duration", [0, 199, 3001, -5, "700", True, float("nan"), float("inf"), 10**400])
    def test_the_duration_is_200_to_3000_ms(self, duration):
        with pytest.raises(InvalidDocument, match="`durationMs`"):
            check(doc_with_transition({**TRANSITION, "durationMs": duration}))

    @pytest.mark.parametrize(
        ("key", "value"), [("easing", "wobble"), ("direction", "sideways"), ("direction", 4)]
    )
    def test_names_must_be_known(self, key, value):
        with pytest.raises(InvalidDocument, match=f"`{key}`"):
            check(doc_with_transition({**TRANSITION, key: value}))


@pytest.mark.django_db
class TestThroughTheApi:
    def test_animation_and_transitions_round_trip_untouched(self, api):
        unknown = {
            "enter": {
                "preset": "from-the-future",
                "durationMs": 777,
                "delayMs": 12,
                "easing": "spring",
                "x": [1],
            }
        }
        doc = doc_with_animation(unknown)
        doc["pages"][1]["transition"] = {
            "preset": "a-new-one",
            "durationMs": 1234,
            "easing": "linear",
            "direction": "up",
        }
        created = api.post(URL, {"document": doc}, format="json")
        assert created.status_code == 201
        stored = api.get(f"{URL}{created.json()['id']}/").json()["document"]
        assert stored["pages"][1]["objects"][1]["animation"] == unknown
        assert stored["pages"][1]["transition"] == doc["pages"][1]["transition"]

    @pytest.mark.parametrize(
        "mutate",
        [
            lambda d: d["pages"][1]["objects"][1].update(animation={"enter": {**ENTER, "durationMs": 5}}),
            lambda d: d["pages"][1]["objects"][1].update(
                animation={"enter": {**ENTER, "preset": "Bad Name"}}
            ),
            lambda d: d["pages"][1].update(transition={**TRANSITION, "durationMs": 10}),
        ],
    )
    def test_create_refuses_bad_values(self, api, mutate):
        doc = doc_with_animation(None)
        mutate(doc)
        res = api.post(URL, {"document": doc}, format="json")
        assert res.status_code == 400
        assert res.json()["error"]["code"] == "invalid_document"

    def test_save_refuses_bad_values_and_keeps_the_stored_document(self, api, user):
        design = make_design(user, document=doc_with_animation({"enter": ENTER}))
        bad = doc_with_animation({"enter": {**ENTER, "delayMs": 999_999}})
        res = api.patch(
            f"{URL}{design.id}/", {"document": bad, "base_revision": design.revision}, format="json"
        )
        assert res.status_code == 400
        assert res.json()["error"]["code"] == "invalid_document"
        design.refresh_from_db()
        assert design.document["pages"][1]["objects"][1]["animation"] == {"enter": ENTER}
