"""`manage.py check` warnings for the AI provider settings."""

from __future__ import annotations

from cryptography.fernet import Fernet
from django.conf import settings
from django.core.checks import Tags, Warning, register

from . import env
from .catalog import USER_PROVIDER_MODES


@register(Tags.security)
def check_ai_settings(app_configs, **kwargs):
    issues = []
    mode = str(getattr(settings, "AI_USER_PROVIDERS", "off")).strip().lower()
    if mode not in USER_PROVIDER_MODES:
        issues.append(
            Warning(
                f"AI_USER_PROVIDERS={mode!r} is not one of {', '.join(USER_PROVIDER_MODES)}; "
                "it is treated as off.",
                id="ai.W001",
            )
        )
    for message in env.load()[1]:
        issues.append(Warning(f"{message} The provider is left out.", id="ai.W002"))
    for key in [settings.AI_SECRETS_KEY, *settings.AI_SECRETS_KEY_FALLBACKS]:
        if not key:
            continue
        try:
            Fernet(key.encode())
        except ValueError:
            issues.append(
                Warning(
                    "AI_SECRETS_KEY (or one of its fallbacks) is not a valid Fernet key; "
                    "provider secrets cannot be stored or read.",
                    hint='Generate one: python -c "from cryptography.fernet import Fernet; '
                    'print(Fernet.generate_key().decode())"',
                    id="ai.W003",
                )
            )
    if not settings.AI_SECRETS_KEY and mode in ("staff", "everyone") and not settings.DEBUG:
        issues.append(
            Warning(
                "Users may store API keys for their own AI servers, encrypted with a key derived from "
                "SECRET_KEY. Changing SECRET_KEY without keeping the old one in DJANGO_SECRET_KEY_FALLBACKS "
                "makes them unreadable.",
                hint="Set AI_SECRETS_KEY to a key of its own.",
                id="ai.W004",
            )
        )
    return issues
