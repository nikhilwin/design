import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.urls import reverse

from apps.fonts.models import FontFamily, FontVariant

from .factories import make_family
from .fontfiles import make_font

pytestmark = pytest.mark.django_db


def formset(prefix="variants", **rows):
    data = {
        f"{prefix}-TOTAL_FORMS": str(len(rows)),
        f"{prefix}-INITIAL_FORMS": "0",
        f"{prefix}-MIN_NUM_FORMS": "0",
        f"{prefix}-MAX_NUM_FORMS": "1000",
    }
    for index, (weight, upload) in enumerate(rows.items()):
        data[f"{prefix}-{index}-weight"] = weight
        data[f"{prefix}-{index}-style"] = "normal"
        data[f"{prefix}-{index}-subset"] = ""
        data[f"{prefix}-{index}-file"] = upload
    return data


def family_data(**overrides):
    data = {
        "family": "Staff Pick",
        "slug": "staff-pick",
        "category": "serif",
        "is_published": "on",
        "scripts": "[]",
        "popularity": "5",
        "source": "fontsource",
        "license": "OFL-1.1",
    }
    data.update(overrides)
    return data


def test_changelist_and_forms_render_with_previews(staff_client):
    family = make_family("Open Sans", slug="open-sans")
    page = staff_client.get(reverse("admin:fonts_fontfamily_changelist"))
    html = page.content.decode()

    assert page.status_code == 200
    assert f"doory-preview-{family.pk.hex}" in html and "The quick brown fox" in html
    assert staff_client.get(reverse("admin:fonts_fontfamily_add")).status_code == 200
    assert staff_client.get(reverse("admin:fonts_fontfamily_change", args=[family.pk])).status_code == 200


def test_changelist_query_count_does_not_grow_with_rows(staff_client, django_assert_max_num_queries):
    for index in range(6):
        make_family(f"Font {index}", variants=[(400, "normal", "latin"), (700, "normal", "latin")])
    with django_assert_max_num_queries(20):
        assert staff_client.get(reverse("admin:fonts_fontfamily_changelist")).status_code == 200


def test_staff_can_add_a_family_with_a_validated_font_file(staff_client):
    upload = SimpleUploadedFile("brand.ttf", make_font("Staff Pick"), content_type="font/ttf")
    response = staff_client.post(
        reverse("admin:fonts_fontfamily_add"), {**family_data(), **formset(**{"400": upload})}
    )

    assert response.status_code == 302, response.context["errors"] if response.context else ""
    family = FontFamily.objects.get(slug="staff-pick")
    variant = family.variants.get()
    assert family.owner is None and variant.format == "ttf" and variant.size > 0
    assert variant.file.name.startswith("fonts/system/staff-pick/") and variant.file.name.endswith(".ttf")


def test_admin_rejects_files_that_are_not_fonts(staff_client):
    junk = SimpleUploadedFile("brand.ttf", b"this is not a font at all", content_type="font/ttf")
    response = staff_client.post(
        reverse("admin:fonts_fontfamily_add"), {**family_data(), **formset(**{"400": junk})}
    )
    assert response.status_code == 200
    assert not FontFamily.objects.exists() and not FontVariant.objects.exists()


def test_publish_and_unpublish_actions(staff_client):
    a, b = make_family("A"), make_family("B")
    url = reverse("admin:fonts_fontfamily_changelist")
    staff_client.post(url, {"action": "unpublish", "_selected_action": [a.pk, b.pk]})
    assert FontFamily.objects.filter(is_published=True).count() == 0
    staff_client.post(url, {"action": "publish", "_selected_action": [a.pk]})
    assert FontFamily.objects.filter(is_published=True).count() == 1


def test_owner_cannot_be_reassigned_in_the_admin(staff_client, user):
    mine = make_family("Mine", owner=user, slug="mine")
    page = staff_client.get(reverse("admin:fonts_fontfamily_change", args=[mine.pk]))
    assert 'name="owner"' not in page.content.decode()
    assert user.email in page.content.decode()
