import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from django.core.files.storage import default_storage
from django.utils import timezone

from apps.assets.tests.helpers import image_bytes, upload
from apps.designs import services
from apps.designs.models import Design, DesignVersion

from .helpers import make_design, make_doc, text_object

URL = "/api/v1/designs/"


def versions_url(design_id) -> str:
    return f"{URL}{design_id}/versions/"


def save(api, design_id, revision, **doc_kwargs):
    return api.patch(
        f"{URL}{design_id}/", {"document": make_doc(**doc_kwargs), "base_revision": revision}, format="json"
    )


def age_versions(design_id, minutes: int) -> None:
    DesignVersion.objects.filter(design_id=design_id).update(
        created_at=timezone.now() - timedelta(minutes=minutes)
    )


@pytest.mark.django_db
class TestAutoVersioning:
    def test_first_document_save_records_a_version_of_the_saved_document(self, api, user):
        design = make_design(user)
        assert save(api, design.pk, 1, width=321).status_code == 200
        (version,) = DesignVersion.objects.filter(design=design)
        assert version.is_auto and version.document["width"] == 321 and version.created_by == user

    def test_saves_inside_the_ten_minute_window_do_not_add_versions(self, api, user):
        design = make_design(user)
        save(api, design.pk, 1)
        for revision in (2, 3, 4):
            save(api, design.pk, revision)
        assert DesignVersion.objects.filter(design=design).count() == 1

    def test_a_save_after_ten_minutes_adds_a_version(self, api, user):
        design = make_design(user)
        save(api, design.pk, 1)
        age_versions(design.pk, 11)
        save(api, design.pk, 2)
        assert DesignVersion.objects.filter(design=design).count() == 2

    def test_just_under_ten_minutes_does_not(self, api, user):
        design = make_design(user)
        save(api, design.pk, 1)
        age_versions(design.pk, 9)
        save(api, design.pk, 2)
        assert DesignVersion.objects.filter(design=design).count() == 1

    def test_title_and_folder_patches_never_create_versions(self, api, user):
        design = make_design(user)
        api.patch(f"{URL}{design.pk}/", {"title": "x", "starred": True}, format="json")
        assert DesignVersion.objects.count() == 0

    def test_failed_saves_create_no_versions(self, api, user):
        design = make_design(user)
        assert save(api, design.pk, 9).status_code == 409
        assert (
            api.patch(
                f"{URL}{design.pk}/", {"document": {"bad": 1}, "base_revision": 1}, format="json"
            ).status_code
            == 400
        )
        assert DesignVersion.objects.count() == 0

    def test_only_the_newest_fifty_auto_versions_are_kept(self, api, user):
        design = make_design(user)
        now = timezone.now()
        for i in range(55):
            DesignVersion.objects.create(
                design=design, document=make_doc(width=100 + i), is_auto=True, label=f"auto-{i}"
            )
            DesignVersion.objects.filter(label=f"auto-{i}").update(created_at=now - timedelta(hours=100 - i))
        save(api, design.pk, 1, width=999)
        autos = DesignVersion.objects.filter(design=design, is_auto=True)
        assert autos.count() == 50
        assert not autos.filter(label__in=[f"auto-{i}" for i in range(0, 6)]).exists()
        assert autos.filter(document__width=999).exists()

    def test_manual_versions_are_never_pruned(self, api, user):
        design = make_design(user)
        now = timezone.now()
        for i in range(60):
            DesignVersion.objects.create(
                design=design, document=make_doc(), is_auto=False, label=f"manual-{i}"
            )
            DesignVersion.objects.filter(label=f"manual-{i}").update(created_at=now - timedelta(days=200 - i))
        for i in range(52):
            DesignVersion.objects.create(design=design, document=make_doc(), is_auto=True, label=f"auto-{i}")
            DesignVersion.objects.filter(label=f"auto-{i}").update(created_at=now - timedelta(days=100 - i))
        save(api, design.pk, 1)
        assert DesignVersion.objects.filter(design=design, is_auto=False).count() == 60
        assert DesignVersion.objects.filter(design=design, is_auto=True).count() == 50

    def test_pruning_is_per_design(self, api, user):
        design, other_design = make_design(user), make_design(user)
        for _ in range(51):
            DesignVersion.objects.create(design=other_design, document=make_doc(), is_auto=True)
        save(api, design.pk, 1)
        assert DesignVersion.objects.filter(design=other_design).count() == 51

    def test_pruned_versions_lose_their_thumbnails(self, api, user, django_capture_on_commit_callbacks):
        design = make_design(user)
        api.put(f"{URL}{design.pk}/thumbnail/", {"image": upload(image_bytes())}, format="multipart")
        oldest = services._record_version(
            Design.objects.get(pk=design.pk), user, is_auto=True, label="oldest"
        )
        DesignVersion.objects.filter(pk=oldest.pk).update(created_at=timezone.now() - timedelta(days=30))
        path = Path(default_storage.path(oldest.thumbnail.name))
        assert path.exists()
        for _ in range(50):
            DesignVersion.objects.create(design=design, document=make_doc(), is_auto=True)
        DesignVersion.objects.exclude(pk=oldest.pk).update(created_at=timezone.now() - timedelta(minutes=11))
        with django_capture_on_commit_callbacks(execute=True):
            save(api, design.pk, 1)
        assert not DesignVersion.objects.filter(pk=oldest.pk).exists() and not path.exists()


