"""Small pieces: rate limiting, origins, client addresses, bookkeeping, configuration, statistics."""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.collab import access, availability, store
from apps.collab.consumers import client_ip
from apps.collab.limits import TokenBucket
from apps.collab.models import CollabInstance, RoomConnection
from apps.collab.room import VersionTracker, color_for

pytestmark = pytest.mark.django_db


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def bucket(clock: Clock) -> TokenBucket:
    return TokenBucket(2, 4, 100, 300, clock=clock)


def test_the_bucket_allows_a_burst_then_refills():
    clock = Clock()
    limiter = bucket(clock)
    assert [limiter.allow(10) for _ in range(5)] == [True, True, True, True, False]
    clock.now += 1.0
    assert limiter.allow(10) and limiter.allow(10) and not limiter.allow(10)


def test_the_bucket_never_exceeds_its_capacity():
    clock = Clock()
    limiter = bucket(clock)
    clock.now += 1000
    assert sum(limiter.allow(1) for _ in range(10)) == 4


def test_a_frame_larger_than_the_byte_budget_is_refused_without_spending_messages():
    clock = Clock()
    limiter = bucket(clock)
    assert limiter.allow(301) is False
    assert sum(limiter.allow(1) for _ in range(10)) == 4


def test_bytes_and_messages_are_limited_independently():
    clock = Clock()
    limiter = TokenBucket(1000, 1000, 10, 25, clock=clock)
    assert limiter.allow(20) and not limiter.allow(20)
    clock.now += 1
    assert limiter.allow(10)


def test_the_bucket_reads_its_rates_from_settings(settings):
    settings.REALTIME_RATE_BURST = 2
    settings.REALTIME_RATE_MESSAGES_PER_SECOND = 1
    limiter = TokenBucket.from_settings()
    assert limiter.allow(1) and limiter.allow(1) and not limiter.allow(1)


@pytest.mark.parametrize(
    ("origin", "host", "allowed"),
    [
        ("http://localhost:5173", "localhost:5173", True),
        ("http://localhost:5173", None, True),  # a trusted origin needs no host
        ("https://evil.example", "localhost:5173", False),
        ("https://evil.example", "evil.example", False),  # same host, but not an allowed host
        ("http://localhost:9999", "localhost:5173", False),
        ("http://127.0.0.1:8000", "127.0.0.1:8000", True),  # same origin as the request and an allowed host
        ("http://127.0.0.1:8000", "localhost:8000", False),
        (None, "localhost:5173", False),
        ("", "localhost:5173", False),
        ("null", "localhost:5173", False),
        ("ftp://localhost:5173", "localhost:5173", False),
        ("javascript:alert(1)", "localhost", False),
        ("HTTP://LOCALHOST:5173", "localhost:5173", True),
    ],
)
def test_origin_policy(origin, host, allowed):
    assert access.origin_allowed(origin, host) is allowed


def test_trusted_origins_may_use_wildcards(settings):
    settings.CSRF_TRUSTED_ORIGINS = ["https://*.example.com"]
    settings.SITE_URL = "https://example.com"
    assert access.origin_allowed("https://app.example.com", "other.test")
    assert access.origin_allowed("https://example.com", "other.test")
    assert not access.origin_allowed("https://example.org", "other.test")
    assert not access.origin_allowed("http://app.example.com", "other.test")


def scope(headers=(), client=("203.0.113.9", 4000)):
    return {"headers": [(name.encode(), value.encode()) for name, value in headers], "client": client}


def test_client_ip_without_a_proxy_is_the_socket_address(settings):
    settings.REST_FRAMEWORK = {**settings.REST_FRAMEWORK, "NUM_PROXIES": None}
    assert client_ip(scope([("x-forwarded-for", "1.2.3.4")])) == "203.0.113.9"


def test_client_ip_behind_proxies_takes_the_address_the_trusted_proxy_saw(settings):
    settings.REST_FRAMEWORK = {**settings.REST_FRAMEWORK, "NUM_PROXIES": 1}
    assert client_ip(scope([("x-forwarded-for", "6.6.6.6, 1.2.3.4")])) == "1.2.3.4"
    settings.REST_FRAMEWORK = {**settings.REST_FRAMEWORK, "NUM_PROXIES": 2}
    assert client_ip(scope([("x-forwarded-for", "6.6.6.6, 1.2.3.4")])) == "6.6.6.6"


def test_client_ip_falls_back_when_the_header_is_missing_or_short(settings):
    settings.REST_FRAMEWORK = {**settings.REST_FRAMEWORK, "NUM_PROXIES": 3}
    assert client_ip(scope([("x-forwarded-for", "1.2.3.4")])) == "203.0.113.9"
    assert client_ip(scope()) == "203.0.113.9"
    assert client_ip({"headers": []}) == ""


