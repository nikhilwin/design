import pytest
from rest_framework.test import APIClient
from rest_framework.throttling import ScopedRateThrottle

from apps.designs.models import Design
from apps.sharing.models import Comment
from apps.sharing.services import MAX_COMMENTS_PER_DESIGN

from .conftest import PASSWORD

HEADER = "HTTP_X_SHARE_PASSWORD"


def shared_comments(link):
    return f"/api/v1/shared/{link.token}/comments/"


def shared_comment(link, comment):
    return f"/api/v1/shared/{link.token}/comments/{comment.id}/"


def design_comments(design):
    return f"/api/v1/designs/{design.id}/comments/"


def design_comment(design, comment):
    return f"/api/v1/designs/{design.id}/comments/{comment.id}/"


def post(client, link, **body):
    return client.post(shared_comments(link), body, format="json")


# ---- reading through a link ---------------------------------------------------------------


@pytest.mark.parametrize("role", ["comment", "edit"])
def test_comment_and_edit_links_list_comments_publicly(anon, make_link, make_comment, stranger, role):
    comment = make_comment(stranger, "Nice colours", page_id="p1", x=10.5, y=20.0)
    response = anon.get(shared_comments(make_link(role)))
    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 1
    assert body["results"][0] == {
        "id": str(comment.id),
        "author": {"id": str(stranger.id), "name": "Sam Stranger", "avatar_url": None},
        "body": "Nice colours",
        "page_id": "p1",
        "x": 10.5,
        "y": 20.0,
        "parent": None,
        "resolved": False,
        "created_at": body["results"][0]["created_at"],
    }


def test_view_links_do_not_expose_comments(anon, view_link, make_comment, stranger):
    make_comment(stranger)
    response = anon.get(shared_comments(view_link))
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "comments_disabled"


def test_comment_without_position_serialises_nulls(anon, comment_link, make_comment, stranger):
    make_comment(stranger)
    item = anon.get(shared_comments(comment_link)).json()["results"][0]
    assert item["page_id"] is None and item["x"] is None and item["y"] is None


def test_author_email_is_never_exposed(anon, comment_link, make_comment, stranger):
    stranger.display_name = ""
    stranger.save()
    make_comment(stranger)
    response = anon.get(shared_comments(comment_link))
    assert "stranger@example.com" not in response.content.decode()
    assert response.json()["results"][0]["author"]["name"] == "Doory user"


def test_comments_are_listed_oldest_first_and_paginated(anon, comment_link, make_comment, stranger):
    for index in range(3):
        make_comment(stranger, f"c{index}")
    body = anon.get(shared_comments(comment_link), {"page_size": 2}).json()
    assert [c["body"] for c in body["results"]] == ["c0", "c1"]
    assert body["count"] == 3 and body["next"] is not None


def test_comments_of_other_designs_are_not_listed(anon, comment_link, make_comment, stranger, owner):
    other = Design.objects.create(owner=owner, title="Other")
    Comment.objects.create(design=other, author=stranger, body="elsewhere")
    make_comment(stranger, "here")
    assert [c["body"] for c in anon.get(shared_comments(comment_link)).json()["results"]] == ["here"]


def test_comment_list_respects_the_password(anon, make_link, make_comment, stranger):
    link = make_link("comment", password=PASSWORD)
    make_comment(stranger)
    assert anon.get(shared_comments(link)).status_code == 401
    assert anon.get(shared_comments(link), **{HEADER: "wrong"}).status_code == 401
    assert anon.get(shared_comments(link), **{HEADER: PASSWORD}).status_code == 200


def test_dead_links_do_not_list_comments(anon, make_link):
    assert anon.get(shared_comments(make_link("comment", is_active=False))).status_code == 404


# ---- creating through a link --------------------------------------------------------------


def test_comment_link_creates_a_comment(stranger_client, comment_link, design, stranger):
    response = post(stranger_client, comment_link, body="  Love it  ", page_id="page-1", x=12, y=34.5)
    assert response.status_code == 201
    body = response.json()
    assert body["body"] == "Love it"
    assert body["author"]["id"] == str(stranger.id)
    assert (body["page_id"], body["x"], body["y"], body["resolved"], body["parent"]) == (
        "page-1",
        12.0,
        34.5,
        False,
        None,
    )
    comment = Comment.objects.get(pk=body["id"])
    assert comment.design_id == design.id and comment.author == stranger


