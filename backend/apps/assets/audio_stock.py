"""`/stock/audio/` — search Freesound, listen to a preview and copy a sound into the user's uploads.

Searches are cached like stock photos (fresh, then a stale copy served when Freesound fails). A preview is
fetched by the server, so the page never talks to Freesound and its media policy stays `'self'`.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from django.conf import settings
from django.core.cache import cache
from django.http import HttpResponse
from drf_spectacular.utils import extend_schema
from rest_framework import serializers, status
from rest_framework.exceptions import NotFound
from rest_framework.response import Response
from rest_framework.views import APIView

from . import freesound, providers
from .exceptions import FileTooLarge, StockBusy, StockNotConfigured, StockUnavailable
from .models import Asset
from .serializers import AssetSerializer
from .services import create_asset
from .throttling import StockPreviewRateThrottle, StockRateThrottle, UploadRateThrottle
from .uploads import clean_name

DEFAULT_PER_PAGE = 20
MAX_PAGE = 100
EMPTY_CACHE_SECONDS = 5 * 60
PREVIEW_MAX_BYTES = 12 * 1024 * 1024
PREVIEW_BROWSER_CACHE_SECONDS = 24 * 60 * 60


class AudioSearchSerializer(serializers.Serializer):
    q = serializers.CharField(max_length=100, required=False, allow_blank=True)
    type = serializers.ChoiceField(choices=("all", *freesound.TYPES), required=False)
    subcategory = serializers.CharField(max_length=60, required=False, allow_blank=True)
    length = serializers.ChoiceField(choices=tuple(freesound.LENGTHS), required=False)
    sort = serializers.ChoiceField(choices=tuple(freesound.SORTS), required=False)
    page = serializers.IntegerField(min_value=1, max_value=MAX_PAGE, required=False)
    per_page = serializers.IntegerField(min_value=1, max_value=freesound.MAX_PER_PAGE, required=False)


class AudioImportSerializer(serializers.Serializer):
    provider = serializers.ChoiceField(choices=(freesound.NAME,), required=False)
    id = serializers.CharField(max_length=12)


def info() -> dict[str, Any]:
    """What the Freesound tab needs to draw itself; `configured: false` hides it."""
    if not freesound.configured():
        return {"configured": False}
    return {
        "configured": True,
        "provider": freesound.NAME,
        "label": freesound.LABEL,
        "url": freesound.HOME_URL,
        "licenses": freesound.allowed_licenses(),
        "types": {name: data["subcategories"] for name, data in freesound.TYPES.items()},
        "lengths": list(freesound.LENGTHS),
        "sorts": list(freesound.SORTS),
    }


def _cache_key(options: dict[str, Any]) -> str:
    digest = hashlib.sha256(json.dumps(options, sort_keys=True).lower().encode()).hexdigest()[:32]
    return f"stock:audio:v1:{digest}"


def search(
    query: str = "",
    kind: str = "all",
    subcategory: str = "",
    length: str = "any",
    sort: str = "relevance",
    page: int = 1,
    per_page: int = DEFAULT_PER_PAGE,
) -> dict[str, Any]:
    """One page of sounds. Raises StockBusy / StockUnavailable when not even a stale copy is there."""
    if not freesound.configured():
        return {"configured": False, "total": 0, "next_page": None, "results": []}
    query = query.strip()
    options = {
        "q": query,
        "type": kind,
        "sub": subcategory,
        "length": length,
        "sort": sort,
        "page": page,
        "per_page": per_page,
        "licenses": freesound.allowed_licenses(),
    }
    key = _cache_key(options)
    payload = cache.get(key)
    if payload is not None:
        return payload
    seconds = freesound.config().cache_seconds
    try:
        found = freesound.search(query, kind, subcategory, length, sort, page, per_page)
    except providers.ProviderBusy as exc:
        stale = cache.get(f"{key}:stale")
        if stale is not None:
            return {**stale, "stale": True}
        raise StockBusy(wait=exc.retry_after) from exc
    except providers.ProviderError as exc:
        stale = cache.get(f"{key}:stale")
        if stale is not None:
            return {**stale, "stale": True}
        raise StockUnavailable() from exc
    payload = {
        "configured": True,
        "provider": freesound.NAME,
        "total": found.total,
        "next_page": found.next_page,
        "results": [sound.as_dict() for sound in found.sounds],
    }
    if seconds and found.sounds:
        cache.set(key, payload, seconds)
        cache.set(f"{key}:stale", payload, seconds * 2)
    elif seconds:
        cache.set(key, payload, min(seconds, EMPTY_CACHE_SECONDS))
    return payload


def _sound(sound_id: str) -> freesound.Sound:
    if not freesound.configured():
        raise StockNotConfigured("Freesound is not configured on this server.")
    if not freesound.valid_id(sound_id):
        raise serializers.ValidationError({"id": ["Not a valid Freesound id."]})
    try:
        return freesound.resolve(sound_id)
    except freesound.NotAllowed as exc:
        raise serializers.ValidationError({"id": [str(exc)]}) from exc
    except providers.ProviderBusy as exc:
        raise StockBusy(wait=exc.retry_after) from exc
    except providers.ProviderError as exc:
        raise StockUnavailable() from exc


def import_sound(owner, sound_id: str) -> tuple[Asset, bool]:
    """The owner's asset for a Freesound sound, downloaded on first use; returns (asset, created)."""
    sound = _sound(sound_id)
    existing = Asset.objects.filter(
        owner=owner, kind=Asset.Kind.AUDIO, meta__provider=freesound.NAME, meta__sound_id=sound.id
    ).first()
    if existing:
        return existing, False
    try:
        data = freesound.download(sound.download_url, settings.MAX_UPLOAD_BYTES)
    except providers.PhotoTooLarge as exc:
        raise FileTooLarge() from exc
    except providers.ProviderError as exc:
        raise StockUnavailable() from exc
    asset = create_asset(
        owner,
        data,
        name=clean_name(sound.title),
        meta={
            "provider": freesound.NAME,
            "sound_id": sound.id,
            "credit": sound.credit(),
            "attribution": {
                "provider": freesound.NAME,
                "author": sound.author,
                "author_url": sound.author_url,
                "source_url": sound.source_url,
            },
        },
    )
    return asset, True


