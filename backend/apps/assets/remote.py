"""Fetch an image from a URL someone gave us, without letting them aim the server at its own network.

Unlike the stock providers (allow-listed CDNs, `providers.download_image`), the host here is arbitrary, so
every hop is checked: https on port 443 only, no credentials in the URL, and every address the host resolves
to must be a public one. The connection then goes to the address that was checked, with TLS verified against
the host name, so a second DNS answer cannot swap in a private address (DNS rebinding). Redirects are
followed by hand and each target is checked the same way.

One deadline covers the whole download, redirects and DNS lookups included: a watchdog shuts the socket down
when it passes, whatever the request is doing (connecting, the TLS handshake, the headers or the body), and
each lookup gets only the time left. Socket timeouts alone restart with every byte, so a server trickling
bytes in any phase could otherwise hold a worker for minutes.
"""

from __future__ import annotations

import contextlib
import http.client
import ipaddress
import socket
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin, urlsplit

import certifi
import urllib3
import urllib3.connection
from urllib3.util.ssl_match_hostname import CertificateError

from .providers import _UNSAFE_URL_CHARS, USER_AGENT

CONNECT_TIMEOUT = 3.05
READ_TIMEOUT = 10.0
DEADLINE_SECONDS = 25.0
CHUNK_BYTES = 16 * 1024
WATCHDOG_POLL_SECONDS = 0.05
MAX_REDIRECTS = 3
_REDIRECT_CODES = frozenset({301, 302, 303, 307, 308})


class RemoteImageError(Exception):
    """The URL is not allowed, or fetching it failed; the message can be shown to the user."""


class RemoteImageTooLarge(RemoteImageError):
    pass


class RemoteImageTimeout(RemoteImageError):
    """A step overran the time it was given."""


@dataclass(frozen=True)
class Target:
    host: str
    addresses: tuple[str, ...]  # every address the host resolved to, all checked; tried in order
    path: str  # path and query, as sent in the request line

    @property
    def host_header(self) -> str:
        return f"[{self.host}]" if ":" in self.host else self.host  # an IPv6 literal goes in brackets


def resolve(host: str) -> list[str]:
    try:
        infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError) as exc:
        raise RemoteImageError(f"Cannot find the host {host}.") from exc
    return list(dict.fromkeys(info[4][0] for info in infos))


# IPv6 ranges that carry an IPv4 address the network may route to: refused outright, because the IPv4
# address inside could be a private one (Python counts most of them as global).
_TUNNELS = tuple(
    ipaddress.ip_network(net)
    for net in (
        "::/96",  # IPv4-compatible (deprecated)
        "64:ff9b:1::/48",  # local-use NAT64 (RFC 8215)
        "2001::/32",  # Teredo
        "2002::/16",  # 6to4
    )
)
_NAT64 = ipaddress.ip_network("64:ff9b::/96")  # well-known NAT64 prefix (RFC 6052): check the IPv4 inside


def is_public(address: str) -> bool:
    ip = ipaddress.ip_address(address.split("%", 1)[0])
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        elif ip in _NAT64:
            ip = ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
        elif any(ip in net for net in _TUNNELS):
            return False
    return ip.is_global and not ip.is_multicast


def check_url(url: str, *, lookup: Callable[[str], list[str]] = resolve) -> Target:
    """The checked target of `url`, or RemoteImageError."""
    if len(url) > 2048 or _UNSAFE_URL_CHARS.search(url):
        raise RemoteImageError("The URL is too long or contains unsafe characters.")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as exc:
        raise RemoteImageError("That is not a valid URL.") from exc
    if parts.scheme != "https":
        raise RemoteImageError("Only https URLs are allowed.")
    if not parts.hostname or parts.username is not None or parts.password is not None:
        raise RemoteImageError("The URL needs a host and no user name or password.")
    if port not in (None, 443):
        raise RemoteImageError("Only the standard https port is allowed.")
    host = parts.hostname
    try:
        ipaddress.ip_address(host)
        literal = True
    except ValueError:
        literal = False
    addresses = [host] if literal else lookup(host)
    if not addresses or not all(is_public(address) for address in addresses):
        raise RemoteImageError("That address is not on the public internet.")
    path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    return Target(host=host, addresses=tuple(addresses), path=path)


def resolve_within(lookup: Callable[[str], list[str]], host: str, seconds: float) -> list[str]:
    """`lookup(host)`, given at most `seconds`. `getaddrinfo` takes no timeout, so it runs on a daemon thread;
    one that overruns is left to finish (the resolver's own timeout ends it) and its answer is dropped."""
    outcome: dict[str, Any] = {}

    def run() -> None:
        try:
            outcome["addresses"] = lookup(host)
        except BaseException as exc:  # handed to the caller below
            outcome["error"] = exc

    thread = threading.Thread(target=run, name="remote-image-dns", daemon=True)
    thread.start()
    thread.join(max(0.0, seconds))
    if thread.is_alive():
        raise RemoteImageTimeout("The download took too long.")
    if "error" in outcome:
        raise outcome["error"]
    return outcome["addresses"]


