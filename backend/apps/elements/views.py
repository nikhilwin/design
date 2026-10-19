from __future__ import annotations

from django.db.models import Count, OuterRef, Q, Subquery
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import generics
from rest_framework.permissions import AllowAny

from apps.core.pagination import StandardPagination

from .filters import ElementFilter
from .models import Element, ElementPack
from .serializers import ElementItemSerializer, ElementPackSerializer

CACHE_CONTROL = "public, max-age=300"


class ElementPagination(StandardPagination):
    page_size = 48


class PublicCatalogView:
    """Catalog reads are identical for everyone: no session lookup, and shared caches may keep them."""

    authentication_classes: list = []
    permission_classes = [AllowAny]

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        if request.method == "GET" and response.status_code == 200:
            response["Cache-Control"] = CACHE_CONTROL
        return response


class ElementPackListView(PublicCatalogView, generics.ListAPIView):
    """Packs that contain at least one published element (not paginated)."""

    serializer_class = ElementPackSerializer
    pagination_class = None
    filter_backends: list = []

    def get_queryset(self):
        first_svg = (
            Element.objects.filter(pack=OuterRef("pk"), is_published=True)
            .order_by("sort_order", "name", "id")
            .values("svg")[:1]
        )
        return (
            ElementPack.objects.filter(is_published=True)
            .annotate(
                element_count=Count("elements", filter=Q(elements__is_published=True)),
                preview_svg=Subquery(first_svg),
            )
            .filter(element_count__gt=0)
            .order_by("sort_order", "name", "id")
        )


class ElementListView(PublicCatalogView, generics.ListAPIView):
    serializer_class = ElementItemSerializer
    pagination_class = ElementPagination
    filter_backends = [DjangoFilterBackend]
    filterset_class = ElementFilter

    def get_queryset(self):
        return (
            Element.objects.filter(is_published=True, pack__is_published=True)
            .select_related("pack")
            .order_by("pack__sort_order", "pack__name", "sort_order", "name", "id")
        )
