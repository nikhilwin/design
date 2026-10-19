import pytest
from django.core.cache import cache


@pytest.fixture(autouse=True)
def _clear_cache():
    """Rate-limit and lockout counters live in the cache; never let them leak between tests."""
    cache.clear()
    yield
    cache.clear()
