from django.contrib import admin
from unfold.admin import ModelAdmin

from .models import Comment, ShareLink


@admin.register(ShareLink)
class ShareLinkAdmin(ModelAdmin):
    """Read-mostly: staff can switch a link off, never see its token or password hash."""

    list_display = (
        "design",
        "role",
        "is_active",
        "expires_at",
        "access_count",
        "last_accessed_at",
        "created_at",
    )
    list_filter = ("role", "is_active")
    search_fields = ("design__title", "design__id")
    list_select_related = ("design",)
    exclude = ("token", "password_hash")
    readonly_fields = (
        "design",
        "role",
        "expires_at",
        "created_by",
        "last_accessed_at",
        "access_count",
        "created_at",
        "updated_at",
    )

    def has_add_permission(self, request):
        return False


@admin.register(Comment)
class CommentAdmin(ModelAdmin):
    """Moderation view: comments can be read and deleted, not edited."""

    list_display = ("short_body", "author", "design", "resolved", "created_at")
    list_filter = ("resolved",)
    search_fields = ("body", "author__email", "design__title")
    list_select_related = ("author", "design")
    readonly_fields = (
        "design",
        "author",
        "body",
        "page_id",
        "x",
        "y",
        "parent",
        "resolved",
        "created_at",
        "updated_at",
    )

    @admin.display(description="Comment")
    def short_body(self, comment: Comment) -> str:
        return comment.body[:80]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False
