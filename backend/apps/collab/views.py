"""Staff-only observability of the real-time servers."""

from __future__ import annotations

from collections import Counter

from django.db.models import Count
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAdminUser
from rest_framework.response import Response

from . import store
from .models import CollabInstance, RoomConnection


@extend_schema(
    responses={200: OpenApiResponse(description="Rooms, connections and counters.")}, tags=["collab"]
)
@api_view(["GET"])
@permission_classes([IsAdminUser])
def stats(request):
    """Live rooms and connections (rows with a recent heartbeat) and the per-process counters."""
    fresh = RoomConnection.objects.filter(heartbeat_at__gt=store.stale_cutoff())
    rooms = fresh.values("design_id").annotate(connections=Count("id")).order_by("-connections", "design_id")
    instances = CollabInstance.objects.filter(heartbeat_at__gt=store.stale_cutoff()).order_by("instance")
    totals: Counter[str] = Counter()
    for instance in instances:
        totals.update(instance.counters)
    return Response(
        {
            "rooms": rooms.count(),
            "connections": fresh.count(),
            "by_role": {
                row["role"]: row["total"] for row in fresh.values("role").annotate(total=Count("id"))
            },
            "designs": [
                {"design": str(row["design_id"]), "connections": row["connections"]} for row in rooms[:100]
            ],
            "instances": [
                {
                    "instance": item.instance,
                    "shared_layer": item.shared_layer,
                    "heartbeat_at": item.heartbeat_at,
                    "counters": item.counters,
                }
                for item in instances
            ],
            "counters": dict(totals),
        }
    )
