"""`/sitemap.xml`: the landing page, the features, FAQ and contact pages, the template gallery and every
published template, for search engines.

The addresses are built from `SITE_URL`, so the file is right for whatever domain the site runs on. It is
served outside `/api/` (crawlers look for it at the root); the web container proxies the path to the API.
"""

from __future__ import annotations

from xml.sax.saxutils import escape

from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.views.decorators.http import require_GET

from .models import Template

MAX_URLS = 50_000  # the sitemap protocol's limit for one file
STATIC_PAGES = ("/", "/features", "/faq", "/contact", "/templates")


@require_GET
def sitemap(request: HttpRequest) -> HttpResponse:
    base = settings.SITE_URL.rstrip("/")
    entries = [(f"{base}{path}", None) for path in STATIC_PAGES]
    published = Template.objects.filter(is_published=True).order_by("slug").values_list("slug", "updated_at")
    for slug, updated in published[: MAX_URLS - len(STATIC_PAGES)]:
        entries.append((f"{base}/templates/{slug}", updated.date().isoformat()))
    rows = "".join(
        f"<url><loc>{escape(location)}</loc>{f'<lastmod>{modified}</lastmod>' if modified else ''}</url>"
        for location, modified in entries
    )
    body = f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{rows}</urlset>\n'
    response = HttpResponse(body, content_type="application/xml; charset=utf-8")
    response["Cache-Control"] = "public, max-age=3600"
    return response
