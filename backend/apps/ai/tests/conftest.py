from __future__ import annotations

import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.ai import catalog
from apps.ai.models import Provider
from apps.ai.tasks import TASKS, Task
from apps.assets.services import create_asset
from apps.assets.tests.helpers import image_bytes

from .fakes import FakeServer

PASSWORD = "correct-horse-battery-1"


@pytest.fixture(autouse=True)
def _clean_cache():
    cache.clear()
    yield
    cache.clear()


@pytest.fixture(autouse=True)
def _no_device_model(monkeypatch):
    """No in-browser model is installed in the tests unless a test says so."""
    monkeypatch.setattr(catalog, "device_available", lambda task: False)


@pytest.fixture
def user(db):
    return User.objects.create_user(email="alice@example.com", password=PASSWORD)


@pytest.fixture
def other(db):
    return User.objects.create_user(email="bob@example.com", password=PASSWORD)


@pytest.fixture
def staff(db):
    return User.objects.create_user(email="staff@example.com", password=PASSWORD, is_staff=True)


def client_for(user) -> APIClient:
    client = APIClient()
    client.force_authenticate(user)
    return client


@pytest.fixture
def api(user):
    return client_for(user)


@pytest.fixture
def other_api(other):
    return client_for(other)


@pytest.fixture
def fake():
    server = FakeServer().start()
    yield server
    server.stop()


@pytest.fixture
def photo(user):
    return create_asset(user, image_bytes(size=(64, 32)), name="photo.png")


def make_provider(
    base_url: str, style: str = "multipart", *, owner=None, secret: str = "", **fields
) -> Provider:
    fields.setdefault("tasks", ["background-removal"])
    fields.setdefault("name", f"{style} provider")
    provider = Provider(owner=owner, base_url=base_url, style=style, **fields)
    provider.set_secret(secret)
    provider.save()
    return provider


@pytest.fixture
def register_task(monkeypatch):
    """Add a task for one test only (the real registry is restored afterwards)."""

    def register(task_id: str, **fields) -> Task:
        fields.setdefault("label", task_id)
        fields.setdefault("output", "image-alpha")
        fields.setdefault("result_suffix", task_id)
        task = Task(id=task_id, **fields)
        monkeypatch.setitem(TASKS, task_id, task)
        return task

    return register
