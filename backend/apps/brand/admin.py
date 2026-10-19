import json

from django.contrib import admin
from django.db.models import Count
from django.utils.html import format_html
from unfold.admin import ModelAdmin
from unfold.decorators import display

from .models import BrandKit


@admin.register(BrandKit)
class BrandKitAdmin(ModelAdmin):
    list_display = ("name", "owner", "is_default", "color_total", "logo_total", "created_at")
    list_filter = ("is_default", "created_at")
    search_fields = ("name", "owner__email")
    list_select_related = ("owner",)
    fields = ("name", "is_default", "owner", "colors_pretty", "fonts_pretty", "created_at", "updated_at")
    readonly_fields = ("owner", "colors_pretty", "fonts_pretty", "created_at", "updated_at")

    def get_queryset(self, request):
        return super().get_queryset(request).annotate(_logo_total=Count("logos"))

    def has_add_permission(self, request):
        return False

    @display(description="Colours")
    def color_total(self, obj: BrandKit) -> int:
        return len(obj.colors)

    @display(description="Logos", ordering="_logo_total")
    def logo_total(self, obj: BrandKit) -> int:
        return obj._logo_total

    @display(description="Colours")
    def colors_pretty(self, obj: BrandKit) -> str:
        return format_html("<pre>{}</pre>", json.dumps(obj.colors, indent=2))

    @display(description="Fonts")
    def fonts_pretty(self, obj: BrandKit) -> str:
        return format_html("<pre>{}</pre>", json.dumps(obj.fonts, indent=2))
