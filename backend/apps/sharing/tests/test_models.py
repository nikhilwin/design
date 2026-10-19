import re

import pytest
from django.db import IntegrityError, transaction

from apps.designs.models import Design
from apps.sharing.models import Comment, ShareLink, generate_share_token

from .conftest import future, past


def test_tokens_are_long_unique_and_url_safe():
    tokens = {generate_share_token() for _ in range(200)}
    assert len(tokens) == 200
    assert all(re.fullmatch(r"[A-Za-z0-9_-]{32}", token) for token in tokens)


def test_new_link_defaults(view_link):
    assert view_link.is_active is True
    assert view_link.role == "view"
    assert view_link.expires_at is None
    assert view_link.access_count == 0
    assert view_link.last_accessed_at is None
    assert view_link.has_password is False


def test_password_is_hashed_and_verified(make_link):
    link = make_link("view", password="s3cret pass")
    assert link.has_password
    assert "s3cret" not in link.password_hash
    assert link.check_password("s3cret pass")
    assert not link.check_password("S3cret pass")
    assert not link.check_password("")


def test_set_password_empty_removes_protection(make_link):
    link = make_link("view", password="s3cret pass")
    link.set_password(None)
    assert not link.has_password
    assert not link.check_password("anything")


def test_check_password_without_password_is_false(view_link):
    assert view_link.check_password("") is False
    assert view_link.check_password("x") is False


def test_expiry(make_link):
    assert make_link("view", expires_at=past()).is_expired()
    assert not make_link("view", expires_at=future()).is_expired()
    assert not make_link("view").is_expired()


def test_token_is_unique(view_link, design):
    with pytest.raises(IntegrityError), transaction.atomic():
        ShareLink.objects.create(design=design, token=view_link.token)


def test_deleting_design_cascades_links_and_comments(design, view_link, make_comment, stranger):
    root = make_comment(stranger)
    make_comment(stranger, parent=root)
    design.delete()
    assert not ShareLink.objects.exists()
    assert not Comment.objects.exists()


def test_deleting_comment_removes_its_replies(make_comment, stranger):
    root = make_comment(stranger)
    make_comment(stranger, "reply", parent=root)
    root.delete()
    assert not Comment.objects.exists()


def test_deleting_author_removes_their_comments(make_comment, stranger):
    make_comment(stranger)
    stranger.delete()
    assert not Comment.objects.exists()


def test_comment_coordinates_must_come_together(design, stranger):
    with pytest.raises(IntegrityError), transaction.atomic():
        Comment.objects.create(design=design, author=stranger, body="x", x=1.0)


def test_comments_are_ordered_oldest_first(make_comment, stranger):
    first, second = make_comment(stranger, "one"), make_comment(stranger, "two")
    assert list(Comment.objects.all()) == [first, second]


def test_owner_deletion_removes_designs_links(owner, view_link):
    owner.delete()
    assert not Design.objects.exists()
    assert not ShareLink.objects.exists()
