from __future__ import annotations

from collections import defaultdict
from decimal import Decimal

from django.views.decorators.cache import cache_control
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from .importer import FORMAT_VERSION
from .models import SizePreset, SizePresetGroup


def _number(value: Decimal) -> int | float:
    return int(value) if value == value.to_integral_value() else float(value)


def _preset(preset: SizePreset) -> dict:
    return {
        "slug": preset.slug,
        "label": preset.label,
        "width": _number(preset.width),
        "height": _number(preset.height),
        "unit": preset.unit,
        "width_px": preset.width_px,
        "height_px": preset.height_px,
        "icon": preset.icon,
        "tags": preset.tags,
        "is_quick": preset.is_quick,
        "aliases": preset.aliases,
        "meta": preset.meta,
    }


def preset_tree() -> list[dict]:
    """The active groups, nested, with their active presets. Groups with nothing to offer are left out."""
    children = defaultdict(list)
    for group in SizePresetGroup.objects.filter(is_active=True).order_by("sort_order", "label", "slug"):
        children[group.parent_id].append(group)
    presets = defaultdict(list)
    for preset in SizePreset.objects.filter(is_active=True).order_by("sort_order", "label", "slug"):
        presets[preset.group_id].append(_preset(preset))

    def build(parent_id) -> list[dict]:
        nodes = []
        for group in children[parent_id]:
            node = {
                "slug": group.slug,
                "label": group.label,
                "icon": group.icon,
                "children": build(group.pk),
                "presets": presets[group.pk],
            }
            if node["children"] or node["presets"]:
                nodes.append(node)
        return nodes

    return build(None)


@extend_schema(
    responses={
        200: OpenApiResponse(
            OpenApiTypes.OBJECT,
            description=(
                "The size preset catalogue: `{version, groups: [{slug, label, icon, children: [...], "
                "presets: [{slug, label, width, height, unit, width_px, height_px, icon, tags, is_quick, "
                "aliases, meta}]}]}`. `width` and `height` are in `unit`; `width_px` and `height_px` are "
                "whole pixels at 96 dpi."
            ),
        )
    },
    tags=["system"],
)
@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
@cache_control(public=True, max_age=60)
def size_presets(request):
    """Public size preset catalogue (built-in and configured), nested in groups."""
    return Response({"version": FORMAT_VERSION, "groups": preset_tree()})
