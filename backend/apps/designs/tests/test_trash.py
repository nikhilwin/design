import uuid
from datetime import timedelta
from io import StringIO
from pathlib import Path

import pytest
from django.core.files.storage import default_storage
from django.core.management import call_command
from django.core.management.base import CommandError
from django.utils import timezone

from apps.assets.tests.helpers import image_bytes, upload
from apps.designs.models import Design, DesignVersion, Folder

from .helpers import make_design, make_doc

URL = "/api/v1/designs/"


def detail(design_id) -> str:
    return f"{URL}{design_id}/"


def trash(owner, title="T", days_ago=0):
    return make_design(owner, title, trashed_at=timezone.now() - timedelta(days=days_ago))


@pytest.mark.django_db
class TestSoftDeleteAndRestore:
    def test_delete_moves_to_trash(self, api, user):
        design = make_design(user)
        assert api.delete(detail(design.pk)).status_code == 204
        assert Design.objects.get(pk=design.pk).trashed_at is not None
        assert api.get(URL).json()["count"] == 0
        assert api.get(URL, {"trashed": "true"}).json()["count"] == 1

    def test_deleting_twice_is_idempotent_and_keeps_the_first_timestamp(self, api, user):
        design = make_design(user)
        api.delete(detail(design.pk))
        first = Design.objects.get(pk=design.pk).trashed_at
        assert api.delete(detail(design.pk)).status_code == 204
        assert Design.objects.get(pk=design.pk).trashed_at == first

    def test_restore(self, api, user):
        design = trash(user)
        res = api.post(f"{detail(design.pk)}restore/")
        assert res.status_code == 200 and res.json()["trashed_at"] is None
        assert res.json()["document"] == design.document
        assert api.get(URL).json()["count"] == 1

    def test_restoring_a_live_design_is_harmless(self, api, user):
        design = make_design(user)
        assert api.post(f"{detail(design.pk)}restore/").status_code == 200

    def test_restored_design_is_editable_again(self, api, user):
        design = trash(user)
        assert api.patch(detail(design.pk), {"title": "x"}, format="json").status_code == 409
        api.post(f"{detail(design.pk)}restore/")
        assert api.patch(detail(design.pk), {"title": "x"}, format="json").status_code == 200

    def test_other_users_cannot_trash_or_restore(self, api, other_api, user):
        live, gone = make_design(user), trash(user)
        assert other_api.delete(detail(live.pk)).status_code == 404
        assert other_api.post(f"{detail(gone.pk)}restore/").status_code == 404
        assert Design.objects.get(pk=live.pk).trashed_at is None
        assert Design.objects.get(pk=gone.pk).trashed_at is not None


@pytest.mark.django_db
class TestPermanentDelete:
    def test_permanent_delete_requires_the_trash(self, api, user):
        design = make_design(user)
        res = api.delete(f"{detail(design.pk)}?permanent=true")
        assert res.status_code == 400 and res.json()["error"]["code"] == "not_in_trash"
        assert Design.objects.filter(pk=design.pk).exists()

    def test_permanent_delete_from_trash(self, api, user):
        design = trash(user)
        assert api.delete(f"{detail(design.pk)}?permanent=true").status_code == 204
        assert not Design.objects.filter(pk=design.pk).exists()
        assert api.get(detail(design.pk)).status_code == 404

    def test_permanent_delete_removes_versions_and_files(self, api, user, django_capture_on_commit_callbacks):
        design = make_design(user)
        api.put(f"{detail(design.pk)}thumbnail/", {"image": upload(image_bytes())}, format="multipart")
        version = api.post(f"{detail(design.pk)}versions/", {"label": "v"}, format="json").json()
        stored = Design.objects.get(pk=design.pk)
        version_row = DesignVersion.objects.get(pk=version["id"])
        paths = [
            Path(default_storage.path(stored.thumbnail.name)),
            Path(default_storage.path(version_row.thumbnail.name)),
        ]
        assert all(p.exists() for p in paths)
        api.delete(detail(design.pk))
        with django_capture_on_commit_callbacks(execute=True):
            api.delete(f"{detail(design.pk)}?permanent=true")
        assert not DesignVersion.objects.filter(design_id=design.pk).exists()
        assert not any(p.exists() for p in paths)

    def test_other_users_cannot_permanently_delete(self, api, other_api, user):
        design = trash(user)
        assert other_api.delete(f"{detail(design.pk)}?permanent=true").status_code == 404
        assert Design.objects.filter(pk=design.pk).exists()


