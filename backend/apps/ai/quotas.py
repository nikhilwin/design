"""Per-user daily quota of an operator provider (`daily_quota`, 0 = unlimited).

Calls that reached the provider count (whatever their outcome); refused calls and cached results do not.
Two calls started at the same moment can both pass the check, so a user may go one or two over under load.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta

from django.utils import timezone

from .catalog import Option
from .errors import QuotaReached
from .models import AICall

COUNTED = (AICall.Status.OK, AICall.Status.ERROR, AICall.Status.TIMEOUT)


def _midnight() -> datetime:
    now = timezone.localtime()
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def used_today(user, provider_ref: str) -> int:
    return AICall.objects.filter(
        user=user, provider_ref=provider_ref, created_at__gte=_midnight(), status__in=COUNTED
    ).count()


def seconds_until_reset() -> int:
    return max(1, math.ceil((_midnight() + timedelta(days=1) - timezone.localtime()).total_seconds()))


def check(user, option: Option) -> None:
    """QuotaReached when `user` has used up today's calls of the option's provider."""
    if option.daily_quota and used_today(user, option.provider_id) >= option.daily_quota:
        raise QuotaReached(wait=seconds_until_reset())
