import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from django.apps import apps
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.utils import timezone
from PIL import Image

from apps.assets.tests.helpers import image_bytes, upload
from apps.designs.models import Design, Folder

from .helpers import image_object, make_design, make_doc, text_object

URL = "/api/v1/designs/"


def detail(design_id) -> str:
    return f"{URL}{design_id}/"


@pytest.mark.django_db
class TestCreate:
    def test_blank_design_defaults(self, api, user):
        res = api.post(URL, {}, format="json")
        assert res.status_code == 201
        body = res.json()
        assert (body["title"], body["width"], body["height"]) == ("Untitled design", 1080, 1080)
        assert (body["page_count"], body["revision"], body["starred"]) == (1, 1, False)
        assert body["folder"] is None and body["thumbnail_url"] is None and body["trashed_at"] is None
        assert body["document"]["schemaVersion"] == 1 and len(body["document"]["pages"]) == 1
        assert body["document"]["pages"][0]["objects"] == []
        assert Design.objects.get(pk=body["id"]).owner == user

    def test_response_has_the_contract_fields(self, api):
        body = api.post(URL, {}, format="json").json()
        assert set(body) == {
            "id", "title", "width", "height", "preset", "page_count", "thumbnail_url", "folder",
            "starred", "revision", "created_at", "updated_at", "trashed_at", "document",
        }  # fmt: skip

    def test_custom_size_title_and_preset(self, api):
        body = api.post(
            URL,
            {"title": "  Poster  ", "width": 1200, "height": 628, "preset": "facebook-post"},
            format="json",
        ).json()
        assert (body["title"], body["width"], body["height"], body["preset"]) == (
            "Poster",
            1200,
            628,
            "facebook-post",
        )
        assert (body["document"]["width"], body["document"]["height"]) == (1200, 628)
        assert body["document"]["meta"] == {"presetId": "facebook-post"}

    @pytest.mark.parametrize(
        "payload",
        [
            {"width": 0},
            {"height": 20_001},
            {"width": "wide"},
            {"width": 10.5},
            {"title": "   "},
            {"title": "x" * 201},
            {"preset": "bad preset!"},
            {"preset": "x" * 65},
        ],
    )
    def test_field_validation(self, api, payload):
        res = api.post(URL, payload, format="json")
        assert res.status_code == 400 and res.json()["error"]["code"] == "validation_error"
        assert set(res.json()["error"]["fields"]) == set(payload)

    def test_document_is_stored_and_facts_derived_from_it(self, api):
        doc = make_doc(
            pages=3, width=1920, height=1080, objects=[text_object()], meta={"presetId": "presentation"}
        )
        body = api.post(URL, {"document": doc, "width": 10, "height": 10}, format="json").json()
        assert (body["width"], body["height"], body["page_count"], body["preset"]) == (
            1920,
            1080,
            3,
            "presentation",
        )
        assert body["document"] == doc

    def test_invalid_document(self, api):
        res = api.post(URL, {"document": {"schemaVersion": 1}}, format="json")
        assert res.status_code == 400 and res.json()["error"]["code"] == "invalid_document"

    def test_local_image_references_are_rejected(self, api):
        doc = make_doc(objects=[image_object("blob:http://localhost/abc")])
        res = api.post(URL, {"document": doc}, format="json")
        assert res.status_code == 400 and res.json()["error"]["code"] == "inline_asset_not_allowed"
        doc = make_doc(objects=[image_object("idb://" + str(uuid.uuid4()))])
        assert (
            api.post(URL, {"document": doc}, format="json").json()["error"]["code"]
            == "inline_asset_not_allowed"
        )

    def test_document_too_large_is_413(self, api, settings):
        settings.MAX_DESIGN_DOCUMENT_BYTES = 2_000
        res = api.post(URL, {"document": make_doc(objects=[text_object("x" * 5_000)])}, format="json")
        assert res.status_code == 413 and res.json()["error"]["code"] == "document_too_large"
        assert Design.objects.count() == 0

    def test_oversized_request_body_is_413_before_parsing(self, api, settings):
        settings.MAX_DESIGN_DOCUMENT_BYTES = 1_000
        res = api.post(URL, data='{"title": "' + "x" * 400_000 + '"}', content_type="application/json")
        assert res.status_code == 413 and res.json()["error"]["code"] == "document_too_large"

    def test_json_nesting_bomb_is_a_400_not_a_500(self, api):
        res = api.post(URL, data="[" * 300_000, content_type="application/json")
        assert res.status_code == 400

    def test_document_and_template_are_exclusive(self, api):
        res = api.post(URL, {"document": make_doc(), "template": "a-template"}, format="json")
        assert res.status_code == 400 and "template" in res.json()["error"]["fields"]

    def test_folder_must_be_owned(self, api, other):
        theirs = Folder.objects.create(owner=other, name="Theirs")
        res = api.post(URL, {"folder": str(theirs.pk)}, format="json")
        assert res.status_code == 400 and "folder" in res.json()["error"]["fields"]

    def test_create_in_own_folder(self, api, user):
        folder = Folder.objects.create(owner=user, name="Mine")
        assert api.post(URL, {"folder": str(folder.pk)}, format="json").json()["folder"] == str(folder.pk)

    def test_mass_assignment_is_ignored(self, api, user, other):
        res = api.post(
            URL,
            {
                "owner": str(other.pk), "revision": 99, "trashed_at": "2020-01-01T00:00:00Z", "starred": True,
                "id": str(uuid.uuid4()), "thumbnail": "evil.png", "page_count": 50, "created_at": "2001-01-01T00:00:00Z",
            },
            format="json",
        )  # fmt: skip
        body = res.json()
        design = Design.objects.get(pk=body["id"])
        assert design.owner == user and design.revision == 1 and design.trashed_at is None
        assert not design.starred and design.page_count == 1 and not design.thumbnail
        assert design.created_at.year >= 2024

    def test_design_limit(self, api, user, settings):
        settings.MAX_DESIGNS_PER_USER = 2
        make_design(user)
        make_design(user)
        res = api.post(URL, {}, format="json")
        assert res.status_code == 409 and res.json()["error"]["code"] == "limit_reached"

    def test_requires_authentication(self, db):
        from rest_framework.test import APIClient

        res = APIClient().post(URL, {}, format="json")
        assert res.status_code == 401 and res.json()["error"]["code"] == "not_authenticated"


