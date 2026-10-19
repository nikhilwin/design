from __future__ import annotations

from django import forms
from django.contrib import admin, messages
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Count
from django.http import HttpRequest
from django.utils.translation import gettext_lazy as _
from unfold.admin import ModelAdmin
from unfold.decorators import action, display
from unfold.widgets import UnfoldAdminTextInputWidget

from .importer import find_name_clash
from .models import SizePreset, SizePresetGroup
from .validators import MAX_ALIASES, MAX_TAGS, normalize_aliases, normalize_tags


def _path(group: SizePresetGroup | None) -> str:
    parts = []
    while group is not None:
        parts.append(group.label)
        group = group.parent
    return " → ".join(reversed(parts))


@admin.register(SizePresetGroup)
class SizePresetGroupAdmin(ModelAdmin):
    list_display = ["label", "slug", "path", "icon", "preset_count", "is_active"]
    list_editable = ["is_active"]
    list_filter = ["is_active", "parent"]
    list_select_related = ["parent__parent__parent"]
    search_fields = ["label", "slug"]
    prepopulated_fields = {"slug": ("label",)}
    autocomplete_fields = ["parent"]
    ordering_field = "sort_order"
    hide_ordering_field = True
    ordering = ["sort_order", "label"]
    actions = ["activate", "deactivate"]

    def get_queryset(self, request: HttpRequest):
        return super().get_queryset(request).annotate(_presets=Count("presets"))

    @display(description=_("Path"))
    def path(self, obj: SizePresetGroup) -> str:
        return _path(obj)

    @display(description=_("Presets"), ordering="_presets")
    def preset_count(self, obj: SizePresetGroup) -> int:
        return obj._presets

    @action(description=_("Activate"))
    def activate(self, request: HttpRequest, queryset):
        count = queryset.update(is_active=True)
        messages.success(request, _("%(count)d group(s) activated.") % {"count": count})

    @action(description=_("Deactivate (hides everything inside)"))
    def deactivate(self, request: HttpRequest, queryset):
        count = queryset.update(is_active=False)
        messages.success(request, _("%(count)d group(s) deactivated.") % {"count": count})


class SizePresetAdminForm(forms.ModelForm):
    """Tags and aliases are typed as comma-separated text rather than JSON."""

    tags = forms.CharField(
        required=False,
        widget=UnfoldAdminTextInputWidget,
        help_text=_("Comma-separated, at most %(max)d, e.g. 4:5, paid.") % {"max": MAX_TAGS},
    )
    aliases = forms.CharField(
        required=False,
        widget=UnfoldAdminTextInputWidget,
        help_text=_("Old slugs that should still mean this preset; comma-separated, at most %(max)d.")
        % {"max": MAX_ALIASES},
    )

    class Meta:
        model = SizePreset
        fields = [
            "label",
            "slug",
            "group",
            "width",
            "height",
            "unit",
            "icon",
            "tags",
            "aliases",
            "meta",
            "is_quick",
            "is_active",
        ]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.initial["tags"] = ", ".join(self.instance.tags or [])
        self.initial["aliases"] = ", ".join(self.instance.aliases or [])

    def clean_tags(self) -> list[str]:
        try:
            return normalize_tags(self.cleaned_data["tags"])
        except ValueError as exc:
            raise ValidationError(str(exc)) from exc

    def clean_aliases(self) -> list[str]:
        try:
            return normalize_aliases(self.cleaned_data["aliases"])
        except ValueError as exc:
            raise ValidationError(str(exc)) from exc


@admin.register(SizePreset)
class SizePresetAdmin(ModelAdmin):
    form = SizePresetAdminForm
    list_display = ["label", "slug", "group_path", "size", "pixels", "is_quick", "is_active"]
    list_editable = ["is_quick", "is_active"]
    list_filter = ["is_active", "is_quick", "unit", "group"]
    list_select_related = ["group__parent__parent"]
    list_per_page = 100
    search_fields = ["label", "slug", "tags", "aliases", "group__label"]
    prepopulated_fields = {"slug": ("label",)}
    autocomplete_fields = ["group"]
    ordering_field = "sort_order"
    hide_ordering_field = True
    ordering = ["group__sort_order", "sort_order", "label"]
    actions = ["activate", "deactivate"]
    readonly_fields = ["pixels", "created_at", "updated_at"]
    fieldsets = [
        (None, {"fields": ["label", "slug", "group", "icon"]}),
        (_("Size"), {"fields": ["width", "height", "unit", "pixels"]}),
        (_("Finding it"), {"fields": ["tags", "aliases", "is_quick", "is_active"]}),
        (_("Extras"), {"fields": ["meta"], "classes": ["collapse"]}),
        (_("Audit"), {"fields": ["created_at", "updated_at"], "classes": ["collapse"]}),
    ]

    @display(description=_("Group"), ordering="group__label")
    def group_path(self, obj: SizePreset) -> str:
        return _path(obj.group)

    @display(description=_("Size"))
    def size(self, obj: SizePreset) -> str:
        return f"{obj.width.normalize():f} x {obj.height.normalize():f} {obj.unit}"

    @display(description=_("Pixels"))
    def pixels(self, obj: SizePreset) -> str:
        if obj.width is None or obj.height is None:
            return "-"
        return f"{obj.width_px} x {obj.height_px} px"

    @action(description=_("Activate"))
    def activate(self, request: HttpRequest, queryset):
        # Activating in bulk skips the form, so check that no slug or alias now means two presets.
        with transaction.atomic():
            count = queryset.filter(is_active=False).update(is_active=True)
            clash = find_name_clash(SizePreset)
            if clash:
                transaction.set_rollback(True)
        if clash:
            messages.error(request, _("Nothing was activated: %(clash)s") % {"clash": clash})
        else:
            messages.success(request, _("%(count)d preset(s) activated.") % {"count": count})

    @action(description=_("Deactivate"))
    def deactivate(self, request: HttpRequest, queryset):
        count = queryset.update(is_active=False)
        messages.success(request, _("%(count)d preset(s) deactivated.") % {"count": count})
