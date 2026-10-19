import pytest
from django.core.cache import cache

from apps.designs.exceptions import InlineAssetNotAllowed, InvalidDocument
from apps.designs.models import Design, DesignVersion
from apps.sharing import services
from apps.sharing.models import ShareLink

from .conftest import PASSWORD, future, make_document, past


def valid_document(**overrides):
    return {**make_document(), **overrides}


# ---- save_shared_document -----------------------------------------------------------------


def test_save_updates_everything_in_one_go(design):
    saved = services.save_shared_document(
        design, make_document(pages=2, width=640, height=480), 1, design.owner
    )
    assert saved.revision == 2
    assert saved.updated_at == Design.objects.get(pk=design.pk).updated_at
    design.refresh_from_db()
    assert (design.revision, design.width, design.height, design.page_count) == (2, 640, 480, 2)


def test_save_refreshes_updated_at(design):
    before = design.updated_at
    services.save_shared_document(design, make_document(), 1, design.owner)
    design.refresh_from_db()
    assert design.updated_at > before


def test_conflict_reports_current_state_and_changes_nothing(design):
    with pytest.raises(services.RevisionConflict) as info:
        services.save_shared_document(design, make_document(pages=9), 5, design.owner)
    assert info.value.current_revision == 1
    design.refresh_from_db()
    assert design.page_count == 1


def test_a_racing_writer_is_caught_by_the_compare_and_swap(design, monkeypatch):
    """Simulates another save landing between the revision check and the write (no row locks on SQLite)."""
    real_validate = services.validate_document

    def validate_then_lose_the_race(document, **kwargs):
        real_validate(document, **kwargs)
        Design.objects.filter(pk=design.pk).update(revision=2, page_count=7)

    monkeypatch.setattr(services, "validate_document", validate_then_lose_the_race)
    with pytest.raises(services.RevisionConflict) as info:
        services.save_shared_document(design, make_document(pages=3), 1, design.owner)
    assert info.value.current_revision == 2
    design.refresh_from_db()
    assert design.page_count != 3  # the losing save wrote nothing


def test_invalid_document_rolls_back(design):
    with pytest.raises(InvalidDocument):
        services.save_shared_document(design, {"nope": True}, 1, design.owner)
    design.refresh_from_db()
    assert design.revision == 1


def test_save_to_deleted_design_is_unavailable(design):
    stale = Design.objects.get(pk=design.pk)
    design.delete()
    with pytest.raises(services.DesignUnavailable):
        services.save_shared_document(stale, make_document(), 1, stale.owner)


def test_local_image_references_are_refused_like_for_owners(design):
    document = make_document()
    document["pages"][0]["background"] = {"type": "image", "src": "idb://abc"}
    with pytest.raises(InlineAssetNotAllowed):
        services.save_shared_document(design, document, 1, design.owner)
    design.refresh_from_db()
    assert design.revision == 1


def test_save_records_an_automatic_version_for_the_editor(design, django_user_model):
    editor = django_user_model.objects.create_user(email="editor@example.test", password="pw-12345-xyz")
    services.save_shared_document(design, make_document(pages=2), 1, editor)
    version = DesignVersion.objects.get(design=design)
    assert (version.is_auto, version.created_by_id, version.page_count) == (True, editor.pk, 2)


# ---- links ---------------------------------------------------------------------------------


def test_resolve_link_variants(make_link, design):
    live = make_link("view")
    assert services.resolve_link(live.token).pk == live.pk
    for dead in (make_link("view", is_active=False), make_link("view", expires_at=past())):
        with pytest.raises(services.ShareLinkNotFound):
            services.resolve_link(dead.token)


def test_resolve_link_defers_the_document_unless_asked(view_link, django_assert_num_queries):
    lazy = services.resolve_link(view_link.token)
    eager = services.resolve_link(view_link.token, with_document=True)
    with django_assert_num_queries(0):
        assert eager.design.document
    with django_assert_num_queries(1):
        assert lazy.design.document


def test_count_active_links(make_link, design):
    make_link("view")
    make_link("edit", expires_at=future())
    make_link("view", is_active=False)
    make_link("view", expires_at=past())
    assert services.count_active_links(design) == 2


def test_record_access_is_atomic_increment(view_link):
    stale_copy = ShareLink.objects.get(pk=view_link.pk)
    services.record_access(view_link)
    services.record_access(stale_copy)
    view_link.refresh_from_db()
    assert view_link.access_count == 2


# ---- password gate -------------------------------------------------------------------------


def test_gate_is_open_without_password(view_link):
    services.enforce_link_password(view_link, None, "1.1.1.1")
    services.enforce_link_password(view_link, "whatever", "1.1.1.1")


def test_gate_outcomes(make_link):
    link = make_link("view", password=PASSWORD)
    with pytest.raises(services.PasswordRequired):
        services.enforce_link_password(link, None, "1.1.1.1")
    with pytest.raises(services.PasswordRequired):
        services.enforce_link_password(link, "   ", "1.1.1.1")
    with pytest.raises(services.PasswordRequired):
        services.enforce_link_password(link, "nope", "1.1.1.1")
    services.enforce_link_password(link, PASSWORD, "1.1.1.1")


def test_lockout_reports_retry_after(make_link):
    link = make_link("view", password=PASSWORD)
    for _ in range(services.PASSWORD_LIMIT_PER_TOKEN_AND_IP):
        with pytest.raises(services.PasswordRequired):
            services.enforce_link_password(link, "bad", "2.2.2.2")
    with pytest.raises(services.PasswordLocked) as info:
        services.enforce_link_password(link, "bad", "2.2.2.2")
    assert 1 <= info.value.retry_after <= services.PASSWORD_WINDOW_SECONDS


def test_counters_expire_with_the_window(make_link):
    link = make_link("view", password=PASSWORD)
    for _ in range(services.PASSWORD_LIMIT_PER_TOKEN_AND_IP):
        with pytest.raises(services.PasswordRequired):
            services.enforce_link_password(link, "bad", "3.3.3.3")
    cache.clear()  # what the cache does when the 15 minute window elapses
    services.enforce_link_password(link, PASSWORD, "3.3.3.3")


def test_cache_keys_do_not_contain_raw_tokens_or_addresses(make_link):
    link = make_link("view", password=PASSWORD)
    with pytest.raises(services.PasswordRequired):
        services.enforce_link_password(link, "bad", "4.4.4.4")
    attempts = services.PasswordAttempts.for_request(link.token, "4.4.4.4")
    for bucket in (attempts.pair, attempts.per_ip, attempts.per_token):
        assert link.token not in bucket.key and "4.4.4.4" not in bucket.key
        assert bucket.count() == 1
