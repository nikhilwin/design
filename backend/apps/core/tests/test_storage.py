from __future__ import annotations

import logging
from unittest import mock

import pytest
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage

from apps.accounts.models import User
from apps.core import storage

pytestmark = pytest.mark.django_db


@pytest.fixture
def user_with_avatar(user):
    user.avatar.save("face.webp", ContentFile(b"webp-bytes"), save=True)
    assert default_storage.exists(user.avatar.name)
    return user


def test_files_are_removed_after_the_row_is_deleted(user_with_avatar, django_capture_on_commit_callbacks):
    name = user_with_avatar.avatar.name
    with django_capture_on_commit_callbacks(execute=True):
        user_with_avatar.delete()
    assert not default_storage.exists(name)


def test_files_survive_until_the_transaction_commits(user_with_avatar, django_capture_on_commit_callbacks):
    name = user_with_avatar.avatar.name
    with django_capture_on_commit_callbacks(execute=False) as callbacks:
        user_with_avatar.delete()
    assert default_storage.exists(name)
    assert len(callbacks) == 1


def test_bulk_queryset_deletes_clean_up_too(user_with_avatar, django_capture_on_commit_callbacks):
    name = user_with_avatar.avatar.name
    with django_capture_on_commit_callbacks(execute=True):
        User.objects.filter(pk=user_with_avatar.pk).delete()
    assert not default_storage.exists(name)


def test_rows_without_a_file_are_fine(user, django_capture_on_commit_callbacks):
    with django_capture_on_commit_callbacks(execute=True) as callbacks:
        user.delete()
    assert callbacks == []


def test_a_missing_file_does_not_raise(user_with_avatar, django_capture_on_commit_callbacks):
    default_storage.delete(user_with_avatar.avatar.name)
    with django_capture_on_commit_callbacks(execute=True):
        user_with_avatar.delete()


def test_storage_errors_are_logged_not_raised(user_with_avatar, django_capture_on_commit_callbacks, caplog):
    with (
        mock.patch.object(default_storage, "delete", side_effect=OSError("disk gone")),
        caplog.at_level(logging.WARNING, logger="apps.core.storage"),
        django_capture_on_commit_callbacks(execute=True),
    ):
        user_with_avatar.delete()
    assert "Could not delete stored file" in caplog.text


def test_registering_twice_does_not_double_delete(user_with_avatar, django_capture_on_commit_callbacks):
    storage.delete_files_on_delete(User, "avatar")
    with django_capture_on_commit_callbacks(execute=False) as callbacks:
        user_with_avatar.delete()
    assert len(callbacks) == 1


def test_delete_file_after_commit_ignores_empty_names(django_capture_on_commit_callbacks):
    with django_capture_on_commit_callbacks(execute=False) as callbacks:
        storage.delete_file_after_commit(default_storage, "")
        storage.delete_file_after_commit(default_storage, None)
    assert callbacks == []


def test_delete_file_after_commit_removes_the_file(django_capture_on_commit_callbacks):
    name = default_storage.save("scratch/tmp.txt", ContentFile(b"x"))
    with django_capture_on_commit_callbacks(execute=True):
        storage.delete_file_after_commit(default_storage, name)
    assert not default_storage.exists(name)


def test_helper_validates_its_arguments():
    with pytest.raises(ValueError, match="at least one"):
        storage.delete_files_on_delete(User)
    with pytest.raises(ValueError, match="not a file field"):
        storage.delete_files_on_delete(User, "email")
    with pytest.raises(Exception, match="has no field"):
        storage.delete_files_on_delete(User, "nonexistent")
