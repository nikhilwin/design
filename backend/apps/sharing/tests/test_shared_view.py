import pytest
from django.utils import timezone

from apps.sharing.models import ShareLink
from apps.sharing.services import (
    PASSWORD_LIMIT_PER_IP,
    PASSWORD_LIMIT_PER_TOKEN,
    PASSWORD_LIMIT_PER_TOKEN_AND_IP,
)

from .conftest import PASSWORD, future, make_document, past

HEADER = "HTTP_X_SHARE_PASSWORD"


def shared_url(link):
    return f"/api/v1/shared/{link.token}/"


def test_view_link_returns_contract_shape(anon, view_link, design):
    response = anon.get(shared_url(view_link))
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "design_id",
        "role",
        "title",
        "width",
        "height",
        "revision",
        "owner",
        "document",
        "fonts",
    }
    assert body["design_id"] == str(design.pk)
    assert body["role"] == "view"
    assert body["title"] == "Summer poster"
    assert (body["width"], body["height"], body["revision"]) == (800, 600, 1)
    assert body["document"] == design.document
    assert body["owner"] == {"name": "Olive Owner", "avatar_url": None}


def test_owner_email_is_never_exposed(anon, view_link, owner):
    owner.display_name = ""
    owner.save()
    response = anon.get(shared_url(view_link))
    assert response.json()["owner"]["name"] == "Doory user"
    assert "owner@example.com" not in response.content.decode()
    assert "owner" not in response.json()["owner"]["name"].lower()


def test_response_is_not_cacheable(anon, view_link):
    response = anon.get(shared_url(view_link))
    cache_control = response["Cache-Control"]
    assert "no-store" in cache_control and "private" in cache_control
    assert "X-Share-Password" in response["Vary"]


def test_all_roles_can_read(anon, make_link):
    for role in ("view", "comment", "edit"):
        assert anon.get(shared_url(make_link(role))).json()["role"] == role


def test_unknown_token_is_404(anon):
    response = anon.get("/api/v1/shared/does-not-exist-does-not-exist-000/")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


@pytest.mark.parametrize("token", ["short", "a" * 65, "bad token with spaces!!!", "%2e%2e%2f%2e%2e%2f"])
def test_malformed_tokens_are_404(anon, token):
    assert anon.get(f"/api/v1/shared/{token}/").status_code == 404


def test_all_dead_links_look_identical(anon, make_link, design):
    from django.utils import timezone as tz

    unknown = anon.get("/api/v1/shared/" + "u" * 32 + "/")
    revoked = anon.get(shared_url(make_link("view", is_active=False)))
    expired = anon.get(shared_url(make_link("view", expires_at=past())))
    trashed_link = make_link("view")
    design.trashed_at = tz.now()
    design.save()
    trashed = anon.get(shared_url(trashed_link))
    for response in (revoked, expired, trashed):
        assert response.status_code == unknown.status_code == 404
        assert response.content == unknown.content


def test_link_of_a_deactivated_owner_is_404(anon, view_link, owner):
    owner.is_active = False
    owner.save()
    assert anon.get(shared_url(view_link)).status_code == 404


def test_link_expiring_in_the_future_works(anon, make_link):
    assert anon.get(shared_url(make_link("view", expires_at=future()))).status_code == 200


def test_restoring_a_trashed_design_revives_links(anon, view_link, design):
    design.trashed_at = timezone.now()
    design.save()
    assert anon.get(shared_url(view_link)).status_code == 404
    design.trashed_at = None
    design.save()
    assert anon.get(shared_url(view_link)).status_code == 200


def test_access_accounting(anon, view_link):
    anon.get(shared_url(view_link))
    anon.get(shared_url(view_link))
    view_link.refresh_from_db()
    assert view_link.access_count == 2
    assert view_link.last_accessed_at is not None


def test_view_costs_a_select_and_an_update(anon, view_link, django_assert_max_num_queries):
    with django_assert_max_num_queries(2):
        assert anon.get(shared_url(view_link)).status_code == 200


def test_failed_requests_are_not_counted_as_views(anon, make_link):
    link = make_link("view", password=PASSWORD)
    anon.get(shared_url(link))
    anon.get(shared_url(link), **{HEADER: "wrong"})
    link.refresh_from_db()
    assert link.access_count == 0


def test_password_required_when_header_missing(anon, make_link):
    response = anon.get(shared_url(make_link("view", password=PASSWORD)))
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "password_required"
    assert "document" not in response.content.decode()


def test_wrong_password_is_rejected(anon, make_link):
    response = anon.get(shared_url(make_link("view", password=PASSWORD)), **{HEADER: "nope"})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "password_required"


def test_correct_password_opens_the_link(anon, make_link):
    response = anon.get(shared_url(make_link("view", password=PASSWORD)), **{HEADER: PASSWORD})
    assert response.status_code == 200


