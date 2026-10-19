import json
from io import BytesIO, StringIO

import pytest
from django.core.management import CommandError, call_command
from PIL import Image

from apps.gallery.models import Template, TemplateCategory

from .factories import make_category, make_document

pytestmark = pytest.mark.django_db


def run(*args, **kwargs):
    out, err = StringIO(), StringIO()
    call_command(*args, stdout=out, stderr=err, **kwargs)
    return out.getvalue(), err.getvalue()


def write_json(path, payload):
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def write_png(path, size=(1600, 900)):
    buffer = BytesIO()
    Image.new("RGB", size, (200, 30, 60)).save(buffer, "PNG")
    path.write_bytes(buffer.getvalue())


def test_seed_gallery_creates_the_standard_categories():
    out, _ = run("seed_gallery")

    names = list(TemplateCategory.objects.values_list("name", flat=True))
    assert names == [
        "Social Media",
        "Presentations",
        "Posters",
        "Flyers",
        "Invitations",
        "Cards",
        "Resumes",
        "Logos",
        "Marketing",
        "Education",
        "Business",
        "Photo Collage",
        "YouTube",
        "Print",
    ]
    assert TemplateCategory.objects.get(slug="social-media").icon == "share-2"
    assert "14 created" in out


def test_seed_gallery_is_idempotent_and_keeps_staff_edits():
    run("seed_gallery")
    TemplateCategory.objects.filter(slug="cards").update(name="Greeting Cards", icon="gift")

    out, _ = run("seed_gallery")

    assert TemplateCategory.objects.count() == 14
    assert "0 created" in out
    assert TemplateCategory.objects.get(slug="cards").name == "Greeting Cards"


def test_seed_gallery_update_resets_defaults():
    run("seed_gallery")
    TemplateCategory.objects.filter(slug="cards").update(name="Greeting Cards", icon="gift")

    out, _ = run("seed_gallery", update=True)

    assert "1 updated" in out
    assert TemplateCategory.objects.get(slug="cards").name == "Cards"


def test_import_template_creates_a_draft_by_default(tmp_path):
    make_category("Marketing")
    path = write_json(
        tmp_path / "sale.json",
        {
            "title": "Big Sale",
            "category": "marketing",
            "tags": ["Sale", "Retail"],
            "document": make_document(1200, 628),
        },
    )

    out, _ = run("import_template", str(path))

    template = Template.objects.get(slug="big-sale")
    assert (template.width, template.height, template.page_count) == (1200, 628, 1)
    assert template.category.slug == "marketing"
    assert template.tags == ["sale", "retail"]
    assert template.is_published is False
    assert "1 created" in out


def test_import_template_is_idempotent_and_preserves_use_count(tmp_path):
    payload = {"title": "Big Sale", "document": make_document(), "is_published": True}
    path = write_json(tmp_path / "sale.json", payload)
    run("import_template", str(path))
    Template.objects.filter(slug="big-sale").update(use_count=12)

    payload["title"] = "Big Sale (2)"
    payload["slug"] = "big-sale"
    payload["document"] = make_document(800, 800, pages=2)
    write_json(path, payload)
    out, _ = run("import_template", str(path))

    assert Template.objects.count() == 1
    template = Template.objects.get()
    assert (template.title, template.use_count, template.page_count, template.is_published) == (
        "Big Sale (2)",
        12,
        2,
        True,
    )
    assert "1 updated" in out


def test_import_template_publish_flag_overrides_the_file(tmp_path):
    path = write_json(tmp_path / "a.json", {"title": "A", "document": make_document(), "is_published": False})
    run("import_template", str(path), publish=True)
    assert Template.objects.get().is_published is True


def test_import_template_resolves_category_by_name_or_creates_it(tmp_path):
    make_category("Photo Collage")
    write_json(tmp_path / "a.json", {"title": "A", "category": "photo collage", "document": make_document()})
    run("import_template", str(tmp_path / "a.json"))
    assert Template.objects.get().category.slug == "photo-collage"

    write_json(tmp_path / "b.json", {"title": "B", "category": "Brand New", "document": make_document()})
    with pytest.raises(CommandError):
        run("import_template", str(tmp_path / "b.json"))
    out, _ = run("import_template", str(tmp_path / "b.json"), create_categories=True)
    assert "1 created" in out
    assert TemplateCategory.objects.filter(slug="brand-new").exists()


def test_import_template_converts_the_thumbnail_to_webp(tmp_path):
    write_png(tmp_path / "thumb.png")
    path = write_json(
        tmp_path / "a.json", {"title": "A", "thumbnail": "thumb.png", "document": make_document()}
    )

    run("import_template", str(path))

    template = Template.objects.get()
    assert template.thumbnail.name.endswith(".webp")
    with template.thumbnail.open("rb") as handle:
        image = Image.open(handle)
        assert image.format == "WEBP" and max(image.size) <= 720


def test_import_template_rejects_thumbnails_outside_the_json_directory(tmp_path):
    inner = tmp_path / "inner"
    inner.mkdir()
    write_png(tmp_path / "secret.png")
    path = write_json(
        inner / "a.json", {"title": "A", "thumbnail": "../secret.png", "document": make_document()}
    )

    with pytest.raises(CommandError):
        run("import_template", str(path))
    assert not Template.objects.exists()


def test_import_template_rejects_a_thumbnail_that_is_not_an_image(tmp_path):
    (tmp_path / "thumb.png").write_text("<script>alert(1)</script>")
    path = write_json(
        tmp_path / "a.json", {"title": "A", "thumbnail": "thumb.png", "document": make_document()}
    )
    with pytest.raises(CommandError):
        run("import_template", str(path))


@pytest.mark.parametrize(
    "payload",
    [
        {"document": make_document()},
        {"title": "A"},
        {"title": "A", "document": {"schemaVersion": 1}},
        {"title": "A", "document": make_document(), "slug": "Not A Slug"},
        {"title": "A", "document": make_document(), "tags": "x"},
        {"title": "A", "document": make_document(), "tags": [1]},
        {"title": "A", "document": make_document(), "is_published": "yes"},
        {"title": "A", "document": make_document(), "surprise": 1},
        ["not", "an", "object"],
    ],
)
def test_import_template_rejects_invalid_files_and_writes_nothing(tmp_path, payload):
    path = write_json(tmp_path / "a.json", payload)
    with pytest.raises(CommandError):
        run("import_template", str(path))
    assert not Template.objects.exists()


def test_import_template_directory_continues_after_a_bad_file(tmp_path):
    write_json(tmp_path / "good.json", {"title": "Good", "document": make_document()})
    write_json(tmp_path / "bad.json", {"title": "Bad"})
    (tmp_path / "broken.json").write_text("{nope")

    with pytest.raises(CommandError, match="2 file"):
        run("import_template", str(tmp_path))

    assert list(Template.objects.values_list("slug", flat=True)) == ["good"]


def test_import_template_missing_path_is_a_clear_error(tmp_path):
    with pytest.raises(CommandError, match="no such file"):
        run("import_template", str(tmp_path / "missing.json"))
