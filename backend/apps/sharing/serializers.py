import math
import re

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.fonts.serializers import FontFamilySerializer

from .models import Comment, ShareLink, ShareRole

PASSWORD_MIN_LENGTH = 4
PASSWORD_MAX_LENGTH = 128
_PRINTABLE_ASCII = re.compile(r"^[\x20-\x7e]+$")
_PAGE_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
COORDINATE_LIMIT = 1_000_000
COMMENT_MAX_LENGTH = 2000
ANONYMOUS_NAME = "Doory user"


def public_name(user) -> str:
    """Display name safe to show to other people: never derived from the e-mail address."""
    return (user.display_name or "").strip() or ANONYMOUS_NAME


def avatar_url(user) -> str | None:
    return user.avatar.url if user.avatar else None


class PublicUserSerializer(serializers.Serializer):
    name = serializers.SerializerMethodField()
    avatar_url = serializers.SerializerMethodField()

    def get_name(self, user) -> str:
        return public_name(user)

    def get_avatar_url(self, user) -> str | None:
        return avatar_url(user)


class CommentAuthorSerializer(PublicUserSerializer):
    id = serializers.UUIDField(read_only=True)


class LinkPasswordField(serializers.CharField):
    """Link passwords travel in an HTTP header, so they are restricted to printable ASCII."""

    default_error_messages = {
        "ascii": "Use only letters, digits, spaces and standard symbols (printable ASCII).",
    }

    def __init__(self, **kwargs):
        kwargs.setdefault("write_only", True)
        kwargs.setdefault("required", False)
        kwargs.setdefault("allow_null", True)
        kwargs.setdefault("allow_blank", True)
        kwargs.setdefault("min_length", PASSWORD_MIN_LENGTH)
        kwargs.setdefault("max_length", PASSWORD_MAX_LENGTH)
        super().__init__(**kwargs)

    def to_internal_value(self, data):
        value = super().to_internal_value(data)
        if value and not _PRINTABLE_ASCII.match(value):
            self.fail("ascii")
        return value


class ShareLinkSerializer(serializers.ModelSerializer):
    """Owner view of a link (and the response of create/update)."""

    url = serializers.SerializerMethodField()
    has_password = serializers.BooleanField(read_only=True)

    class Meta:
        model = ShareLink
        fields = ["id", "token", "role", "url", "is_active", "expires_at", "has_password", "created_at"]
        read_only_fields = fields

    def get_url(self, link: ShareLink) -> str:
        return f"{settings.SITE_URL.rstrip('/')}/s/{link.token}"


class _ShareLinkWriteSerializer(serializers.ModelSerializer):
    password = LinkPasswordField()

    def validate_expires_at(self, value):
        unchanged = self.instance is not None and value == self.instance.expires_at
        if value is not None and not unchanged and value <= timezone.now():
            raise serializers.ValidationError("expires_at must be in the future.")
        return value


class ShareLinkCreateSerializer(_ShareLinkWriteSerializer):
    role = serializers.ChoiceField(choices=ShareRole.choices)

    class Meta:
        model = ShareLink
        fields = ["role", "expires_at", "password"]

    def create(self, validated_data):
        password = validated_data.pop("password", None)
        link = ShareLink(**validated_data)
        link.set_password(password)
        link.save()
        return link


class ShareLinkUpdateSerializer(_ShareLinkWriteSerializer):
    class Meta:
        model = ShareLink
        fields = ["role", "expires_at", "is_active", "password"]

    def update(self, instance, validated_data):
        if "password" in validated_data:
            instance.set_password(validated_data.pop("password"))
        for field, value in validated_data.items():
            setattr(instance, field, value)
        instance.save()
        return instance


class SharedDesignSerializer(serializers.Serializer):
    """What an anonymous viewer is allowed to learn about a design. `fonts` are the owner's uploaded font
    families that the document names, so the viewer's browser can draw the text as the owner sees it."""

    design_id = serializers.UUIDField()
    role = serializers.CharField()
    title = serializers.CharField()
    width = serializers.IntegerField()
    height = serializers.IntegerField()
    revision = serializers.IntegerField()
    owner = PublicUserSerializer()
    document = serializers.JSONField()
    fonts = FontFamilySerializer(many=True)


class SharedSaveSerializer(serializers.Serializer):
    document = serializers.JSONField()
    base_revision = serializers.IntegerField(min_value=1)


class SharedSaveResultSerializer(serializers.Serializer):
    revision = serializers.IntegerField()
    updated_at = serializers.DateTimeField()


class CommentSerializer(serializers.ModelSerializer):
    author = CommentAuthorSerializer(read_only=True)
    page_id = serializers.SerializerMethodField()
    parent = serializers.PrimaryKeyRelatedField(read_only=True)

    class Meta:
        model = Comment
        fields = ["id", "author", "body", "page_id", "x", "y", "parent", "resolved", "created_at"]
        read_only_fields = fields

    @extend_schema_field(serializers.CharField(allow_null=True))
    def get_page_id(self, comment: Comment) -> str | None:
        return comment.page_id or None


