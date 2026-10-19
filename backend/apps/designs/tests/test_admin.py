import pytest
from django.test import Client
from django.utils import timezone

from apps.accounts.models import User
from apps.designs.models import Design, DesignVersion, Folder

from .helpers import make_design, make_doc, text_object


@pytest.fixture
def staff_client(db):
    admin = User.objects.create_superuser(email="root@example.com", password="correct-horse-battery-1")
    client = Client()
    client.force_login(admin)
    return client


@pytest.mark.django_db
class TestAdmin:
    def test_changelists_render_with_filters_and_search(self, staff_client, user):
        make_design(user, "Birthday card")
        make_design(user, "Gone", trashed_at=timezone.now())
        for model in ("design", "designversion", "folder"):
            assert staff_client.get(f"/admin/designs/{model}/").status_code == 200
        res = staff_client.get("/admin/designs/design/", {"trashed": "yes", "q": "Gone"})
        assert res.status_code == 200 and b"Gone" in res.content
        res = staff_client.get("/admin/designs/design/", {"trashed": "no"})
        assert b"Birthday card" in res.content and b"Gone" not in res.content

    def test_design_page_shows_the_document_read_only(self, staff_client, user):
        design = make_design(user, "Doc", document=make_doc(objects=[text_object("visible-marker")]))
        res = staff_client.get(f"/admin/designs/design/{design.pk}/change/")
        assert res.status_code == 200
        assert b"visible-marker" in res.content
        assert b'name="document"' not in res.content and b"<textarea" not in res.content

    def test_document_html_is_escaped(self, staff_client, user):
        design = make_design(user, document=make_doc(objects=[text_object("<script>alert(1)</script>")]))
        res = staff_client.get(f"/admin/designs/design/{design.pk}/change/")
        assert b"<script>alert(1)</script>" not in res.content and b"&lt;script&gt;" in res.content

    def test_saving_from_admin_cannot_change_the_document(self, staff_client, user):
        design = make_design(user, "Before", document=make_doc(width=640))
        res = staff_client.post(
            f"/admin/designs/design/{design.pk}/change/",
            {"title": "After", "document": '{"hacked": true}', "revision": 99},
        )
        assert res.status_code in (200, 302)
        fresh = Design.objects.get(pk=design.pk)
        assert fresh.document["width"] == 640 and fresh.revision == 1

    def test_admin_cannot_add_designs(self, staff_client):
        assert staff_client.get("/admin/designs/design/add/").status_code == 403

    def test_trash_actions(self, staff_client, user):
        design = make_design(user)
        staff_client.post(
            "/admin/designs/design/", {"action": "move_to_trash", "_selected_action": [str(design.pk)]}
        )
        assert Design.objects.get(pk=design.pk).trashed_at is not None
        staff_client.post(
            "/admin/designs/design/", {"action": "restore_from_trash", "_selected_action": [str(design.pk)]}
        )
        assert Design.objects.get(pk=design.pk).trashed_at is None

    def test_version_and_folder_pages(self, staff_client, user):
        design = make_design(user)
        version = DesignVersion.objects.create(
            design=design, document=make_doc(objects=[text_object("v-marker")])
        )
        folder = Folder.objects.create(owner=user, name="Clients")
        res = staff_client.get(f"/admin/designs/designversion/{version.pk}/change/")
        assert res.status_code == 200 and b"v-marker" in res.content
        assert staff_client.get(f"/admin/designs/folder/{folder.pk}/change/").status_code == 200
        assert staff_client.get("/admin/designs/designversion/add/").status_code == 403

    def test_non_staff_are_redirected_to_login(self, user):
        client = Client()
        client.force_login(user)
        assert client.get("/admin/designs/design/").status_code == 302
