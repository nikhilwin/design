from django.core.exceptions import ImproperlyConfigured

from .base import *
from .base import SECRET_KEY, SITE_URL, env

DEBUG = False
MIN_SECRET_KEY_LENGTH = 32  # `openssl rand -base64 48` gives 64
if SECRET_KEY.startswith("dev-insecure") or len(SECRET_KEY) < MIN_SECRET_KEY_LENGTH:
    raise ImproperlyConfigured(
        f"Set DJANGO_SECRET_KEY to a long random value of at least {MIN_SECRET_KEY_LENGTH} characters "
        "in production."
    )

# TLS is terminated by a reverse proxy that sets X-Forwarded-Proto (the bundled nginx passes it on).
# SECURE_COOKIES / SECURE_SSL_REDIRECT may only be switched off to try Doory over plain HTTP locally.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = env.bool("SECURE_SSL_REDIRECT", default=True)
SECURE_REDIRECT_EXEMPT = [r"^api/v1/health/$"]  # container health checks speak plain HTTP
SESSION_COOKIE_SECURE = env.bool("SECURE_COOKIES", default=True)
CSRF_COOKIE_SECURE = SESSION_COOKIE_SECURE
SECURE_HSTS_SECONDS = 60 * 60 * 24 * 30
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_CONTENT_TYPE_NOSNIFF = True

# The bundled setup is same-origin: trust the site's own origin for CSRF and allow no cross-origin callers.
CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS", default=[SITE_URL])
CORS_ALLOWED_ORIGINS = env.list("CORS_ALLOWED_ORIGINS", default=[])

# Number of trusted reverse proxies in front of the API; DRF throttles key on the client address
# taken from X-Forwarded-For. Set 0 only when gunicorn is reachable directly (no proxy).
REST_FRAMEWORK = {**REST_FRAMEWORK, "NUM_PROXIES": env.int("NUM_PROXIES", default=1)}

# HSTS preloading is a long-lived commitment each operator must opt into deliberately.
SILENCED_SYSTEM_CHECKS = ["security.W021"]