class _Coordinate(serializers.FloatField):
    def to_internal_value(self, data):
        value = super().to_internal_value(data)
        if not math.isfinite(value) or abs(value) > COORDINATE_LIMIT:
            self.fail("invalid")
        return value


class CommentCreateSerializer(serializers.Serializer):
    """`context["design_id"]` is the design the comment is written to."""

    body = serializers.CharField(max_length=COMMENT_MAX_LENGTH)
    page_id = serializers.RegexField(
        _PAGE_ID, required=False, allow_null=True, allow_blank=True, max_length=64
    )
    x = _Coordinate(required=False, allow_null=True)
    y = _Coordinate(required=False, allow_null=True)
    parent = serializers.UUIDField(required=False, allow_null=True)

    def validate(self, attrs):
        parent_id = attrs.pop("parent", None)
        if parent_id is not None:
            parent = (
                Comment.objects.filter(pk=parent_id, design_id=self.context["design_id"])
                .only("id", "parent_id", "page_id", "x", "y")
                .first()
            )
            if parent is None:
                raise serializers.ValidationError({"parent": "Unknown comment."})
            if parent.parent_id is not None:
                raise serializers.ValidationError({"parent": "Replies cannot be nested."})
            attrs.update(parent=parent, page_id=parent.page_id, x=parent.x, y=parent.y)
            return attrs
        x, y = attrs.get("x"), attrs.get("y")
        if (x is None) != (y is None):
            raise serializers.ValidationError({"x": "x and y must be given together."})
        attrs["page_id"] = attrs.get("page_id") or ""
        attrs["x"], attrs["y"] = x, y
        return attrs

    def create(self, validated_data):
        return Comment.objects.create(**validated_data)


ANCHOR_FIELDS = ("page_id", "x", "y")


class _AnchorMixin(serializers.Serializer):
    """`page_id`, `x` and `y` of a pin. `x` and `y` travel together; `page_id` is optional."""

    page_id = serializers.RegexField(
        _PAGE_ID, required=False, allow_null=True, allow_blank=True, max_length=64
    )
    x = _Coordinate(required=False, allow_null=True)
    y = _Coordinate(required=False, allow_null=True)

    def validate(self, attrs):
        if ("x" in attrs) != ("y" in attrs) or (attrs.get("x") is None) != (attrs.get("y") is None):
            raise serializers.ValidationError({"x": "x and y must be given together."})
        if "page_id" in attrs:
            attrs["page_id"] = attrs["page_id"] or ""
        return attrs

    def move(self, comment: Comment, attrs: dict) -> Comment:
        """Applies the anchor to a top-level comment and to its replies, which always follow the thread."""
        anchor = {name: attrs[name] for name in ANCHOR_FIELDS if name in attrs}
        if not anchor:
            return comment
        with transaction.atomic():
            for name, value in anchor.items():
                setattr(comment, name, value)
            comment.save(update_fields=[*anchor, "updated_at"])
            Comment.objects.filter(parent=comment).update(**anchor, updated_at=timezone.now())
        return comment


class CommentUpdateSerializer(_AnchorMixin):
    """Owner PATCH: resolve or re-open a thread and/or move its pin (top-level comments only), and change the
    text of a comment the requesting user wrote (`context["user"]`)."""

    resolved = serializers.BooleanField(required=False)
    body = serializers.CharField(max_length=COMMENT_MAX_LENGTH, required=False)

    def validate(self, attrs):
        attrs = super().validate(attrs)
        user = self.context.get("user")
        if "body" in attrs and (user is None or self.instance is None or self.instance.author_id != user.pk):
            raise serializers.ValidationError({"body": "You can only change the text of your own comments."})
        if self.instance is not None and self.instance.parent_id is not None:
            if "resolved" in attrs:
                raise serializers.ValidationError({"resolved": "Only top-level comments can be resolved."})
            if any(name in attrs for name in ANCHOR_FIELDS):
                raise serializers.ValidationError({"x": "Only top-level comments can be moved."})
        return attrs

    def update(self, instance, validated_data):
        changed = [field for field in ("resolved", "body") if field in validated_data]
        for field in changed:
            setattr(instance, field, validated_data[field])
        if changed:
            instance.save(update_fields=[*changed, "updated_at"])
        return self.move(instance, validated_data)


class CommentMoveSerializer(_AnchorMixin):
    """PATCH through a share link: the author moves the pin of their own thread (nothing else)."""

    def validate(self, attrs):
        attrs = super().validate(attrs)
        if not any(name in attrs for name in ANCHOR_FIELDS):
            raise serializers.ValidationError({"x": "Give the new position of the comment."})
        if self.instance is not None and self.instance.parent_id is not None:
            raise serializers.ValidationError({"x": "Only top-level comments can be moved."})
        return attrs

    def update(self, instance, validated_data):
        return self.move(instance, validated_data)
