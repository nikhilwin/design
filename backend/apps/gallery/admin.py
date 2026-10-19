from __future__ import annotations

import json

from django import forms
from django.contrib import admin, messages
from django.core.exceptions import ValidationError
from django.core.files.base import ContentFile
from django.db.models import Count, Q
from django.http import HttpRequest, HttpResponseRedirect
from django.urls import reverse
from django.utils.html import format_html
from django.utils.translation import gettext_lazy as _
from unfold.admin import ModelAdmin
from unfold.decorators import action, display
from unfold.widgets import UnfoldAdminFileFieldWidget, UnfoldAdminTextInputWidget

from apps.core.images import ImageError

from .models import Template, TemplateCategory
from .services import duplicate_template, replace_thumbnail, thumbnail_from_upload
from .validators import (
    MAX_TAGS,
    TemplateDocumentError,
    normalize_tags,
    validate_template_document,
)

MAX_JSON_UPLOAD_BYTES = 16 * 1024 * 1024
DOCUMENT_PREVIEW_CHARS = 200_000


@admin.register(TemplateCategory)
class TemplateCategoryAdmin(ModelAdmin):
    list_display = ["name", "slug", "icon", "published_templates", "total_templates"]
    search_fields = ["name", "slug"]
    prepopulated_fields = {"slug": ("name",)}
    ordering_field = "sort_order"
    hide_ordering_field = True
    ordering = ["sort_order", "name"]

    def get_queryset(self, request: HttpRequest):
        return (
            super()
            .get_queryset(request)
            .annotate(
                _published=Count("templates", filter=Q(templates__is_published=True)),
                _total=Count("templates"),
            )
        )

    @display(description=_("Published"), ordering="_published")
    def published_templates(self, obj: TemplateCategory) -> int:
        return obj._published

    @display(description=_("Templates"), ordering="_total")
    def total_templates(self, obj: TemplateCategory) -> int:
        return obj._total


class TemplateAdminForm(forms.ModelForm):
    """Edit a template's metadata and replace its document from an uploaded JSON file.

    The document itself is never edited inline: it is validated as a whole and its size, page count and
    preset are derived from it, so the row can never disagree with its document.
    """

    document_file = forms.FileField(
        required=False,
        label=_("Document (JSON file)"),
        widget=UnfoldAdminFileFieldWidget,
        help_text=_("A Doory design document (JSON). Required when creating a template."),
    )
    tags = forms.CharField(
        required=False,
        widget=UnfoldAdminTextInputWidget,
        help_text=_("Comma-separated, at most %(max)d.") % {"max": MAX_TAGS},
    )

    class Meta:
        model = Template
        fields = [
            "title",
            "slug",
            "description",
            "category",
            "tags",
            "preset",
            "thumbnail",
            "is_featured",
            "is_published",
        ]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.initial["tags"] = ", ".join(self.instance.tags or [])

    def _post_clean(self) -> None:
        # The document is checked in clean(); do not pile the model-level re-check on top of its error.
        if "document_file" not in self.errors:
            super()._post_clean()

    def clean_tags(self) -> list[str]:
        try:
            return normalize_tags(self.cleaned_data["tags"])
        except ValueError as exc:
            raise ValidationError(str(exc)) from exc

    def clean_thumbnail(self):
        upload = self.cleaned_data.get("thumbnail")
        if not upload or not hasattr(upload, "read"):
            return upload  # unchanged or cleared
        try:
            return thumbnail_from_upload(upload, slug=self.cleaned_data.get("slug") or "template")
        except ImageError as exc:
            raise ValidationError(str(exc)) from exc

    def clean(self):
        cleaned = super().clean()
        upload = cleaned.get("document_file")
        if upload is None:
            if self.instance._state.adding:
                self.add_error("document_file", _("Upload the template's JSON document."))
            return cleaned
        if upload.size > MAX_JSON_UPLOAD_BYTES:
            self.add_error("document_file", _("The file is larger than 16 MB."))
            return cleaned
        try:
            document = json.loads(upload.read().decode("utf-8"))
            self.instance.apply_document(document)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.add_error("document_file", _("The file is not valid UTF-8 JSON."))
        except TemplateDocumentError as exc:
            self.add_error("document_file", str(exc))
        else:
            cleaned["preset"] = cleaned.get("preset") or self.instance.preset
        return cleaned


def _validate(request: HttpRequest, templates) -> None:
    for template in templates:
        try:
            summary = validate_template_document(template.document)
        except TemplateDocumentError as exc:
            messages.error(request, f"{template.title}: {exc}")
            continue
        if (summary.width, summary.height, summary.page_count) != (
            template.width,
            template.height,
            template.page_count,
        ):
            messages.warning(request, f"{template.title}: size or page count differs from the document.")
        else:
            messages.success(
                request,
                f"{template.title}: valid ({summary.page_count} page(s), "
                f"{summary.width} x {summary.height}).",
            )


