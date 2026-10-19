from __future__ import annotations

from django.db.models import Exists, OuterRef
from django_filters.rest_framework import DjangoFilterBackend
from drf_spectacular.utils import extend_schema
from rest_framework import generics, status
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle

from apps.core.pagination import StandardPagination

from .filters import FontFilter
from .models import FontFamily, FontVariant
from .serializers import FontFamilySerializer, FontUploadSerializer, with_variants
from .uploads import add_user_font

CACHE_CONTROL = "public, max-age=300"


class FontPagination(StandardPagination):
    page_size = 50


class FontUploadThrottle(UserRateThrottle):
    scope = "upload"


class PublicFontList(generics.ListAPIView):
    """Built-in fonts that have at least one file. Identical for everyone, so no session lookup and
    shared caches may keep it."""

    serializer_class = FontFamilySerializer
    pagination_class = FontPagination
    filter_backends = [DjangoFilterBackend]
    filterset_class = FontFilter
    authentication_classes: list = []
    permission_classes = [AllowAny]

    def get_queryset(self):
        has_files = FontVariant.objects.filter(family=OuterRef("pk"))
        return (
            FontFamily.objects.filter(owner__isnull=True, is_published=True)
            .filter(Exists(has_files))
            .prefetch_related(with_variants())
            .order_by("popularity", "family", "id")
        )

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        if request.method == "GET" and response.status_code == 200:
            response["Cache-Control"] = CACHE_CONTROL
        return response


class UserFontListCreate(generics.ListCreateAPIView):
    """The caller's uploaded font families (list) and uploading new ones (multipart `files`)."""

    permission_classes = [IsAuthenticated]
    pagination_class = FontPagination
    filter_backends: list = []
    parser_classes = [MultiPartParser, FormParser]
    serializer_class = FontFamilySerializer

    def get_throttles(self):
        return [FontUploadThrottle()] if self.request.method == "POST" else super().get_throttles()

    def get_queryset(self):
        return (
            FontFamily.objects.filter(owner=self.request.user)
            .prefetch_related(with_variants())
            .order_by("family", "id")
        )

    @extend_schema(request=FontUploadSerializer, responses={201: FontFamilySerializer})
    def post(self, request, *args, **kwargs):
        upload = FontUploadSerializer(data=request.data)
        upload.is_valid(raise_exception=True)
        family = add_user_font(
            request.user,
            upload.validated_data["files"],
            family=upload.validated_data.get("family"),
            category=upload.validated_data.get("category"),
        )
        return Response(
            FontFamilySerializer(family, context={"request": request}).data, status.HTTP_201_CREATED
        )


class UserFontDelete(generics.DestroyAPIView):
    """Remove one of the caller's uploaded families and its files. Other users' fonts are a 404."""

    permission_classes = [IsAuthenticated]
    serializer_class = FontFamilySerializer

    def get_queryset(self):
        return FontFamily.objects.filter(owner=self.request.user)
