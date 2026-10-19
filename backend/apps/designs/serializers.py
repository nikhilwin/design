from django.conf import settings
from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.assets.uploads import strip_unsafe_chars

from .folders import MAX_NAME_LENGTH as FOLDER_NAME_LENGTH
from .models import Design, DesignVersion, Folder
from .services import BULK_ACTIONS, DEFAULT_SIZE
from .validators import MAX_DIMENSION, MAX_PRESET_LENGTH, validate_document

TITLE_MAX_LENGTH = 200
LABEL_MAX_LENGTH = 120
MAX_BULK_IDS = 200
DEFAULT_VERSION_LABEL = "Saved version"


def clean_text(value: str) -> str:
    return " ".join(strip_unsafe_chars(value).split())


@extend_schema_field({"type": "object", "additionalProperties": True})
class DocumentField(serializers.Field):
    """A design document. Validated by the iterative `validate_document`; never re-serialised by DRF."""

    def to_internal_value(self, data):
        validate_document(data, max_bytes=settings.MAX_DESIGN_DOCUMENT_BYTES)
        return data

    def to_representation(self, value):
        return value


class OwnedFolderField(serializers.PrimaryKeyRelatedField):
    """A folder reference that only resolves to the requesting user's folders."""

    def get_queryset(self):
        request = self.context.get("request")
        if request is None or not request.user.is_authenticated:
            return Folder.objects.none()
        return Folder.objects.filter(owner=request.user)


class TitleField(serializers.CharField):
    def __init__(self, **kwargs):
        super().__init__(max_length=TITLE_MAX_LENGTH * 2, **kwargs)

    def to_internal_value(self, data):
        title = clean_text(super().to_internal_value(data))
        if not title:
            raise serializers.ValidationError("The title cannot be empty.")
        if len(title) > TITLE_MAX_LENGTH:
            raise serializers.ValidationError(
                f"Ensure this field has no more than {TITLE_MAX_LENGTH} characters."
            )
        return title


class DesignSummarySerializer(serializers.ModelSerializer):
    thumbnail_url = serializers.SerializerMethodField()
    folder = serializers.PrimaryKeyRelatedField(read_only=True)

    class Meta:
        model = Design
        fields = (
            "id",
            "title",
            "width",
            "height",
            "preset",
            "page_count",
            "thumbnail_url",
            "folder",
            "starred",
            "revision",
            "created_at",
            "updated_at",
            "trashed_at",
        )
        read_only_fields = fields

    def get_thumbnail_url(self, obj: Design) -> str | None:
        return obj.thumbnail.url if obj.thumbnail else None


class DesignSerializer(DesignSummarySerializer):
    document = DocumentField(read_only=True)

    class Meta(DesignSummarySerializer.Meta):
        fields = (*DesignSummarySerializer.Meta.fields, "document")
        read_only_fields = fields


class DesignQuerySerializer(serializers.Serializer):
    q = serializers.CharField(max_length=200, required=False, allow_blank=True)
    folder = serializers.CharField(max_length=36, required=False)
    # `default=None`: in a query string (form-style input) a missing boolean reads as False,
    # and every list would then silently leave out the starred designs.
    starred = serializers.BooleanField(required=False, allow_null=True, default=None)
    trashed = serializers.BooleanField(required=False, default=False)
    ordering = serializers.CharField(max_length=32, required=False, allow_blank=True)

    def validate_folder(self, value: str) -> str:
        if value != "root":
            serializers.UUIDField().run_validation(value)
        return value


class DesignCreateSerializer(serializers.Serializer):
    title = TitleField(required=False)
    width = serializers.IntegerField(min_value=1, max_value=MAX_DIMENSION, required=False)
    height = serializers.IntegerField(min_value=1, max_value=MAX_DIMENSION, required=False)
    preset = serializers.RegexField(
        r"\A[A-Za-z0-9._-]*\Z",
        max_length=MAX_PRESET_LENGTH,
        required=False,
        allow_blank=True,
        trim_whitespace=False,
    )
    document = DocumentField(required=False)
    folder = OwnedFolderField(queryset=Folder.objects.none(), required=False, allow_null=True)
    template = serializers.SlugField(max_length=120, required=False)

    def validate(self, attrs):
        if "document" in attrs and "template" in attrs:
            raise serializers.ValidationError(
                {"template": ["Send either `document` or `template`, not both."]}
            )
        attrs.setdefault("width", DEFAULT_SIZE)
        attrs.setdefault("height", DEFAULT_SIZE)
        return attrs


