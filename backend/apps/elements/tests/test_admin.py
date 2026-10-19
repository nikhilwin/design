from io import BytesIO

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client
from django.urls import reverse
from PIL import Image

from apps.accounts.models import User
from apps.elements.models import Element, ElementPack

from .factories import CURRENT_COLOR, EVIL, RED_SQUARE, make_element, make_pack

pytestmark = pytest.mark.django_db


def svg_upload(text=RED_SQUARE, name="shape.svg"):
    return SimpleUploadedFile(name, text.encode(), content_type="image/svg+xml")


def element_form(pack, **overrides):
    data = {
        "pack": str(pack.id),
        "name": "Uploaded",
        "kind": "shape",
        "tags": "Alpha, beta, ALPHA",
        "is_published": "on",
        "sort_order": "0",
    }
    data.update(overrides)
    return data


def test_changelists_and_forms_render(staff_client):
    pack = make_pack()
    element = make_element(pack)
    for name in ("elementpack", "element"):
        assert staff_client.get(reverse(f"admin:elements_{name}_changelist")).status_code == 200
    assert staff_client.get(reverse("admin:elements_elementpack_add")).status_code == 200
    assert staff_client.get(reverse("admin:elements_element_add")).status_code == 200
    assert staff_client.get(reverse("admin:elements_element_change", args=[element.pk])).status_code == 200
    page = staff_client.get(reverse("admin:elements_elementpack_change", args=[pack.pk]))
    assert page.status_code == 200 and element.svg.url in page.content.decode()


def test_admin_add_sanitises_the_uploaded_svg(staff_client):
    pack = make_pack()
    response = staff_client.post(
        reverse("admin:elements_element_add"), {**element_form(pack), "svg": svg_upload(EVIL)}
    )

    assert response.status_code == 302
    element = Element.objects.get()
    with element.svg.open("rb") as handle:
        stored = handle.read().decode()
    assert "script" not in stored and "onclick" not in stored and "evil.example" not in stored
    assert element.tags == ["alpha", "beta"]
    assert element.colors == ["#ff0000"]


@pytest.mark.parametrize("payload", ["not xml", "<html/>", ""])
def test_admin_add_rejects_non_svg_uploads(staff_client, payload):
    pack = make_pack()
    response = staff_client.post(
        reverse("admin:elements_element_add"), {**element_form(pack), "svg": svg_upload(payload)}
    )
    assert response.status_code == 200
    assert response.context["adminform"].form.errors.get("svg")
    assert not Element.objects.exists()


def test_admin_replace_svg_refreshes_metadata(staff_client):
    pack = make_pack()
    element = make_element(pack)
    response = staff_client.post(
        reverse("admin:elements_element_change", args=[element.pk]),
        {**element_form(pack, name=element.name), "svg": svg_upload(CURRENT_COLOR)},
    )
    assert response.status_code == 302
    element.refresh_from_db()
    assert element.is_recolorable is False and element.width == 24


def test_bulk_upload_page_requires_login_and_staff_permissions(client, user):
    pack = make_pack()
    url = reverse("admin:elements_elementpack_upload", args=[pack.pk])
    assert client.get(url).status_code == 302
    web = Client()
    web.force_login(user)
    assert web.get(url).status_code == 302


def test_bulk_upload_needs_both_change_and_add_permissions(db):
    from django.contrib.auth.models import Permission

    pack = make_pack()
    editor = User.objects.create_user(email="editor@example.com", password="pw-12345-abc", is_staff=True)
    editor.user_permissions.add(Permission.objects.get(codename="change_elementpack"))
    web = Client()
    web.force_login(editor)
    assert web.get(reverse("admin:elements_elementpack_upload", args=[pack.pk])).status_code == 403
    editor.user_permissions.add(Permission.objects.get(codename="add_element"))
    editor = User.objects.get(pk=editor.pk)
    web.force_login(editor)
    assert web.get(reverse("admin:elements_elementpack_upload", args=[pack.pk])).status_code == 200


def test_bulk_upload_adds_many_files_and_reports_the_bad_ones(staff_client):
    pack = make_pack(kind="icon")
    response = staff_client.post(
        reverse("admin:elements_elementpack_upload", args=[pack.pk]),
        {
            "files": [
                svg_upload(RED_SQUARE, "Red Box.svg"),
                svg_upload(CURRENT_COLOR, "mono-icon.svg"),
                svg_upload(EVIL, "evil.svg"),
                svg_upload("nope", "broken.svg"),
            ],
            "kind": "",
        },
        follow=True,
    )

    assert response.status_code == 200
    assert sorted(Element.objects.values_list("name", flat=True)) == ["Evil", "Mono Icon", "Red Box"]
    assert set(Element.objects.values_list("kind", flat=True)) == {"icon"}
    messages = [str(m) for m in response.context["messages"]]
    assert any(m.startswith("broken.svg:") for m in messages)
    assert any("3 added" in m for m in messages)
    for element in Element.objects.all():
        with element.svg.open("rb") as handle:
            assert b"script" not in handle.read()


