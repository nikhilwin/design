"""Fetching images from arbitrary URLs (`apps.assets.remote`): only public https hosts, every hop checked."""

from __future__ import annotations

import socket
import sys
import threading
import time

import pytest
import urllib3

from apps.assets import remote

from .helpers import image_bytes

PUBLIC = "93.184.215.14"


class Response:
    def __init__(self, status=200, headers=None, body=b""):
        self.status = status
        self.headers = {"Content-Type": "image/png", **(headers or {})}
        self.body = body
        self.offset = 0
        self.closed = False

    def read1(self, size):
        chunk = self.body[self.offset : self.offset + size]
        self.offset += len(chunk)
        return chunk

    def close(self):
        self.closed = True


def dns(table):
    return lambda host: table.get(host, [])


def fetch(url, responses, table=None, max_bytes=10_000_000):
    calls = []

    def opener(target, watchdog):
        calls.append(target)
        return responses.pop(0)

    data = remote.fetch_image(
        url, max_bytes=max_bytes, lookup=dns(table or {"img.example": [PUBLIC]}), opener=opener
    )
    return data, calls


def test_a_public_image_is_fetched_from_the_checked_address():
    png = image_bytes()
    data, calls = fetch("https://img.example/a/b.png?x=1", [Response(body=png)])
    assert data == png
    assert calls == [remote.Target(host="img.example", addresses=(PUBLIC,), path="/a/b.png?x=1")]


@pytest.mark.parametrize(
    "url, table",
    [
        ("http://img.example/a.png", None),
        ("https://img.example:8443/a.png", None),
        ("https://user:pw@img.example/a.png", None),
        ("https://127.0.0.1/a.png", None),
        ("https://[::1]/a.png", None),
        ("https://169.254.169.254/latest/meta-data", None),
        ("https://[::ffff:10.0.0.1]/a.png", None),
        ("https://[64:ff9b::a9fe:a9fe]/a.png", None),  # NAT64 of 169.254.169.254
        ("https://[64:ff9b:1::a9fe:a9fe]/a.png", None),  # local-use NAT64
        ("https://[2002:a9fe:a9fe::1]/a.png", None),  # 6to4
        ("https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/a.png", None),  # Teredo
        ("https://[::127.0.0.1]/a.png", None),  # IPv4-compatible
        ("https://six.example/a.png", {"six.example": ["64:ff9b::7f00:1"]}),
        ("https://internal.example/a.png", {"internal.example": ["10.1.2.3"]}),
        ("https://mixed.example/a.png", {"mixed.example": [PUBLIC, "192.168.1.5"]}),
        ("https://nowhere.example/a.png", {}),
        ("file:///etc/passwd", None),
    ],
)
def test_private_and_odd_urls_are_refused(url, table):
    with pytest.raises(remote.RemoteImageError):
        fetch(url, [Response(body=image_bytes())], table)


def test_redirects_are_checked_hop_by_hop():
    png = image_bytes()
    table = {"img.example": [PUBLIC], "cdn.example": [PUBLIC], "evil.example": ["127.0.0.1"]}
    data, calls = fetch(
        "https://img.example/a.png",
        [Response(302, {"Location": "https://cdn.example/b.png"}), Response(body=png)],
        table,
    )
    assert data == png and [c.host for c in calls] == ["img.example", "cdn.example"]
    with pytest.raises(remote.RemoteImageError, match="public internet"):
        fetch("https://img.example/a.png", [Response(302, {"Location": "https://evil.example/"})], table)
    with pytest.raises(remote.RemoteImageError, match="Too many redirects"):
        fetch("https://img.example/a.png", [Response(302, {"Location": "/again"}) for _ in range(5)], table)