class DesignUpdateSerializer(serializers.Serializer):
    title = TitleField()
    document = DocumentField()
    base_revision = serializers.IntegerField(min_value=1)
    folder = OwnedFolderField(queryset=Folder.objects.none(), allow_null=True)
    starred = serializers.BooleanField()

    def validate(self, attrs):
        if "document" in attrs and "base_revision" not in attrs:
            raise serializers.ValidationError({"base_revision": ["Required when saving a document."]})
        return attrs


class BulkSerializer(serializers.Serializer):
    ids = serializers.ListField(
        child=serializers.UUIDField(), min_length=1, max_length=MAX_BULK_IDS, allow_empty=False
    )
    action = serializers.ChoiceField(choices=BULK_ACTIONS)
    folder = OwnedFolderField(queryset=Folder.objects.none(), required=False, allow_null=True)

    def validate(self, attrs):
        if attrs["action"] == "move" and "folder" not in attrs:
            raise serializers.ValidationError(
                {"folder": ["Required for the move action (null = top level)."]}
            )
        attrs["ids"] = list(dict.fromkeys(attrs["ids"]))
        return attrs


class VersionSummarySerializer(serializers.ModelSerializer):
    thumbnail_url = serializers.SerializerMethodField()

    class Meta:
        model = DesignVersion
        fields = ("id", "label", "is_auto", "page_count", "thumbnail_url", "created_at")
        read_only_fields = fields

    def get_thumbnail_url(self, obj: DesignVersion) -> str | None:
        return obj.thumbnail.url if obj.thumbnail else None


class VersionDetailSerializer(VersionSummarySerializer):
    document = DocumentField(read_only=True)

    class Meta(VersionSummarySerializer.Meta):
        fields = (*VersionSummarySerializer.Meta.fields, "document")
        read_only_fields = fields


class VersionCreateSerializer(serializers.Serializer):
    label = serializers.CharField(max_length=LABEL_MAX_LENGTH * 2, required=False, allow_blank=True)

    def validate_label(self, value: str) -> str:
        label = clean_text(value)
        if len(label) > LABEL_MAX_LENGTH:
            raise serializers.ValidationError(
                f"Ensure this field has no more than {LABEL_MAX_LENGTH} characters."
            )
        return label or DEFAULT_VERSION_LABEL


class FolderSerializer(serializers.ModelSerializer):
    parent = serializers.PrimaryKeyRelatedField(read_only=True)
    design_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = Folder
        fields = ("id", "name", "parent", "design_count", "created_at")
        read_only_fields = fields


class FolderWriteSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=FOLDER_NAME_LENGTH * 2)
    parent = OwnedFolderField(queryset=Folder.objects.none(), required=False, allow_null=True)

    def validate_name(self, value: str) -> str:
        name = clean_text(value)
        if not name:
            raise serializers.ValidationError("The name cannot be empty.")
        if len(name) > FOLDER_NAME_LENGTH:
            raise serializers.ValidationError(
                f"Ensure this field has no more than {FOLDER_NAME_LENGTH} characters."
            )
        return name


class FieldSerializer(serializers.Serializer):
    """A template field (`doc/fields.py:list_fields`); for the API schema only."""

    key = serializers.CharField(allow_null=True)
    type = serializers.ChoiceField(choices=["text", "image", "color"])
    label = serializers.CharField(allow_null=True)
    pages = serializers.ListField(child=serializers.IntegerField())
    object_ids = serializers.ListField(child=serializers.CharField())
    current = serializers.JSONField(allow_null=True)
    fit = serializers.JSONField(allow_null=True)
    overflow = serializers.BooleanField()


class FillSerializer(serializers.Serializer):
    values = serializers.DictField(child=serializers.JSONField(allow_null=True), allow_empty=False)
    as_copy = serializers.BooleanField(default=True)
    name = TitleField(required=False)


class BulkFillSerializer(serializers.Serializer):
    rows = serializers.ListField(
        child=serializers.DictField(child=serializers.JSONField(allow_null=True)), min_length=1
    )
    row_numbers = serializers.ListField(
        child=serializers.IntegerField(min_value=1), required=False, allow_null=True
    )
    name_pattern = serializers.CharField(max_length=200, required=False, allow_blank=True)
    folder = OwnedFolderField(queryset=Folder.objects.none(), required=False, allow_null=True)
    export = serializers.ChoiceField(choices=["png", "jpg"], required=False, allow_null=True)

    def validate(self, attrs):
        rows = attrs.get("rows", [])
        row_numbers = attrs.get("row_numbers")
        if row_numbers is not None and len(row_numbers) != len(rows):
            raise serializers.ValidationError({"row_numbers": "Must have one entry per row when provided."})
        return attrs

    def validate_rows(self, rows):
        if len(rows) > settings.BULK_FILL_MAX_ROWS:
            raise serializers.ValidationError(f"At most {settings.BULK_FILL_MAX_ROWS} rows at a time.")
        return rows
