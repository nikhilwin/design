from __future__ import annotations

from pathlib import Path

from django import forms
from django.contrib import admin, messages
from django.core.exceptions import PermissionDenied, ValidationError
from django.core.files.base import ContentFile
from django.db.models import Count, Q
from django.http import Http404, HttpRequest, HttpResponseRedirect
from django.template.response import TemplateResponse
from django.urls import path, reverse
from django.utils.html import format_html, format_html_join
from django.utils.translation import gettext_lazy as _
from unfold.admin import ModelAdmin
from unfold.decorators import action, display
from unfold.widgets import UnfoldAdminFileFieldWidget, UnfoldAdminSelectWidget, UnfoldAdminTextInputWidget

from apps.core.images import ImageError, make_thumbnail, process_image_upload
from apps.core.svg import MAX_BYTES, SvgError

from .importer import element_key, element_name, element_tags, import_svg
from .models import Element, ElementKind, ElementPack

MAX_BULK_FILES = 100
PREVIEW_GRID_LIMIT = 120
THUMBNAIL_MAX_SIDE = 480
MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024


def svg_preview(element: Element, height: int = 40) -> str:
    return format_html(
        '<img src="{}" alt="" loading="lazy" style="height:{}px;max-width:120px">', element.svg.url, height
    )


class MultipleFileInput(UnfoldAdminFileFieldWidget):
    allow_multiple_selected = True


class MultipleFileField(forms.FileField):
    def __init__(self, *args, **kwargs):
        kwargs.setdefault(
            "widget", MultipleFileInput(attrs={"accept": ".svg,image/svg+xml", "multiple": True})
        )
        super().__init__(*args, **kwargs)

    def clean(self, data, initial=None):
        files = data if isinstance(data, (list, tuple)) else [data]
        cleaned = [super(MultipleFileField, self).clean(item, initial) for item in files if item]
        if not cleaned:
            raise ValidationError(self.error_messages["required"], code="required")
        if len(cleaned) > MAX_BULK_FILES:
            raise ValidationError(_("Upload at most %(max)d files at a time.") % {"max": MAX_BULK_FILES})
        return cleaned


class BulkUploadForm(forms.Form):
    files = MultipleFileField(label=_("SVG files"))
    kind = forms.ChoiceField(
        required=False,
        choices=[("", _("Same as the pack")), *ElementKind.choices],
        widget=UnfoldAdminSelectWidget,
        label=_("Kind"),
    )


class ElementPackAdminForm(forms.ModelForm):
    class Meta:
        model = ElementPack
        fields = [
            "slug",
            "name",
            "kind",
            "license",
            "license_url",
            "attribution",
            "source_url",
            "description",
            "thumbnail",
            "sort_order",
            "is_published",
        ]

    def clean_thumbnail(self):
        upload = self.cleaned_data.get("thumbnail")
        if not upload or not hasattr(upload, "read") or "thumbnail" not in self.changed_data:
            return upload
        try:
            data = process_image_upload(upload, max_bytes=MAX_THUMBNAIL_BYTES).data
            return ContentFile(
                make_thumbnail(data, THUMBNAIL_MAX_SIDE), name=f"{self.cleaned_data.get('slug')}.webp"
            )
        except ImageError as exc:
            raise ValidationError(str(exc)) from exc