@admin.register(Template)
class TemplateAdmin(ModelAdmin):
    form = TemplateAdminForm
    list_display = [
        "preview",
        "title",
        "category",
        "size",
        "page_count",
        "is_featured",
        "is_published",
        "use_count",
        "created_at",
    ]
    list_display_links = ["preview", "title"]
    list_editable = ["is_featured", "is_published"]
    list_filter = ["is_published", "is_featured", "category", "preset"]
    list_select_related = ["category"]
    list_per_page = 40
    search_fields = ["title", "slug", "description", "tags"]
    prepopulated_fields = {"slug": ("title",)}
    autocomplete_fields = ["category"]
    actions = ["publish", "unpublish", "feature", "unfeature", "duplicate", "validate_documents"]
    actions_detail = ["validate_document", "duplicate_template_detail"]
    readonly_fields = [
        "preview_large",
        "document_json",
        "size",
        "page_count",
        "use_count",
        "created_by",
        "created_at",
        "updated_at",
    ]
    fieldsets = [
        (None, {"fields": ["title", "slug", "category", "description", "tags", "preset"]}),
        (_("Thumbnail"), {"fields": ["thumbnail", "preview_large"]}),
        (_("Document"), {"fields": ["document_file", "size", "page_count", "document_json"]}),
        (_("Visibility"), {"fields": ["is_published", "is_featured", "use_count"]}),
        (_("Audit"), {"fields": ["created_by", "created_at", "updated_at"], "classes": ["collapse"]}),
    ]

    def get_queryset(self, request: HttpRequest):
        return super().get_queryset(request).defer("document")

    def has_add_permission(self, request: HttpRequest, obj: Template | None = None) -> bool:
        # Unfold evaluates detail-action permissions with the object id as a second argument.
        return super().has_add_permission(request)

    def save_model(self, request: HttpRequest, obj: Template, form: TemplateAdminForm, change: bool) -> None:
        if not change and obj.created_by_id is None:
            obj.created_by = request.user
        new_thumbnail = form.cleaned_data.get("thumbnail")
        previous = ""
        if change and "thumbnail" in form.changed_data:
            previous = Template.objects.filter(pk=obj.pk).values_list("thumbnail", flat=True).first() or ""
            if isinstance(new_thumbnail, ContentFile):
                obj.thumbnail = previous
                replace_thumbnail(obj, new_thumbnail)
                previous = ""
        super().save_model(request, obj, form, change)
        if previous and not obj.thumbnail:
            obj.thumbnail.storage.delete(previous)  # the editor cleared the thumbnail

    @display(description=_("Preview"), image=True)
    def preview(self, obj: Template):
        return obj.thumbnail.url if obj.thumbnail else None

    @display(description=_("Current thumbnail"))
    def preview_large(self, obj: Template):
        if not obj.thumbnail:
            return "—"
        return format_html(
            '<img src="{}" alt="" style="max-width:20rem;max-height:20rem;border-radius:0.5rem">',
            obj.thumbnail.url,
        )

    @display(description=_("Size (px)"), ordering="width")
    def size(self, obj: Template) -> str:
        return f"{obj.width} x {obj.height} · {obj.orientation}" if obj.width else "—"

    @display(description=_("Document (read-only)"))
    def document_json(self, obj: Template):
        if not obj.pk:
            return "—"
        text = json.dumps(
            Template.objects.only("document").get(pk=obj.pk).document, indent=2, ensure_ascii=False
        )
        note = ""
        if len(text) > DOCUMENT_PREVIEW_CHARS:
            text = text[:DOCUMENT_PREVIEW_CHARS]
            note = format_html("<p><em>{}</em></p>", _("Preview truncated — the stored document is longer."))
        return format_html(
            '<pre style="max-height:28rem;overflow:auto;font-size:0.75rem;white-space:pre-wrap">{}</pre>{}',
            text,
            note,
        )

    @admin.action(description=_("Publish selected templates"))
    def publish(self, request: HttpRequest, queryset) -> None:
        count = queryset.update(is_published=True)
        self.message_user(request, _("%(n)d template(s) published.") % {"n": count}, messages.SUCCESS)

    @admin.action(description=_("Unpublish selected templates"))
    def unpublish(self, request: HttpRequest, queryset) -> None:
        count = queryset.update(is_published=False)
        self.message_user(request, _("%(n)d template(s) unpublished.") % {"n": count}, messages.SUCCESS)

    @admin.action(description=_("Mark selected templates as featured"))
    def feature(self, request: HttpRequest, queryset) -> None:
        self.message_user(
            request, _("%(n)d template(s) featured.") % {"n": queryset.update(is_featured=True)}
        )

    @admin.action(description=_("Remove featured mark from selected templates"))
    def unfeature(self, request: HttpRequest, queryset) -> None:
        self.message_user(
            request, _("%(n)d template(s) unfeatured.") % {"n": queryset.update(is_featured=False)}
        )

    @admin.action(description=_("Duplicate selected templates (as drafts)"))
    def duplicate(self, request: HttpRequest, queryset) -> None:
        copies = [duplicate_template(template, created_by=request.user) for template in queryset]
        self.message_user(
            request, _("%(n)d draft copy/copies created.") % {"n": len(copies)}, messages.SUCCESS
        )

    @admin.action(description=_("Validate the documents of selected templates"))
    def validate_documents(self, request: HttpRequest, queryset) -> None:
        _validate(request, queryset.select_related(None).defer(None))

    @action(description=_("Validate document"), url_path="validate", permissions=["change"])
    def validate_document(self, request: HttpRequest, object_id: str):
        _validate(request, Template.objects.filter(pk=object_id))
        return HttpResponseRedirect(reverse("admin:gallery_template_change", args=[object_id]))

    @action(description=_("Duplicate as draft"), url_path="duplicate", permissions=["add"])
    def duplicate_template_detail(self, request: HttpRequest, object_id: str):
        copy_ = duplicate_template(Template.objects.get(pk=object_id), created_by=request.user)
        messages.success(request, _("Draft copy created."))
        return HttpResponseRedirect(reverse("admin:gallery_template_change", args=[copy_.pk]))