@pytest.mark.django_db
class TestManualVersions:
    def test_create_and_list(self, api, user):
        design = make_design(user, document=make_doc(pages=2))
        res = api.post(versions_url(design.pk), {"label": "  Before client review  "}, format="json")
        assert res.status_code == 201
        body = res.json()
        assert set(body) == {"id", "label", "is_auto", "page_count", "thumbnail_url", "created_at"}
        assert (body["label"], body["is_auto"], body["page_count"]) == ("Before client review", False, 2)
        listing = api.get(versions_url(design.pk)).json()
        assert listing["count"] == 1 and listing["results"][0]["id"] == body["id"]
        assert "document" not in listing["results"][0]

    def test_label_defaults_and_is_validated(self, api, user):
        design = make_design(user)
        assert api.post(versions_url(design.pk), {}, format="json").json()["label"] == "Saved version"
        assert (
            api.post(versions_url(design.pk), {"label": "  "}, format="json").json()["label"]
            == "Saved version"
        )
        res = api.post(versions_url(design.pk), {"label": "x" * 121}, format="json")
        assert res.status_code == 400 and "label" in res.json()["error"]["fields"]

    def test_manual_version_snapshots_the_current_document(self, api, user):
        design = make_design(user, document=make_doc(objects=[text_object("v1")]))
        version = api.post(versions_url(design.pk), {"label": "v1"}, format="json").json()
        save(api, design.pk, 1, objects=[text_object("v2")])
        detail = api.get(f"{versions_url(design.pk)}{version['id']}/").json()
        assert detail["document"]["pages"][0]["objects"][0]["text"] == "v1"

    def test_manual_versions_have_a_cap(self, api, user, monkeypatch):
        monkeypatch.setattr(services, "MAX_MANUAL_VERSIONS", 2)
        design = make_design(user)
        assert api.post(versions_url(design.pk), {"label": "a"}, format="json").status_code == 201
        assert api.post(versions_url(design.pk), {"label": "b"}, format="json").status_code == 201
        res = api.post(versions_url(design.pk), {"label": "c"}, format="json")
        assert res.status_code == 409 and res.json()["error"]["code"] == "limit_reached"

    def test_list_is_newest_first_and_paginated(self, api, user):
        design = make_design(user)
        for i in range(3):
            api.post(versions_url(design.pk), {"label": f"v{i}"}, format="json")
            DesignVersion.objects.filter(label=f"v{i}").update(
                created_at=timezone.now() - timedelta(hours=10 - i)
            )
        body = api.get(versions_url(design.pk), {"page_size": 2}).json()
        assert [v["label"] for v in body["results"]] == ["v2", "v1"] and body["count"] == 3 and body["next"]

    def test_list_query_count(self, api, user, django_assert_max_num_queries):
        design = make_design(user)
        for i in range(8):
            DesignVersion.objects.create(design=design, document=make_doc(), label=str(i))
        with django_assert_max_num_queries(3):
            assert api.get(versions_url(design.pk)).json()["count"] == 8

    def test_version_thumbnail_is_copied_from_the_design(self, api, user):
        design = make_design(user)
        api.put(f"{URL}{design.pk}/thumbnail/", {"image": upload(image_bytes())}, format="multipart")
        body = api.post(versions_url(design.pk), {"label": "with thumb"}, format="json").json()
        assert (
            body["thumbnail_url"]
            and body["thumbnail_url"] != api.get(f"{URL}{design.pk}/").json()["thumbnail_url"]
        )

    def test_trashed_design_cannot_get_versions(self, api, user):
        design = make_design(user, trashed_at=timezone.now())
        assert api.post(versions_url(design.pk), {"label": "x"}, format="json").status_code == 409
        assert api.get(versions_url(design.pk)).status_code == 200


