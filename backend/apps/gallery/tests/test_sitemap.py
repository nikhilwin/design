from xml.etree import ElementTree

import pytest

from .factories import make_template

NS = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}


@pytest.mark.django_db
class TestSitemap:
    def test_lists_the_site_pages_the_gallery_and_every_published_template(self, client, settings):
        settings.SITE_URL = "https://doory.example.org/"
        make_template("Summer Sale")
        make_template("Wedding Invite")
        make_template("Draft One", is_published=False)
        response = client.get("/sitemap.xml")
        assert response.status_code == 200
        assert response["Content-Type"].startswith("application/xml")
        assert "max-age" in response["Cache-Control"]
        root = ElementTree.fromstring(response.content)
        locations = [node.text for node in root.findall("s:url/s:loc", NS)]
        assert locations == [
            "https://doory.example.org/",
            "https://doory.example.org/features",
            "https://doory.example.org/faq",
            "https://doory.example.org/contact",
            "https://doory.example.org/templates",
            "https://doory.example.org/templates/summer-sale",
            "https://doory.example.org/templates/wedding-invite",
        ]
        assert len(root.findall("s:url/s:lastmod", NS)) == 2

    def test_works_without_any_template_and_without_a_session(self, client, settings):
        settings.SITE_URL = "http://localhost:5173"
        root = ElementTree.fromstring(client.get("/sitemap.xml").content)
        assert [node.text for node in root.findall("s:url/s:loc", NS)] == [
            "http://localhost:5173/",
            "http://localhost:5173/features",
            "http://localhost:5173/faq",
            "http://localhost:5173/contact",
            "http://localhost:5173/templates",
        ]

    def test_only_get_is_allowed(self, client):
        assert client.post("/sitemap.xml").status_code == 405
