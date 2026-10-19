import io
import logging

import pypdf
import pytest

from apps.exports.layout import PX_PER_MM, PageGeometry
from apps.exports.pdfmeta import PT_PER_PX, finalize_pdf

PT_PER_MM = PX_PER_MM * PT_PER_PX


def blank_pdf(*sizes_pt) -> bytes:
    writer = pypdf.PdfWriter()
    for width, height in sizes_pt:
        writer.add_blank_page(width, height)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def read(data: bytes) -> pypdf.PdfReader:
    return pypdf.PdfReader(io.BytesIO(data))


def box(rect) -> list[float]:
    return [round(float(v), 3) for v in rect]


def test_a_page_with_bleed_and_marks_gets_trim_and_bleed_boxes():
    geometry = PageGeometry.create(400, 300, bleed_mm=3, crop_marks=True)
    media = (geometry.page_width * PT_PER_PX, geometry.page_height * PT_PER_PX)
    page = read(finalize_pdf(blank_pdf(media), [geometry])).pages[0]
    slug_pt, bleed_pt = geometry.slug * PT_PER_PX, geometry.bleed * PT_PER_PX
    width, height = media
    assert box(page.mediabox) == box([0, 0, width, height])
    assert box(page.bleedbox) == box([slug_pt, slug_pt, width - slug_pt, height - slug_pt])
    assert box(page.trimbox) == box(
        [slug_pt + bleed_pt, slug_pt + bleed_pt, width - slug_pt - bleed_pt, height - slug_pt - bleed_pt]
    )
    # millimetres: the bleed is 3 mm wide on every side and the slug is 6 mm
    assert float(page.bleedbox.left) / PT_PER_MM == pytest.approx(6, abs=1e-3)
    assert (float(page.trimbox.left) - float(page.bleedbox.left)) / PT_PER_MM == pytest.approx(3, abs=1e-3)


def test_bleed_without_marks_has_a_bleed_box_equal_to_the_media_box():
    geometry = PageGeometry.create(400, 300, bleed_mm=2)
    media = (geometry.page_width * PT_PER_PX, geometry.page_height * PT_PER_PX)
    page = read(finalize_pdf(blank_pdf(media), [geometry])).pages[0]
    assert box(page.bleedbox) == box(page.mediabox)
    assert float(page.trimbox.left) / PT_PER_MM == pytest.approx(2, abs=1e-3)
    assert float(page.trimbox.width) == pytest.approx(400 * PT_PER_PX, abs=1e-3)


def test_marks_without_bleed():
    geometry = PageGeometry.create(400, 300, crop_marks=True)
    media = (geometry.page_width * PT_PER_PX, geometry.page_height * PT_PER_PX)
    page = read(finalize_pdf(blank_pdf(media), [geometry])).pages[0]
    assert box(page.trimbox) == box(page.bleedbox)
    assert float(page.trimbox.left) / PT_PER_MM == pytest.approx(6, abs=1e-3)


def test_a_plain_page_has_no_extra_boxes():
    geometry = PageGeometry.create(400, 300)
    page = read(finalize_pdf(blank_pdf((300, 225)), [geometry])).pages[0]
    assert "/TrimBox" not in page and "/BleedBox" not in page


def test_every_page_gets_the_boxes_of_its_own_geometry():
    geometries = [
        PageGeometry.create(400, 300, bleed_mm=3, crop_marks=True),
        PageGeometry.create(200, 500),
        PageGeometry.create(100, 100, bleed_mm=5),
    ]
    sizes = [(g.page_width * PT_PER_PX, g.page_height * PT_PER_PX) for g in geometries]
    pages = read(finalize_pdf(blank_pdf(*sizes), geometries)).pages
    assert "/TrimBox" in pages[0] and "/TrimBox" not in pages[1] and "/TrimBox" in pages[2]
    assert float(pages[0].trimbox.width) == pytest.approx(400 * PT_PER_PX)
    assert float(pages[2].trimbox.width) == pytest.approx(100 * PT_PER_PX)
    assert float(pages[2].trimbox.left) / PT_PER_MM == pytest.approx(5, abs=1e-3)


