import json

from django.contrib import admin, messages
from django.db.models import Count
from django.utils import timezone
from django.utils.html import format_html
from unfold.admin import ModelAdmin
from unfold.decorators import display

from .models import Design, DesignVersion, Folder

MAX_PRETTY_CHARS = 200_000


def pretty_document(document: object) -> str:
    text = json.dumps(document, indent=2, ensure_ascii=False, sort_keys=True)
    note = ""
    if len(text) > MAX_PRETTY_CHARS:
        text, note = text[:MAX_PRETTY_CHARS], "\n... (truncated)"
    return format_html(
        '<pre style="max-height:480px;overflow:auto;white-space:pre-wrap;font-size:12px">{}{}</pre>',
        text,
        note,
    )


def thumbnail_preview(obj) -> str:
    if not obj.thumbnail:
        return "-"
    return format_html(
        '<img src="{}" alt="" style="max-height:160px;max-width:240px;border-radius:6px">', obj.thumbnail.url
    )


class TrashedFilter(admin.SimpleListFilter):
    title = "trash"
    parameter_name = "trashed"

    def lookups(self, request, model_admin):
        return [("yes", "In trash"), ("no", "Not in trash")]

    def queryset(self, request, queryset):
        if self.value() == "yes":
            return queryset.filter(trashed_at__isnull=False)
        if self.value() == "no":
            return queryset.filter(trashed_at__isnull=True)
        return queryset


@admin.register(Design)
class DesignAdmin(ModelAdmin):
    list_display = (
        "thumb",
        "title",
        "owner",
        "dimensions",
        "page_count",
        "revision",
        "starred",
        "in_trash",
        "updated_at",
    )
    list_display_links = ("thumb", "title")
    list_filter = (TrashedFilter, "starred", "preset", "created_at")
    search_fields = ("title", "owner__email")
    list_select_related = ("owner",)
    date_hierarchy = "created_at"
    actions = ("move_to_trash", "restore_from_trash")
    fields = (
        "title",
        "starred",
        "owner",
        "folder",
        "dimensions",
        "preset",
        "page_count",
        "revision",
        "thumb_large",
        "document_pretty",
        "trashed_at",
        "created_at",
        "updated_at",
    )
    readonly_fields = (
        "owner",
        "folder",
        "dimensions",
        "preset",
        "page_count",
        "revision",
        "thumb_large",
        "document_pretty",
        "trashed_at",
        "created_at",
        "updated_at",
    )

    def get_queryset(self, request):
        return super().get_queryset(request).defer("document")

    def has_add_permission(self, request):
        return False

    @display(description="Preview")
    def thumb(self, obj: Design) -> str:
        return thumbnail_preview(obj)

    @display(description="Thumbnail")
    def thumb_large(self, obj: Design) -> str:
        return thumbnail_preview(obj)

    @display(description="Size")
    def dimensions(self, obj: Design) -> str:
        return f"{obj.width} x {obj.height}"

    @display(description="Trashed", boolean=True)
    def in_trash(self, obj: Design) -> bool:
        return obj.trashed_at is not None

    @display(description="Document (read-only)")
    def document_pretty(self, obj: Design) -> str:
        return pretty_document(obj.document)

    @admin.action(description="Move selected designs to the trash")
    def move_to_trash(self, request, queryset):
        count = queryset.filter(trashed_at__isnull=True).update(trashed_at=timezone.now())
        self.message_user(request, f"{count} design(s) moved to the trash.", messages.SUCCESS)

    @admin.action(description="Restore selected designs from the trash")
    def restore_from_trash(self, request, queryset):
        count = queryset.filter(trashed_at__isnull=False).update(trashed_at=None)
        self.message_user(request, f"{count} design(s) restored.", messages.SUCCESS)


@admin.register(DesignVersion)
class DesignVersionAdmin(ModelAdmin):
    list_display = ("design", "label", "is_auto", "page_count", "created_by", "created_at")
    list_filter = ("is_auto", "created_at")
    search_fields = ("label", "design__title", "design__owner__email")
    list_select_related = ("design", "created_by")
    fields = (
        "design",
        "label",
        "is_auto",
        "page_count",
        "created_by",
        "thumb_large",
        "document_pretty",
        "created_at",
    )
    readonly_fields = fields

    def get_queryset(self, request):
        return super().get_queryset(request).defer("document")

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    @display(description="Thumbnail")
    def thumb_large(self, obj: DesignVersion) -> str:
        return thumbnail_preview(obj)

    @display(description="Document (read-only)")
    def document_pretty(self, obj: DesignVersion) -> str:
        return pretty_document(obj.document)


@admin.register(Folder)
class FolderAdmin(ModelAdmin):
    list_display = ("name", "owner", "parent", "design_total", "created_at")
    search_fields = ("name", "owner__email")
    list_select_related = ("owner", "parent")
    readonly_fields = ("owner", "parent", "created_at", "updated_at")
    fields = ("name", "owner", "parent", "created_at", "updated_at")

    def get_queryset(self, request):
        return super().get_queryset(request).annotate(_design_total=Count("designs"))

    def has_add_permission(self, request):
        return False

    @display(description="Designs", ordering="_design_total")
    def design_total(self, obj: Folder) -> int:
        return obj._design_total
