import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from apps.accounts.models import User

PASSWORD = "correct-horse-battery-1"


@pytest.fixture(autouse=True)
def _clean_cache():
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def user(db):
    return User.objects.create_user(email="alice@example.com", password=PASSWORD)


@pytest.fixture
def other(db):
    return User.objects.create_user(email="bob@example.com", password=PASSWORD)


@pytest.fixture
def api(user):
    client = APIClient()
    client.force_authenticate(user)
    return client


@pytest.fixture
def other_api(other):
    client = APIClient()
    client.force_authenticate(other)
    return client