@pytest.mark.django_db
class TestEmptyTrash:
    def test_empties_only_own_trash(self, api, user, other):
        trash(user), trash(user), make_design(user, "keep")
        theirs = trash(other)
        assert api.delete(f"{URL}trash/").status_code == 204
        assert [d.title for d in Design.objects.filter(owner=user)] == ["keep"]
        assert Design.objects.filter(pk=theirs.pk).exists()

    def test_empty_trash_when_empty(self, api):
        assert api.delete(f"{URL}trash/").status_code == 204


@pytest.mark.django_db
class TestBulk:
    def bulk(self, api, ids, action, **extra):
        return api.post(
            f"{URL}bulk/", {"ids": [str(i) for i in ids], "action": action, **extra}, format="json"
        )

    def test_trash_and_restore(self, api, user):
        a, b = make_design(user), make_design(user)
        assert self.bulk(api, [a.pk, b.pk], "trash").json() == {"affected": 2}
        assert Design.objects.filter(owner=user, trashed_at__isnull=False).count() == 2
        assert self.bulk(api, [a.pk], "restore").json() == {"affected": 1}
        assert Design.objects.get(pk=a.pk).trashed_at is None

    def test_trashing_twice_counts_only_changes(self, api, user):
        a = make_design(user)
        self.bulk(api, [a.pk], "trash")
        assert self.bulk(api, [a.pk], "trash").json() == {"affected": 0}

    def test_foreign_and_unknown_ids_are_never_touched_or_counted(self, api, user, other):
        mine, theirs = make_design(user), make_design(other)
        res = self.bulk(api, [mine.pk, theirs.pk, uuid.uuid4()], "trash")
        assert res.status_code == 200 and res.json() == {"affected": 1}
        assert Design.objects.get(pk=theirs.pk).trashed_at is None

    def test_bulk_delete_only_removes_trashed_designs(self, api, user):
        live, gone = make_design(user), trash(user)
        assert self.bulk(api, [live.pk, gone.pk], "delete").json() == {"affected": 1}
        assert Design.objects.filter(pk=live.pk).exists() and not Design.objects.filter(pk=gone.pk).exists()

    def test_bulk_delete_cannot_reach_other_users_trash(self, api, other):
        theirs = trash(other)
        assert self.bulk(api, [theirs.pk], "delete").json() == {"affected": 0}
        assert Design.objects.filter(pk=theirs.pk).exists()

    def test_star_and_unstar_skip_trashed_designs(self, api, user):
        live, gone = make_design(user), trash(user)
        assert self.bulk(api, [live.pk, gone.pk], "star").json() == {"affected": 1}
        assert Design.objects.get(pk=live.pk).starred and not Design.objects.get(pk=gone.pk).starred
        assert self.bulk(api, [live.pk], "unstar").json() == {"affected": 1}
        assert not Design.objects.get(pk=live.pk).starred

    def test_move_to_a_folder_and_back_to_the_top(self, api, user):
        folder = Folder.objects.create(owner=user, name="F")
        a, b = make_design(user), make_design(user)
        assert self.bulk(api, [a.pk, b.pk], "move", folder=str(folder.pk)).json() == {"affected": 2}
        assert Design.objects.get(pk=a.pk).folder == folder
        assert self.bulk(api, [a.pk], "move", folder=None).json() == {"affected": 1}
        assert Design.objects.get(pk=a.pk).folder is None

    def test_move_requires_the_folder_key(self, api, user):
        res = self.bulk(api, [make_design(user).pk], "move")
        assert res.status_code == 400 and "folder" in res.json()["error"]["fields"]

    def test_move_into_someone_elses_folder_is_refused(self, api, user, other):
        theirs = Folder.objects.create(owner=other, name="Theirs")
        design = make_design(user)
        res = self.bulk(api, [design.pk], "move", folder=str(theirs.pk))
        assert res.status_code == 400
        assert Design.objects.get(pk=design.pk).folder is None

    def test_move_does_not_move_trashed_designs(self, api, user):
        folder = Folder.objects.create(owner=user, name="F")
        gone = trash(user)
        assert self.bulk(api, [gone.pk], "move", folder=str(folder.pk)).json() == {"affected": 0}

    def test_duplicate_ids_are_counted_once(self, api, user):
        a = make_design(user)
        assert self.bulk(api, [a.pk, a.pk, a.pk], "trash").json() == {"affected": 1}

    @pytest.mark.parametrize(
        "payload",
        [
            {"ids": [], "action": "trash"},
            {"ids": ["not-a-uuid"], "action": "trash"},
            {"ids": [str(uuid.uuid4())], "action": "explode"},
            {"ids": [str(uuid.uuid4())]},
            {"action": "trash"},
            {"ids": "abc", "action": "trash"},
            {"ids": [str(uuid.uuid4()) for _ in range(201)], "action": "trash"},
        ],
    )
    def test_validation(self, api, payload):
        res = api.post(f"{URL}bulk/", payload, format="json")
        assert res.status_code == 400 and res.json()["error"]["code"] == "validation_error"

    def test_two_hundred_ids_are_allowed(self, api):
        ids = [str(uuid.uuid4()) for _ in range(200)]
        assert api.post(f"{URL}bulk/", {"ids": ids, "action": "trash"}, format="json").json() == {
            "affected": 0
        }

    def test_requires_authentication(self, db):
        from rest_framework.test import APIClient

        assert (
            APIClient().post(f"{URL}bulk/", {"ids": [], "action": "trash"}, format="json").status_code == 401
        )


