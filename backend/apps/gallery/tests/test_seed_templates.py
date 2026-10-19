"""The starter templates shipped in backend/data/templates and the command that installs them."""

from __future__ import annotations

import json
import re
import shutil
from io import BytesIO, StringIO
from pathlib import Path

import pytest
from django.conf import settings
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.core.management import CommandError, call_command
from PIL import Image

from apps.fonts.models import FontFamily, FontVariant
from apps.gallery.management.commands.seed_gallery import CATEGORIES
from apps.gallery.management.commands.seed_templates import DATA_DIR, load_document, load_manifest
from apps.gallery.models import Template

pytestmark = pytest.mark.django_db

UUID_V4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
MAX_THUMBNAIL_BYTES = 80 * 1024
POPULAR_FONTS = {
    row["family"]: row["popularity"]
    for row in json.loads((DATA_DIR.parent / "popular_fonts.json").read_text())
}
# `make content` and the Docker first-run flags install `sync_fonts --popular 100`.
DEFAULT_FONT_INSTALL = 100


def run(*args, **kwargs):
    out, err = StringIO(), StringIO()
    call_command(*args, stdout=out, stderr=err, **kwargs)
    return out.getvalue(), err.getvalue()


def walk(objects):
    for obj in objects:
        yield obj
        yield from walk(obj.get("objects", []))


@pytest.fixture(scope="module")
def entries():
    return load_manifest(DATA_DIR)


def test_there_are_exactly_ten_templates_with_unique_slugs(entries):
    slugs = [entry["slug"] for entry in entries]
    assert len(slugs) == 10
    assert len(set(slugs)) == 10
    assert len({entry["title"] for entry in entries}) == 10


def test_every_category_is_a_standard_category_and_four_templates_are_featured(entries):
    standard = {slug for slug, _, _ in CATEGORIES}
    assert {entry["category"] for entry in entries} <= standard
    assert sum(1 for entry in entries if entry.get("is_featured")) == 4


def test_every_document_passes_the_server_validator_within_the_limits(entries):
    for entry in entries:
        document = load_document(DATA_DIR, entry["slug"])
        assert 1 <= document["width"] <= 20_000 and 1 <= document["height"] <= 20_000
        assert 1 <= len(document["pages"]) <= 100
        assert (DATA_DIR / f"{entry['slug']}.json").stat().st_size < 1024 * 1024
        preset = entry.get("preset", "")
        assert document.get("meta", {}).get("presetId", "") == preset


def test_the_pitch_deck_has_three_pages_and_the_business_card_two(entries):
    pages = {e["slug"]: len(load_document(DATA_DIR, e["slug"])["pages"]) for e in entries}
    assert pages["modern-pitch-deck"] == 3
    assert pages["clean-business-card"] == 2
    assert all(
        count == 1
        for slug, count in pages.items()
        if slug not in {"modern-pitch-deck", "clean-business-card"}
    )


def test_the_sizes_are_the_ones_the_brief_asks_for(entries):
    sizes = {
        e["slug"]: tuple(load_document(DATA_DIR, e["slug"])[k] for k in ("width", "height")) for e in entries
    }
    assert sizes["bold-sale-announcement"] == (1080, 1080)
    assert sizes["serif-quote-card"] == (1080, 1080)
    assert sizes["rooftop-event-story"] == (1080, 1920)
    assert sizes["modern-pitch-deck"] == (1920, 1080)
    assert sizes["night-bloom-concert-poster"] == (18 * 96, 24 * 96)
    assert sizes["grand-opening-flyer"] == (816, 1056)
    assert sizes["botanical-celebration-invitation"] == (5 * 96, 7 * 96)
    assert sizes["modern-resume"] == (794, 1123)
    assert sizes["bold-youtube-thumbnail"] == (1280, 720)
    assert sizes["clean-business-card"] == (336, 192)


def test_object_ids_are_unique_v4_uuids_and_every_layer_is_named(entries):
    for entry in entries:
        document = load_document(DATA_DIR, entry["slug"])
        seen: set[str] = set()
        for page in document["pages"]:
            assert UUID_V4.match(page["id"])
            for obj in walk(page["objects"]):
                assert UUID_V4.match(obj["id"]), (entry["slug"], obj.get("name"))
                assert obj["id"] not in seen
                seen.add(obj["id"])
                assert obj.get("name"), f"{entry['slug']}: an object has no layer name"


