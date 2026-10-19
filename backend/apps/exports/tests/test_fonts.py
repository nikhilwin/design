import pytest
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage

from apps.exports import fonts
from apps.exports.exceptions import InvalidExport

from .helpers import build_test_font

ORIGINS = ["http://127.0.0.1:8000"]


@pytest.fixture
def stored_font(db):
    name = default_storage.save("fonts/test-sans.ttf", ContentFile(build_test_font()))
    yield name
    default_storage.delete(name)


def spec(url, **extra):
    return {"family": "Doory Test Sans", "url": url, "weight": 400, "style": "normal", **extra}


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("/media/fonts/a.woff2", "fonts/a.woff2"),
        ("/media/a.ttf", "a.ttf"),
        ("/media/fonts/My%20Font.ttf", "fonts/My Font.ttf"),
        ("http://127.0.0.1:8000/media/fonts/a.woff2", "fonts/a.woff2"),
        ("/media/fonts/a.woff2?v=3", "fonts/a.woff2"),
    ],
)
def test_media_storage_name(url, expected):
    assert fonts.media_storage_name(url, ORIGINS) == expected


@pytest.mark.parametrize(
    "url",
    [
        "/static/fonts/a.woff2",
        "/etc/passwd",
        "/media/",
        "/media/../secret.ttf",
        "/media/fonts/../../secret.ttf",
        "/media/%2e%2e/secret.ttf",
        "/media//etc/passwd",
        "/media/fonts/a\\b.ttf",
        "/media/a%00.ttf",
        "http://evil.example/media/fonts/a.woff2",
        "http://127.0.0.1:9999/media/fonts/a.woff2",
        "file:///media/fonts/a.woff2",
        "ftp://127.0.0.1:8000/media/a.ttf",
        "//evil.example/media/a.ttf",
        "",
    ],
)
def test_media_storage_name_rejects(url):
    with pytest.raises(InvalidExport) as info:
        fonts.media_storage_name(url, ORIGINS)
    assert info.value.detail.code == "invalid_font"


def test_font_mime_detection():
    assert fonts.font_mime(b"wOF2....") == "font/woff2"
    assert fonts.font_mime(b"wOFF....") == "font/woff"
    assert fonts.font_mime(b"OTTO....") == "font/otf"
    assert fonts.font_mime(b"\x00\x01\x00\x00..") == "font/ttf"
    assert fonts.font_mime(b"true....") == "font/ttf"
    assert fonts.font_mime(b"<svg") is None
    assert fonts.font_mime(b"") is None


def test_load_fonts_reads_from_storage(stored_font):
    (font,) = fonts.load_fonts([spec(f"/media/{stored_font}", weight=700, style="italic")], ORIGINS)
    assert font.family == "Doory Test Sans"
    assert (font.weight, font.style, font.mime) == (700, "italic", "font/ttf")
    assert font.data == build_test_font()


def test_the_same_file_is_read_once_for_several_variants(stored_font, monkeypatch):
    reads = []
    real = fonts._read_font
    monkeypatch.setattr(fonts, "_read_font", lambda name: reads.append(name) or real(name))
    result = fonts.load_fonts([spec(f"/media/{stored_font}", weight=w) for w in (400, 700)], ORIGINS)
    assert len(result) == 2 and reads == [stored_font]


def test_missing_files_are_rejected(db):
    with pytest.raises(InvalidExport):
        fonts.load_fonts([spec("/media/fonts/nope.ttf")], ORIGINS)


def test_files_that_are_not_fonts_are_rejected(db):
    name = default_storage.save("fonts/fake.ttf", ContentFile(b"<?xml version='1.0'?><svg/>"))
    try:
        with pytest.raises(InvalidExport):
            fonts.load_fonts([spec(f"/media/{name}")], ORIGINS)
    finally:
        default_storage.delete(name)


def test_oversized_fonts_are_rejected(db, monkeypatch):
    monkeypatch.setattr(fonts, "MAX_FONT_BYTES", 100)
    name = default_storage.save("fonts/big.ttf", ContentFile(build_test_font()))
    try:
        with pytest.raises(InvalidExport):
            fonts.load_fonts([spec(f"/media/{name}")], ORIGINS)
    finally:
        default_storage.delete(name)


def test_total_font_budget(stored_font, monkeypatch):
    monkeypatch.setattr(fonts, "MAX_TOTAL_FONT_BYTES", 10)
    with pytest.raises(InvalidExport):
        fonts.load_fonts([spec(f"/media/{stored_font}")], ORIGINS)


def test_too_many_fonts(monkeypatch):
    monkeypatch.setattr(fonts, "MAX_FONTS", 2)
    with pytest.raises(InvalidExport):
        fonts.load_fonts([spec("/media/a.ttf")] * 3, ORIGINS)


def test_no_fonts_is_fine():
    assert fonts.load_fonts([], ORIGINS) == []
