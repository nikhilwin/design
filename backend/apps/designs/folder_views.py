from django.db.models import Count, Q
from django.db.models.functions import Lower
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import mixins, serializers, status, viewsets
from rest_framework.response import Response

from apps.assets.parsers import BoundedJSONParser
from apps.core.pagination import StandardPagination

from . import folders
from .models import Folder
from .serializers import FolderSerializer, FolderWriteSerializer


class FolderPagination(StandardPagination):
    page_size = 100


@extend_schema(tags=["folders"])
class FolderViewSet(mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    serializer_class = FolderSerializer
    parser_classes = [BoundedJSONParser]
    pagination_class = FolderPagination
    filter_backends: list = []
    lookup_value_regex = "[0-9a-fA-F-]{36}"

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Folder.objects.none()
        return (
            Folder.objects.filter(owner=self.request.user)
            .annotate(design_count=Count("designs", filter=Q(designs__trashed_at__isnull=True)))
            .order_by(Lower("name"), "pk")
        )

    def _present(self, folder: Folder) -> Response:
        return Response(FolderSerializer(self.get_queryset().get(pk=folder.pk)).data)

    @extend_schema(parameters=[OpenApiParameter("parent", str, description="A folder id or `root`.")])
    def list(self, request, *args, **kwargs):
        queryset = self.get_queryset()
        parent = request.query_params.get("parent")
        if parent == "root":
            queryset = queryset.filter(parent__isnull=True)
        elif parent:
            serializers.UUIDField().run_validation(parent)
            queryset = queryset.filter(parent_id=parent)
        page = self.paginate_queryset(queryset)
        return self.get_paginated_response(FolderSerializer(page, many=True).data)

    @extend_schema(request=FolderWriteSerializer, responses={201: FolderSerializer})
    def create(self, request, *args, **kwargs):
        body = FolderWriteSerializer(data=request.data, context=self.get_serializer_context())
        body.is_valid(raise_exception=True)
        folder = folders.create_folder(
            request.user, name=body.validated_data["name"], parent=body.validated_data.get("parent")
        )
        response = self._present(folder)
        response.status_code = status.HTTP_201_CREATED
        return response

    @extend_schema(request=FolderWriteSerializer, responses=FolderSerializer)
    def partial_update(self, request, *args, **kwargs):
        folder = self.get_object()
        body = FolderWriteSerializer(data=request.data, partial=True, context=self.get_serializer_context())
        body.is_valid(raise_exception=True)
        folders.update_folder(request.user, folder, body.validated_data)
        return self._present(folder)

    @extend_schema(responses={204: None})
    def destroy(self, request, *args, **kwargs):
        folders.delete_folder(request.user, self.get_object())
        return Response(status=status.HTTP_204_NO_CONTENT)
