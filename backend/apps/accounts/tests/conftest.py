from __future__ import annotations

import re
from io import BytesIO
from urllib.parse import parse_qs, urlparse

import pytest
from django.core import mail
from django.core.files.uploadedfile import SimpleUploadedFile
from PIL import Image
from rest_framework.test import APIClient

from apps.accounts.models import User

PASSWORD = "plum-umbrella-ripple-47"
NEW_PASSWORD = "granite-lantern-meadow-82"

REGISTER = "/api/v1/auth/register/"
LOGIN = "/api/v1/auth/login/"
LOGOUT = "/api/v1/auth/logout/"
ME = "/api/v1/auth/me/"
CSRF = "/api/v1/auth/csrf/"
PASSWORD_CHANGE = "/api/v1/auth/password/change/"
PASSWORD_RESET = "/api/v1/auth/password/reset/"
PASSWORD_RESET_CONFIRM = "/api/v1/auth/password/reset/confirm/"
EMAIL_VERIFY = "/api/v1/auth/email/verify/"
EMAIL_RESEND = "/api/v1/auth/email/resend/"
GOOGLE = "/api/v1/auth/google/"


@pytest.fixture
def client() -> APIClient:
    return APIClient()


@pytest.fixture
def csrf_client() -> APIClient:
    """A client that enforces CSRF exactly like a browser."""
    return APIClient(enforce_csrf_checks=True)


@pytest.fixture
def make_user(db):
    def factory(email: str = "ada@example.com", password: str | None = PASSWORD, **extra) -> User:
        return User.objects.create_user(email, password, **extra)

    return factory


@pytest.fixture
def user(make_user) -> User:
    return make_user()


@pytest.fixture
def auth_client(client, user) -> APIClient:
    """A client logged in through the real login endpoint (so it owns a genuine session)."""
    res = client.post(LOGIN, {"email": user.email, "password": PASSWORD}, format="json")
    assert res.status_code == 200
    return client


def login_as(email: str, password: str = PASSWORD) -> APIClient:
    other = APIClient()
    res = other.post(LOGIN, {"email": email, "password": password}, format="json")
    assert res.status_code == 200, res.content
    return other


def png_upload(
    size: tuple[int, int] = (300, 100), name: str = "me.png", mode: str = "RGB"
) -> SimpleUploadedFile:
    buf = BytesIO()
    color = (225, 29, 72) if mode == "RGB" else (225, 29, 72, 120)
    Image.new(mode, size, color).save(buf, "PNG")
    return SimpleUploadedFile(name, buf.getvalue(), content_type="image/png")


def link_params(message: mail.EmailMessage) -> dict[str, str]:
    """`uid` / `token` from the first link in an email body."""
    url = re.search(r"https?://\S+", message.body).group(0)
    query = parse_qs(urlparse(url).query)
    return {key: values[0] for key, values in query.items()}


def last_email_params() -> dict[str, str]:
    return link_params(mail.outbox[-1])