@admin.register(ElementPack)
class ElementPackAdmin(ModelAdmin):
    form = ElementPackAdminForm
    list_display = ["name", "slug", "kind", "license", "published_elements", "total_elements", "is_published"]
    list_editable = ["is_published"]
    list_filter = ["kind", "is_published"]
    search_fields = ["name", "slug", "description"]
    prepopulated_fields = {"slug": ("name",)}
    ordering_field = "sort_order"
    hide_ordering_field = True
    ordering = ["sort_order", "name"]
    readonly_fields = ["preview_grid", "source_ref", "synced_at", "created_at", "updated_at"]
    actions_detail = ["upload_svgs"]
    actions = ["publish", "unpublish"]
    fieldsets = [
        (None, {"fields": ["name", "slug", "kind", "description", "is_published"]}),
        (_("Licence"), {"fields": ["license", "license_url", "attribution", "source_url"]}),
        (_("Synced content"), {"fields": ["source_ref", "synced_at"], "classes": ["collapse"]}),
        (_("Thumbnail"), {"fields": ["thumbnail"]}),
        (_("Elements"), {"fields": ["preview_grid"]}),
    ]

    def get_queryset(self, request: HttpRequest):
        return (
            super()
            .get_queryset(request)
            .annotate(
                _published=Count("elements", filter=Q(elements__is_published=True)),
                _total=Count("elements"),
            )
        )

    @display(description=_("Published"), ordering="_published")
    def published_elements(self, obj: ElementPack) -> int:
        return obj._published

    @display(description=_("Elements"), ordering="_total")
    def total_elements(self, obj: ElementPack) -> int:
        return obj._total

    @display(description=_("Preview"))
    def preview_grid(self, obj: ElementPack):
        if not obj.pk:
            return "—"
        elements = list(obj.elements.order_by("sort_order", "name", "id")[:PREVIEW_GRID_LIMIT])
        if not elements:
            return _("No elements yet. Use “Upload SVGs” to add some.")
        cells = format_html_join(
            "",
            '<div title="{}" style="aspect-ratio:1;display:flex;align-items:center;justify-content:center;'
            "border:1px solid color-mix(in srgb, currentColor 18%, transparent);"
            'border-radius:6px;padding:6px">'
            '<img src="{}" alt="{}" loading="lazy" style="max-width:100%;max-height:100%{}"></div>',
            ((e.name, e.svg.url, e.name, "" if e.is_published else ";opacity:.35") for e in elements),
        )
        return format_html(
            '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:8px;'
            'max-width:56rem">{}</div>',
            cells,
        )

    @admin.action(description=_("Publish selected packs"))
    def publish(self, request: HttpRequest, queryset) -> None:
        self.message_user(request, _("%(n)d pack(s) published.") % {"n": queryset.update(is_published=True)})

    @admin.action(description=_("Unpublish selected packs"))
    def unpublish(self, request: HttpRequest, queryset) -> None:
        self.message_user(
            request, _("%(n)d pack(s) unpublished.") % {"n": queryset.update(is_published=False)}
        )

    @action(description=_("Upload SVGs"), url_path="upload-svgs", permissions=["change"])
    def upload_svgs(self, request: HttpRequest, object_id: str):
        return HttpResponseRedirect(reverse("admin:elements_elementpack_upload", args=[object_id]))

    def get_urls(self):
        custom = [
            path(
                "<path:object_id>/upload/",
                self.admin_site.admin_view(self.bulk_upload_view),
                name="elements_elementpack_upload",
            )
        ]
        return custom + super().get_urls()

    def bulk_upload_view(self, request: HttpRequest, object_id: str):
        pack = self.get_object(request, object_id)
        if pack is None:
            raise Http404
        if not (self.has_change_permission(request, pack) and request.user.has_perm("elements.add_element")):
            raise PermissionDenied
        pack_url = reverse("admin:elements_elementpack_change", args=[pack.pk])
        form = BulkUploadForm(request.POST or None, request.FILES or None)
        if request.method == "POST" and form.is_valid():
            created = updated = unchanged = 0
            for upload in form.cleaned_data["files"]:
                label = upload.name
                try:
                    if upload.size > MAX_BYTES:
                        raise SvgError("The file is larger than 5 MB.")
                    name = element_name(Path(label).stem)
                    key = element_key(Path(label))
                    outcome = import_svg(
                        pack,
                        key=key,
                        name=name,
                        tags=element_tags((), name),
                        data=upload.read(MAX_BYTES + 1),
                        kind=form.cleaned_data["kind"] or None,
                    )
                except (SvgError, ValueError) as exc:
                    messages.error(request, f"{label}: {exc}")
                    continue
                created += outcome == "created"
                updated += outcome == "updated"
                unchanged += outcome == "unchanged"
            if created or updated or unchanged:
                messages.success(
                    request,
                    _("%(c)d added, %(u)d replaced, %(n)d unchanged.")
                    % {"c": created, "u": updated, "n": unchanged},
                )
            return HttpResponseRedirect(pack_url)
        context = {
            **self.admin_site.each_context(request),
            "title": _("Upload SVGs to %(pack)s") % {"pack": pack.name},
            "opts": self.model._meta,
            "pack": pack,
            "form": form,
            "max_files": MAX_BULK_FILES,
            "cancel_url": pack_url,
        }
        return TemplateResponse(request, "admin/elements/bulk_upload.html", context)