@pytest.mark.django_db
class TestCreateFromTemplate:
    @pytest.fixture
    def template_model(self):
        return apps.get_model("gallery", "Template")

    def make_template(self, template_model, **kwargs):
        defaults = {
            "slug": "summer-sale",
            "title": "Summer Sale",
            "width": 1200,
            "height": 628,
            "preset": "facebook-post",
            "document": make_doc(pages=2, width=1200, height=628),
            "page_count": 2,
            "is_published": True,
        }
        defaults.update(kwargs)
        return template_model.objects.create(**defaults)

    def test_copies_the_template_and_bumps_use_count(self, api, template_model):
        template = self.make_template(template_model)
        res = api.post(URL, {"template": "summer-sale"}, format="json")
        assert res.status_code == 201
        body = res.json()
        assert (body["title"], body["width"], body["height"], body["page_count"]) == (
            "Summer Sale",
            1200,
            628,
            2,
        )
        assert body["preset"] == "facebook-post"
        assert body["document"]["pages"] == template.document["pages"]
        template.refresh_from_db()
        assert template.use_count == 1
        api.post(URL, {"template": "summer-sale", "title": "Mine"}, format="json")
        template.refresh_from_db()
        assert template.use_count == 2

    def test_the_copy_starts_with_the_templates_picture_as_its_thumbnail(self, api, template_model):
        template = self.make_template(template_model)
        template.thumbnail.save("summer-sale.webp", ContentFile(b"RIFF-template-picture"), save=True)
        res = api.post(URL, {"template": "summer-sale"}, format="json")
        assert res.status_code == 201
        design = Design.objects.get(pk=res.json()["id"])
        assert design.thumbnail.name.startswith(f"designs/{design.owner_id}/")
        with design.thumbnail.open("rb") as handle:
            assert handle.read() == b"RIFF-template-picture"
        assert res.json()["thumbnail_url"]

    def test_a_template_without_a_picture_gives_a_copy_without_one(self, api, template_model):
        self.make_template(template_model)
        res = api.post(URL, {"template": "summer-sale"}, format="json")
        assert res.status_code == 201
        assert not Design.objects.get(pk=res.json()["id"]).thumbnail

    def test_unpublished_or_unknown_template_is_404(self, api, template_model):
        self.make_template(template_model, slug="draft", is_published=False)
        assert api.post(URL, {"template": "draft"}, format="json").status_code == 404
        assert api.post(URL, {"template": "nope"}, format="json").status_code == 404
        assert Design.objects.count() == 0

    def test_failed_creation_does_not_bump_use_count(self, api, user, template_model, settings):
        template = self.make_template(template_model)
        settings.MAX_DESIGNS_PER_USER = 0
        assert api.post(URL, {"template": template.slug}, format="json").status_code == 409
        template.refresh_from_db()
        assert template.use_count == 0

    def test_broken_template_document_is_refused(self, api, template_model):
        self.make_template(template_model, slug="broken", document={"nope": True})
        assert api.post(URL, {"template": "broken"}, format="json").status_code == 400

    def test_template_in_a_folder(self, api, user, template_model):
        self.make_template(template_model)
        folder = Folder.objects.create(owner=user, name="F")
        res = api.post(URL, {"template": "summer-sale", "folder": str(folder.pk)}, format="json")
        assert res.json()["folder"] == str(folder.pk)