@pytest.mark.django_db
class TestRestore:
    def test_restore_snapshots_current_then_applies_the_version(self, api, user):
        design = make_design(user, document=make_doc(width=100, objects=[text_object("old")]))
        version = api.post(versions_url(design.pk), {"label": "old"}, format="json").json()
        saved = save(api, design.pk, 1, width=200, pages=3, objects=[text_object("new")])
        assert saved.status_code == 200
        before = DesignVersion.objects.filter(design=design).count()
        res = api.post(f"{versions_url(design.pk)}{version['id']}/restore/")
        assert res.status_code == 200
        body = res.json()
        assert (body["revision"], body["width"], body["page_count"]) == (3, 100, 1)
        assert body["document"]["pages"][0]["objects"][0]["text"] == "old"
        assert DesignVersion.objects.filter(design=design).count() == before + 1
        snapshot = DesignVersion.objects.filter(design=design, label="Before restore").get()
        assert snapshot.is_auto and snapshot.document["width"] == 200 and snapshot.page_count == 3

    def test_restore_bumps_revision_so_stale_clients_conflict(self, api, user):
        design = make_design(user)
        version = api.post(versions_url(design.pk), {"label": "x"}, format="json").json()
        api.post(f"{versions_url(design.pk)}{version['id']}/restore/")
        assert save(api, design.pk, 1).status_code == 409
        assert save(api, design.pk, 2).status_code == 200

    def test_a_restore_can_itself_be_undone(self, api, user):
        design = make_design(user, document=make_doc(width=100))
        first = api.post(versions_url(design.pk), {"label": "w100"}, format="json").json()
        save(api, design.pk, 1, width=555)
        api.post(f"{versions_url(design.pk)}{first['id']}/restore/")
        snapshot = DesignVersion.objects.get(design=design, label="Before restore")
        res = api.post(f"{versions_url(design.pk)}{snapshot.pk}/restore/")
        assert res.json()["width"] == 555

    def test_restoring_an_invalid_stored_document_is_refused(self, api, user):
        design = make_design(user)
        broken = DesignVersion.objects.create(design=design, document={"schemaVersion": 1, "pages": "nope"})
        res = api.post(f"{versions_url(design.pk)}{broken.pk}/restore/")
        assert res.status_code == 400 and res.json()["error"]["code"] == "invalid_document"
        assert Design.objects.get(pk=design.pk).revision == 1
        assert not DesignVersion.objects.filter(label="Before restore").exists()

    def test_restoring_a_version_with_local_references_is_refused(self, api, user):
        design = make_design(user)
        bad = make_doc(objects=[{"id": "i", "type": "image", "src": "idb://x"}])
        version = DesignVersion.objects.create(design=design, document=bad)
        res = api.post(f"{versions_url(design.pk)}{version.pk}/restore/")
        assert res.status_code == 400 and res.json()["error"]["code"] == "inline_asset_not_allowed"

    def test_trashed_design_cannot_be_restored_to_a_version(self, api, user):
        design = make_design(user, trashed_at=timezone.now())
        version = DesignVersion.objects.create(design=design, document=make_doc())
        assert api.post(f"{versions_url(design.pk)}{version.pk}/restore/").status_code == 409

    def test_restore_prunes_to_the_cap(self, api, user):
        design = make_design(user)
        for _ in range(50):
            DesignVersion.objects.create(design=design, document=make_doc(), is_auto=True)
        version = DesignVersion.objects.create(design=design, document=make_doc(), is_auto=False)
        api.post(f"{versions_url(design.pk)}{version.pk}/restore/")
        assert DesignVersion.objects.filter(design=design, is_auto=True).count() == 50


@pytest.mark.django_db
class TestVersionAuthorization:
    def test_other_users_endpoints_are_404(self, api, other_api, user):
        design = make_design(user)
        version = DesignVersion.objects.create(design=design, document=make_doc())
        base = versions_url(design.pk)
        assert other_api.get(base).status_code == 404
        assert other_api.post(base, {"label": "x"}, format="json").status_code == 404
        assert other_api.get(f"{base}{version.pk}/").status_code == 404
        assert other_api.post(f"{base}{version.pk}/restore/").status_code == 404
        assert Design.objects.get(pk=design.pk).revision == 1

    def test_a_version_of_another_design_is_not_reachable_through_mine(self, api, user):
        mine, also_mine = make_design(user), make_design(user)
        version = DesignVersion.objects.create(design=also_mine, document=make_doc())
        assert api.get(f"{versions_url(mine.pk)}{version.pk}/").status_code == 404
        assert api.post(f"{versions_url(mine.pk)}{version.pk}/restore/").status_code == 404

    def test_idor_across_users_via_version_id(self, api, other, user):
        theirs = make_design(other)
        version = DesignVersion.objects.create(design=theirs, document=make_doc())
        mine = make_design(user)
        assert api.get(f"{versions_url(mine.pk)}{version.pk}/").status_code == 404
        assert api.post(f"{versions_url(mine.pk)}{version.pk}/restore/").status_code == 404

    def test_unknown_ids_are_404(self, api, user):
        design = make_design(user)
        assert api.get(f"{versions_url(design.pk)}{uuid.uuid4()}/").status_code == 404
        assert api.get(versions_url(uuid.uuid4())).status_code == 404

    def test_requires_authentication(self, db, user):
        from rest_framework.test import APIClient

        design = make_design(user)
        assert APIClient().get(versions_url(design.pk)).status_code == 401
