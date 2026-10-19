import pytest
from django.urls import reverse

from apps.accounts.models import User


@pytest.fixture
def staff_client(client, db):
    admin = User.objects.create_superuser("root@example.com", "root-pass-12345")
    client.force_login(admin)
    return client


def test_share_link_admin_hides_secrets(staff_client, make_link):
    link = make_link("edit", password="topsecret")
    changelist = staff_client.get(reverse("admin:sharing_sharelink_changelist"))
    assert changelist.status_code == 200
    change = staff_client.get(reverse("admin:sharing_sharelink_change", args=[link.pk]))
    assert change.status_code == 200
    content = change.content.decode()
    assert link.token not in content
    assert link.password_hash not in content


def test_share_links_cannot_be_created_in_admin(staff_client):
    assert staff_client.get(reverse("admin:sharing_sharelink_add")).status_code == 403


def test_staff_can_switch_a_link_off(staff_client, make_link):
    link = make_link("view")
    url = reverse("admin:sharing_sharelink_change", args=[link.pk])
    staff_client.post(url, {"is_active": ""})
    link.refresh_from_db()
    assert link.is_active is False


def test_comment_admin_is_read_only_but_deletable(staff_client, make_comment, stranger):
    comment = make_comment(stranger, "moderate me")
    assert staff_client.get(reverse("admin:sharing_comment_changelist")).status_code == 200
    assert staff_client.get(reverse("admin:sharing_comment_add")).status_code == 403
    delete = staff_client.post(reverse("admin:sharing_comment_delete", args=[comment.pk]), {"post": "yes"})
    assert delete.status_code == 302
    assert not type(comment).objects.exists()
