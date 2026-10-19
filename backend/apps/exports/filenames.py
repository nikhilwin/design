import re
import time
import unicodedata

DEFAULT_STEM = "design"
MAX_STEM_LENGTH = 80
_DISALLOWED = re.compile(r"[^\w\- .()]+", re.UNICODE)
_WHITESPACE = re.compile(r"\s+")
_SPACES = re.compile(r"[\s._]{2,}")


def pdf_filename(title: str | None) -> str:
    return export_filename(title, "pdf")


def export_filename(title: str | None, extension: str) -> str:
    """Download name from a user supplied title: letters, digits, spaces, dashes, dots and brackets only."""
    text = unicodedata.normalize("NFC", title or "")
    text = _WHITESPACE.sub(" ", text)
    text = "".join(ch for ch in text if unicodedata.category(ch)[0] != "C")
    text = _DISALLOWED.sub("", text)
    text = _SPACES.sub(" ", text).strip(" .-_")
    text = text[:MAX_STEM_LENGTH].strip(" .-_")
    return f"{text or DEFAULT_STEM}.{extension}"


# ---- structured names (#59) --------------------------------------------------------------------
# `<title>_<platform>_<preset>_<W>x<H>[_pNN][_<unix>].<ext>`, the same rules as the editor's
# `engine/export/filenames.ts`; both are checked against `engine/fixtures/export-filenames.json` there.

STYLES = ("simple", "structured")
MAX_SLUG_LENGTH = 80
_NOT_SLUG = re.compile(r"[^a-z0-9]+")


def slug(text: str | None, limit: int = MAX_SLUG_LENGTH) -> str:
    """Lowercase ASCII letters and digits joined by dashes; accents dropped, anything else is a separator."""
    folded = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode("ascii").lower()
    return _NOT_SLUG.sub("-", folded).strip("-")[:limit].strip("-")


def unix_now() -> int:
    """Seconds since the epoch, for the timestamp part (one per export)."""
    return int(time.time())


def _px(value: float) -> int:
    return int(float(value) + 0.5)  # half up, as Math.round in the editor


def structured_filename(
    title: str | None,
    extension: str,
    *,
    platform: str | None = None,
    preset: str | None = None,
    width: float | None = None,
    height: float | None = None,
    page: int | None = None,
    pages: int = 1,
    unix: int | None = None,
    suffix: str | None = None,
) -> str:
    """A structured download name; parts without a value are left out. `page` (1-based) only counts in a
    design of several pages, numbered with as many digits as the page count needs (at least two)."""
    parts = [slug(title) or DEFAULT_STEM]
    parts += [s for s in (slug(platform), slug(preset)) if s] if preset else []
    if width and height:
        parts.append(f"{_px(width)}x{_px(height)}")
    if page is not None and pages > 1:
        parts.append(f"p{str(page).zfill(max(2, len(str(pages))))}")
    if suffix:
        parts.append(slug(suffix))
    if unix is not None:
        parts.append(str(int(unix)))
    return f"{'_'.join(parts)}.{extension}"


def preset_parts(preset_slug: str | None, width: float, height: float) -> tuple[str | None, str | None]:
    """`(platform, preset)` for a page still at its size preset's size, `(None, None)` for a custom size. The
    platform is the preset's `meta.platforms[0]`, else the slug of the group it sits in."""
    from apps.presets.models import SizePreset

    if not preset_slug:
        return None, None
    active = SizePreset.objects.filter(is_active=True, group__is_active=True).select_related("group")
    found = active.filter(slug=preset_slug).first() or next(
        (p for p in active.exclude(aliases=[]) if preset_slug in (p.aliases or [])), None
    )
    if found is None or (found.width_px, found.height_px) != (_px(width), _px(height)):
        return None, None
    platforms = (found.meta or {}).get("platforms") if isinstance(found.meta, dict) else None
    first = platforms[0] if isinstance(platforms, list) and platforms else ""
    return (slug(first) if isinstance(first, str) else "") or found.group.slug, found.slug


def page_filename(title: str | None, result, *, style: str, unix: int | None = None) -> str:
    """The download name of one page `export_image` made (`result`), simple (as before) or structured."""
    if style != "structured":
        if result.page_count > 1:
            title = f"{title} - page {result.page_index + 1}"
        return export_filename(title, result.format)
    platform, preset = preset_parts(result.preset, result.page_width, result.page_height)
    return structured_filename(
        title,
        result.format,
        platform=platform,
        preset=preset,
        width=result.page_width,
        height=result.page_height,
        page=result.page_index + 1,
        pages=result.page_count,
        unix=unix,
    )
