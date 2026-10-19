from __future__ import annotations

from rest_framework import serializers

from .models import Element, ElementPack


class PackRefSerializer(serializers.ModelSerializer):
    class Meta:
        model = ElementPack
        fields = ["id", "slug", "name"]
        read_only_fields = fields


class ElementPackSerializer(serializers.ModelSerializer):
    element_count = serializers.IntegerField(read_only=True)
    thumbnail_url = serializers.SerializerMethodField()

    class Meta:
        model = ElementPack
        fields = [
            "id",
            "slug",
            "name",
            "kind",
            "thumbnail_url",
            "element_count",
            "license",
            "license_url",
            "attribution",
            "source_url",
        ]
        read_only_fields = fields

    def get_thumbnail_url(self, obj: ElementPack) -> str | None:
        """The pack's own thumbnail, else its first element's SVG (annotated by the view)."""
        if obj.thumbnail:
            return obj.thumbnail.url
        preview = getattr(obj, "preview_svg", None)
        return Element._meta.get_field("svg").storage.url(preview) if preview else None


class ElementItemSerializer(serializers.ModelSerializer):
    pack = PackRefSerializer(read_only=True)
    svg_url = serializers.SerializerMethodField()

    class Meta:
        model = Element
        fields = [
            "id",
            "name",
            "kind",
            "style",
            "pack",
            "tags",
            "svg_url",
            "width",
            "height",
            "colors",
            "is_recolorable",
        ]
        read_only_fields = fields

    def get_svg_url(self, obj: Element) -> str:
        return obj.svg.url