def test_bulk_upload_replaces_artwork_for_the_same_file_name(staff_client):
    pack = make_pack()
    url = reverse("admin:elements_elementpack_upload", args=[pack.pk])
    staff_client.post(url, {"files": [svg_upload(RED_SQUARE, "box.svg")], "kind": ""})
    staff_client.post(url, {"files": [svg_upload(CURRENT_COLOR, "box.svg")], "kind": ""})
    assert Element.objects.count() == 1 and Element.objects.get().is_recolorable is False


def test_bulk_upload_applies_a_chosen_kind_and_rejects_an_empty_submit(staff_client):
    pack = make_pack()
    url = reverse("admin:elements_elementpack_upload", args=[pack.pk])
    staff_client.post(url, {"files": [svg_upload(RED_SQUARE, "a.svg")], "kind": "sticker"})
    assert Element.objects.get().kind == "sticker"
    assert staff_client.post(url, {"kind": ""}).status_code == 200


def test_bulk_upload_unknown_pack_is_404(staff_client):
    url = reverse("admin:elements_elementpack_upload", args=["00000000-0000-0000-0000-000000000000"])
    assert staff_client.get(url).status_code == 404


def test_pack_thumbnail_is_reencoded_to_webp(staff_client):
    buffer = BytesIO()
    Image.new("RGB", (900, 600), (225, 29, 72)).save(buffer, "PNG")
    response = staff_client.post(
        reverse("admin:elements_elementpack_add"),
        {
            "name": "Pack",
            "slug": "pack",
            "kind": "shape",
            "license": "CC0-1.0",
            "source_url": "",
            "description": "",
            "sort_order": "0",
            "is_published": "on",
            "thumbnail": SimpleUploadedFile("t.png", buffer.getvalue(), content_type="image/png"),
        },
    )
    assert response.status_code == 302
    pack = ElementPack.objects.get()
    with pack.thumbnail.open("rb") as handle:
        assert Image.open(handle).format == "WEBP"


def test_publish_and_unpublish_actions(staff_client):
    pack = make_pack()
    first, second = make_element(pack, name="A"), make_element(pack, name="B")
    url = reverse("admin:elements_element_changelist")
    staff_client.post(url, {"action": "unpublish", "_selected_action": [first.pk, second.pk]})
    assert Element.objects.filter(is_published=True).count() == 0
    staff_client.post(url, {"action": "publish", "_selected_action": [first.pk]})
    assert Element.objects.filter(is_published=True).count() == 1
    staff_client.post(
        reverse("admin:elements_elementpack_changelist"),
        {"action": "unpublish", "_selected_action": [pack.pk]},
    )
    assert ElementPack.objects.get().is_published is False


def test_upload_action_redirects_from_the_pack_page(staff_client):
    pack = make_pack()
    response = staff_client.get(reverse("admin:elements_elementpack_upload_svgs", args=[pack.pk]))
    assert response.status_code == 302 and response["Location"].endswith(f"/{pack.pk}/upload/")


def test_admin_keeps_style_and_search_columns_in_step_when_an_element_is_edited(staff_client):
    pack = make_pack()
    element = make_element(pack, name="Old", style="")

    response = staff_client.post(
        reverse("admin:elements_element_change", args=[element.pk]),
        {**element_form(pack, name="Café Au Lait", style="filled", tags="Drink, Hot"), "svg": ""},
    )

    assert response.status_code == 302
    element.refresh_from_db()
    assert (element.style, element.search_name, element.search_tags) == (
        "filled",
        "cafe au lait",
        " drink hot ",
    )


def test_admin_rejects_an_unknown_style(staff_client):
    pack = make_pack()
    response = staff_client.post(
        reverse("admin:elements_element_add"),
        {**element_form(pack, style="neon"), "svg": svg_upload()},
    )
    assert response.status_code == 200 and not Element.objects.exists()


def test_pack_form_stores_licence_url_and_attribution_and_shows_the_synced_release(staff_client):
    pack = make_pack(license="MIT", source_ref="demo-icons@1.0.0")
    page = staff_client.get(reverse("admin:elements_elementpack_change", args=[pack.pk])).content.decode()
    assert "demo-icons@1.0.0" in page and "attribution" in page

    response = staff_client.post(
        reverse("admin:elements_elementpack_change", args=[pack.pk]),
        {
            "name": pack.name,
            "slug": pack.slug,
            "kind": "icon",
            "license": "MIT",
            "license_url": "https://example.com/LICENSE",
            "attribution": "Demo: Copyright (c) 2026 Example (MIT).",
            "source_url": "",
            "description": "",
            "sort_order": "0",
            "is_published": "on",
        },
    )

    assert response.status_code == 302
    pack.refresh_from_db()
    assert (pack.license_url, pack.attribution) == (
        "https://example.com/LICENSE",
        "Demo: Copyright (c) 2026 Example (MIT).",
    )
    assert pack.source_ref == "demo-icons@1.0.0"  # not editable in the form
