"""Outgoing calls to providers (`apps.ai.transport`): network policies, pinned addresses, no redirects, one
deadline and a size cap."""

from __future__ import annotations

import time

import pytest

from apps.ai import transport
from apps.ai.transport import TransportError

from .fakes import json_answer

PUBLIC = "93.184.215.14"


def dns(table):
    calls = []

    def lookup(host):
        calls.append(host)
        answer = table.get(host, [])
        return answer.pop(0) if answer and isinstance(answer[0], list) else answer

    lookup.calls = calls
    return lookup


class Response:
    def __init__(self, status=200, headers=None, body=b""):
        self.status = status
        self.headers = {"Content-Type": "image/png", **(headers or {})}
        self.body = body
        self.offset = 0

    def read1(self, size):
        chunk = self.body[self.offset : self.offset + size]
        self.offset += len(chunk)
        return chunk

    def close(self):
        pass


def recorder(response=None):
    seen = []

    def connect(endpoint, watchdog, method, headers, body, timeout):
        seen.append((endpoint, method, headers, body))
        return response or Response(body=b"ok")

    connect.seen = seen
    return connect


def send(url, policy, *, table=None, response=None, max_bytes=1000, timeout=5.0, **kwargs):
    connect = recorder(response)
    result = transport.send(
        "POST",
        url,
        policy=policy,
        body=b"data",
        max_bytes=max_bytes,
        timeout=timeout,
        lookup=dns(table or {"ai.example.com": [PUBLIC]}),
        connect=connect,
        **kwargs,
    )
    return result, connect.seen


@pytest.fixture
def user_policy(settings):
    settings.AI_USER_PROVIDERS_ALLOW_HTTP = False
    return transport.user_policy()


@pytest.fixture
def operator_policy(settings):
    settings.AI_ALLOWED_PRIVATE_HOSTS = ["model-server"]
    return transport.operator_policy()


def test_a_public_https_server_is_called_on_the_checked_address(user_policy):
    result, seen = send("https://ai.example.com:8443/v1/run?x=1", user_policy)
    assert result.status == 200 and result.body == b"ok"
    endpoint, method, headers, body = seen[0]
    assert (endpoint.host, endpoint.port, endpoint.addresses, endpoint.path) == (
        "ai.example.com",
        8443,
        (PUBLIC,),
        "/v1/run?x=1",
    )
    assert method == "POST" and body == b"data"
    assert headers["Host"] == "ai.example.com:8443" and headers["Content-Length"] == "4"


@pytest.mark.parametrize(
    "url, table",
    [
        ("http://ai.example.com/run", None),  # https only for users
        ("https://user:pw@ai.example.com/run", None),
        ("https://127.0.0.1/run", None),
        ("https://10.1.2.3/run", None),
        ("https://192.168.0.10:8080/run", None),
        ("https://[::1]/run", None),
        ("https://[fe80::1]/run", None),
        ("https://169.254.169.254/latest/meta-data", None),  # cloud metadata
        ("https://[fd00:ec2::254]/latest", None),  # metadata over IPv6 (unique local)
        ("https://[::ffff:10.0.0.1]/run", None),
        ("https://[64:ff9b::a9fe:a9fe]/run", None),  # NAT64 of 169.254.169.254
        ("https://0.0.0.0/run", None),
        ("https://metadata.example/run", {"metadata.example": ["169.254.169.254"]}),
        ("https://internal.example/run", {"internal.example": ["10.0.0.7"]}),
        ("https://loop.example/run", {"loop.example": ["127.0.0.1"]}),
        ("https://mixed.example/run", {"mixed.example": [PUBLIC, "192.168.1.5"]}),
        ("https://six.example/run", {"six.example": ["::ffff:127.0.0.1"]}),
        ("file:///etc/passwd", None),
        ("gopher://ai.example.com/", None),
    ],
)
def test_user_providers_cannot_reach_private_addresses(user_policy, url, table):
    with pytest.raises(TransportError) as caught:
        send(url, user_policy, table=table)
    assert caught.value.code == "refused_address"


def test_an_unknown_host_is_unreachable(user_policy):
    with pytest.raises(TransportError) as caught:
        send("https://nowhere.example/run", user_policy, table={})
    assert caught.value.code == "unreachable"


def test_a_dns_answer_that_changes_between_lookups_cannot_swap_in_a_private_address(user_policy):
    """The host is resolved once; the connection goes to the address that was checked."""
    table = {"rebind.example": [[PUBLIC], ["127.0.0.1"]]}
    lookup = dns(table)
    connect = recorder()
    transport.send(
        "POST",
        "https://rebind.example/run",
        policy=user_policy,
        body=b"x",
        max_bytes=100,
        timeout=5,
        lookup=lookup,
        connect=connect,
    )
    assert lookup.calls == ["rebind.example"]
    assert connect.seen[0][0].addresses == (PUBLIC,)
    with pytest.raises(TransportError):  # the second answer would have been refused
        transport.send(
            "POST",
            "https://rebind.example/run",
            policy=user_policy,
            body=b"x",
            max_bytes=100,
            timeout=5,
            lookup=lookup,
            connect=connect,
        )