def credit_of(asset: Asset) -> dict[str, Any] | None:
    credit = (asset.meta or {}).get("credit")
    return credit if isinstance(credit, dict) else None


class AudioStockInfoView(APIView):
    @extend_schema(responses={200: dict}, tags=["stock"])
    def get(self, request):
        return Response(info())


class AudioStockSearchView(APIView):
    def get_throttles(self):
        return [*super().get_throttles(), StockRateThrottle()]

    @extend_schema(parameters=[AudioSearchSerializer], responses={200: dict}, tags=["stock"])
    def get(self, request):
        params = AudioSearchSerializer(data=request.query_params)
        params.is_valid(raise_exception=True)
        data = params.validated_data
        return Response(
            search(
                data.get("q", ""),
                data.get("type", "all"),
                data.get("subcategory", ""),
                data.get("length", "any"),
                data.get("sort", "relevance"),
                data.get("page", 1),
                data.get("per_page", DEFAULT_PER_PAGE),
            )
        )


class AudioStockPreviewView(APIView):
    """The sound's short MP3 preview, relayed from Freesound's CDN."""

    def get_throttles(self):
        return [*super().get_throttles(), StockPreviewRateThrottle()]

    @extend_schema(responses={(200, "audio/mpeg"): bytes}, tags=["stock"])
    def get(self, request, sound_id: str):
        if not freesound.configured():
            raise NotFound()
        sound = _sound(sound_id)
        try:
            data = freesound.download(sound.preview_url, PREVIEW_MAX_BYTES)
        except providers.ProviderError as exc:
            raise StockUnavailable() from exc
        response = HttpResponse(data, content_type="audio/mpeg")
        response["Cache-Control"] = f"private, max-age={PREVIEW_BROWSER_CACHE_SECONDS}"
        response["X-Content-Type-Options"] = "nosniff"
        return response


class AudioStockImportView(APIView):
    def get_throttles(self):
        return [*super().get_throttles(), UploadRateThrottle()]

    @extend_schema(request=AudioImportSerializer, responses={200: dict, 201: dict}, tags=["stock"])
    def post(self, request):
        body = AudioImportSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        asset, created = import_sound(request.user, body.validated_data["id"])
        return Response(
            {**AssetSerializer(asset).data, "credit": credit_of(asset)},
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )
