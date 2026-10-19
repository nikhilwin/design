"""Outgoing HTTP to AI providers, built on the pieces of `apps.assets.remote`.

Every call is checked against a network policy before anything is sent:

* **user** providers (anyone's own server): https only (http only with `AI_USER_PROVIDERS_ALLOW_HTTP`), ports
  443 and 8443 (80 and 8080 with http, more in `AI_USER_PROVIDERS_ALLOWED_PORTS`), and every address the host
  resolves to must be public, so nobody can aim the server at its own network or a cloud metadata service.
* **operator** providers (admin and `.env`): http or https, any port; private addresses only for host names in
  `AI_ALLOWED_PRIVATE_HOSTS` or IP literals the operator typed, public addresses for everything else.

The connection goes to the address that was checked (TLS still verified against the host name), so a second
DNS answer cannot swap in another address. Redirects are never followed: a provider cannot bounce a request
(with its image and key) to another host. One deadline covers DNS, connecting, sending and the answer, and
the answer's size is capped. Nothing here logs request bodies, headers or URLs.
"""

from __future__ import annotations

import ipaddress
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import certifi
import urllib3.connection
from django.conf import settings
from django.views.decorators.debug import sensitive_variables

from apps.assets import remote
from apps.assets.providers import _UNSAFE_URL_CHARS, USER_AGENT

MAX_URL_LENGTH = 2048


