"""Brand kits: named colours, font roles and logos the user designs with."""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from typing import Annotated, Any, Literal

from django.shortcuts import get_object_or_404
from pydantic import BaseModel, Field

from apps.apitokens.scopes import BRAND_WRITE, DESIGNS_READ
from apps.brand import services
from apps.brand.models import BrandKit
from apps.brand.serializers import BrandKitSerializer, with_logos

from ..context import current
from ..registry import tool
from .designs import _uuid


class BrandColor(BaseModel):
    hex: Annotated[str, Field(description="#rgb or #rrggbb.", max_length=7)]
    name: Annotated[str, Field(max_length=40)] = ""


class BrandFont(BaseModel):
    role: Literal["heading", "subheading", "body"]
    family: Annotated[str, Field(description="A family from search_fonts.", max_length=100)]


KitId = Annotated[str, Field(description="A brand kit id from list_brand_kits.")]
Colors = Annotated[list[BrandColor] | None, Field(description="Replaces the kit's colours.", max_length=100)]
Fonts = Annotated[list[BrandFont] | None, Field(description="Replaces the kit's fonts.", max_length=3)]
LogoIds = Annotated[
    list[str] | None, Field(description="Replaces the logos: asset ids from list_assets.", max_length=20)
]


def _kit(kit: BrandKit) -> dict[str, Any]:
    return {
        "id": str(kit.pk),
        "name": kit.name,
        "is_default": kit.is_default,
        "colors": kit.colors,
        "fonts": kit.fonts,
        "logos": [
            {"asset_id": str(logo.pk), "name": logo.name, "url": logo.file.url} for logo in kit.logos.all()
        ],
    }


def _kits():
    return with_logos(BrandKit.objects.filter(owner=current().user))


def _save(kit: BrandKit | None, **fields: Any) -> dict[str, Any]:
    """Validate like the REST API (BrandKitSerializer), then save through the brand services."""
    data = {key: value for key, value in fields.items() if value is not None}
    if "colors" in data:
        data["colors"] = [
            {"id": uuid.uuid4().hex[:12], **BrandColor.model_validate(color).model_dump()}
            for color in data["colors"]
        ]
    if "fonts" in data:
        data["fonts"] = [BrandFont.model_validate(font).model_dump() for font in data["fonts"]]
    user = current().user
    serializer = BrandKitSerializer(
        kit, data=data, partial=kit is not None, context={"request": SimpleNamespace(user=user)}
    )
    serializer.is_valid(raise_exception=True)
    values = dict(serializer.validated_data)
    saved = services.update_kit(user, kit, values) if kit else services.create_kit(user, values)
    return _kit(_kits().get(pk=saved.pk))


@tool(scope=DESIGNS_READ, title="List brand kits", read_only=True)
def list_brand_kits() -> dict[str, Any]:
    """Your brand kits: named colours, font roles and logos (logo ids work as asset_id in add_image)."""
    return {"brand_kits": [_kit(kit) for kit in _kits()]}


@tool(scope=BRAND_WRITE, title="Create a brand kit")
def create_brand_kit(
    name: Annotated[str, Field(min_length=1, max_length=80)],
    colors: Colors = None,
    fonts: Fonts = None,
    logo_ids: LogoIds = None,
    is_default: bool = False,
) -> dict[str, Any]:
    """Create a brand kit. The default kit is the one the editor offers first."""
    return _save(None, name=name, colors=colors, fonts=fonts, logo_ids=logo_ids, is_default=is_default)


@tool(scope=BRAND_WRITE, title="Change a brand kit", idempotent=True)
def update_brand_kit(
    kit_id: KitId,
    name: Annotated[str | None, Field(min_length=1, max_length=80)] = None,
    colors: Colors = None,
    fonts: Fonts = None,
    logo_ids: LogoIds = None,
    is_default: bool | None = None,
) -> dict[str, Any]:
    """Change a brand kit. Only what you pass changes; colours, fonts and logos are replaced as a whole."""
    kit = get_object_or_404(_kits(), pk=_uuid(kit_id))
    return _save(kit, name=name, colors=colors, fonts=fonts, logo_ids=logo_ids, is_default=is_default)