def test_size_type_and_status_are_checked():
    with pytest.raises(remote.RemoteImageTooLarge):
        fetch("https://img.example/a.png", [Response(headers={"Content-Length": "999"})], max_bytes=100)
    with pytest.raises(remote.RemoteImageTooLarge):
        fetch("https://img.example/a.png", [Response(body=b"x" * 500)], max_bytes=100)
    with pytest.raises(remote.RemoteImageError, match="not an image"):
        fetch("https://img.example/a.html", [Response(headers={"Content-Type": "text/html"})])
    with pytest.raises(remote.RemoteImageError, match="404"):
        fetch("https://img.example/a.png", [Response(404)])


def test_nat64_addresses_of_public_hosts_are_allowed():
    assert remote.is_public("64:ff9b::5db8:d70e")  # 93.184.215.14
    assert not remote.is_public("64:ff9b::a00:1")  # 10.0.0.1


class FakeConnection:
    """Stands in for urllib3's HTTPSConnection: `down` addresses refuse the connection."""

    down: set[str] = set()
    requests: list[tuple[str, dict]] = []

    def __init__(self, address, **kwargs):
        self.address = address
        self.sock = None
        self.timeout = None

    def connect(self):
        if self.address in self.down:
            raise urllib3.exceptions.NewConnectionError(None, "unreachable")

    def request(self, method, path, headers, **kwargs):
        self.requests.append((self.address, headers))

    def getresponse(self):
        return Response(body=b"img")

    def close(self):
        pass


@pytest.fixture
def fake_connections(monkeypatch):
    monkeypatch.setattr(urllib3.connection, "HTTPSConnection", FakeConnection)
    monkeypatch.setattr(FakeConnection, "down", set())
    monkeypatch.setattr(FakeConnection, "requests", [])
    return FakeConnection


def test_every_checked_address_is_tried_in_turn(fake_connections):
    fake_connections.down = {"2606:2800:220:1::1"}
    target = remote.Target(host="img.example", addresses=("2606:2800:220:1::1", PUBLIC), path="/a.png")
    with remote.Watchdog(time.monotonic() + 5) as watchdog:
        remote._open(target, watchdog)
        assert [address for address, _ in fake_connections.requests] == [PUBLIC]
        fake_connections.down = {"2606:2800:220:1::1", PUBLIC}
        with pytest.raises(urllib3.exceptions.NewConnectionError):
            remote._open(target, watchdog)


def test_an_ipv6_literal_host_header_is_bracketed(fake_connections):
    with remote.Watchdog(time.monotonic() + 5) as watchdog:
        remote._open(remote.check_url("https://[2606:2800:220:1::1]/a.png"), watchdog)
        remote._open(
            remote.check_url("https://img.example/a.png", lookup=dns({"img.example": [PUBLIC]})), watchdog
        )
    assert [headers["Host"] for _, headers in fake_connections.requests] == [
        "[2606:2800:220:1::1]",
        "img.example",
    ]


def drip_server(script):
    """A local TCP server that reads the request (if `script` says so) and runs `script(conn, stop)`."""
    listener = socket.create_server(("127.0.0.1", 0))
    stop = threading.Event()

    def serve():
        listener.settimeout(5)
        try:
            conn, _ = listener.accept()
        except OSError:
            return
        with conn:
            try:
                script(conn, stop)
            except OSError:
                return

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    return listener, stop, thread


def drip(conn, stop, data=b"x"):
    while not stop.is_set():
        conn.sendall(data)
        time.sleep(0.2)


def _drip_body(conn, stop):
    conn.recv(4096)
    conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 100000\r\n\r\n")
    drip(conn, stop)


def _drip_headers(conn, stop):
    conn.recv(4096)
    conn.sendall(b"HTTP/1.1 200 OK\r\nX-Slow: ")
    drip(conn, stop)  # one header line that never ends


def _unanswered(conn, stop):
    conn.recv(4096)
    stop.wait(30)  # reads the request, never answers: only the watchdog ends the 10 s read


def _silent(conn, stop):
    stop.wait(30)  # accepts the connection, then says nothing: a TLS handshake waits for the server hello


@pytest.fixture
def server(request):
    listener, stop, thread = drip_server(request.param)
    yield listener.getsockname()[1]
    stop.set()
    listener.close()
    thread.join(timeout=5)


