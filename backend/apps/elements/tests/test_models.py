import pytest
from django.core.exceptions import ValidationError
from django.core.files.base import ContentFile

from apps.core.svg import SvgError
from apps.elements.models import Element, ElementPack

from .factories import CURRENT_COLOR, EVIL, RED_SQUARE, make_element, make_pack

pytestmark = pytest.mark.django_db


def stored(element: Element) -> str:
    with element.svg.open("rb") as handle:
        return handle.read().decode()


def test_save_derives_size_colours_and_recolourability():
    element = make_element(name="Wide")

    assert (element.width, element.height) == (40, 20)
    assert element.colors == ["#e11d48"]
    assert element.is_recolorable is True
    assert element.svg.name.startswith("elements/shapes/") and element.svg.name.endswith(".svg")


def test_svg_without_hex_colours_is_not_recolourable():
    element = make_element(svg=CURRENT_COLOR)
    assert element.colors == [] and element.is_recolorable is False
    assert (element.width, element.height) == (24, 24)


def test_save_sanitises_whatever_was_assigned():
    element = make_element(svg=EVIL)

    text = stored(element)
    for forbidden in ("script", "foreignObject", "onload", "onclick", "javascript", "evil.example"):
        assert forbidden not in text
    assert "<rect" in text
    assert element.colors == ["#ff0000"]


@pytest.mark.parametrize(
    "payload",
    [
        b"",
        b"not xml at all",
        b"<html><body/></html>",
        b'<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg/>',
    ],
)
def test_save_refuses_unusable_svg_and_stores_nothing(payload):
    pack = make_pack()
    element = Element(pack=pack, name="Bad", svg=ContentFile(payload, name="bad.svg"))

    with pytest.raises(SvgError):
        element.save()
    assert not Element.objects.exists()


def test_save_requires_a_file():
    with pytest.raises(ValueError, match="needs an SVG"):
        Element(pack=make_pack(), name="Empty").save()


def test_clean_reports_unsafe_uploads_as_a_field_error():
    element = Element(pack=make_pack(), name="Bad", svg=ContentFile(b"<nope>", name="bad.svg"))
    with pytest.raises(ValidationError) as caught:
        element.full_clean(exclude=["key"])
    assert "svg" in caught.value.message_dict


def test_clean_sanitises_so_a_later_save_cannot_see_the_original():
    element = Element(pack=make_pack(), name="Evil", svg=ContentFile(EVIL.encode(), name="evil.svg"))
    element.full_clean(exclude=["key"])
    element.save()
    assert "script" not in stored(element)


def test_resaving_without_a_new_file_keeps_the_stored_artwork():
    element = make_element()
    name = element.svg.name
    element.name = "Renamed"
    element.save()
    assert Element.objects.get(pk=element.pk).svg.name == name


def test_replacing_the_svg_updates_metadata_and_removes_the_old_file():
    element = make_element()
    old = element.svg.name
    storage = element.svg.storage

    element.svg = ContentFile(CURRENT_COLOR.encode(), name="new.svg")
    element.save()

    element.refresh_from_db()
    assert element.is_recolorable is False and element.width == 24
    assert element.svg.name != old and not storage.exists(old) and storage.exists(element.svg.name)


def test_save_with_update_fields_still_persists_derived_metadata():
    element = make_element()
    element.svg = ContentFile(CURRENT_COLOR.encode(), name="new.svg")
    element.save(update_fields=["svg"])
    element.refresh_from_db()
    assert element.colors == [] and element.width == 24


def test_bulk_create_is_blocked_because_it_would_skip_sanitisation():
    with pytest.raises(NotImplementedError):
        Element.objects.bulk_create([Element(pack=make_pack(), name="x")])


def test_keys_are_generated_and_unique_within_a_pack():
    pack = make_pack()
    first, second = make_element(pack, name="Big Star"), make_element(pack, name="Big Star")
    other = make_element(make_pack("other"), name="Big Star")
    assert (first.key, second.key, other.key) == ("big-star", "big-star-2", "big-star")


def test_deleting_an_element_or_pack_removes_the_files():
    pack = make_pack()
    element = make_element(pack)
    storage, name = element.svg.storage, element.svg.name
    pack.delete()
    assert not storage.exists(name)
    assert not Element.objects.exists()


def test_license_must_look_like_an_spdx_identifier():
    pack = ElementPack(slug="x", name="X", license="all rights reserved!!")
    with pytest.raises(ValidationError) as caught:
        pack.full_clean(exclude=["thumbnail"])
    assert "license" in caught.value.message_dict
    ElementPack(slug="y", name="Y", license="Apache-2.0 OR MIT").full_clean(exclude=["thumbnail"])


def test_unchanged_source_text_is_not_mutated_by_ingest():
    element = make_element()
    assert RED_SQUARE.split("<rect")[0] in stored(element)