@pytest.mark.parametrize("excess", [(0.42, 0.9), (0.0, 0.0), (1.5, 1.2)])
def test_the_sheet_is_cut_back_to_the_exact_page_at_the_top_left(excess):
    """The sheet Chromium prints is up to 1.5 pt larger than the page; the page sits at its top left corner."""
    geometry = PageGeometry.create(794, 1123, bleed_mm=3)
    exact = (geometry.page_width * PT_PER_PX, geometry.page_height * PT_PER_PX)
    sheet = (exact[0] + excess[0], exact[1] + excess[1])
    page = read(finalize_pdf(blank_pdf(sheet), [geometry])).pages[0]
    assert float(page.mediabox.width) == pytest.approx(exact[0], abs=1e-3)
    assert float(page.mediabox.height) == pytest.approx(exact[1], abs=1e-3)
    assert float(page.mediabox.top) == pytest.approx(sheet[1], abs=1e-3)  # the top edge stays where it was
    assert float(page.mediabox.left) == 0
    assert float(page.trimbox.top) == pytest.approx(sheet[1] - 3 * PT_PER_MM, abs=1e-3)
    assert float(page.trimbox.left) == pytest.approx(3 * PT_PER_MM, abs=1e-3)


@pytest.mark.parametrize("sheet", [(100, 100), (300 - 0.33, 225), (300 + 5, 225), (300, 225 + 2.5)])
def test_a_page_that_was_not_printed_as_asked_is_left_alone(sheet, caplog):
    geometry = PageGeometry.create(400, 300, bleed_mm=3)
    with caplog.at_level(logging.WARNING, logger="doory.exports"):
        page = read(finalize_pdf(blank_pdf(sheet), [geometry])).pages[0]
    assert box(page.mediabox) == box([0, 0, *sheet])
    assert "/TrimBox" not in page
    assert "page 1 is not the requested size" in caplog.text


def test_language_title_and_creator():
    out = read(
        finalize_pdf(blank_pdf((100, 100)), [PageGeometry.create(100, 100)], title="Menu", lang="de-CH")
    )
    assert out.trailer["/Root"]["/Lang"] == "de-CH"
    assert out.metadata.title == "Menu"
    assert out.metadata.creator == "Doory"


def test_an_empty_title_keeps_the_one_the_browser_wrote():
    writer = pypdf.PdfWriter()
    writer.add_blank_page(100, 100)
    writer.add_metadata({"/Title": "From the page"})
    buffer = io.BytesIO()
    writer.write(buffer)
    assert (
        read(finalize_pdf(buffer.getvalue(), [PageGeometry.create(100, 100)])).metadata.title
        == "From the page"
    )


def test_the_page_count_must_match_or_nothing_is_written(caplog):
    data = blank_pdf((100, 100), (100, 100))
    with caplog.at_level(logging.ERROR, logger="doory.exports"):
        assert finalize_pdf(data, [PageGeometry.create(100, 100, bleed_mm=3)]) == data
    assert "page boxes not written" in caplog.text


@pytest.mark.parametrize(
    "data", [b"", b"not a pdf", b"%PDF-1.7\n% truncated\n", b"%PDF-1.7\n" + b"1 0 obj <<" * 50]
)
def test_unreadable_input_is_returned_unchanged(data, caplog):
    with caplog.at_level(logging.ERROR, logger="doory.exports"):
        assert finalize_pdf(data, [PageGeometry.create(100, 100)]) == data


def test_page_content_is_not_touched():
    writer = pypdf.PdfWriter()
    page = writer.add_blank_page(300, 200)
    from pypdf.generic import DecodedStreamObject, NameObject

    stream = DecodedStreamObject()
    stream.set_data(b"1 0 0 rg 10 10 100 100 re f")
    page[NameObject("/Contents")] = writer._add_object(stream)
    buffer = io.BytesIO()
    writer.write(buffer)
    out = read(finalize_pdf(buffer.getvalue(), [PageGeometry.create(400, 267, bleed_mm=0.5)])).pages[0]
    assert out.get_contents().get_data() == b"1 0 0 rg 10 10 100 100 re f"
