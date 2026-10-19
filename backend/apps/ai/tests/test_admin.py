"""The admin: operator providers with Load models / Test connection, `.env` providers, users' servers and the
call log. Secrets never reach a page."""

from __future__ import annotations

import pytest
from django.test import Client
from django.urls import reverse

from apps.accounts.models import User
from apps.ai.models import AICall, Provider

from .conftest import PASSWORD, make_provider
from .fakes import Y_KEY

pytestmark = pytest.mark.django_db

SECRET = "Bearer admin-secret-value-321"


@pytest.fixture
def admin_client(db) -> Client:
    User.objects.create_superuser(email="root@example.com", password=PASSWORD)
    client = Client()
    assert client.login(email="root@example.com", password=PASSWORD)
    return client


def form_data(base_url: str, **fields) -> dict:
    return {
        "name": "Server X",
        "base_url": base_url,
        "style": "multipart",
        "style_config": '{"path": "/api/remove"}',
        "timeout_seconds": "60",
        "max_image_bytes": "0",
        "auth_header": "Authorization",
        "secret": "",
        "tasks": ["background-removal"],
        "enabled": "on",
        "sort_order": "0",
        "audience": "everyone",
        "daily_quota": "0",
        "models-TOTAL_FORMS": "0",
        "models-INITIAL_FORMS": "0",
        "models-MIN_NUM_FORMS": "0",
        "models-MAX_NUM_FORMS": "1000",
        **fields,
    }


def test_adding_a_provider_stores_the_secret_encrypted(admin_client, fake):
    response = admin_client.post(reverse("admin:ai_provider_add"), form_data(fake.url, secret=SECRET))
    assert response.status_code == 302, response.content.decode()[:3000]
    provider = Provider.objects.get()
    assert provider.owner is None and provider.secret() == SECRET
    page = admin_client.get(reverse("admin:ai_provider_change", args=[provider.pk])).content.decode()
    assert "admin-secret-value" not in page and "Set (hidden)" in page


def test_moving_a_provider_to_another_host_drops_its_secret(admin_client, fake):
    provider = make_provider(fake.url, secret=SECRET, auth_header="Authorization")
    url = reverse("admin:ai_provider_change", args=[provider.pk])
    assert admin_client.post(url, form_data("http://other.example:7000")).status_code == 302
    assert not Provider.objects.get().has_secret


def test_an_empty_secret_keeps_the_stored_one_and_clear_removes_it(admin_client, fake):
    provider = make_provider(fake.url, secret=SECRET, auth_header="Authorization")
    url = reverse("admin:ai_provider_change", args=[provider.pk])
    assert admin_client.post(url, form_data(fake.url)).status_code == 302
    assert Provider.objects.get().secret() == SECRET
    assert admin_client.post(url, form_data(fake.url, clear_secret="on")).status_code == 302
    assert not Provider.objects.get().has_secret


@pytest.mark.parametrize(
    "fields, error",
    [
        ({"style_config": '{"path": "no-slash"}'}, "start with /"),
        ({"base_url": "ftp://x.example"}, "http:// or https://"),
        ({"auth_header": "Content-Type"}, "set by Doory"),
        ({"secret": "a\nb"}, "line breaks"),
    ],
)
def test_invalid_settings_are_shown_in_the_form(admin_client, fake, fields, error):
    response = admin_client.post(reverse("admin:ai_provider_add"), {**form_data(fake.url), **fields})
    assert response.status_code == 200 and error in response.content.decode()
    assert not Provider.objects.exists()


