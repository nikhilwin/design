from __future__ import annotations

import pytest
from django.urls import reverse

from apps.accounts.models import User

from .conftest import PASSWORD, png_upload

pytestmark = pytest.mark.django_db

CHANGELIST = "admin:accounts_user_changelist"


@pytest.fixture
def admin_client(client, make_user):
    admin = make_user("root@example.com", is_staff=True, is_superuser=True, is_email_verified=True)
    client.force_login(admin)
    client.admin = admin
    return client


def test_admin_requires_staff(client, user):
    client.force_login(user)
    res = client.get(reverse(CHANGELIST))
    assert res.status_code == 302 and "/admin/login/" in res["Location"]


def test_admin_login_accepts_mixed_case_email(client, make_user):
    make_user("root@example.com", is_staff=True, is_superuser=True)
    res = client.post(
        "/admin/login/?next=/admin/",
        {"username": "ROOT@Example.com", "password": PASSWORD},
    )
    assert res.status_code == 302 and res["Location"] == "/admin/"


def test_changelist_search_and_filters(admin_client, make_user):
    make_user("grace@example.com", display_name="Grace Hopper")
    url = reverse(CHANGELIST)
    assert admin_client.get(url).status_code == 200
    found = admin_client.get(url, {"q": "hopper"})
    assert found.status_code == 200
    assert b"grace@example.com" in found.content and b"ada@example.com" not in found.content
    for query in ({"is_active__exact": "1"}, {"is_email_verified__exact": "0"}, {"is_staff__exact": "1"}):
        assert admin_client.get(url, query).status_code == 200


def test_add_page_and_creation(admin_client):
    url = reverse("admin:accounts_user_add")
    assert admin_client.get(url).status_code == 200
    res = admin_client.post(
        url,
        {
            "email": "Fresh@Example.com",
            "display_name": "Fresh",
            "usable_password": "true",
            "password1": PASSWORD,
            "password2": PASSWORD,
        },
    )
    assert res.status_code == 302
    created = User.objects.get(email="fresh@example.com")
    assert created.check_password(PASSWORD)


def test_change_page_shows_readonly_fields_and_avatar(admin_client, user):
    user.avatar.save("a.webp", png_upload((8, 8)), save=True)
    res = admin_client.get(reverse("admin:accounts_user_change", args=[user.pk]))
    assert res.status_code == 200
    body = res.content.decode()
    assert user.avatar.url in body
    assert "Created at" in body and "Last login" in body


def test_change_page_without_avatar(admin_client, user):
    assert admin_client.get(reverse("admin:accounts_user_change", args=[user.pk])).status_code == 200


def test_edit_user_through_admin(admin_client, user):
    url = reverse("admin:accounts_user_change", args=[user.pk])
    form = {
        "email": user.email,
        "password": user.password,
        "display_name": "Edited",
        "is_active": "on",
    }
    res = admin_client.post(url, form)
    assert res.status_code == 302
    user.refresh_from_db()
    assert user.display_name == "Edited"


def post_action(admin_client, action: str, *users: User):
    return admin_client.post(
        reverse(CHANGELIST),
        {"action": action, "_selected_action": [str(u.pk) for u in users]},
        follow=True,
    )


def test_action_mark_verified(admin_client, user, make_user):
    other = make_user("grace@example.com")
    res = post_action(admin_client, "mark_verified", user, other)
    assert res.status_code == 200
    assert User.objects.filter(is_email_verified=True, email__in=[user.email, other.email]).count() == 2


def test_action_deactivate_and_activate(admin_client, user):
    post_action(admin_client, "deactivate_users", user)
    user.refresh_from_db()
    assert user.is_active is False
    post_action(admin_client, "activate_users", user)
    user.refresh_from_db()
    assert user.is_active is True


def test_deactivate_never_locks_out_the_acting_admin(admin_client):
    post_action(admin_client, "deactivate_users", admin_client.admin)
    admin_client.admin.refresh_from_db()
    assert admin_client.admin.is_active is True


def test_admin_password_page_renders(admin_client, user):
    url = reverse("admin:auth_user_password_change", args=[user.pk])
    assert admin_client.get(url).status_code == 200
