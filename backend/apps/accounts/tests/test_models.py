from __future__ import annotations

import pytest
from django.db import IntegrityError, transaction

from apps.accounts.models import User
from apps.accounts.tokens import (
    EmailVerificationTokenGenerator,
    decode_uid,
    email_verification_token_generator,
    encode_uid,
    password_reset_token_generator,
)

pytestmark = pytest.mark.django_db


def test_create_user_normalises_and_hashes(db):
    user = User.objects.create_user("  Mixed.Case@Example.COM".strip(), "plum-umbrella-ripple-47")
    assert user.email == "mixed.case@example.com"
    assert user.has_usable_password()
    assert not user.is_staff and not user.is_superuser and user.is_active


def test_create_user_without_password_has_an_unusable_one():
    assert not User.objects.create_user("a@example.com").has_usable_password()


def test_create_user_requires_an_email():
    with pytest.raises(ValueError):
        User.objects.create_user("", "x")


def test_create_superuser_flags():
    admin = User.objects.create_superuser("root@example.com", "plum-umbrella-ripple-47")
    assert admin.is_staff and admin.is_superuser and admin.is_email_verified


def test_save_lowercases_the_email():
    user = User(email="  Foo@Bar.com ")
    user.set_unusable_password()
    user.save()
    assert User.objects.get().email == "foo@bar.com"


def test_email_uniqueness_is_enforced_case_insensitively_by_the_database(user):
    with pytest.raises(IntegrityError), transaction.atomic():
        User.objects.bulk_create([User(email="ADA@EXAMPLE.COM", password="!")])


def test_natural_key_lookup_ignores_case(user):
    assert User.objects.get_by_natural_key(" ADA@example.com ") == user
    with pytest.raises(User.DoesNotExist):
        User.objects.get_by_natural_key("")
    with pytest.raises(User.DoesNotExist):
        User.objects.get_by_natural_key(None)


def test_primary_keys_are_uuids(user):
    import uuid

    assert isinstance(user.pk, uuid.UUID)


def test_name_prefers_display_name(user):
    assert user.name == "ada"
    user.display_name = "Ada L."
    assert user.name == "Ada L."


# --- tokens ---------------------------------------------------------------------------------------


def test_uid_round_trip(user):
    assert decode_uid(encode_uid(user)) == user


@pytest.mark.parametrize(
    "uid", ["", "!!!", "bm90LWEtdXVpZA", "MDAwMDAwMDAtMDAwMC0wMDAwLTAwMDAtMDAwMDAwMDAwMDAw"]
)
def test_decode_uid_rejects_garbage(db, uid):
    assert decode_uid(uid) is None


def test_decode_uid_skips_inactive_users(user):
    uid = encode_uid(user)
    user.is_active = False
    user.save()
    assert decode_uid(uid) is None


def test_the_two_generators_use_different_salts(user):
    assert EmailVerificationTokenGenerator.key_salt != password_reset_token_generator.key_salt
    token = email_verification_token_generator.make_token(user)
    assert not password_reset_token_generator.check_token(user, token)
    assert email_verification_token_generator.check_token(user, token)


def test_verification_token_changes_when_the_flag_flips(user):
    token = email_verification_token_generator.make_token(user)
    user.is_email_verified = True
    assert not email_verification_token_generator.check_token(user, token)


def test_verification_token_survives_a_login(user):
    from django.utils import timezone

    token = email_verification_token_generator.make_token(user)
    user.last_login = timezone.now()
    user.save()
    assert email_verification_token_generator.check_token(user, token)