def test_load_models_and_test_connection(admin_client, fake):
    provider = make_provider(fake.url, "doory")
    # GET returns the confirmation page without modifying models
    confirm_page = admin_client.get(
        reverse("admin:ai_provider_load_models", args=[provider.pk])
    ).content.decode()
    assert "Load models" in confirm_page
    assert not provider.models.exists()

    response = admin_client.post(reverse("admin:ai_provider_load_models", args=[provider.pk]), follow=True)
    assert "2 model(s)" in response.content.decode()
    assert list(provider.models.values_list("remote_name", flat=True)) == ["general-fast", "general-best"]

    # GET returns confirmation page without running test
    test_confirm = admin_client.get(
        reverse("admin:ai_provider_test_connection", args=[provider.pk])
    ).content.decode()
    assert "Test connection" in test_confirm
    assert not AICall.objects.exists()

    page = admin_client.post(
        reverse("admin:ai_provider_test_connection", args=[provider.pk])
    ).content.decode()
    assert "It works" in page and "data:image/png;base64," in page
    assert AICall.objects.get().status == "ok"


def test_a_failing_test_shows_the_reason_but_not_the_secret(admin_client, fake):
    provider = make_provider(
        fake.url,
        style_config={"path": "/v1/remove-background", "file_field": "image_file"},
        auth_header="X-Api-Key",
        secret="wrong-key-value",
    )
    page = admin_client.post(
        reverse("admin:ai_provider_test_connection", args=[provider.pk])
    ).content.decode()
    assert "refused the credentials" in page and "wrong-key-value" not in page


def test_load_models_on_another_style_says_so(admin_client, fake):
    provider = make_provider(fake.url)
    response = admin_client.post(reverse("admin:ai_provider_load_models", args=[provider.pk]), follow=True)
    assert "enter them by hand" in response.content.decode()


def test_env_providers_are_listed_read_only_with_a_test_button(admin_client, fake, settings):
    settings.AI_ENV_PROVIDERS = [
        {
            "index": 1,
            "URL": fake.url,
            "STYLE": "multipart",
            "STYLE_CONFIG": '{"path": "/v1/remove-background", "file_field": "image_file"}',
            "AUTH_HEADER": "X-Api-Key",
            "AUTH_VALUE": Y_KEY,
            "LABEL": "Model server",
        },
        {"index": 2, "URL": "nope"},
    ]
    page = admin_client.get(reverse("admin:ai_provider_changelist")).content.decode()
    assert "env-1" in page and "Model server" in page and "AI_PROVIDER_2_URL" in page
    assert Y_KEY not in page and fake.url not in page
    assert '<form method="post"' in page
    tested = admin_client.post(reverse("admin:ai_provider_env_test", args=["env-1"])).content.decode()
    assert "It works" in tested and Y_KEY not in tested
    assert admin_client.post(reverse("admin:ai_provider_env_test", args=["env-9"])).status_code == 404


def test_users_servers_are_listed_for_support_without_secrets(admin_client, fake):
    owner = User.objects.create_user(email="owner@example.com", password=PASSWORD)
    provider = make_provider(fake.url, owner=owner, secret=SECRET, auth_header="Authorization")
    assert reverse("admin:ai_provider_change", args=[provider.pk])
    assert (
        admin_client.get(reverse("admin:ai_provider_change", args=[provider.pk])).status_code == 302
    )  # not here
    page = admin_client.get(reverse("admin:ai_userprovider_change", args=[provider.pk])).content.decode()
    assert "owner@example.com" in page and "admin-secret-value" not in page
    listing = admin_client.get(reverse("admin:ai_userprovider_changelist")).content.decode()
    assert provider.name in listing


def test_the_call_log_is_read_only(admin_client, fake):
    user = User.objects.create_user(email="caller@example.com", password=PASSWORD)
    AICall.objects.create(user=user, provider_ref="env-1", task="background-removal", status="ok")
    page = admin_client.get(reverse("admin:ai_aicall_changelist") + "?status__exact=ok").content.decode()
    assert "caller@example.com" in page
    assert admin_client.get(reverse("admin:ai_aicall_add")).status_code == 403


def test_regular_users_cannot_test_env_providers(fake, settings):
    User.objects.create_user(email="plain@example.com", password=PASSWORD, is_staff=True)
    client = Client()
    client.login(email="plain@example.com", password=PASSWORD)
    assert client.get(reverse("admin:ai_provider_env_test", args=["env-1"])).status_code == 403
    assert client.post(reverse("admin:ai_provider_env_test", args=["env-1"])).status_code == 403
