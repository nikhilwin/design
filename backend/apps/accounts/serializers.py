from __future__ import annotations

import re

from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers
from rest_framework.exceptions import ErrorDetail

from .models import User

PASSWORD_MAX_LENGTH = 128  # bounds hashing cost; Django's own validators handle the minimum

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


class UserSerializer(serializers.ModelSerializer):
    """The signed-in user's own profile. Never exposes hashes, tokens or other users' data."""

    name = serializers.CharField(read_only=True)
    avatar_url = serializers.SerializerMethodField()
    has_password = serializers.SerializerMethodField()
    google_linked = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = (
            "id",
            "email",
            "display_name",
            "name",
            "avatar_url",
            "is_email_verified",
            "has_password",
            "google_linked",
            "created_at",
        )
        read_only_fields = fields

    @extend_schema_field(OpenApiTypes.STR)
    def get_avatar_url(self, obj: User) -> str | None:
        return obj.avatar.url if obj.avatar else None

    def get_has_password(self, obj: User) -> bool:
        return obj.has_usable_password()

    def get_google_linked(self, obj: User) -> bool:
        return bool(obj.google_sub)


class UserEnvelopeSerializer(serializers.Serializer):
    user = UserSerializer()


class OptionalUserEnvelopeSerializer(serializers.Serializer):
    user = UserSerializer(allow_null=True)


class GoogleResultSerializer(serializers.Serializer):
    user = UserSerializer()
    created = serializers.BooleanField()


def clean_display_name(value: str) -> str:
    """Collapse whitespace and drop control characters (names end up in emails and the UI)."""
    return _CONTROL_CHARS.sub("", " ".join(value.split()))


def check_new_password(password: str, user: User, field: str = "new_password") -> None:
    """Run Django's password validators; failures keep their validator codes under `field`."""
    try:
        validate_password(password, user=user)
    except DjangoValidationError as exc:
        raise serializers.ValidationError(
            {
                field: [
                    ErrorDetail(error.messages[0], code=error.code or "invalid") for error in exc.error_list
                ]
            }
        ) from exc


def _password_field(**kwargs) -> serializers.CharField:
    return serializers.CharField(
        write_only=True,
        trim_whitespace=False,
        max_length=PASSWORD_MAX_LENGTH,
        style={"input_type": "password"},
        **kwargs,
    )


class RegisterSerializer(serializers.Serializer):
    email = serializers.EmailField(max_length=254)
    password = _password_field()
    display_name = serializers.CharField(max_length=80, required=False, allow_blank=True, default="")

    def validate_email(self, value: str) -> str:
        email = value.strip().lower()
        if User.objects.filter(email__iexact=email).exists():
            raise serializers.ValidationError(
                "An account with this email already exists.", code="email_taken"
            )
        return email

    def validate_display_name(self, value: str) -> str:
        return clean_display_name(value)

    def validate(self, attrs):
        candidate = User(email=attrs["email"], display_name=attrs.get("display_name", ""))
        check_new_password(attrs["password"], candidate, field="password")
        return attrs


class LoginSerializer(serializers.Serializer):
    email = serializers.EmailField(max_length=254)
    password = _password_field()

    def validate_email(self, value: str) -> str:
        return value.strip().lower()


class ProfileUpdateSerializer(serializers.Serializer):
    display_name = serializers.CharField(max_length=80, required=False, allow_blank=True)
    avatar = serializers.FileField(required=False, write_only=True)
    remove_avatar = serializers.BooleanField(required=False, write_only=True)

    def validate_display_name(self, value: str) -> str:
        return clean_display_name(value)


class DeleteAccountSerializer(serializers.Serializer):
    password = _password_field(required=False, allow_blank=True)
    confirm_email = serializers.CharField(required=False, allow_blank=True, max_length=254, write_only=True)


class PasswordChangeSerializer(serializers.Serializer):
    old_password = _password_field(required=False, allow_blank=True)
    new_password = _password_field()


class PasswordResetRequestSerializer(serializers.Serializer):
    email = serializers.EmailField(max_length=254)

    def validate_email(self, value: str) -> str:
        return value.strip().lower()


class PasswordResetConfirmSerializer(serializers.Serializer):
    uid = serializers.CharField(max_length=128)
    token = serializers.CharField(max_length=128)
    new_password = _password_field()


class EmailVerifySerializer(serializers.Serializer):
    uid = serializers.CharField(max_length=128)
    token = serializers.CharField(max_length=128)


class GoogleLoginSerializer(serializers.Serializer):
    credential = serializers.CharField(max_length=8192, trim_whitespace=True)