class TransportError(Exception):
    """The call was refused or failed. `code` is one of the codes of `apps.ai.errors`; `message` is safe to
    show (no URL, no secret)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Policy:
    name: str
    allow_http: bool
    private_hosts: frozenset[str] = frozenset()  # host names that may resolve to private addresses
    private_literals: bool = False  # whether a private IP literal in the URL is allowed
    allowed_ports: frozenset[int] | None = None  # None: any port allowed


def operator_policy() -> Policy:
    hosts = frozenset(
        host.strip().lower().rstrip(".") for host in settings.AI_ALLOWED_PRIVATE_HOSTS if host.strip()
    )
    return Policy("operator", allow_http=True, private_hosts=hosts, private_literals=True, allowed_ports=None)


def user_policy() -> Policy:
    ports = {443, 8443}
    if getattr(settings, "AI_USER_PROVIDERS_ALLOW_HTTP", False):
        ports.update({80, 8080})
    ports.update(int(port) for port in settings.AI_USER_PROVIDERS_ALLOWED_PORTS)
    return Policy(
        "user",
        allow_http=bool(settings.AI_USER_PROVIDERS_ALLOW_HTTP),
        allowed_ports=frozenset(ports),
    )


@dataclass(frozen=True)
class Endpoint:
    scheme: str
    host: str
    port: int
    addresses: tuple[str, ...]  # every address the host resolved to, all checked; tried in order
    path: str  # path and query, as sent in the request line

    @property
    def host_header(self) -> str:
        host = f"[{self.host}]" if ":" in self.host else self.host
        default = 443 if self.scheme == "https" else 80
        return host if self.port == default else f"{host}:{self.port}"

    def target(self) -> remote.Target:
        return remote.Target(host=self.host, addresses=self.addresses, path=self.path)


def _never_reachable(address: str) -> bool:
    """Addresses no policy allows: unspecified (0.0.0.0, ::) and multicast."""
    ip = ipaddress.ip_address(address.split("%", 1)[0])
    return ip.is_unspecified or ip.is_multicast


def _refused() -> TransportError:
    return TransportError("refused_address", "That server address is not allowed.")


def check_url(
    url: str,
    policy: Policy,
    *,
    lookup: Callable[[str], list[str]] = remote.resolve,
    resolve_hosts: bool = True,
) -> Endpoint:
    """The checked endpoint of `url` under `policy`, or TransportError. With `resolve_hosts=False` only the
    form of the URL and IP literals are checked (for forms: host names are resolved and checked on each call).
    """
    if len(url) > MAX_URL_LENGTH or _UNSAFE_URL_CHARS.search(url):
        raise TransportError(
            "refused_address", "The server address is too long or contains unsafe characters."
        )
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as exc:
        raise TransportError("refused_address", "The server address is not a valid URL.") from exc
    allowed_schemes = ("https", "http") if policy.allow_http else ("https",)
    if parts.scheme not in allowed_schemes:
        start = "http:// or https://" if policy.allow_http else "https://"
        raise TransportError("refused_address", f"The server address must start with {start}.")
    effective_port = port or (443 if parts.scheme == "https" else 80)
    if policy.allowed_ports is not None and effective_port not in policy.allowed_ports:
        raise TransportError("refused_address", f"Port {effective_port} is not allowed.")
    if not parts.hostname or parts.username is not None or parts.password is not None:
        raise TransportError(
            "refused_address", "The server address needs a host and no user name or password."
        )
    host = parts.hostname.rstrip(".")
    try:
        ipaddress.ip_address(host.split("%", 1)[0])
        literal = True
    except ValueError:
        literal = False
    if literal:
        addresses = [host]
        private_ok = policy.private_literals
    elif not resolve_hosts:
        addresses = []
        private_ok = True
    else:
        try:
            addresses = lookup(host)
        except remote.RemoteImageError as exc:
            raise TransportError("unreachable", "The server's host name cannot be found.") from exc
        private_ok = host.lower() in policy.private_hosts
    if not addresses and resolve_hosts:
        raise TransportError("unreachable", "The server's host name cannot be found.")
    for address in addresses:
        if _never_reachable(address) or not (private_ok or remote.is_public(address)):
            raise _refused()
    path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    return Endpoint(
        scheme=parts.scheme,
        host=host,
        port=port or (443 if parts.scheme == "https" else 80),
        addresses=tuple(addresses),
        path=path,
    )


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: Mapping[str, str]  # lower-case names
    body: bytes

    def header(self, name: str) -> str:
        return self.headers.get(name.lower(), "")

    @property
    def content_type(self) -> str:
        return self.header("content-type").split(";", 1)[0].strip().lower()


Connect = Callable[[Endpoint, remote.Watchdog, str, dict[str, str], bytes, float], Any]


@sensitive_variables("headers", "body")
def _connect(
    endpoint: Endpoint,
    watchdog: remote.Watchdog,
    method: str,
    headers: dict[str, str],
    body: bytes,
    timeout: float,
) -> Any:
    """Send the request to the first of `endpoint.addresses` that answers; the response, body not read yet."""
    failure: Exception | None = None
    for address in endpoint.addresses:
        if watchdog.left() <= 0:
            break
        if endpoint.scheme == "https":
            conn = urllib3.connection.HTTPSConnection(
                address,
                port=endpoint.port,
                cert_reqs="CERT_REQUIRED",
                ca_certs=certifi.where(),
                server_hostname=endpoint.host,
                assert_hostname=endpoint.host,
            )
        else:
            conn = urllib3.connection.HTTPConnection(address, port=endpoint.port)
        try:
            return remote.request(
                conn,
                endpoint.target(),
                watchdog,
                method=method,
                headers=headers,
                body=body or None,
                read_timeout=timeout,
            )
        except (urllib3.exceptions.NewConnectionError, urllib3.exceptions.ConnectTimeoutError) as exc:
            conn.close()
            failure = exc  # this address is unreachable: try the next one
        except BaseException:
            conn.close()
            raise
    raise failure or TransportError("timeout", "The server took too long to answer.")


def _timeout() -> TransportError:
    return TransportError("timeout", "The server took too long to answer.")


@sensitive_variables("headers", "body", "request_headers")
def send(
    method: str,
    url: str,
    *,
    policy: Policy,
    headers: Mapping[str, str] | None = None,
    body: bytes = b"",
    max_bytes: int,
    timeout: float,
    lookup: Callable[[str], list[str]] | None = None,
    connect: Connect = _connect,
) -> HttpResponse:
    """Send one request under `policy` and return the whole answer (any status; redirects are an error)."""
    lookup = lookup or remote.resolve
    with remote.Watchdog(time.monotonic() + timeout) as watchdog:

        def timed_lookup(host: str) -> list[str]:
            try:
                return remote.resolve_within(lookup, host, watchdog.left())
            except remote.RemoteImageTimeout as exc:  # the lookup overran what was left of the deadline
                raise _timeout() from exc
            except remote.RemoteImageError as exc:
                if watchdog.left() <= 0:
                    raise _timeout() from exc
                raise

        try:
            endpoint = check_url(url, policy, lookup=timed_lookup)
            request_headers = {
                "Host": endpoint.host_header,
                "User-Agent": USER_AGENT,
                **(headers or {}),
            }
            if body or method in ("POST", "PUT", "PATCH"):
                request_headers["Content-Length"] = str(len(body))
            response = connect(endpoint, watchdog, method, request_headers, body, timeout)
            try:
                if watchdog.fired:
                    raise _timeout()
                status = int(response.status)
                if 300 <= status < 400:
                    raise TransportError(
                        "bad_response", "The server answered with a redirect, which is not followed."
                    )
                declared = response.headers.get("Content-Length", "")
                if declared.isdigit() and int(declared) > max_bytes:
                    raise TransportError("too_large", "The server's answer is too large.")
                data = remote.read_body(response, max_bytes=max_bytes)
                if watchdog.fired:  # cut at the deadline: what arrived is not the whole answer
                    raise _timeout()
                names = {name.lower(): value for name, value in response.headers.items()}
                return HttpResponse(status=status, headers=names, body=data)
            finally:
                response.close()
                watchdog.release()
        except TransportError:
            raise
        except UnicodeEncodeError as exc:
            raise TransportError(
                "bad_response", "Request headers must contain only Latin-1 characters."
            ) from exc
        except remote.RemoteImageTooLarge as exc:
            raise TransportError("too_large", "The server's answer is too large.") from exc
        except (remote.RemoteImageError, *remote.TRANSPORT_ERRORS) as exc:
            if watchdog.fired or watchdog.left() <= 0:
                raise _timeout() from exc
            raise TransportError("unreachable", "The server cannot be reached.") from exc