@pytest.mark.django_db
class TestRetrieve:
    def test_returns_full_design(self, api, user):
        design = make_design(user, document=make_doc(objects=[text_object("hi")]))
        body = api.get(detail(design.pk)).json()
        assert body["id"] == str(design.pk) and body["document"]["pages"][0]["objects"][0]["text"] == "hi"

    def test_other_users_design_is_404(self, api, other):
        assert api.get(detail(make_design(other).pk)).status_code == 404

    def test_unknown_and_malformed_ids_are_404(self, api):
        assert api.get(detail(uuid.uuid4())).status_code == 404
        assert api.get(f"{URL}not-a-uuid/").status_code == 404

    def test_trashed_design_can_still_be_read(self, api, user):
        design = make_design(user, trashed_at=timezone.now())
        assert api.get(detail(design.pk)).json()["trashed_at"] is not None


@pytest.mark.django_db
class TestList:
    def test_summaries_only_and_newest_first(self, api, user):
        old = make_design(user, "Old")
        new = make_design(user, "New")
        Design.objects.filter(pk=old.pk).update(updated_at=timezone.now() - timedelta(days=1))
        body = api.get(URL).json()
        assert [d["id"] for d in body["results"]] == [str(new.pk), str(old.pk)]
        assert all("document" not in d for d in body["results"])
        assert set(body) == {"count", "next", "previous", "results"}

    def test_only_own_designs(self, api, user, other):
        mine = make_design(user)
        make_design(other)
        assert [d["id"] for d in api.get(URL).json()["results"]] == [str(mine.pk)]

    def test_trash_is_hidden_unless_requested(self, api, user):
        live = make_design(user, "Live")
        trashed = make_design(user, "Gone", trashed_at=timezone.now())
        assert [d["id"] for d in api.get(URL).json()["results"]] == [str(live.pk)]
        assert [d["id"] for d in api.get(URL, {"trashed": "true"}).json()["results"]] == [str(trashed.pk)]

    def test_search_title(self, api, user):
        make_design(user, "Birthday Invitation")
        make_design(user, "Quarterly report")
        titles = [d["title"] for d in api.get(URL, {"q": "invit"}).json()["results"]]
        assert titles == ["Birthday Invitation"]

    def test_search_is_literal_not_a_pattern(self, api, user):
        make_design(user, "100% organic")
        make_design(user, "plain")
        assert api.get(URL, {"q": "%"}).json()["count"] == 1

    def test_starred_filter(self, api, user):
        make_design(user, "a", starred=True)
        make_design(user, "b")
        assert [d["title"] for d in api.get(URL, {"starred": "true"}).json()["results"]] == ["a"]
        assert [d["title"] for d in api.get(URL, {"starred": "false"}).json()["results"]] == ["b"]

    def test_starred_designs_stay_in_the_unfiltered_list_and_in_search(self, api, user):
        # A query string with no `starred` must not mean `starred=false` (a missing value of a form-style boolean is False).
        make_design(user, "Starred poster", starred=True)
        make_design(user, "Plain poster")
        assert sorted(d["title"] for d in api.get(URL).json()["results"]) == [
            "Plain poster",
            "Starred poster",
        ]
        assert sorted(d["title"] for d in api.get(URL, {"q": "poster"}).json()["results"]) == [
            "Plain poster",
            "Starred poster",
        ]
        assert api.get(URL, {"folder": "root"}).json()["count"] == 2
        assert api.get(URL, {"starred": "true"}).json()["count"] == 1

    def test_folder_filter(self, api, user):
        folder = Folder.objects.create(owner=user, name="F")
        make_design(user, "in", folder=folder)
        make_design(user, "out")
        assert [d["title"] for d in api.get(URL, {"folder": str(folder.pk)}).json()["results"]] == ["in"]
        assert [d["title"] for d in api.get(URL, {"folder": "root"}).json()["results"]] == ["out"]

    def test_invalid_folder_param_is_a_400(self, api):
        assert api.get(URL, {"folder": "../../x"}).status_code == 400

    def test_ordering_is_whitelisted_and_case_insensitive_for_titles(self, api, user):
        for title in ("banana", "Apple", "cherry"):
            make_design(user, title)
        asc = [d["title"] for d in api.get(URL, {"ordering": "title"}).json()["results"]]
        desc = [d["title"] for d in api.get(URL, {"ordering": "-title"}).json()["results"]]
        assert asc == ["Apple", "banana", "cherry"] and desc == asc[::-1]
        oldest = [d["title"] for d in api.get(URL, {"ordering": "created_at"}).json()["results"]]
        assert oldest == ["banana", "Apple", "cherry"]

    @pytest.mark.parametrize("ordering", ["owner", "document", "-id", "title,owner", "__class__"])
    def test_unknown_ordering_is_a_400(self, api, ordering):
        assert api.get(URL, {"ordering": ordering}).status_code == 400

    def test_pagination_is_stable_across_ties(self, api, user):
        for _ in range(5):
            make_design(user, "same")
        seen = []
        for page in (1, 2, 3):
            seen += [
                d["id"]
                for d in api.get(URL, {"ordering": "title", "page_size": 2, "page": page}).json()["results"]
            ]
        assert len(seen) == len(set(seen)) == 5

    def test_query_count_does_not_grow_with_designs(self, api, user, django_assert_max_num_queries):
        folder = Folder.objects.create(owner=user, name="F")
        for i in range(12):
            make_design(user, f"d{i}", folder=folder)
        with django_assert_max_num_queries(2):
            body = api.get(URL).json()
        assert body["count"] == 12

    def test_document_is_never_loaded_for_listings(self, api, user):
        make_design(user, document=make_doc(objects=[text_object("secret-doc-marker")]))
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        with CaptureQueriesContext(connection) as ctx:
            api.get(URL)
        assert all(
            '"document"' not in q["sql"].split(" FROM ")[0]
            for q in ctx.captured_queries
            if "designs_design" in q["sql"]
        )

    def test_requires_authentication(self, db):
        from rest_framework.test import APIClient

        assert APIClient().get(URL).status_code == 401


