from rest_framework.routers import SimpleRouter

from .views import BrandKitViewSet

router = SimpleRouter()
router.register("brand-kits", BrandKitViewSet, basename="brand-kit")

urlpatterns = router.urls