@pytest.mark.django_db
class TestPurgeTrashCommand:
    def run(self, *args) -> str:
        out = StringIO()
        call_command("purge_trash", *args, stdout=out)
        return out.getvalue()

    def test_deletes_only_designs_trashed_over_thirty_days_ago(self, user, other):
        trash(user, "old", 31)
        recent, live = trash(user, "recent", 29), make_design(user, "live")
        old_other = trash(other, "old-other", 90)
        output = self.run()
        assert "Purged 2 design(s)" in output
        assert set(Design.objects.values_list("pk", flat=True)) == {recent.pk, live.pk}
        assert not Design.objects.filter(pk=old_other.pk).exists()

    def test_custom_days(self, user):
        trash(user, "a", 8), trash(user, "b", 3)
        self.run("--days", "7")
        assert [d.title for d in Design.objects.all()] == ["b"]

    def test_zero_days_purges_everything_in_the_trash(self, user):
        trash(user, "a", 0), make_design(user, "live")
        self.run("--days", "0")
        assert [d.title for d in Design.objects.all()] == ["live"]

    def test_negative_days_rejected(self, db):
        with pytest.raises(CommandError):
            self.run("--days", "-1")

    def test_cascades_versions_and_files(self, user, django_capture_on_commit_callbacks):
        design = trash(user, "old", 40)
        DesignVersion.objects.create(design=design, document=make_doc())
        with django_capture_on_commit_callbacks(execute=True):
            self.run()
        assert not Design.objects.exists() and not DesignVersion.objects.exists()

    def test_nothing_to_purge(self, user):
        make_design(user)
        assert "Purged 0 design(s)" in self.run()