def test_edit_link_can_comment_too(stranger_client, edit_link):
    assert post(stranger_client, edit_link, body="hi").status_code == 201


def test_view_link_cannot_comment(stranger_client, view_link):
    response = post(stranger_client, view_link, body="hi")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "comments_disabled"
    assert not Comment.objects.exists()


def test_anonymous_cannot_comment(anon, comment_link):
    assert post(anon, comment_link, body="hi").status_code == 401
    assert not Comment.objects.exists()


def test_comment_requires_the_password(stranger_client, make_link):
    link = make_link("comment", password=PASSWORD)
    assert post(stranger_client, link, body="hi").status_code == 401
    assert (
        stranger_client.post(
            shared_comments(link), {"body": "hi"}, format="json", **{HEADER: PASSWORD}
        ).status_code
        == 201
    )


def test_dead_link_cannot_comment(stranger_client, make_link):
    from .conftest import past

    assert post(stranger_client, make_link("comment", expires_at=past()), body="hi").status_code == 404


@pytest.mark.parametrize("body", ["", "   ", None, "x" * 2001, ["a"], {"a": 1}])
def test_invalid_bodies(stranger_client, comment_link, body):
    response = post(stranger_client, comment_link, body=body)
    assert response.status_code == 400
    assert "body" in response.json()["error"]["fields"]


def test_body_of_exactly_2000_characters_is_fine(stranger_client, comment_link):
    assert post(stranger_client, comment_link, body="é" * 2000).status_code == 201


def test_null_bytes_are_rejected(stranger_client, comment_link):
    assert post(stranger_client, comment_link, body="hello\x00world").status_code == 400


def test_markup_is_stored_verbatim_not_interpreted(stranger_client, comment_link):
    payload = "<img src=x onerror=alert(1)> & <b>"
    response = post(stranger_client, comment_link, body=payload)
    assert response.status_code == 201
    assert response.json()["body"] == payload
    assert response["Content-Type"].startswith("application/json")


@pytest.mark.parametrize(
    "extra",
    [
        {"x": 1},
        {"y": 1},
        {"x": "abc", "y": 1},
        {"x": 1e12, "y": 1},
        {"x": float("nan"), "y": 1},
        {"page_id": "has spaces"},
        {"page_id": "x" * 65},
        {"page_id": "<script>"},
    ],
)
def test_invalid_positions_and_page_ids(stranger_client, comment_link, extra):
    import json

    response = stranger_client.post(
        shared_comments(comment_link), json.dumps({"body": "hi", **extra}), content_type="application/json"
    )
    assert response.status_code == 400, response.content


def test_blank_page_id_is_stored_as_empty(stranger_client, comment_link):
    response = post(stranger_client, comment_link, body="hi", page_id="")
    assert response.status_code == 201 and response.json()["page_id"] is None


def test_unknown_fields_cannot_be_assigned(stranger_client, comment_link, owner):
    response = post(
        stranger_client, comment_link, body="hi", author=str(owner.id), resolved=True, design="x", id="y"
    )
    assert response.status_code == 201
    comment = Comment.objects.get()
    assert comment.author != owner and comment.resolved is False


def test_comment_creation_is_rate_limited(stranger_client, comment_link, monkeypatch):
    monkeypatch.setitem(ScopedRateThrottle.THROTTLE_RATES, "upload", "3/min")
    statuses = [post(stranger_client, comment_link, body=f"c{i}").status_code for i in range(5)]
    assert statuses == [201, 201, 201, 429, 429]


def test_reads_are_not_subject_to_the_upload_rate(stranger_client, comment_link, monkeypatch):
    monkeypatch.setitem(ScopedRateThrottle.THROTTLE_RATES, "upload", "1/min")
    for _ in range(4):
        assert stranger_client.get(shared_comments(comment_link)).status_code == 200


def test_comment_limit_per_design(stranger_client, comment_link, design, stranger, monkeypatch):
    Comment.objects.bulk_create(
        [Comment(design=design, author=stranger, body="x") for _ in range(MAX_COMMENTS_PER_DESIGN)]
    )
    response = post(stranger_client, comment_link, body="one too many")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "comment_limit_reached"


# ---- replies ------------------------------------------------------------------------------