class ElementAdminForm(forms.ModelForm):
    tags = forms.CharField(
        required=False,
        widget=UnfoldAdminTextInputWidget,
        help_text=_("Comma-separated."),
    )

    class Meta:
        model = Element
        fields = ["pack", "name", "kind", "style", "tags", "svg", "is_published", "sort_order"]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.initial["tags"] = ", ".join(self.instance.tags or [])

    def clean_tags(self) -> list[str]:
        words = [" ".join(tag.split()).lower() for tag in self.cleaned_data["tags"].split(",")]
        tags = list(dict.fromkeys(tag for tag in words if tag))
        if len(tags) > 30 or any(len(tag) > 40 for tag in tags):
            raise ValidationError(_("Use at most 30 tags of up to 40 characters."))
        return tags


@admin.register(Element)
class ElementAdmin(ModelAdmin):
    form = ElementAdminForm
    list_display = [
        "preview",
        "name",
        "pack",
        "kind",
        "style",
        "tag_list",
        "size",
        "is_recolorable",
        "is_published",
    ]
    list_display_links = ["preview", "name"]
    list_editable = ["is_published"]
    list_filter = ["pack", "kind", "style", "is_published", "is_recolorable"]
    list_select_related = ["pack"]
    list_per_page = 60
    search_fields = ["name", "key", "tags"]
    actions = ["publish", "unpublish"]
    readonly_fields = [
        "preview_large",
        "size",
        "palette",
        "is_recolorable",
        "key",
        "created_at",
        "updated_at",
    ]
    fieldsets = [
        (None, {"fields": ["pack", "name", "kind", "style", "tags", "is_published", "sort_order"]}),
        (_("Artwork"), {"fields": ["svg", "preview_large", "size", "palette", "is_recolorable"]}),
        (_("Identity"), {"fields": ["key", "created_at", "updated_at"], "classes": ["collapse"]}),
    ]

    @display(description=_("Preview"))
    def preview(self, obj: Element):
        return svg_preview(obj)

    @display(description=_("Artwork"))
    def preview_large(self, obj: Element):
        return svg_preview(obj, 160) if obj.svg else "—"

    @display(description=_("Tags"))
    def tag_list(self, obj: Element) -> str:
        return ", ".join(obj.tags[:6])

    @display(description=_("Size"))
    def size(self, obj: Element) -> str:
        return f"{obj.width:g} x {obj.height:g}" if obj.width else "—"

    @display(description=_("Colours"))
    def palette(self, obj: Element):
        if not obj.colors:
            return _("None (not recolourable)")
        return format_html_join(
            " ",
            '<span title="{0}" style="display:inline-block;width:1.25rem;height:1.25rem;border-radius:4px;'
            'background:{0};border:1px solid color-mix(in srgb, currentColor 25%, transparent)"></span>',
            ((color,) for color in obj.colors),
        )

    @admin.action(description=_("Publish selected elements"))
    def publish(self, request: HttpRequest, queryset) -> None:
        self.message_user(
            request, _("%(n)d element(s) published.") % {"n": queryset.update(is_published=True)}
        )

    @admin.action(description=_("Unpublish selected elements"))
    def unpublish(self, request: HttpRequest, queryset) -> None:
        self.message_user(
            request, _("%(n)d element(s) unpublished.") % {"n": queryset.update(is_published=False)}
        )
