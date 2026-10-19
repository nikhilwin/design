"""Container health probe: the server answers /api/v1/health/ (which also touches the database).

`HEALTH_PORT` selects the port (8000 for the API, 8001 for the real-time server, 8002 for the MCP server) and
`HEALTH_PATH` the path (the MCP server answers /mcp/health)."""

import os
import sys
import urllib.request

hosts = [h.strip().lstrip(".") for h in os.environ.get("DJANGO_ALLOWED_HOSTS", "localhost").split(",")]
host = next((h for h in hosts if h and h != "*"), "localhost")  # must pass Django's ALLOWED_HOSTS check
port = int(os.environ.get("HEALTH_PORT", "8000"))
path = os.environ.get("HEALTH_PATH", "/api/v1/health/")
request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers={"Host": host})

try:
    with urllib.request.urlopen(request, timeout=4) as response:  # noqa: S310  (fixed http URL)
        sys.exit(0 if response.status == 200 else 1)
except OSError:
    sys.exit(1)
