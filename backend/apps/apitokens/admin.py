from django.contrib import admin
from django.utils import timezone
from unfold.admin import ModelAdmin

from .models import ApiToken


@admin.register(ApiToken)
class ApiTokenAdmin(ModelAdmin):
    list_display = ("name", "prefix", "owner", "created_at", "last_used_at", "expires_at", "revoked_at")
    list_filter = ("created_at", "revoked_at")
    search_fields = ("name", "prefix", "owner__email")
    list_select_related = ("owner",)
    fields = ("name", "prefix", "owner", "scopes", "created_at", "last_used_at", "expires_at", "revoked_at")
    readonly_fields = fields
    actions = ["revoke"]

    def has_add_permission(self, request):
        return False

    @admin.action(description="Revoke the selected tokens")
    def revoke(self, request, queryset):
        queryset.filter(revoked_at__isnull=True).update(revoked_at=timezone.now())