def test_text_uses_only_fonts_a_default_install_has_in_the_weights_sync_fonts_installs(entries):
    for entry in entries:
        document = load_document(DATA_DIR, entry["slug"])
        used = set()
        for page in document["pages"]:
            for obj in walk(page["objects"]):
                if obj["type"] != "textbox":
                    continue
                family = obj["fontFamily"].split(",")[0].strip('" ')
                assert POPULAR_FONTS.get(family, 10**6) <= DEFAULT_FONT_INSTALL, (entry["slug"], family)
                assert obj["fontWeight"] in (400, 700)
                assert obj["fontSize"] >= 8
                used.add(family)
        assert sorted(used) == sorted(entry["fonts"]), entry["slug"]


def test_photos_are_framed_starter_photos_that_ship_with_the_templates(entries):
    with_photos: set[str] = set()
    for entry in entries:
        for page in load_document(DATA_DIR, entry["slug"])["pages"]:
            for obj in walk(page["objects"]):
                assert not obj.get("isPlaceholder"), f"{entry['slug']}: an empty photo slot"
                if obj["type"] != "image" or "qr" in obj:
                    continue
                with_photos.add(entry["slug"])
                assert obj["src"].startswith("/media/templates/photos/"), obj["src"]
                assert (DATA_DIR / "photos" / obj["src"].rsplit("/", 1)[1]).is_file(), obj["src"]
                assert obj["slot"]["width"] > 0 and obj["slot"]["height"] > 0, "a photo sits in a frame"
    assert with_photos == {
        "bold-sale-announcement",
        "rooftop-event-story",
        "modern-pitch-deck",
        "modern-resume",
        "bold-youtube-thumbnail",
    }


def test_every_shipped_photo_is_used_small_and_credited(entries):
    used = {
        obj["src"].rsplit("/", 1)[1]
        for entry in entries
        for page in load_document(DATA_DIR, entry["slug"])["pages"]
        for obj in walk(page["objects"])
        if obj["type"] == "image" and "src" in obj
    }
    shipped = {path.name for path in (DATA_DIR / "photos").glob("*.webp")}
    assert shipped == used
    credits = (Path(settings.BASE_DIR).parent / "THIRD_PARTY.md").read_text(encoding="utf-8")
    for name in shipped:
        path = DATA_DIR / "photos" / name
        assert path.stat().st_size < 400 * 1024, name
        with Image.open(path) as image:
            assert image.format == "WEBP" and max(image.size) <= 2000
        assert name in credits, f"{name} is not credited in THIRD_PARTY.md"


def test_thumbnails_are_small_webp_images_of_the_first_page(entries):
    for entry in entries:
        path = DATA_DIR / "thumbs" / f"{entry['slug']}.webp"
        assert path.stat().st_size < MAX_THUMBNAIL_BYTES, path.name
        with Image.open(path) as image:
            assert image.format == "WEBP"
            assert max(image.size) == 720
            document = load_document(DATA_DIR, entry["slug"])
            assert abs(image.width / image.height - document["width"] / document["height"]) < 0.01


def test_seeding_publishes_every_template_with_a_thumbnail_and_is_idempotent(entries):
    out, _ = run("seed_templates")

    assert "10 created, 0 updated, 0 kept, 0 failed" in out
    assert Template.objects.filter(is_published=True).count() == 10
    assert Template.objects.filter(is_featured=True).count() == 4
    for template in Template.objects.all():
        assert template.category is not None
        assert template.thumbnail.name.endswith(".webp")
        assert template.page_count == len(template.document["pages"])

    for path in (DATA_DIR / "photos").glob("*.webp"):
        assert default_storage.size(f"templates/photos/{path.name}") == path.stat().st_size

    Template.objects.filter(slug="modern-resume").update(use_count=7, title="Edited by staff")
    out, _ = run("seed_templates")
    assert "0 created, 0 updated, 10 kept, 0 failed" in out
    assert "0 copied" in out
    assert Template.objects.count() == 10
    assert Template.objects.get(slug="modern-resume").title == "Edited by staff"


def test_update_refreshes_existing_templates_and_keeps_their_use_count():
    run("seed_templates")
    Template.objects.filter(slug="modern-resume").update(
        use_count=7, title="Edited by staff", is_featured=True
    )

    out, _ = run("seed_templates", update=True)

    assert "0 created, 10 updated, 0 kept, 0 failed" in out
    resume = Template.objects.get(slug="modern-resume")
    assert (resume.title, resume.use_count, resume.is_featured) == ("Modern resume", 7, False)


