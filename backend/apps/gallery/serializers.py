from __future__ import annotations

from rest_framework import serializers

from .models import Template, TemplateCategory


def file_url(field_file) -> str | None:
    """Storage URL of a file field (a root-relative `/media/…` path locally, absolute with object storage)."""
    return field_file.url if field_file else None


class TemplateCategorySerializer(serializers.ModelSerializer):
    template_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = TemplateCategory
        fields = ["id", "slug", "name", "icon", "template_count", "sort_order"]
        read_only_fields = fields


class CategoryRefSerializer(serializers.ModelSerializer):
    class Meta:
        model = TemplateCategory
        fields = ["id", "slug", "name"]
        read_only_fields = fields


class TemplateSummarySerializer(serializers.ModelSerializer):
    category = CategoryRefSerializer(read_only=True, allow_null=True)
    orientation = serializers.ChoiceField(choices=["landscape", "portrait", "square"], read_only=True)
    thumbnail_url = serializers.SerializerMethodField()

    class Meta:
        model = Template
        fields = [
            "id",
            "slug",
            "title",
            "category",
            "tags",
            "width",
            "height",
            "orientation",
            "preset",
            "page_count",
            "thumbnail_url",
            "is_featured",
            "use_count",
            "created_at",
        ]
        read_only_fields = fields

    def get_thumbnail_url(self, obj: Template) -> str | None:
        return file_url(obj.thumbnail)


class TemplateDetailSerializer(TemplateSummarySerializer):
    class Meta(TemplateSummarySerializer.Meta):
        fields = [*TemplateSummarySerializer.Meta.fields, "description", "document"]
        read_only_fields = fields