@pytest.mark.django_db
class TestUpdate:
    def test_title_only_needs_no_revision_and_does_not_bump_it(self, api, user):
        design = make_design(user)
        res = api.patch(detail(design.pk), {"title": "  Renamed  "}, format="json")
        assert res.status_code == 200
        assert res.json()["title"] == "Renamed" and res.json()["revision"] == 1
        assert res.json()["document"] == design.document

    def test_starred_and_folder_do_not_bump_revision_or_updated_at(self, api, user):
        folder = Folder.objects.create(owner=user, name="F")
        design = make_design(user)
        before = Design.objects.get(pk=design.pk).updated_at
        res = api.patch(detail(design.pk), {"starred": True, "folder": str(folder.pk)}, format="json")
        assert res.json()["starred"] is True and res.json()["folder"] == str(folder.pk)
        fresh = Design.objects.get(pk=design.pk)
        assert fresh.revision == 1 and fresh.updated_at == before
        assert api.patch(detail(design.pk), {"folder": None}, format="json").json()["folder"] is None

    def test_saving_a_document_bumps_revision_and_derives_facts(self, api, user):
        design = make_design(user)
        doc = make_doc(pages=4, width=500, height=700, meta={"presetId": "poster"})
        res = api.patch(detail(design.pk), {"document": doc, "base_revision": 1}, format="json")
        assert res.status_code == 200
        body = res.json()
        assert (body["revision"], body["width"], body["height"], body["page_count"]) == (2, 500, 700, 4)
        assert body["preset"] == "poster" and body["document"] == doc
        stored = Design.objects.get(pk=design.pk)
        assert stored.document == doc and stored.revision == 2

    def test_preset_follows_the_document(self, api, user):
        design = make_design(user, preset="poster")
        api.patch(detail(design.pk), {"document": make_doc(), "base_revision": 1}, format="json")
        assert Design.objects.get(pk=design.pk).preset == ""

    def test_document_requires_base_revision(self, api, user):
        design = make_design(user)
        res = api.patch(detail(design.pk), {"document": make_doc()}, format="json")
        assert res.status_code == 400 and "base_revision" in res.json()["error"]["fields"]

    def test_stale_base_revision_is_a_409_with_current_state(self, api, user):
        design = make_design(user)
        first = api.patch(
            detail(design.pk), {"document": make_doc(width=111), "base_revision": 1}, format="json"
        )
        assert first.status_code == 200
        second = api.patch(
            detail(design.pk), {"document": make_doc(width=222), "base_revision": 1}, format="json"
        )
        assert second.status_code == 409
        body = second.json()
        assert body["error"]["code"] == "revision_conflict"
        assert body["current"]["revision"] == 2 and body["current"]["updated_at"]
        stored = Design.objects.get(pk=design.pk)
        assert stored.document["width"] == 111 and stored.revision == 2

    def test_future_base_revision_is_also_a_conflict(self, api, user):
        design = make_design(user)
        res = api.patch(detail(design.pk), {"document": make_doc(), "base_revision": 7}, format="json")
        assert res.status_code == 409

    def test_chained_saves_with_the_returned_revision(self, api, user):
        design = make_design(user)
        revision = 1
        for width in (101, 102, 103):
            res = api.patch(
                detail(design.pk),
                {"document": make_doc(width=width), "base_revision": revision},
                format="json",
            )
            assert res.status_code == 200
            revision = res.json()["revision"]
        assert revision == 4

    def test_title_in_the_same_request_as_a_stale_document_changes_nothing(self, api, user):
        design = make_design(user, "Original")
        api.patch(detail(design.pk), {"document": make_doc(), "base_revision": 1}, format="json")
        res = api.patch(
            detail(design.pk), {"title": "Sneaky", "document": make_doc(), "base_revision": 1}, format="json"
        )
        assert res.status_code == 409
        assert Design.objects.get(pk=design.pk).title == "Original"

    def test_invalid_document_keeps_the_stored_one(self, api, user):
        design = make_design(user)
        res = api.patch(
            detail(design.pk),
            {"document": {"schemaVersion": 1, "pages": []}, "base_revision": 1},
            format="json",
        )
        assert res.status_code == 400 and res.json()["error"]["code"] == "invalid_document"
        assert Design.objects.get(pk=design.pk).document == design.document

    def test_local_references_rejected_on_save(self, api, user):
        design = make_design(user)
        doc = make_doc(objects=[image_object("blob:http://x/1")])
        res = api.patch(detail(design.pk), {"document": doc, "base_revision": 1}, format="json")
        assert res.status_code == 400 and res.json()["error"]["code"] == "inline_asset_not_allowed"

    def test_oversized_document_is_413(self, api, user, settings):
        design = make_design(user)
        settings.MAX_DESIGN_DOCUMENT_BYTES = 1_000
        res = api.patch(
            detail(design.pk),
            {"document": make_doc(objects=[text_object("y" * 3000)]), "base_revision": 1},
            format="json",
        )
        assert res.status_code == 413

    def test_trashed_designs_are_read_only(self, api, user):
        design = make_design(user, trashed_at=timezone.now())
        for payload in ({"title": "x"}, {"starred": True}, {"document": make_doc(), "base_revision": 1}):
            res = api.patch(detail(design.pk), payload, format="json")
            assert res.status_code == 409 and res.json()["error"]["code"] == "design_trashed"

    def test_cannot_move_into_someone_elses_folder(self, api, user, other):
        design = make_design(user)
        theirs = Folder.objects.create(owner=other, name="Theirs")
        res = api.patch(detail(design.pk), {"folder": str(theirs.pk)}, format="json")
        assert res.status_code == 400 and "folder" in res.json()["error"]["fields"]

    def test_mass_assignment_is_ignored(self, api, user, other):
        design = make_design(user)
        res = api.patch(
            detail(design.pk),
            {
                "title": "ok",
                "owner": str(other.pk),
                "revision": 50,
                "width": 1,
                "page_count": 9,
                "trashed_at": "2020-01-01T00:00:00Z",
                "preset": "x",
            },
            format="json",
        )
        assert res.status_code == 200
        fresh = Design.objects.get(pk=design.pk)
        assert (fresh.owner, fresh.revision, fresh.width, fresh.page_count, fresh.trashed_at) == (
            user,
            1,
            800,
            1,
            None,
        )

    def test_other_users_design_is_404_and_untouched(self, api, other_api, user):
        design = make_design(user, "Mine")
        res = other_api.patch(detail(design.pk), {"title": "Hijacked"}, format="json")
        assert res.status_code == 404
        res = other_api.patch(detail(design.pk), {"document": make_doc(), "base_revision": 1}, format="json")
        assert res.status_code == 404
        assert Design.objects.get(pk=design.pk).title == "Mine"

    def test_empty_patch_is_a_noop(self, api, user):
        design = make_design(user)
        assert api.patch(detail(design.pk), {}, format="json").status_code == 200

    def test_put_is_not_allowed(self, api, user):
        assert api.put(detail(make_design(user).pk), {"title": "x"}, format="json").status_code == 405

    def test_title_with_control_characters_is_cleaned(self, api, user):
        design = make_design(user)
        res = api.patch(detail(design.pk), {"title": "Hel\x07lo‮  World"}, format="json")
        assert res.json()["title"] == "Hello World"

    def test_save_query_count_is_small(self, api, user, django_assert_max_num_queries):
        design = make_design(user)
        with django_assert_max_num_queries(12):
            assert (
                api.patch(
                    detail(design.pk), {"document": make_doc(), "base_revision": 1}, format="json"
                ).status_code
                == 200
            )