def test_reply_inherits_position_of_its_thread(stranger_client, comment_link, make_comment, owner):
    root = make_comment(owner, "root", page_id="p9", x=5.0, y=6.0)
    response = post(
        stranger_client, comment_link, body="reply", parent=str(root.id), x=100, y=100, page_id="zzz"
    )
    assert response.status_code == 201
    body = response.json()
    assert body["parent"] == str(root.id)
    assert (body["page_id"], body["x"], body["y"]) == ("p9", 5.0, 6.0)


def test_replies_cannot_be_nested(stranger_client, comment_link, make_comment, owner):
    root = make_comment(owner, "root")
    reply = make_comment(owner, "reply", parent=root)
    response = post(stranger_client, comment_link, body="deep", parent=str(reply.id))
    assert response.status_code == 400
    assert "parent" in response.json()["error"]["fields"]


def test_reply_to_a_comment_of_another_design_is_rejected(stranger_client, comment_link, owner, stranger):
    other = Design.objects.create(owner=owner, title="Other")
    foreign = Comment.objects.create(design=other, author=stranger, body="foreign")
    response = post(stranger_client, comment_link, body="hi", parent=str(foreign.id))
    assert response.status_code == 400


def test_reply_to_unknown_or_malformed_parent(stranger_client, comment_link):
    assert (
        post(
            stranger_client, comment_link, body="hi", parent="6c1a2f2e-0000-4000-8000-000000000000"
        ).status_code
        == 400
    )
    assert post(stranger_client, comment_link, body="hi", parent="not-a-uuid").status_code == 400


def test_replies_are_listed_with_their_parent(anon, comment_link, make_comment, owner, stranger):
    root = make_comment(owner, "root")
    make_comment(stranger, "reply", parent=root)
    results = anon.get(shared_comments(comment_link)).json()["results"]
    assert [r["parent"] for r in results] == [None, str(root.id)]


# ---- deleting through a link --------------------------------------------------------------


def test_author_deletes_own_comment_through_the_link(stranger_client, comment_link, make_comment, stranger):
    comment = make_comment(stranger)
    assert stranger_client.delete(shared_comment(comment_link, comment)).status_code == 204
    assert not Comment.objects.exists()


def test_author_cannot_delete_other_peoples_comments(stranger_client, comment_link, make_comment, owner):
    comment = make_comment(owner)
    assert stranger_client.delete(shared_comment(comment_link, comment)).status_code == 404
    assert Comment.objects.filter(pk=comment.pk).exists()


def test_anonymous_cannot_delete(anon, comment_link, make_comment, stranger):
    comment = make_comment(stranger)
    assert anon.delete(shared_comment(comment_link, comment)).status_code == 401


def test_delete_needs_a_valid_link_for_the_same_design(stranger_client, make_comment, stranger, owner):
    from apps.sharing.models import ShareLink

    comment = make_comment(stranger)
    other = Design.objects.create(owner=owner, title="Other")
    foreign_link = ShareLink.objects.create(design=other, role="comment")
    assert stranger_client.delete(shared_comment(foreign_link, comment)).status_code == 404


def test_deleting_a_root_comment_removes_the_thread(
    stranger_client, comment_link, make_comment, stranger, owner
):
    root = make_comment(stranger, "root")
    make_comment(owner, "reply", parent=root)
    stranger_client.delete(shared_comment(comment_link, root))
    assert Comment.objects.count() == 0


# ---- owner endpoints ----------------------------------------------------------------------


def test_owner_lists_comments_with_filters(owner_client, design, make_comment, stranger):
    make_comment(stranger, "open", page_id="p1")
    done = make_comment(stranger, "done", page_id="p2")
    done.resolved = True
    done.save()
    url = design_comments(design)
    assert owner_client.get(url).json()["count"] == 2
    assert [c["body"] for c in owner_client.get(url, {"resolved": "true"}).json()["results"]] == ["done"]
    assert [c["body"] for c in owner_client.get(url, {"resolved": "false"}).json()["results"]] == ["open"]
    assert [c["body"] for c in owner_client.get(url, {"page_id": "p1"}).json()["results"]] == ["open"]


def test_owner_can_comment_and_reply(owner_client, design):
    root = owner_client.post(
        design_comments(design), {"body": "note to self", "page_id": "p1", "x": 1, "y": 2}, format="json"
    )
    assert root.status_code == 201
    reply = owner_client.post(
        design_comments(design), {"body": "more", "parent": root.json()["id"]}, format="json"
    )
    assert reply.status_code == 201 and reply.json()["parent"] == root.json()["id"]


