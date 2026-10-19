"""WebSocket URL routes."""

from django.conf import settings
from django.urls import path

from .consumers import CollabConsumer

websocket_urlpatterns = (
    [path("ws/designs/<uuid:design_id>/", CollabConsumer.as_asgi())] if settings.REALTIME_ENABLED else []
)