@pytest.mark.django_db
class TestDuplicate:
    def test_duplicate_copies_document_and_folder(self, api, user):
        folder = Folder.objects.create(owner=user, name="F")
        doc = make_doc(pages=2, objects=[text_object("copy me")])
        design = make_design(user, "Logo", document=doc, folder=folder, starred=True, preset="poster")
        res = api.post(f"{detail(design.pk)}duplicate/")
        assert res.status_code == 201
        body = res.json()
        assert body["id"] != str(design.pk) and body["title"] == "Copy of Logo"
        assert body["document"] == doc and body["folder"] == str(folder.pk)
        assert (body["revision"], body["starred"], body["page_count"], body["preset"]) == (
            1,
            False,
            2,
            "poster",
        )

    def test_duplicate_title_is_capped(self, api, user):
        design = make_design(user, "t" * 200)
        assert len(api.post(f"{detail(design.pk)}duplicate/").json()["title"]) == 200

    def test_duplicate_copies_the_thumbnail_file(self, api, user):
        design = make_design(user)
        api.put(
            f"{detail(design.pk)}thumbnail/",
            {"image": upload(image_bytes("PNG", (600, 400)))},
            format="multipart",
        )
        copy = api.post(f"{detail(design.pk)}duplicate/").json()
        original = Design.objects.get(pk=design.pk)
        duplicate = Design.objects.get(pk=copy["id"])
        assert duplicate.thumbnail.name != original.thumbnail.name
        assert (
            Path(default_storage.path(duplicate.thumbnail.name)).read_bytes()
            == Path(default_storage.path(original.thumbnail.name)).read_bytes()
        )

    def test_duplicate_is_owner_only_and_not_for_trashed(self, api, other_api, user):
        design = make_design(user)
        assert other_api.post(f"{detail(design.pk)}duplicate/").status_code == 404
        trashed = make_design(user, trashed_at=timezone.now())
        assert api.post(f"{detail(trashed.pk)}duplicate/").status_code == 409
        assert Design.objects.count() == 2

    def test_duplicate_respects_the_design_limit(self, api, user, settings):
        design = make_design(user)
        settings.MAX_DESIGNS_PER_USER = 1
        assert api.post(f"{detail(design.pk)}duplicate/").status_code == 409


