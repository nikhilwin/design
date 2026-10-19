"""Audio tracks of a design."""

import copy

import pytest

from apps.designs.exceptions import InlineAssetNotAllowed, InvalidDocument
from apps.designs.validators import describe_document, validate_document

from .helpers import make_design, make_doc

LIMIT = 12 * 1024 * 1024
URL = "/api/v1/designs/"

TRACK = {
    "id": "t1",
    "kind": "music",
    "name": "Sunny day",
    "src": "/media/audio/music/sunny-day-0123456789ab.ogg",
    "scope": {"type": "design"},
    "startMs": 0,
    "trimStartMs": 0,
    "trimEndMs": 42000,
    "durationMs": 42000,
    "volume": 0.6,
    "fadeInMs": 500,
    "fadeOutMs": 1500,
    "loop": True,
    "muted": False,
}


def check(doc: dict) -> None:
    validate_document(doc, max_bytes=LIMIT)


def doc_with(*tracks) -> dict:
    return make_doc(pages=2, audioTracks=[copy.deepcopy(t) for t in tracks])


def track(**changes) -> dict:
    return {**copy.deepcopy(TRACK), **changes}


class TestAccepted:
    def test_a_document_without_audio_is_fine(self):
        check(make_doc(pages=2))

    @pytest.mark.parametrize("tracks", [None, []])
    def test_no_tracks(self, tracks):
        check(make_doc(audioTracks=tracks))

    def test_a_full_track(self):
        check(doc_with(TRACK))

    def test_all_kinds_and_both_scopes(self):
        doc = doc_with(
            track(id="a", kind="music"),
            track(id="b", kind="voiceover", scope={"type": "page", "pageId": "p1"}, duckUnderVoiceover=False),
            track(id="c", kind="sfx", src="https://cdn.example.com/pop.ogg"),
            track(id="d", kind="upload", assetId="7d0d52a4-2a3c-4e2b-a8cf-0c8b1b6f3f10"),
        )
        check(doc)

    def test_a_minimal_track(self):
        check(doc_with({"id": "x", "kind": "sfx", "src": "/media/a.ogg", "scope": {"type": "design"}}))

    def test_exactly_32_tracks(self):
        check(doc_with(*[track(id=f"t{i}") for i in range(32)]))

    def test_bounds_are_inclusive(self):
        check(
            doc_with(
                track(
                    startMs=86_400_000,
                    trimStartMs=0,
                    trimEndMs=86_400_000,
                    volume=0,
                    fadeInMs=60_000,
                    fadeOutMs=0,
                )
            )
        )

    def test_unknown_keys_pass(self):
        check(doc_with(track(futureSetting={"a": 1})))

    def test_null_settings_count_as_not_set(self):
        check(doc_with(track(volume=None, fadeInMs=None, loop=None, assetId=None, name=None)))

    def test_describe_ignores_audio(self):
        assert describe_document(doc_with(TRACK)).page_count == 2