def test_owner_comment_endpoints_are_owner_only(stranger_client, anon, design, make_comment, stranger):
    comment = make_comment(stranger)
    assert anon.get(design_comments(design)).status_code == 401
    assert stranger_client.get(design_comments(design)).status_code == 404
    assert stranger_client.post(design_comments(design), {"body": "x"}, format="json").status_code == 404
    assert (
        stranger_client.patch(design_comment(design, comment), {"resolved": True}, format="json").status_code
        == 404
    )
    comment.refresh_from_db()
    assert comment.resolved is False


def test_owner_resolves_and_reopens_a_thread(owner_client, design, make_comment, stranger):
    comment = make_comment(stranger)
    url = design_comment(design, comment)
    assert owner_client.patch(url, {"resolved": True}, format="json").json()["resolved"] is True
    assert owner_client.patch(url, {"resolved": False}, format="json").json()["resolved"] is False


def test_replies_cannot_be_resolved(owner_client, design, make_comment, stranger):
    root = make_comment(stranger)
    reply = make_comment(stranger, "r", parent=root)
    assert (
        owner_client.patch(design_comment(design, reply), {"resolved": True}, format="json").status_code
        == 400
    )


def test_owner_patch_only_touches_resolved(owner_client, design, make_comment, stranger):
    comment = make_comment(stranger, "original")
    owner_client.patch(design_comment(design, comment), {"author": "x", "resolved": True}, format="json")
    comment.refresh_from_db()
    assert comment.body == "original" and comment.author == stranger and comment.resolved


def test_only_authors_change_the_text_of_their_comments(owner_client, owner, design, make_comment, stranger):
    theirs = make_comment(stranger, "original")
    response = owner_client.patch(
        design_comment(design, theirs), {"body": "edited", "resolved": True}, format="json"
    )
    assert response.status_code == 400 and "own comments" in str(response.json()["error"]["fields"]["body"])
    theirs.refresh_from_db()
    assert theirs.body == "original" and theirs.resolved is False  # nothing applied
    mine = make_comment(owner, "typo")
    assert (
        owner_client.patch(design_comment(design, mine), {"body": "fixed"}, format="json").json()["body"]
        == "fixed"
    )


def test_owner_can_delete_any_comment(owner_client, design, make_comment, stranger):
    comment = make_comment(stranger)
    assert owner_client.delete(design_comment(design, comment)).status_code == 204
    assert not Comment.objects.exists()


def test_author_can_delete_own_comment_by_design_id(stranger_client, design, make_comment, stranger):
    comment = make_comment(stranger)
    assert stranger_client.delete(design_comment(design, comment)).status_code == 204


def test_bystanders_cannot_delete(design, make_comment, stranger, owner, db):
    from apps.accounts.models import User

    bystander = User.objects.create_user("bystander@example.com", "bystander-pass-123")
    comment = make_comment(stranger)
    client = APIClient()
    client.force_authenticate(bystander)
    assert client.delete(design_comment(design, comment)).status_code == 404
    assert Comment.objects.filter(pk=comment.pk).exists()


def test_comment_of_another_design_is_unreachable_through_this_one(owner_client, design, owner, stranger):
    other = Design.objects.create(owner=owner, title="Other")
    comment = Comment.objects.create(design=other, author=stranger, body="x")
    assert owner_client.delete(design_comment(design, comment)).status_code == 404
    assert (
        owner_client.patch(design_comment(design, comment), {"resolved": True}, format="json").status_code
        == 404
    )


def test_owner_cannot_comment_on_a_trashed_design(owner_client, design):
    from django.utils import timezone

    design.trashed_at = timezone.now()
    design.save()
    assert owner_client.post(design_comments(design), {"body": "x"}, format="json").status_code == 400
    assert owner_client.get(design_comments(design)).status_code == 200


def test_owner_comment_list_query_budget(
    owner_client, design, make_comment, stranger, django_assert_max_num_queries
):
    for index in range(10):
        make_comment(stranger, f"c{index}")
    with django_assert_max_num_queries(4):
        assert owner_client.get(design_comments(design)).status_code == 200


# ---- moving a pin -------------------------------------------------------------------------


