import pytest
from rest_framework.test import APIClient

from apps.accounts.models import User


@pytest.fixture
def client():
    return APIClient()


@pytest.fixture
def user(db):
    return User.objects.create_user(email="maker@example.com", password="pw-12345-abc")


@pytest.fixture
def auth_client(user):
    api = APIClient()
    api.force_authenticate(user)
    return api


@pytest.fixture
def staff_client(db):
    from django.test import Client

    staff = User.objects.create_superuser(email="staff@example.com", password="pw-12345-abc")
    web = Client()
    web.force_login(staff)
    return web


@pytest.fixture(autouse=True)
def _fresh_throttle_cache():
    from django.core.cache import cache

    cache.clear()
    yield
    cache.clear()


@pytest.fixture(autouse=True)
def _isolated_media_root(settings, tmp_path_factory):
    """Every test gets its own empty MEDIA_ROOT, so stored-file assertions never see other tests' files."""
    settings.MEDIA_ROOT = tmp_path_factory.mktemp("media")
