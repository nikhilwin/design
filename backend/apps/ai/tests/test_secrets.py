"""Provider secrets are stored encrypted and can only be read with the right key."""

from __future__ import annotations

from io import StringIO

import pytest
from cryptography.fernet import Fernet

from apps.ai import secrets
from apps.ai.models import Provider

from .conftest import make_provider

pytestmark = pytest.mark.django_db


def test_a_secret_is_stored_encrypted_and_read_back(fake):
    provider = make_provider(fake.url, secret="Bearer top-secret-value")
    stored = bytes(Provider.objects.get(pk=provider.pk).secret_encrypted)
    assert b"top-secret-value" not in stored and stored
    assert Provider.objects.get(pk=provider.pk).secret() == "Bearer top-secret-value"


def test_an_empty_secret_removes_it(fake):
    provider = make_provider(fake.url, secret="abc")
    provider.set_secret("")
    assert not provider.has_secret and provider.secret() == ""


def test_without_ai_secrets_key_the_key_is_derived_from_secret_key(settings):
    settings.AI_SECRETS_KEY = ""
    token = secrets.encrypt("value")
    assert Fernet(secrets.derive_key(settings.SECRET_KEY)).decrypt(token) == b"value"
    assert secrets.uses_derived_key()


def test_a_configured_key_is_used_and_old_keys_still_read(settings):
    old, new = Fernet.generate_key().decode(), Fernet.generate_key().decode()
    settings.AI_SECRETS_KEY = old
    token = secrets.encrypt("value")
    settings.AI_SECRETS_KEY = new
    with pytest.raises(secrets.SecretUnreadable):
        secrets.decrypt(token)
    settings.AI_SECRETS_KEY_FALLBACKS = [old]
    assert secrets.decrypt(token) == "value"
    assert Fernet(new.encode()).decrypt(secrets.encrypt("x")) == b"x"  # new secrets use the new key


def test_rotating_secret_key_keeps_secrets_readable_through_the_fallbacks(settings):
    settings.AI_SECRETS_KEY = ""
    token = secrets.encrypt("value")
    previous = settings.SECRET_KEY
    settings.SECRET_KEY = "a-brand-new-secret-key-for-the-test"
    with pytest.raises(secrets.SecretUnreadable):
        secrets.decrypt(token)
    settings.SECRET_KEY_FALLBACKS = [previous]
    assert secrets.decrypt(token) == "value"


def test_setting_ai_secrets_key_keeps_secrets_from_secret_key_readable(settings):
    settings.AI_SECRETS_KEY = ""
    token = secrets.encrypt("secret-from-derived-key")
    # Operator follows ai.W004 and sets AI_SECRETS_KEY
    settings.AI_SECRETS_KEY = Fernet.generate_key().decode()
    assert secrets.decrypt(token) == "secret-from-derived-key"


def test_reencrypt_ai_secrets_command(settings, fake):
    from io import StringIO

    from django.core.management import call_command

    settings.AI_SECRETS_KEY = ""
    provider = make_provider(fake.url, secret="original-secret")
    original_token = bytes(provider.secret_encrypted)

    new_key = Fernet.generate_key().decode()
    settings.AI_SECRETS_KEY = new_key

    # Dry run does not change DB
    out_dry = StringIO()
    call_command("reencrypt_ai_secrets", dry_run=True, stdout=out_dry)
    assert "Would re-encrypt 1" in out_dry.getvalue()
    provider.refresh_from_db()
    assert bytes(provider.secret_encrypted) == original_token

    # Real run re-encrypts with new primary key
    out = StringIO()
    call_command("reencrypt_ai_secrets", stdout=out)
    assert "Re-encrypted 1" in out.getvalue()
    provider.refresh_from_db()
    assert bytes(provider.secret_encrypted) != original_token
    assert Fernet(new_key.encode()).decrypt(bytes(provider.secret_encrypted)) == b"original-secret"


def test_invalid_ai_secrets_key_raises_secret_unreadable(settings):
    settings.AI_SECRETS_KEY = "not-a-valid-fernet-key"
    with pytest.raises(secrets.SecretUnreadable) as exc:
        secrets.encrypt("val")
    assert "not a valid Fernet key" in str(exc.value)


def test_an_invalid_fallback_key_is_skipped(settings):
    settings.AI_SECRETS_KEY = Fernet.generate_key().decode()
    token = secrets.encrypt("value")
    settings.AI_SECRETS_KEY_FALLBACKS = ["not-a-valid-fernet-key"]
    assert secrets.decrypt(token) == "value" and secrets.can_encrypt()


def test_reencrypt_fails_when_a_secret_cannot_be_read(settings, fake):
    from django.core.management import CommandError, call_command

    make_provider(fake.url, secret="abc")
    settings.AI_SECRETS_KEY = Fernet.generate_key().decode()
    settings.SECRET_KEY = "a-completely-different-key"
    with pytest.raises(CommandError, match="1 provider secret"):
        call_command("reencrypt_ai_secrets", stdout=StringIO(), stderr=StringIO())


def test_an_unreadable_secret_is_a_clean_provider_error(settings, fake, user, photo):
    from apps.ai import services
    from apps.ai.errors import AIProviderError

    provider = make_provider(fake.url, style="multipart", secret="abc", style_config={"path": "/api/remove"})
    # Change both so it cannot be decrypted by any fallback
    settings.AI_SECRETS_KEY = Fernet.generate_key().decode()
    settings.SECRET_KEY = "a-completely-different-key"
    with pytest.raises(AIProviderError) as caught:
        services.run(user, "background-removal", photo, f"{provider.id}:")
    assert caught.value.code == "secret_unreadable"
    assert fake.requests == []
