from rest_framework import serializers

from apps.accounts.serializers import PASSWORD_MAX_LENGTH
from apps.designs.serializers import clean_text

from .models import ApiToken
from .scopes import DEFAULT_SCOPES, SCOPES

NAME_MAX_LENGTH = 80
MAX_EXPIRY_DAYS = 365
DEFAULT_EXPIRY_DAYS = 90


class ApiTokenSerializer(serializers.ModelSerializer):
    class Meta:
        model = ApiToken
        fields = ("id", "name", "prefix", "scopes", "created_at", "last_used_at", "expires_at", "revoked_at")
        read_only_fields = fields


class ApiTokenCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=NAME_MAX_LENGTH * 2)
    scopes = serializers.ListField(
        child=serializers.ChoiceField(choices=sorted(SCOPES)),
        min_length=1,
        max_length=len(SCOPES),
        default=list(DEFAULT_SCOPES),
    )
    expires_in_days = serializers.IntegerField(
        min_value=1, max_value=MAX_EXPIRY_DAYS, default=DEFAULT_EXPIRY_DAYS
    )
    # The caller proves it is the account owner (see `accounts.views.confirm_identity`): an open session
    # alone must not be enough to mint a long-lived key.
    password = serializers.CharField(
        required=False,
        allow_blank=True,
        write_only=True,
        trim_whitespace=False,
        max_length=PASSWORD_MAX_LENGTH,
    )
    confirm_email = serializers.CharField(required=False, allow_blank=True, write_only=True, max_length=254)

    def validate_name(self, value: str) -> str:
        name = clean_text(value)
        if not name:
            raise serializers.ValidationError("The name cannot be empty.")
        if len(name) > NAME_MAX_LENGTH:
            raise serializers.ValidationError(
                f"Ensure this field has no more than {NAME_MAX_LENGTH} characters."
            )
        return name


class IssuedTokenSerializer(ApiTokenSerializer):
    token = serializers.CharField(read_only=True, help_text="The full token. It is shown only this once.")

    class Meta(ApiTokenSerializer.Meta):
        fields = (*ApiTokenSerializer.Meta.fields, "token")
        read_only_fields = fields


class ScopeSerializer(serializers.Serializer):
    id = serializers.CharField()
    description = serializers.CharField()