def test_password_whitespace_is_trimmed_like_headers(anon, make_link):
    response = anon.get(shared_url(make_link("view", password=PASSWORD)), **{HEADER: f"  {PASSWORD} "})
    assert response.status_code == 200


def test_password_comparison_goes_through_the_hasher(anon, make_link, monkeypatch):
    calls = []
    from apps.sharing import models

    real = models.check_password
    monkeypatch.setattr(models, "check_password", lambda raw, hashed: calls.append(raw) or real(raw, hashed))
    anon.get(shared_url(make_link("view", password=PASSWORD)), **{HEADER: PASSWORD})
    assert calls == [PASSWORD]


def test_missing_password_does_not_count_as_an_attempt(anon, make_link):
    link = make_link("view", password=PASSWORD)
    for _ in range(PASSWORD_LIMIT_PER_TOKEN_AND_IP + 5):
        assert anon.get(shared_url(link)).status_code == 401
    assert anon.get(shared_url(link), **{HEADER: PASSWORD}).status_code == 200


def test_ten_wrong_passwords_lock_the_attacker_out(anon, make_link):
    link = make_link("view", password=PASSWORD)
    for _ in range(PASSWORD_LIMIT_PER_TOKEN_AND_IP):
        assert anon.get(shared_url(link), **{HEADER: "guess"}).status_code == 401
    locked = anon.get(shared_url(link), **{HEADER: "guess"})
    assert locked.status_code == 429
    assert 1 <= int(locked["Retry-After"]) <= 15 * 60
    # even the right password is refused while the window is open
    assert anon.get(shared_url(link), **{HEADER: PASSWORD}).status_code == 429


def test_lockout_does_not_affect_other_addresses(anon, make_link):
    link = make_link("view", password=PASSWORD)
    for _ in range(PASSWORD_LIMIT_PER_TOKEN_AND_IP + 1):
        anon.get(shared_url(link), **{HEADER: "guess", "REMOTE_ADDR": "203.0.113.5"})
    other = anon.get(shared_url(link), **{HEADER: PASSWORD, "REMOTE_ADDR": "203.0.113.6"})
    assert other.status_code == 200


def test_success_resets_the_pair_counter(anon, make_link):
    link = make_link("view", password=PASSWORD)
    for _ in range(PASSWORD_LIMIT_PER_TOKEN_AND_IP - 1):
        anon.get(shared_url(link), **{HEADER: "guess"})
    assert anon.get(shared_url(link), **{HEADER: PASSWORD}).status_code == 200
    for _ in range(PASSWORD_LIMIT_PER_TOKEN_AND_IP - 1):
        assert anon.get(shared_url(link), **{HEADER: "guess"}).status_code == 401


def test_one_address_cannot_spray_many_links(anon, make_link):
    links = [make_link("view", password=PASSWORD) for _ in range(4)]
    attempts = 0
    for link in links[:3]:
        for _ in range(PASSWORD_LIMIT_PER_TOKEN_AND_IP):
            assert anon.get(shared_url(link), **{HEADER: "guess"}).status_code == 401
            attempts += 1
    assert attempts == PASSWORD_LIMIT_PER_IP
    assert anon.get(shared_url(links[3]), **{HEADER: "guess"}).status_code == 429


def test_distributed_guessing_locks_the_token(anon, make_link):
    link = make_link("view", password=PASSWORD)
    for index in range(PASSWORD_LIMIT_PER_TOKEN):
        anon.get(shared_url(link), **{HEADER: "guess", "REMOTE_ADDR": f"198.51.100.{index % 250}"})
    fresh_address = anon.get(shared_url(link), **{HEADER: PASSWORD, "REMOTE_ADDR": "192.0.2.77"})
    assert fresh_address.status_code == 429


def test_forwarded_for_header_cannot_dodge_the_limit(anon, make_link):
    link = make_link("view", password=PASSWORD)
    for index in range(PASSWORD_LIMIT_PER_TOKEN_AND_IP):
        anon.get(shared_url(link), **{HEADER: "guess", "HTTP_X_FORWARDED_FOR": f"10.1.1.{index}"})
    response = anon.get(shared_url(link), **{HEADER: "guess", "HTTP_X_FORWARDED_FOR": "10.9.9.9"})
    assert response.status_code == 429


def test_dead_links_do_not_reveal_password_state(anon, make_link):
    dead = make_link("view", password=PASSWORD, is_active=False)
    assert anon.get(shared_url(dead), **{HEADER: "guess"}).status_code == 404
    assert anon.get(shared_url(dead)).status_code == 404


def test_disabling_the_link_blocks_the_right_password_too(anon, make_link):
    link = make_link("view", password=PASSWORD)
    ShareLink.objects.filter(pk=link.pk).update(is_active=False)
    assert anon.get(shared_url(link), **{HEADER: PASSWORD}).status_code == 404


def test_large_document_round_trips(anon, design, view_link):
    design.document = make_document(pages=20)
    design.page_count = 20
    design.save()
    assert len(anon.get(shared_url(view_link)).json()["document"]["pages"]) == 20
