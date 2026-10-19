from django.urls import path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView

from . import views
from .permissions import StaffOrDebug

urlpatterns = [
    path("health/", views.health, name="health"),
    path("config/", views.config, name="config"),
    path("schema/", SpectacularAPIView.as_view(), name="schema"),
    # The page runs a script from a CDN on the API's own origin: only staff (or a development server) open it.
    path(
        "docs/",
        SpectacularSwaggerView.as_view(url_name="schema", permission_classes=[StaffOrDebug]),
        name="docs",
    ),
]
