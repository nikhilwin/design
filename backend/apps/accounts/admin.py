from django.contrib import admin, messages
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from django.db.models import QuerySet
from django.http import HttpRequest
from django.utils.html import format_html
from unfold.admin import ModelAdmin
from unfold.forms import AdminPasswordChangeForm, UserChangeForm, UserCreationForm

from .models import User


class UserAdminCreationForm(UserCreationForm):
    class Meta:
        model = User
        fields = ("email", "display_name")


class UserAdminChangeForm(UserChangeForm):
    class Meta:
        model = User
        fields = "__all__"


@admin.register(User)
class UserAdmin(BaseUserAdmin, ModelAdmin):
    form = UserAdminChangeForm
    add_form = UserAdminCreationForm
    change_password_form = AdminPasswordChangeForm

    list_display = (
        "email",
        "display_name",
        "is_email_verified",
        "is_active",
        "is_staff",
        "google",
        "created_at",
    )
    list_filter = ("is_active", "is_staff", "is_superuser", "is_email_verified", "created_at")
    search_fields = ("email", "display_name")
    ordering = ("-created_at",)
    date_hierarchy = "created_at"
    list_per_page = 50
    readonly_fields = ("avatar_preview", "google_sub", "last_login", "created_at", "updated_at")
    actions = ("mark_verified", "activate_users", "deactivate_users")

    fieldsets = (
        (None, {"fields": ("email", "password")}),
        ("Profile", {"fields": ("display_name", "avatar", "avatar_preview")}),
        ("Verification", {"fields": ("is_email_verified", "google_sub")}),
        (
            "Permissions",
            {"fields": ("is_active", "is_staff", "is_superuser", "groups", "user_permissions")},
        ),
        ("Dates", {"fields": ("last_login", "created_at", "updated_at")}),
    )
    add_fieldsets = (
        (
            None,
            {
                "classes": ("wide",),
                "fields": ("email", "display_name", "usable_password", "password1", "password2"),
            },
        ),
    )
    filter_horizontal = ("groups", "user_permissions")

    @admin.display(description="Avatar")
    def avatar_preview(self, obj: User) -> str:
        if not obj.avatar:
            return "-"
        return format_html(
            '<img src="{}" alt="" width="64" height="64" style="border-radius:50%;object-fit:cover">',
            obj.avatar.url,
        )

    @admin.display(description="Google", boolean=True)
    def google(self, obj: User) -> bool:
        return bool(obj.google_sub)

    @admin.action(description="Mark selected users as email-verified")
    def mark_verified(self, request: HttpRequest, queryset: QuerySet[User]) -> None:
        updated = queryset.filter(is_email_verified=False).update(is_email_verified=True)
        self.message_user(request, f"{updated} user(s) marked as verified.", messages.SUCCESS)

    @admin.action(description="Activate selected users")
    def activate_users(self, request: HttpRequest, queryset: QuerySet[User]) -> None:
        updated = queryset.filter(is_active=False).update(is_active=True)
        self.message_user(request, f"{updated} user(s) activated.", messages.SUCCESS)

    @admin.action(description="Deactivate selected users")
    def deactivate_users(self, request: HttpRequest, queryset: QuerySet[User]) -> None:
        updated = queryset.exclude(pk=request.user.pk).filter(is_active=True).update(is_active=False)
        self.message_user(request, f"{updated} user(s) deactivated.", messages.SUCCESS)
