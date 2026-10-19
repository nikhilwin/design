from django.urls import path
from rest_framework.routers import SimpleRouter

from .folder_views import FolderViewSet
from .views import DesignVersionDetailView, DesignVersionListView, DesignVersionRestoreView, DesignViewSet

router = SimpleRouter()
router.register("designs", DesignViewSet, basename="design")
router.register("folders", FolderViewSet, basename="folder")

urlpatterns = [
    path("designs/<uuid:design_pk>/versions/", DesignVersionListView.as_view(), name="design-versions"),
    path(
        "designs/<uuid:design_pk>/versions/<uuid:version_pk>/",
        DesignVersionDetailView.as_view(),
        name="design-version-detail",
    ),
    path(
        "designs/<uuid:design_pk>/versions/<uuid:version_pk>/restore/",
        DesignVersionRestoreView.as_view(),
        name="design-version-restore",
    ),
    *router.urls,
]