def test_owner_moves_a_thread_and_its_replies_follow(owner_client, design, make_comment, stranger, owner):
    root = make_comment(stranger, "root", page_id="p1", x=10, y=20)
    reply = make_comment(owner, "reply", parent=root, page_id="p1", x=10, y=20)
    other = make_comment(stranger, "elsewhere", page_id="p1", x=1, y=2)
    response = owner_client.patch(
        design_comment(design, root), {"page_id": "p2", "x": 300.5, "y": 40}, format="json"
    )
    assert response.status_code == 200, response.content
    assert (response.json()["page_id"], response.json()["x"], response.json()["y"]) == ("p2", 300.5, 40.0)
    reply.refresh_from_db()
    other.refresh_from_db()
    assert (reply.page_id, reply.x, reply.y) == ("p2", 300.5, 40.0)
    assert (other.page_id, other.x, other.y) == ("p1", 1.0, 2.0)


def test_moving_keeps_the_page_when_only_the_position_is_given(owner_client, design, make_comment, stranger):
    root = make_comment(stranger, "root", page_id="p1", x=10, y=20)
    response = owner_client.patch(design_comment(design, root), {"x": 5, "y": 6}, format="json")
    assert response.status_code == 200
    assert (response.json()["page_id"], response.json()["x"], response.json()["y"]) == ("p1", 5.0, 6.0)


def test_moving_can_unpin_a_thread(owner_client, design, make_comment, stranger):
    root = make_comment(stranger, "root", page_id="p1", x=10, y=20)
    response = owner_client.patch(
        design_comment(design, root), {"page_id": None, "x": None, "y": None}, format="json"
    )
    assert response.status_code == 200
    assert (response.json()["page_id"], response.json()["x"], response.json()["y"]) == (None, None, None)


def test_moving_and_resolving_can_happen_in_one_request(owner_client, design, make_comment, stranger):
    root = make_comment(stranger, "root", page_id="p1", x=10, y=20)
    body = owner_client.patch(
        design_comment(design, root), {"resolved": True, "x": 7, "y": 8}, format="json"
    ).json()
    assert (body["resolved"], body["x"], body["y"]) == (True, 7.0, 8.0)


def test_moving_bumps_updated_at(owner_client, design, make_comment, stranger):
    root = make_comment(stranger, "root", page_id="p1", x=10, y=20)
    before = Comment.objects.get(pk=root.pk).updated_at
    owner_client.patch(design_comment(design, root), {"x": 1, "y": 2}, format="json")
    assert Comment.objects.get(pk=root.pk).updated_at > before


@pytest.mark.parametrize(
    "body",
    [
        {"x": 1},
        {"y": 1},
        {"x": None, "y": 1},
        {"x": "abc", "y": 1},
        {"x": 1e12, "y": 1},
        {"page_id": "has spaces", "x": 1, "y": 2},
        {"page_id": "x" * 65, "x": 1, "y": 2},
        {"page_id": "<script>", "x": 1, "y": 2},
    ],
)
def test_invalid_moves_are_rejected_and_change_nothing(owner_client, design, make_comment, stranger, body):
    import json

    root = make_comment(stranger, "root", page_id="p1", x=10, y=20)
    response = owner_client.patch(
        design_comment(design, root), json.dumps(body), content_type="application/json"
    )
    assert response.status_code == 400, response.content
    root.refresh_from_db()
    assert (root.page_id, root.x, root.y) == ("p1", 10.0, 20.0)


def test_replies_cannot_be_moved_on_their_own(owner_client, design, make_comment, stranger):
    root = make_comment(stranger, "root", page_id="p1", x=10, y=20)
    reply = make_comment(stranger, "reply", parent=root, page_id="p1", x=10, y=20)
    response = owner_client.patch(design_comment(design, reply), {"x": 1, "y": 2}, format="json")
    assert response.status_code == 400
    reply.refresh_from_db()
    assert (reply.x, reply.y) == (10.0, 20.0)


def test_strangers_cannot_move_through_the_owner_endpoint(stranger_client, design, make_comment, stranger):
    root = make_comment(stranger, "root", page_id="p1", x=10, y=20)
    response = stranger_client.patch(design_comment(design, root), {"x": 1, "y": 2}, format="json")
    assert response.status_code == 404
    root.refresh_from_db()
    assert (root.x, root.y) == (10.0, 20.0)


