"""Settings of the app-shell e2e stack: the development settings with a generous sign-in rate limit and a patient SQLite.

The specs register dozens of accounts per minute from one address, far above the 20 requests per minute that
protect a real site's sign-in endpoints; everything else (per-account lockout, share-password limits, upload
limits) is the real configuration and is exercised by the specs.

The live editor saves through the WebSocket process while the specs call the REST API, so two writers meet on one
SQLite file. Write-ahead logging lets readers pass, `IMMEDIATE` transactions queue instead of failing half way, and the
30 second timeout covers a machine that is busy with other work (a production site runs PostgreSQL).
"""

import os

from doory.settings.dev import *  # noqa: F403
from doory.settings.dev import DATABASES, REST_FRAMEWORK

REST_FRAMEWORK = {
    **REST_FRAMEWORK,
    "DEFAULT_THROTTLE_RATES": {**REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"], "auth": os.environ.get("E2E_AUTH_RATE", "600/min")},
}

DATABASES = {
    "default": {
        **DATABASES["default"],
        "OPTIONS": {
            **DATABASES["default"].get("OPTIONS", {}),
            "timeout": 30,
            "transaction_mode": "IMMEDIATE",
            "init_command": "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;",
        },
    },
}