class Watchdog:
    """Shuts down the socket of the connection it watches once `deadline` passes, which wakes any read or
    handshake blocked on it. A connection whose socket does not exist yet (still connecting, bounded by its
    connect timeout) is cut as soon as it gets one."""

    def __init__(self, deadline: float) -> None:
        self.deadline = deadline
        self.fired = False
        self._conn: Any = None
        self._lock = threading.Lock()
        self._done = threading.Event()
        self._thread = threading.Thread(target=self._run, name="remote-image-watchdog", daemon=True)
        self._thread.start()

    def left(self) -> float:
        return self.deadline - time.monotonic()

    def watch(self, conn: Any) -> None:
        with self._lock:
            self._conn = conn

    def release(self) -> None:
        """Close the watched connection (`response.close()` leaves its socket open) and stop watching it."""
        with self._lock:
            conn, self._conn = self._conn, None
        if conn is not None:
            conn.close()

    def stop(self) -> None:
        self._done.set()

    def _run(self) -> None:
        if self._done.wait(max(0.0, self.left())):
            return
        self.fired = True
        while not self._done.is_set():
            with self._lock:
                sock = getattr(self._conn, "sock", None)
            if sock is not None:
                with contextlib.suppress(OSError):  # already closed
                    sock.shutdown(socket.SHUT_RDWR)
            self._done.wait(WATCHDOG_POLL_SECONDS)  # again, in case a new socket appeared meanwhile

    def __enter__(self) -> Watchdog:
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop()


def request(
    conn: Any,
    target: Target,
    watchdog: Watchdog,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    read_timeout: float | None = None,
) -> Any:
    """Connect `conn` under `watchdog` and send `method` to `target.path` (by default a GET for an image);
    the response, its body not read yet."""
    watchdog.watch(conn)
    conn.timeout = max(0.001, min(CONNECT_TIMEOUT, watchdog.left()))
    conn.connect()
    # Per read; the watchdog bounds the total.
    conn.timeout = READ_TIMEOUT if read_timeout is None else read_timeout
    conn.request(
        method,
        target.path,
        body=body,
        headers=headers or {"Host": target.host_header, "User-Agent": USER_AGENT, "Accept": "image/*"},
        preload_content=False,
    )
    return conn.getresponse()


def _open(target: Target, watchdog: Watchdog) -> Any:
    """GET `target.path` from the first of `target.addresses` that answers, with SNI and certificate checks
    for `target.host`."""
    failure: Exception | None = None
    for address in target.addresses:
        if watchdog.left() <= 0:
            break
        conn = urllib3.connection.HTTPSConnection(
            address,
            port=443,
            cert_reqs="CERT_REQUIRED",
            ca_certs=certifi.where(),
            server_hostname=target.host,
            assert_hostname=target.host,
        )
        try:
            return request(conn, target, watchdog)
        except (urllib3.exceptions.NewConnectionError, urllib3.exceptions.ConnectTimeoutError) as exc:
            conn.close()
            failure = exc  # unreachable (a dual-stack host without a working IPv6 route, say): next one
        except BaseException:
            conn.close()
            raise
    raise failure or RemoteImageError("The download took too long.")


def read_body(response: Any, *, max_bytes: int) -> bytes:
    buffer = bytearray()
    while True:
        chunk = response.read1(CHUNK_BYTES)  # whatever has arrived, up to CHUNK_BYTES; b"" at the end
        if not chunk:
            return bytes(buffer)
        buffer.extend(chunk)
        if len(buffer) > max_bytes:
            raise RemoteImageTooLarge("The image is too large.")


# What a request can raise when the server misbehaves or the watchdog cuts the socket.
# A certificate for another host fails urllib3's own name check, which raises a ValueError subclass.
TRANSPORT_ERRORS = (urllib3.exceptions.HTTPError, http.client.HTTPException, OSError, CertificateError)


def fetch_image(
    url: str,
    *,
    max_bytes: int,
    lookup: Callable[[str], list[str]] = resolve,
    opener: Callable[[Target, Watchdog], Any] = _open,
) -> bytes:
    """The bytes of the image at `url` (an image/* response of at most `max_bytes`)."""
    with Watchdog(time.monotonic() + DEADLINE_SECONDS) as watchdog:
        try:
            return _fetch(url, max_bytes=max_bytes, lookup=lookup, opener=opener, watchdog=watchdog)
        except RemoteImageError:
            raise
        except TRANSPORT_ERRORS as exc:
            if watchdog.fired or watchdog.left() <= 0:
                raise RemoteImageError("The download took too long.") from exc
            raise RemoteImageError("The download failed.") from exc


def _fetch(url: str, *, max_bytes: int, lookup, opener, watchdog: Watchdog) -> bytes:
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        if watchdog.left() <= 0:
            raise RemoteImageError("The download took too long.")
        target = check_url(current, lookup=lambda host: resolve_within(lookup, host, watchdog.left()))
        response = opener(target, watchdog)
        try:
            if watchdog.fired:  # cut while reading the headers: they may be incomplete
                raise RemoteImageError("The download took too long.")
            if response.status in _REDIRECT_CODES:
                location = response.headers.get("Location")
                if not location:
                    raise RemoteImageError("The server redirected without a target.")
                current = urljoin(current, location)
                continue
            if response.status != 200:
                raise RemoteImageError(f"The server answered {response.status}.")
            if not response.headers.get("Content-Type", "").lower().startswith("image/"):
                raise RemoteImageError("That URL is not an image.")
            declared = response.headers.get("Content-Length", "")
            if declared.isdigit() and int(declared) > max_bytes:
                raise RemoteImageTooLarge("The image is too large.")
            body = read_body(response, max_bytes=max_bytes)
            if watchdog.fired:  # cut at the deadline: what arrived is not the whole image
                raise RemoteImageError("The download took too long.")
            return body
        finally:
            response.close()
            watchdog.release()
    raise RemoteImageError("Too many redirects.")