def test_http_is_allowed_for_users_only_when_the_operator_says_so(settings):
    settings.AI_USER_PROVIDERS_ALLOW_HTTP = True
    result, seen = send("http://ai.example.com/run", transport.user_policy())
    assert result.status == 200 and seen[0][0].port == 80


@pytest.mark.parametrize("port", [22, 25, 6379, 9200, 27017])
def test_user_policy_rejects_disallowed_ports(user_policy, port):
    with pytest.raises(TransportError) as caught:
        send(f"https://ai.example.com:{port}/run", user_policy)
    assert caught.value.code == "refused_address"
    assert f"Port {port} is not allowed" in caught.value.message


def test_operators_may_use_http_ip_literals_and_listed_private_hosts(operator_policy):
    send("http://10.0.0.5:7000/run", operator_policy)
    send("http://127.0.0.1:7000/run", operator_policy)
    _, seen = send("http://model-server:7000/run", operator_policy, table={"model-server": ["172.18.0.3"]})
    assert seen[0][0].addresses == ("172.18.0.3",)


def test_operators_cannot_reach_other_private_host_names(operator_policy):
    with pytest.raises(TransportError) as caught:
        send("http://intranet.example/run", operator_policy, table={"intranet.example": ["10.0.0.9"]})
    assert caught.value.code == "refused_address"


@pytest.mark.parametrize("url", ["http://0.0.0.0:7000/", "http://[::]:7000/", "http://224.0.0.1/"])
def test_no_policy_allows_unspecified_or_multicast_addresses(operator_policy, url):
    with pytest.raises(TransportError):
        send(url, operator_policy)


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_redirects_are_never_followed(user_policy, status):
    with pytest.raises(TransportError) as caught:
        send(
            "https://ai.example.com/run",
            user_policy,
            response=Response(status, {"Location": "http://169.254.169.254/"}),
        )
    assert caught.value.code == "bad_response" and "redirect" in caught.value.message


def test_a_real_redirect_is_not_followed_to_its_target(operator_policy, fake):
    fake.routes[("POST", "/hop")] = lambda request: (302, {"Location": f"{fake.url}/api/remove"}, b"")
    with pytest.raises(TransportError):
        transport.send("POST", f"{fake.url}/hop", policy=operator_policy, body=b"x", max_bytes=100, timeout=5)
    assert [r.path for r in fake.requests] == ["/hop"]


def test_the_answer_size_is_capped(user_policy):
    with pytest.raises(TransportError) as caught:
        send("https://ai.example.com/run", user_policy, response=Response(headers={"Content-Length": "5000"}))
    assert caught.value.code == "too_large"
    with pytest.raises(TransportError) as caught:  # no Content-Length: counted while reading
        send("https://ai.example.com/run", user_policy, response=Response(body=b"x" * 5000))
    assert caught.value.code == "too_large"


def test_error_answers_are_returned_for_the_style_to_judge(user_policy):
    result, _ = send("https://ai.example.com/run", user_policy, response=Response(500, body=b"oops"))
    assert result.status == 500 and result.body == b"oops"


def test_a_slow_server_is_cut_at_the_deadline(operator_policy, fake):
    def slow(request):
        time.sleep(3)
        return json_answer({})

    fake.routes[("POST", "/slow")] = slow
    started = time.monotonic()
    with pytest.raises(TransportError) as caught:
        transport.send(
            "POST", f"{fake.url}/slow", policy=operator_policy, body=b"x", max_bytes=100, timeout=0.5
        )
    assert caught.value.code == "timeout"
    assert time.monotonic() - started < 2


def test_a_slow_dns_lookup_counts_against_the_deadline(user_policy):
    def slow(host):
        time.sleep(3)
        return [PUBLIC]

    started = time.monotonic()
    with pytest.raises(TransportError) as caught:
        transport.send(
            "POST", "https://ai.example.com/", policy=user_policy, max_bytes=10, timeout=0.3, lookup=slow
        )
    assert caught.value.code == "timeout" and time.monotonic() - started < 1.5


def test_a_closed_port_is_unreachable(operator_policy):
    import socket

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    with pytest.raises(TransportError) as caught:
        transport.send("GET", f"http://127.0.0.1:{port}/", policy=operator_policy, max_bytes=10, timeout=3)
    assert caught.value.code == "unreachable"


def test_a_real_round_trip_sends_headers_and_body(operator_policy, fake):
    fake.routes[("PUT", "/echo")] = lambda request: (200, {"Content-Type": "text/plain"}, request.body[::-1])
    result = transport.send(
        "PUT",
        f"{fake.url}/echo",
        policy=operator_policy,
        headers={"X-Api-Key": "k"},
        body=b"abc",
        max_bytes=100,
        timeout=5,
    )
    assert result.body == b"cba" and result.content_type == "text/plain"
    assert fake.requests[0].headers["x-api-key"] == "k"
    assert fake.requests[0].headers["host"] == fake.url.removeprefix("http://")


def test_errors_never_mention_the_url_or_headers(user_policy):
    with pytest.raises(TransportError) as caught:
        transport.send(
            "POST",
            "https://secret-host.example/run?key=abc",
            policy=user_policy,
            headers={"Authorization": "Bearer abc"},
            max_bytes=10,
            timeout=1,
            lookup=dns({"secret-host.example": ["10.0.0.1"]}),
        )
    assert "secret-host" not in caught.value.message and "abc" not in caught.value.message