class TestRejected:
    def test_not_a_list(self):
        with pytest.raises(InvalidDocument, match="audioTracks"):
            check(make_doc(audioTracks={"id": "a"}))

    def test_too_many(self):
        with pytest.raises(InvalidDocument, match="at most 32"):
            check(doc_with(*[track(id=f"t{i}") for i in range(33)]))

    @pytest.mark.parametrize("item", [None, "a.ogg", 5, [TRACK], True])
    def test_a_track_must_be_an_object(self, item):
        with pytest.raises(InvalidDocument, match="Audio track 1"):
            check(make_doc(audioTracks=[item]))

    @pytest.mark.parametrize("track_id", [None, "", 5, "x" * 65, ["a"], True])
    def test_the_id(self, track_id):
        with pytest.raises(InvalidDocument, match="`id`"):
            check(doc_with(track(id=track_id)))

    def test_ids_are_unique(self):
        with pytest.raises(InvalidDocument, match="Audio track 2"):
            check(doc_with(track(id="a"), track(id="a")))

    @pytest.mark.parametrize("kind", [None, "", "video", "Music", 3])
    def test_the_kind(self, kind):
        with pytest.raises(InvalidDocument, match="`kind`"):
            check(doc_with(track(kind=kind)))

    @pytest.mark.parametrize("name", [5, "n" * 201, ["a"], True])
    def test_the_name(self, name):
        with pytest.raises(InvalidDocument, match="`name`"):
            check(doc_with(track(name=name)))

    @pytest.mark.parametrize(
        "src",
        [
            None,
            "",
            5,
            "x" * 2049,
            "javascript:alert(1)",
            "data:audio/wav;base64,AAAA",
            "http://example.com/a.ogg",
            "//evil.example/a.ogg",
            "ftp://example.com/a.ogg",
            "file:///etc/passwd",
            "media/audio/a.ogg",
            ["/media/a.ogg"],
        ],
    )
    def test_the_source(self, src):
        with pytest.raises(InvalidDocument, match="`src`"):
            check(doc_with(track(src=src)))

    @pytest.mark.parametrize(
        "src", ["idb://0b0a44ae-1e0f-4a1d-9c30-4a8f6c6f2d3a", "blob:https://x.example/uuid"]
    )
    def test_local_sources_are_not_saved(self, src):
        with pytest.raises(InlineAssetNotAllowed):
            check(doc_with(track(src=src)))

    @pytest.mark.parametrize("asset_id", [5, "x" * 65, ["a"], True])
    def test_the_asset_id(self, asset_id):
        with pytest.raises(InvalidDocument, match="`assetId`"):
            check(doc_with(track(assetId=asset_id)))

    @pytest.mark.parametrize(
        "scope",
        [
            None,
            "design",
            {},
            {"type": "all"},
            {"type": "page"},
            {"type": "page", "pageId": ""},
            {"type": "page", "pageId": 4},
        ],
    )
    def test_the_scope(self, scope):
        with pytest.raises(InvalidDocument, match="`scope"):
            check(doc_with(track(scope=scope)))

    @pytest.mark.parametrize(
        ("key", "value"),
        [
            ("startMs", -1),
            ("startMs", 86_400_001),
            ("startMs", "0"),
            ("startMs", True),
            ("startMs", float("nan")),
            ("startMs", float("inf")),
            ("trimStartMs", -5),
            ("trimEndMs", -1),
            ("trimEndMs", 10**400),
            ("durationMs", -1),
            ("volume", -0.1),
            ("volume", 1.01),
            ("volume", "loud"),
            ("volume", float("nan")),
            ("fadeInMs", -1),
            ("fadeInMs", 60_001),
            ("fadeOutMs", True),
            ("fadeOutMs", [1]),
        ],
    )
    def test_numbers_must_be_in_range(self, key, value):
        with pytest.raises(InvalidDocument, match=f"`{key}`"):
            check(doc_with(track(**{key: value})))

    @pytest.mark.parametrize("key", ["loop", "muted", "duckUnderVoiceover"])
    @pytest.mark.parametrize("value", ["yes", 1, 0, [True]])
    def test_flags_are_booleans(self, key, value):
        with pytest.raises(InvalidDocument, match=f"`{key}`"):
            check(doc_with(track(**{key: value})))

    def test_trim_end_cannot_precede_trim_start(self):
        with pytest.raises(InvalidDocument, match="trimEndMs"):
            check(doc_with(track(trimStartMs=5000, trimEndMs=4000)))


@pytest.mark.django_db
class TestThroughTheApi:
    def test_a_design_with_audio_round_trips(self, api):
        doc = doc_with(TRACK)
        created = api.post(
            URL, {"title": "With sound", "width": 800, "height": 600, "document": doc}, format="json"
        )
        assert created.status_code == 201, created.content
        loaded = api.get(f"{URL}{created.json()['id']}/").json()
        assert loaded["document"]["audioTracks"] == [TRACK]

    def test_a_bad_track_is_a_400_invalid_document(self, api):
        doc = doc_with(track(volume=3))
        res = api.post(URL, {"title": "x", "width": 800, "height": 600, "document": doc}, format="json")
        assert res.status_code == 400 and res.json()["error"]["code"] == "invalid_document"

    def test_a_local_source_is_an_inline_asset_error(self, api):
        doc = doc_with(track(src="idb://0b0a44ae-1e0f-4a1d-9c30-4a8f6c6f2d3a"))
        res = api.post(URL, {"title": "x", "width": 800, "height": 600, "document": doc}, format="json")
        assert res.status_code == 400 and res.json()["error"]["code"] == "inline_asset_not_allowed"

    def test_saving_audio_into_an_existing_design(self, api, user):
        design = make_design(user)
        res = api.patch(
            f"{URL}{design.id}/",
            {"document": doc_with(TRACK), "base_revision": design.revision},
            format="json",
        )
        assert res.status_code == 200, res.content


class TestRealtimeRoundTrip:
    """`audioTracks` is a document-level list: the generic Y mapping carries it as one value of `meta`."""

    def test_the_room_keeps_the_tracks(self):
        from apps.collab.schema import document_to_ydoc, ydoc_to_document

        doc = doc_with(TRACK, track(id="t2", kind="sfx", scope={"type": "page", "pageId": "p1"}))
        assert ydoc_to_document(document_to_ydoc(doc))["audioTracks"] == doc["audioTracks"]

    def test_a_room_document_still_validates(self):
        from apps.collab.schema import document_to_ydoc, ydoc_to_document

        check(ydoc_to_document(document_to_ydoc(doc_with(TRACK))))
