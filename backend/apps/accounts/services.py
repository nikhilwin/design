"""Account operations that span more than one model field or request."""

from __future__ import annotations

import uuid

from django.core.files.base import ContentFile
from django.db import IntegrityError, transaction

from apps.apitokens.services import revoke_all as revoke_all_tokens
from apps.core.exceptions import ApiError
from apps.core.images import process_image_upload, square_crop_webp
from apps.core.storage import delete_file_after_commit

from .google import GoogleIdentity
from .models import User
from .serializers import clean_display_name

AVATAR_SIZE = 512
AVATAR_MAX_PIXELS = 16_000_000  # a 5 MB PNG can hold far more pixels than we want to decode


def build_avatar(upload, *, max_bytes: int) -> bytes:
    """Validate an uploaded image by decoding it, then return a centre-cropped 512 px square WebP."""
    processed = process_image_upload(upload, max_bytes=max_bytes, max_pixels=AVATAR_MAX_PIXELS)
    return square_crop_webp(processed.data, AVATAR_SIZE)


def replace_avatar(user: User, data: bytes | None) -> None:
    """Store `data` (WebP bytes) as the avatar, or clear it when `None`; the old file is removed."""
    storage = user.avatar.storage
    old_name = user.avatar.name
    if data is None:
        user.avatar = ""
    else:
        user.avatar.save(f"{uuid.uuid4().hex}.webp", ContentFile(data), save=False)
    new_name = user.avatar.name
    try:
        user.save(update_fields=["avatar", "updated_at"])
    except Exception:
        if new_name and new_name != old_name:
            storage.delete(new_name)
        raise
    if old_name != new_name:
        delete_file_after_commit(storage, old_name)


def sign_in_with_google(identity: GoogleIdentity) -> tuple[User, bool]:
    """Find, link or create the account for a verified Google identity. Returns `(user, created)`."""
    try:
        return _link_or_create(identity)
    except IntegrityError:  # two first sign-ins for the same account raced; the retry finds the winner
        return _link_or_create(identity)


@transaction.atomic
def _link_or_create(identity: GoogleIdentity) -> tuple[User, bool]:
    user = User.objects.select_for_update().filter(google_sub=identity.sub).first()
    if user is None:
        user = User.objects.select_for_update().filter(email__iexact=identity.email).first()
        if user is not None and user.google_sub and user.google_sub != identity.sub:
            raise ApiError(
                "google_account_mismatch", "This email address is already linked to another Google account."
            )
    if user is not None:
        if not user.is_active:
            raise ApiError("account_disabled", "This account has been disabled.")
        fields = ["updated_at"]
        if not user.google_sub:
            user.google_sub = identity.sub
            fields.append("google_sub")
        if not user.is_email_verified:
            # The email was never proven by whoever registered it, so a password set at that point may
            # belong to someone else. Google has now proven ownership: drop the password.
            user.set_unusable_password()
            user.is_email_verified = True
            fields += ["password", "is_email_verified"]
        user.save(update_fields=fields)
        if "password" in fields:
            revoke_all_tokens(user)  # and so may any token made with it
        return user, False

    user = User.objects.create_user(
        identity.email,
        None,
        display_name=clean_display_name(identity.name)[:80],
        google_sub=identity.sub,
        is_email_verified=True,
    )
    return user, True
