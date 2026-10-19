"""Google Identity Services ID-token verification (the only network call in the sign-in flow)."""

from __future__ import annotations

from dataclasses import dataclass

from django.conf import settings
from google.auth.exceptions import GoogleAuthError
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token

REQUEST_TIMEOUT_SECONDS = 5


class GoogleSignInError(Exception):
    """The credential could not be verified or is unusable for sign-in."""


@dataclass(frozen=True)
class GoogleIdentity:
    sub: str
    email: str
    name: str


class _Transport(google_requests.Request):
    """google-auth transport with a short default timeout (its own default is two minutes)."""

    def __call__(self, url, method="GET", body=None, headers=None, timeout=REQUEST_TIMEOUT_SECONDS, **kwargs):
        return super().__call__(url, method, body, headers, timeout, **kwargs)


def verify_google_credential(credential: str) -> GoogleIdentity:
    """Verify signature, expiry, issuer and audience of `credential`; require a verified email."""
    try:
        claims = id_token.verify_oauth2_token(credential, _Transport(), settings.GOOGLE_CLIENT_ID)
    except (GoogleAuthError, ValueError) as exc:
        raise GoogleSignInError("The Google credential is invalid or expired.") from exc

    sub = str(claims.get("sub") or "")
    email = str(claims.get("email") or "").strip().lower()
    if not sub or not email:
        raise GoogleSignInError("The Google account did not share an email address.")
    if claims.get("email_verified") not in (True, "true"):
        raise GoogleSignInError("The Google account's email address is not verified.")
    return GoogleIdentity(sub=sub, email=email, name=str(claims.get("name") or ""))
