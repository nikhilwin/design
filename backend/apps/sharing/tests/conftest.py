from datetime import timedelta

import pytest
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.designs.models import Design
from apps.sharing.models import Comment, ShareLink

PASSWORD = "correct horse"


def make_document(pages: int = 1, width: int = 800, height: int = 600, **extra) -> dict:
    return {
        "schemaVersion": 1,
        "width": width,
        "height": height,
        "unit": "px",
        "pages": [
            {
                "id": f"00000000-0000-4000-8000-{index:012d}",
                "background": {"type": "solid", "color": "#ffffff"},
                "objects": [],
            }
            for index in range(pages)
        ],
        **extra,
    }


@pytest.fixture(autouse=True)
def _fresh_cache():
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def owner(db) -> User:
    return User.objects.create_user("owner@example.com", "owner-pass-123", display_name="Olive Owner")


@pytest.fixture
def stranger(db) -> User:
    return User.objects.create_user("stranger@example.com", "stranger-pass-123", display_name="Sam Stranger")


@pytest.fixture
def design(owner) -> Design:
    return Design.objects.create(
        owner=owner, title="Summer poster", width=800, height=600, document=make_document()
    )


@pytest.fixture
def anon(db) -> APIClient:
    return APIClient()


@pytest.fixture
def owner_client(owner) -> APIClient:
    client = APIClient()
    client.force_authenticate(owner)
    return client


@pytest.fixture
def stranger_client(stranger) -> APIClient:
    client = APIClient()
    client.force_authenticate(stranger)
    return client


@pytest.fixture
def make_link(design, owner):
    def factory(role="view", password: str | None = None, **fields) -> ShareLink:
        link = ShareLink(design=design, role=role, created_by=owner, **fields)
        link.set_password(password)
        link.save()
        return link

    return factory


@pytest.fixture
def view_link(make_link) -> ShareLink:
    return make_link("view")


@pytest.fixture
def comment_link(make_link) -> ShareLink:
    return make_link("comment")


@pytest.fixture
def edit_link(make_link) -> ShareLink:
    return make_link("edit")


@pytest.fixture
def make_comment(design):
    def factory(author, body="Looks great", **fields) -> Comment:
        return Comment.objects.create(design=design, author=author, body=body, **fields)

    return factory


def past(hours: int = 1):
    return timezone.now() - timedelta(hours=hours)


def future(hours: int = 1):
    return timezone.now() + timedelta(hours=hours)