def test_the_public_api_lists_and_serves_the_templates(client):
    run("seed_templates")

    listing = client.get("/api/v1/templates/", {"page_size": 50})
    assert listing.status_code == 200
    assert listing.data["count"] == 10
    assert all(row["thumbnail_url"] for row in listing.data["results"])
    assert client.get("/api/v1/templates/", {"featured": "true"}).data["count"] == 4
    assert client.get("/api/v1/templates/", {"category": "social-media"}).data["count"] == 3

    detail = client.get("/api/v1/templates/modern-pitch-deck/")
    assert detail.status_code == 200
    assert detail.data["page_count"] == 3
    assert detail.data["document"]["pages"][1]["name"] == "The problem"
    assert detail.data["preset"] == "presentation"


def test_missing_fonts_are_reported_with_the_command_that_installs_them():
    out, _ = run("seed_templates")
    assert 'manage.py sync_fonts "Anton"' in out or "sync_fonts" in out
    assert "Anton" in out

    names = {family for entry in load_manifest(DATA_DIR) for family in entry["fonts"]}
    for index, name in enumerate(sorted(names)):
        family = FontFamily.objects.create(family=name, slug=f"font-{index}", popularity=index + 1)
        FontVariant.objects.create(family=family, weight=400, file=ContentFile(b"font", name="f.woff2"))
    out, _ = run("seed_templates")
    assert "not installed" not in out


def test_a_broken_template_is_reported_and_the_others_are_still_installed(tmp_path):
    shutil.copytree(DATA_DIR, tmp_path / "data")
    broken = tmp_path / "data" / "serif-quote-card.json"
    document = json.loads(broken.read_text())
    document["pages"][0]["objects"][0]["src"] = "blob:http://localhost/1"
    broken.write_text(json.dumps(document))

    with pytest.raises(CommandError, match=r"serif-quote-card\.json is not a valid design document"):
        run("seed_templates", data_dir=str(tmp_path / "data"))
    assert not Template.objects.exists()


def test_a_template_whose_photo_is_missing_is_refused_and_the_others_are_installed(tmp_path):
    shutil.copytree(DATA_DIR, tmp_path / "data")
    (tmp_path / "data" / "photos" / "deck-architecture.webp").unlink()

    with pytest.raises(CommandError, match="1 template"):
        run("seed_templates", data_dir=str(tmp_path / "data"))
    assert not Template.objects.filter(slug="modern-pitch-deck").exists()
    assert Template.objects.count() == 9


def test_a_template_the_importer_refuses_does_not_stop_the_rest(tmp_path):
    shutil.copytree(DATA_DIR, tmp_path / "data")
    (tmp_path / "data" / "thumbs" / "modern-resume.webp").write_bytes(b"not an image")

    with pytest.raises(CommandError, match="1 template"):
        run("seed_templates", data_dir=str(tmp_path / "data"))
    assert Template.objects.count() == 9


@pytest.mark.parametrize(
    "mutate",
    [
        lambda m: m.update(version=2),
        lambda m: m.update(templates=[]),
        lambda m: m["templates"].append(dict(m["templates"][0])),
        lambda m: m["templates"][0].update(slug="Not A Slug"),
        lambda m: m["templates"][0].update(surprise=1),
        lambda m: m["templates"][0].update(tags="sale"),
        lambda m: m["templates"][0].update(title=" "),
    ],
)
def test_a_malformed_manifest_is_refused_before_anything_is_written(tmp_path, mutate):
    shutil.copytree(DATA_DIR, tmp_path / "data")
    path = tmp_path / "data" / "manifest.json"
    manifest = json.loads(path.read_text())
    mutate(manifest)
    path.write_text(json.dumps(manifest))

    with pytest.raises(CommandError):
        run("seed_templates", data_dir=str(tmp_path / "data"))
    assert not Template.objects.exists()


def test_a_missing_directory_is_a_clear_error(tmp_path):
    with pytest.raises(CommandError, match="does not exist"):
        run("seed_templates", data_dir=str(tmp_path / "nowhere"))


def test_thumbnail_conversion_keeps_webp_under_the_size_limit():
    run("seed_templates")
    for template in Template.objects.all():
        with template.thumbnail.open("rb") as handle:
            data = handle.read()
        assert len(data) < MAX_THUMBNAIL_BYTES
        assert Image.open(BytesIO(data)).format == "WEBP"


def test_the_data_directory_is_the_one_inside_the_backend():
    assert Path(__file__).resolve().parents[3] / "data" / "templates" == DATA_DIR