def test_version_tracker_advances_over_contiguous_batches_only():
    tracker = VersionTracker(5)
    tracker.add(7)
    assert tracker.contiguous == 5 and tracker.latest == 7
    tracker.add(6)
    assert tracker.contiguous == 7
    tracker.add(6)
    tracker.add(3)
    assert tracker.contiguous == 7
    tracker.reset(20)
    assert (tracker.contiguous, tracker.latest) == (20, 20)


def test_colours_are_stable_per_user():
    user = uuid.uuid4()
    assert color_for(user) == color_for(user)
    assert len({color_for(uuid.uuid4()) for _ in range(60)}) > 3


def test_realtime_availability_follows_the_settings(settings):
    assert availability.realtime_enabled() is True
    settings.REALTIME_ENABLED = False
    assert availability.realtime_enabled() is False
    settings.REALTIME_ENABLED = True
    settings.CHANNEL_LAYERS = {}
    assert availability.realtime_enabled() is False


def test_the_websocket_route_exists_only_when_enabled():
    from apps.collab.routing import websocket_urlpatterns

    assert len(websocket_urlpatterns) == 1


@pytest.fixture
def staff(db):
    return User.objects.create_user("staff@example.com", "staff-pass-123", is_staff=True)


@pytest.fixture
def design(db, staff):
    from apps.designs.models import Design

    return Design.objects.create(owner=staff, title="x", document={"pages": []})


def test_stats_are_staff_only(db, staff, django_user_model):
    anonymous = APIClient().get("/api/v1/collab/stats/")
    assert anonymous.status_code in (401, 403)
    member = django_user_model.objects.create_user("plain@example.com", "plain-pass-123")
    client = APIClient()
    client.force_login(member)
    assert client.get("/api/v1/collab/stats/").status_code == 403
    client.force_login(staff)
    assert client.get("/api/v1/collab/stats/").status_code == 200


def test_stats_count_live_rooms_and_ignore_dead_processes(staff, design):
    now = timezone.now()
    for role, instance, beat in [
        ("owner", "host:1:a", now),
        ("edit", "host:1:a", now),
        ("view", "host:2:b", now),
        ("edit", "ghost:9:z", now - timedelta(minutes=10)),
    ]:
        RoomConnection.objects.create(
            design=design, user=staff, instance=instance, role=role, heartbeat_at=beat
        )
    CollabInstance.objects.create(
        instance="host:1:a", heartbeat_at=now, counters={"connects": 2, "flushes": 1}
    )
    CollabInstance.objects.create(instance="host:2:b", heartbeat_at=now, counters={"connects": 1})
    CollabInstance.objects.create(
        instance="ghost:9:z", heartbeat_at=now - timedelta(minutes=10), counters={"connects": 99}
    )
    client = APIClient()
    client.force_login(staff)
    body = client.get("/api/v1/collab/stats/").json()
    assert body["rooms"] == 1 and body["connections"] == 3
    assert body["by_role"] == {"owner": 1, "edit": 1, "view": 1}
    assert body["designs"] == [{"design": str(design.pk), "connections": 3}]
    assert body["counters"] == {"connects": 3, "flushes": 1}
    assert [item["instance"] for item in body["instances"]] == ["host:1:a", "host:2:b"]


def test_heartbeat_refreshes_rows_and_forget_removes_them(staff, design):
    stale = timezone.now() - timedelta(seconds=25)
    row = RoomConnection.objects.create(
        design=design, user=staff, instance="me", role="owner", heartbeat_at=stale
    )
    leaked = RoomConnection.objects.create(
        design=design, user=staff, instance="me", role="owner", heartbeat_at=stale
    )
    store.heartbeat("me", False, {"connects": 1}, [row.pk])
    row.refresh_from_db()
    leaked.refresh_from_db()
    assert row.heartbeat_at > stale
    assert leaked.heartbeat_at == stale  # a row this process does not hold goes stale on its own
    assert CollabInstance.objects.get(instance="me").counters == {"connects": 1}
    store.forget_instance("me")
    assert not RoomConnection.objects.filter(instance="me").exists()
    assert not CollabInstance.objects.filter(instance="me").exists()


def test_a_room_counts_as_live_until_its_heartbeat_goes_stale(staff, design):
    assert store.room_is_live(design.pk) is False
    row = RoomConnection.objects.create(
        design=design, user=staff, instance="me", role="owner", heartbeat_at=timezone.now()
    )
    assert store.room_is_live(design.pk) is True
    RoomConnection.objects.filter(pk=row.pk).update(heartbeat_at=timezone.now() - timedelta(minutes=2))
    assert store.room_is_live(design.pk) is False


def test_admission_checks_both_limits(staff, design, settings):
    settings.REALTIME_MAX_CONNECTIONS_PER_DESIGN = 2
    settings.REALTIME_MAX_CONNECTIONS_PER_USER = 5
    results = [store.admit(design.pk, staff.pk, "owner", None, "me").ok for _ in range(3)]
    assert results == [True, True, False]
    assert RoomConnection.objects.filter(design=design).count() == 2
    store.release(RoomConnection.objects.first().pk)
    assert store.admit(design.pk, staff.pk, "owner", None, "me").ok is True