@pytest.mark.django_db
class TestThumbnail:
    def put(self, api, design, data, name="t.png"):
        return api.put(f"{detail(design.pk)}thumbnail/", {"image": upload(data, name)}, format="multipart")

    def test_thumbnail_is_converted_to_480px_webp(self, api, user):
        design = make_design(user)
        res = self.put(api, design, image_bytes("PNG", (1600, 800)))
        assert res.status_code == 200
        url = res.json()["thumbnail_url"]
        assert url.endswith(".webp")
        stored = Design.objects.get(pk=design.pk)
        with Image.open(default_storage.path(stored.thumbnail.name)) as img:
            assert img.format == "WEBP" and max(img.size) == 480
        assert api.get(detail(design.pk)).json()["thumbnail_url"] == url
        assert api.get(URL).json()["results"][0]["thumbnail_url"] == url

    def test_replacing_removes_the_old_file_and_changes_the_url(
        self, api, user, django_capture_on_commit_callbacks
    ):
        design = make_design(user)
        first = self.put(api, design, image_bytes()).json()["thumbnail_url"]
        old_path = Path(default_storage.path(Design.objects.get(pk=design.pk).thumbnail.name))
        with django_capture_on_commit_callbacks(execute=True):
            second = self.put(api, design, image_bytes("JPEG")).json()["thumbnail_url"]
        assert first != second and not old_path.exists()

    @pytest.mark.parametrize(
        "payload", [b"<svg xmlns='http://www.w3.org/2000/svg'/>", b"<?php evil ?>", b"not an image", b""]
    )
    def test_non_images_are_rejected(self, api, user, payload):
        assert self.put(api, make_design(user), payload).status_code == 400

    def test_oversize_thumbnail_is_413(self, api, user):
        import os

        from PIL import Image as PILImage

        big = PILImage.frombytes("RGB", (900, 900), os.urandom(900 * 900 * 3))
        from io import BytesIO

        buf = BytesIO()
        big.save(buf, "PNG")
        assert len(buf.getvalue()) > 2 * 1024 * 1024
        res = self.put(api, make_design(user), buf.getvalue())
        assert res.status_code == 413 and res.json()["error"]["code"] == "file_too_large"

    def test_declared_length_checked_up_front(self, api, user):
        design = make_design(user)
        res = api.put(
            f"{detail(design.pk)}thumbnail/",
            {"image": upload(image_bytes())},
            format="multipart",
            CONTENT_LENGTH=str(100 * 1024 * 1024),
        )
        assert res.status_code == 413

    def test_missing_field_is_a_400(self, api, user):
        design = make_design(user)
        res = api.put(f"{detail(design.pk)}thumbnail/", {"file": upload(image_bytes())}, format="multipart")
        assert res.status_code == 400 and "image" in res.json()["error"]["fields"]

    def test_owner_only_and_not_for_trashed(self, api, other_api, user):
        design = make_design(user)
        assert self.put(other_api, design, image_bytes()).status_code == 404
        trashed = make_design(user, trashed_at=timezone.now())
        assert self.put(api, trashed, image_bytes()).status_code == 409
