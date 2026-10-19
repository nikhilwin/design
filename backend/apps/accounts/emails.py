"""Transactional emails: multipart (plain text + branded HTML), sent off the request thread."""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlencode

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.template.loader import render_to_string

from .models import User
from .tokens import email_verification_token_generator, encode_uid, password_reset_token_generator

logger = logging.getLogger(__name__)

_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="doory-mail")


def _link(path: str, user: User, token: str) -> str:
    query = urlencode({"uid": encode_uid(user), "token": token})
    return f"{settings.SITE_URL.rstrip('/')}{path}?{query}"


def _deliver(message: EmailMultiAlternatives) -> None:
    try:
        message.send()
    except Exception:  # a mail outage must never fail sign-up or leak whether an address exists
        logger.exception("Could not send %r to a user", message.subject)


def _send(template: str, subject: str, user: User, context: dict[str, str]) -> None:
    context = {"user": user, "site_url": settings.SITE_URL.rstrip("/"), **context}
    message = EmailMultiAlternatives(
        subject=subject,
        body=render_to_string(f"accounts/email/{template}.txt", context),
        to=[user.email],
    )
    message.attach_alternative(render_to_string(f"accounts/email/{template}.html", context), "text/html")
    if settings.EMAIL_SEND_ASYNC:
        _executor.submit(_deliver, message)
    else:
        _deliver(message)


def send_verification_email(user: User) -> None:
    token = email_verification_token_generator.make_token(user)
    _send(
        "verify_email",
        "Verify your email address for Doory",
        user,
        {"action_url": _link("/verify-email", user, token)},
    )


def send_password_reset_email(user: User) -> None:
    token = password_reset_token_generator.make_token(user)
    _send(
        "reset_password",
        "Reset your Doory password",
        user,
        {"action_url": _link("/reset-password", user, token)},
    )
