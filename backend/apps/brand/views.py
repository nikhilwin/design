from drf_spectacular.utils import extend_schema
from rest_framework import mixins, status, viewsets
from rest_framework.response import Response

from apps.assets.parsers import BoundedJSONParser

from . import services
from .models import BrandKit
from .serializers import BrandKitSerializer, with_logos


@extend_schema(tags=["brand-kits"])
class BrandKitViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    serializer_class = BrandKitSerializer
    parser_classes = [BoundedJSONParser]
    filter_backends: list = []
    lookup_value_regex = "[0-9a-fA-F-]{36}"

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return BrandKit.objects.none()
        return with_logos(BrandKit.objects.filter(owner=self.request.user))

    def _present(self, kit: BrandKit, status_code: int = status.HTTP_200_OK) -> Response:
        fresh = self.get_queryset().get(pk=kit.pk)
        return Response(self.get_serializer(fresh).data, status=status_code)

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        kit = services.create_kit(request.user, dict(serializer.validated_data))
        return self._present(kit, status.HTTP_201_CREATED)

    def partial_update(self, request, *args, **kwargs):
        serializer = self.get_serializer(self.get_object(), data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        kit = services.update_kit(request.user, serializer.instance, dict(serializer.validated_data))
        return self._present(kit)