def plain_opener(port):
    """The real request path, over plain HTTP to the local server."""
    return lambda target, watchdog: remote.request(
        urllib3.connection.HTTPConnection("127.0.0.1", port=port), target, watchdog
    )


def tls_opener(port):
    """The real request path with TLS, to a local server that never answers the handshake."""
    return lambda target, watchdog: remote.request(
        urllib3.connection.HTTPSConnection("127.0.0.1", port=port, cert_reqs="CERT_NONE"), target, watchdog
    )


@pytest.mark.parametrize(
    ("server", "make_opener"),
    [
        (_drip_body, plain_opener),
        (_drip_headers, plain_opener),
        pytest.param(
            _unanswered,
            plain_opener,
            marks=pytest.mark.xfail(
                sys.platform == "win32",
                reason="shutdown() does not wake a blocked recv on Windows",
                strict=True,
            ),
        ),
        (_silent, tls_opener),
    ],
    indirect=["server"],
    ids=["body", "headers", "unanswered", "tls-handshake"],
)
def test_a_server_dripping_bytes_in_any_phase_cannot_hold_the_worker_past_the_deadline(
    monkeypatch, server, make_opener
):
    monkeypatch.setattr(remote, "DEADLINE_SECONDS", 1.0)
    monkeypatch.setattr(remote, "CONNECT_TIMEOUT", 10.0)  # so the handshake case is ended by the watchdog
    started = time.monotonic()
    with pytest.raises(remote.RemoteImageError, match="took too long"):
        remote.fetch_image(
            "https://img.example/a.png",
            max_bytes=10_000_000,
            lookup=dns({"img.example": [PUBLIC]}),
            opener=make_opener(server),
        )
    assert time.monotonic() - started < 2.5  # not READ_TIMEOUT per byte


def test_the_watchdog_stops_without_firing_when_the_download_ends_in_time():
    with remote.Watchdog(time.monotonic() + 0.2) as watchdog:
        pass
    time.sleep(0.4)
    assert watchdog.fired is False


def test_a_slow_dns_lookup_counts_against_the_deadline(monkeypatch):
    monkeypatch.setattr(remote, "DEADLINE_SECONDS", 0.5)

    def slow(host):
        time.sleep(3)
        return [PUBLIC]

    started = time.monotonic()
    with pytest.raises(remote.RemoteImageError, match="took too long"):
        remote.fetch_image("https://img.example/a.png", max_bytes=1000, lookup=slow, opener=None)
    assert time.monotonic() - started < 1.5


def test_lookup_errors_still_reach_the_caller():
    with pytest.raises(remote.RemoteImageError, match="Cannot find the host"):
        remote.fetch_image(
            "https://nowhere.invalid/a.png",
            max_bytes=1000,
            lookup=lambda host: remote.resolve("nowhere.invalid"),
            opener=None,
        )


def test_a_certificate_for_another_host_is_a_clean_failure():
    from urllib3.util.ssl_match_hostname import CertificateError

    def opener(target, watchdog):
        raise CertificateError("hostname 'img.example' doesn't match 'other.example'")

    with pytest.raises(remote.RemoteImageError, match="The download failed"):
        remote.fetch_image(
            "https://img.example/a.png", max_bytes=1000, lookup=dns({"img.example": [PUBLIC]}), opener=opener
        )


def test_every_connection_is_closed_redirects_included():
    closed = []

    class Conn:
        def __init__(self, name):
            self.name = name

        def close(self):
            closed.append(self.name)

    responses = [Response(302, {"Location": "/b.png"}), Response(body=image_bytes())]

    def opener(target, watchdog):
        watchdog.watch(Conn(target.path))
        return responses.pop(0)

    remote.fetch_image(
        "https://img.example/a.png",
        max_bytes=10_000_000,
        lookup=dns({"img.example": [PUBLIC]}),
        opener=opener,
    )
    assert closed == ["/a.png", "/b.png"]
