"""Print metadata for the PDF Chromium produced: exact page boxes, document language and creator.

Chromium rounds a page's size to whole PDF points (and then down to 1/300 inch), so a printed sheet is not
exactly the size that was asked for. `layout` asks for a sheet one point larger than the page, and the page
sits at the top left of it: this module cuts the MediaBox back to the exact page size (anchored at the top
left, so nothing moves) and, for pages with bleed or crop marks, adds the boxes a preflight check reads.
The *TrimBox* is the finished page; the *BleedBox* is the trim plus the bleed (the media minus the slug
that carries the marks). pypdf (BSD-3-Clause) edits page dictionaries and the catalog only; page content,
fonts and images are copied byte for byte.
"""

from __future__ import annotations

import io
import logging
from collections.abc import Sequence

from pypdf import PageObject, PdfReader, PdfWriter
from pypdf.errors import PyPdfError
from pypdf.generic import NameObject, RectangleObject, TextStringObject

from .layout import PageGeometry

logger = logging.getLogger("doory.exports")

PT_PER_PX = 0.75  # one CSS px in PDF points
# The printed sheet is the page plus the allowance, rounded: between 0 and 1.5 pt larger than the page.
# Anything outside this range was not printed as asked (and would have cropped or shifted the artwork).
MAX_SHEET_EXCESS_PT = 2.0
MIN_SHEET_EXCESS_PT = -0.01
CREATOR = "Doory"


def _box(left: float, top: float, width_px: float, height_px: float) -> RectangleObject:
    """The rectangle of `width_px` x `height_px` whose top left corner is at (`left`, `top`) in PDF points."""
    return RectangleObject([left, top - height_px * PT_PER_PX, left + width_px * PT_PER_PX, top])


def _write_boxes(page: PageObject, geometry: PageGeometry) -> bool:
    """Set the exact MediaBox of `page` and, with bleed or marks, its TrimBox and BleedBox.

    Returns False (and touches nothing) when the page is not the size that was asked for.
    """
    media = page.mediabox
    left, top = float(media.left), float(media.top)
    exact = _box(left, top, geometry.page_width, geometry.page_height)
    excess = (float(media.width) - float(exact.width), float(media.height) - float(exact.height))
    if not all(MIN_SHEET_EXCESS_PT <= value <= MAX_SHEET_EXCESS_PT for value in excess):
        return False
    page.mediabox = exact
    if geometry.bleed > 0 or geometry.has_marks:
        slug_pt = geometry.slug * PT_PER_PX
        margin_pt = geometry.margin * PT_PER_PX
        page.bleedbox = _box(left + slug_pt, top - slug_pt, geometry.art_width, geometry.art_height)
        page.trimbox = _box(left + margin_pt, top - margin_pt, geometry.width, geometry.height)
    return True


def finalize_pdf(
    pdf: bytes, geometries: Sequence[PageGeometry], *, title: str = "", lang: str = "en"
) -> bytes:
    """`pdf` with exact page boxes, TrimBox/BleedBox where there is bleed or marks, `/Lang` and `/Creator`.

    The input is returned unchanged (and the problem logged) when it cannot be read or does not have one
    page per geometry: a PDF with Chromium's own boxes is still a correct PDF, a wrong box would be worse.
    """
    try:
        reader = PdfReader(io.BytesIO(pdf))
        if len(reader.pages) != len(geometries):
            logger.error(
                "PDF has %d page(s) but %d were requested: page boxes not written",
                len(reader.pages),
                len(geometries),
            )
            return pdf
        writer = PdfWriter(clone_from=reader)
        for number, (page, geometry) in enumerate(zip(writer.pages, geometries, strict=True), start=1):
            if not _write_boxes(page, geometry):
                logger.warning("PDF page %d is not the requested size: its boxes were left as is", number)
        writer.root_object[NameObject("/Lang")] = TextStringObject(lang)
        metadata = {"/Creator": CREATOR}
        if title:
            metadata["/Title"] = title
        writer.add_metadata(metadata)
        out = io.BytesIO()
        writer.write(out)
        return out.getvalue()
    except (PyPdfError, ValueError, KeyError, RecursionError, OSError):
        logger.exception("PDF metadata could not be written; returning the PDF without it")
        return pdf
