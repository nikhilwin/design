import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "doory.settings.prod")
django_asgi_app = get_asgi_application()

# Imported after the Django app registry is ready (they touch models).
from channels.auth import AuthMiddlewareStack  # noqa: E402
from channels.routing import ProtocolTypeRouter, URLRouter  # noqa: E402

from apps.collab.consumers import RealtimeOriginValidator  # noqa: E402
from apps.collab.routing import websocket_urlpatterns  # noqa: E402

# Plain HTTP is served by Django; WebSockets (real-time co-editing) need a session and a same-site origin.
application = ProtocolTypeRouter(
    {
        "http": django_asgi_app,
        "websocket": RealtimeOriginValidator(AuthMiddlewareStack(URLRouter(websocket_urlpatterns))),
    }
)