@pytest.mark.parametrize("role", ["comment", "edit"])
def test_author_moves_their_own_pin_through_the_link(
    stranger_client, make_link, make_comment, stranger, role
):
    link = make_link(role)
    root = make_comment(stranger, "root", page_id="p1", x=10, y=20)
    reply = make_comment(stranger, "reply", parent=root, page_id="p1", x=10, y=20)
    response = stranger_client.patch(
        shared_comment(link, root), {"page_id": "p3", "x": 99, "y": 98}, format="json"
    )
    assert response.status_code == 200, response.content
    assert (response.json()["page_id"], response.json()["x"], response.json()["y"]) == ("p3", 99.0, 98.0)
    assert response.json()["author"]["id"] == str(stranger.id)
    reply.refresh_from_db()
    assert (reply.page_id, reply.x, reply.y) == ("p3", 99.0, 98.0)


def test_link_moves_ignore_everything_but_the_position(stranger_client, comment_link, make_comment, stranger):
    root = make_comment(stranger, "root", page_id="p1", x=10, y=20)
    response = stranger_client.patch(
        shared_comment(comment_link, root),
        {"x": 1, "y": 2, "resolved": True, "body": "edited", "author": "x"},
        format="json",
    )
    assert response.status_code == 200
    root.refresh_from_db()
    assert (root.resolved, root.body, root.author) == (False, "root", stranger)
    assert (root.x, root.y) == (1.0, 2.0)


def test_link_move_needs_a_position(stranger_client, comment_link, make_comment, stranger):
    root = make_comment(stranger, "root", page_id="p1", x=10, y=20)
    assert (
        stranger_client.patch(
            shared_comment(comment_link, root), {"resolved": True}, format="json"
        ).status_code
        == 400
    )
    assert stranger_client.patch(shared_comment(comment_link, root), {}, format="json").status_code == 400


def test_link_visitors_cannot_move_other_peoples_pins(stranger_client, comment_link, make_comment, owner):
    root = make_comment(owner, "root", page_id="p1", x=10, y=20)
    response = stranger_client.patch(shared_comment(comment_link, root), {"x": 1, "y": 2}, format="json")
    assert response.status_code == 404
    root.refresh_from_db()
    assert (root.x, root.y) == (10.0, 20.0)


def test_anonymous_visitors_cannot_move_pins(anon, comment_link, make_comment, stranger):
    root = make_comment(stranger, "root", page_id="p1", x=10, y=20)
    assert anon.patch(shared_comment(comment_link, root), {"x": 1, "y": 2}, format="json").status_code == 401


def test_view_links_cannot_move_pins(stranger_client, view_link, make_comment, stranger):
    root = make_comment(stranger, "root", page_id="p1", x=10, y=20)
    response = stranger_client.patch(shared_comment(view_link, root), {"x": 1, "y": 2}, format="json")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "comments_disabled"


def test_link_moves_respect_the_password(stranger_client, make_link, make_comment, stranger):
    link = make_link("comment", password=PASSWORD)
    root = make_comment(stranger, "root", page_id="p1", x=10, y=20)
    url = shared_comment(link, root)
    assert stranger_client.patch(url, {"x": 1, "y": 2}, format="json").status_code == 401
    assert stranger_client.patch(url, {"x": 1, "y": 2}, format="json", **{HEADER: "wrong"}).status_code == 401
    assert (
        stranger_client.patch(url, {"x": 1, "y": 2}, format="json", **{HEADER: PASSWORD}).status_code == 200
    )


def test_link_moves_of_a_reply_or_a_foreign_design_are_rejected(
    stranger_client, comment_link, make_comment, stranger, owner
):
    root = make_comment(stranger, "root", page_id="p1", x=10, y=20)
    reply = make_comment(stranger, "reply", parent=root, page_id="p1", x=10, y=20)
    assert (
        stranger_client.patch(
            shared_comment(comment_link, reply), {"x": 1, "y": 2}, format="json"
        ).status_code
        == 400
    )
    other = Design.objects.create(owner=owner, title="Other")
    foreign = Comment.objects.create(design=other, author=stranger, body="x", page_id="p1", x=1, y=1)
    assert (
        stranger_client.patch(
            shared_comment(comment_link, foreign), {"x": 5, "y": 5}, format="json"
        ).status_code
        == 404
    )
