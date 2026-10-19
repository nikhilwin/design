from __future__ import annotations

from django.db.models import Count, Q
from django_filters.rest_framework import DjangoFilterBackend
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import generics, status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.designs.serializers import DesignSerializer
from apps.designs.services import create_from_template

from .filters import TemplateFilter
from .models import Template, TemplateCategory
from .serializers import TemplateCategorySerializer, TemplateDetailSerializer, TemplateSummarySerializer

DEFAULT_ORDERING = ("-is_featured", "-use_count", "-created_at", "id")


def published_templates():
    return Template.objects.filter(is_published=True).select_related("category")


class PublicCatalogView:
    """Gallery reads are identical for everyone: no session lookup (so responses stay cacheable)."""

    authentication_classes: list = []
    permission_classes = [AllowAny]


class TemplateCategoryListView(PublicCatalogView, generics.ListAPIView):
    """All template categories with the number of published templates in each (not paginated)."""

    serializer_class = TemplateCategorySerializer
    pagination_class = None
    filter_backends: list = []

    def get_queryset(self):
        return TemplateCategory.objects.annotate(
            template_count=Count("templates", filter=Q(templates__is_published=True))
        ).order_by("sort_order", "name", "id")


class TemplateListView(PublicCatalogView, generics.ListAPIView):
    """Published templates; `document` is not loaded for list rows."""

    serializer_class = TemplateSummarySerializer
    filter_backends = [DjangoFilterBackend]
    filterset_class = TemplateFilter

    def get_queryset(self):
        return published_templates().defer("document").order_by(*DEFAULT_ORDERING)


class TemplateDetailView(PublicCatalogView, generics.RetrieveAPIView):
    serializer_class = TemplateDetailSerializer
    lookup_field = "slug"

    def get_queryset(self):
        return published_templates()


class TemplateUseView(APIView):
    """Create a design owned by the caller from a template (shortcut for `POST /designs/ {template}`)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses={201: OpenApiTypes.OBJECT}, tags=["templates"])
    def post(self, request, slug: str):
        design = create_from_template(request.user, slug, title=None, folder=None)
        return Response(
            DesignSerializer(design, context={"request": request}).data, status=status.HTTP_201_CREATED
        )
