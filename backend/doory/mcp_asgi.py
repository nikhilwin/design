"""ASGI entry point of the MCP server: `uvicorn doory.mcp_asgi:application --port 8002`."""

import os

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "doory.settings.prod")
django.setup()

from apps.mcp.server import build_app  # noqa: E402

application = build_app()
