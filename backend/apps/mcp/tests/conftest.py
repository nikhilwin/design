from __future__ import annotations

import pytest
from django.core.cache import cache

from apps.accounts.models import User
from apps.apitokens import services as tokens
from apps.apitokens.scopes import SCOPES
from apps.mcp import context

PASSWORD = "correct-horse-battery-1"


@pytest.fixture(autouse=True)
def _mcp_on(settings):
    settings.MCP_ENABLED = True  # the server is opt-in


@pytest.fixture(autouse=True)
def _clean_cache():
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def user(db):
    return User.objects.create_user(email="alice@example.com", password=PASSWORD, display_name="Alice")


@pytest.fixture
def other(db):
    return User.objects.create_user(email="bob@example.com", password=PASSWORD)


@pytest.fixture
def issued(user):
    return tokens.issue_token(user, name="Claude", scopes=list(SCOPES), expires_in_days=30)


@pytest.fixture
def as_caller(issued):
    """Run tool functions directly, as the holder of `issued`."""
    bound = context.bind(context.Caller(issued.token.owner, issued.token))
    yield issued
    context.unbind(bound)
