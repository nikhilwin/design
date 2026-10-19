import pytest
import requests

from apps.assets import providers
from apps.assets.models import Asset

from .helpers import image_bytes

SEARCH = "/api/v1/stock/photos/"
IMPORT = "/api/v1/stock/photos/import/"
UNSPLASH_ID = "abcDEF_123-x"


class FakeResponse:
    def __init__(self, status=200, payload=None, body=b"", headers=None, chunk_error=None):
        self.status_code = status
        self._payload = payload
        self._body = body
        self.headers = headers or {}
        self._chunk_error = chunk_error
        self.closed = False

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload

    def iter_content(self, chunk_size=1):
        if self._chunk_error:
            raise self._chunk_error
        for start in range(0, len(self._body), chunk_size):
            yield self._body[start : start + chunk_size]

    def close(self):
        self.closed = True


class FakeNetwork:
    """Routes `providers.http_get` calls to canned responses and records every request."""

    def __init__(self):
        self.routes: dict[str, object] = {}
        self.calls: list[dict] = []

    def add(self, url, response):
        self.routes[url] = response

    def __call__(self, url, **kwargs):
        self.calls.append({"url": url, **kwargs})
        route = self.routes.get(url)
        if route is None:
            raise AssertionError(f"unexpected request to {url}")
        if isinstance(route, Exception):
            raise route
        return route() if callable(route) else route

    def urls(self):
        return [c["url"] for c in self.calls]


@pytest.fixture
def net(monkeypatch):
    network = FakeNetwork()
    monkeypatch.setattr(providers, "http_get", network)
    return network


@pytest.fixture
def unsplash(settings):
    settings.UNSPLASH_ACCESS_KEY = "unsplash-secret"
    settings.PEXELS_API_KEY = ""


@pytest.fixture
def pexels(settings):
    settings.UNSPLASH_ACCESS_KEY = ""
    settings.PEXELS_API_KEY = "pexels-secret"


def unsplash_item(photo_id=UNSPLASH_ID, **overrides):
    item = {
        "id": photo_id,
        "width": 4000,
        "height": 3000,
        "urls": {
            "raw": f"https://images.unsplash.com/photo-{photo_id}?ixid=abc",
            "regular": f"https://images.unsplash.com/photo-{photo_id}?w=1080",
            "small": f"https://images.unsplash.com/photo-{photo_id}?w=400",
        },
        "user": {"name": "Ada Lovelace", "links": {"html": "https://unsplash.com/@ada"}},
        "links": {
            "html": f"https://unsplash.com/photos/{photo_id}",
            "download_location": f"https://api.unsplash.com/photos/{photo_id}/download",
        },
    }
    item.update(overrides)
    return item


def pexels_item(photo_id=77, **overrides):
    item = {
        "id": photo_id,
        "width": 3000,
        "height": 2000,
        "url": f"https://www.pexels.com/photo/{photo_id}/",
        "photographer": "Grace Hopper",
        "photographer_url": "https://www.pexels.com/@grace",
        "src": {
            "original": f"https://images.pexels.com/photos/{photo_id}/original.jpeg",
            "large2x": f"https://images.pexels.com/photos/{photo_id}/large2x.jpeg",
            "large": f"https://images.pexels.com/photos/{photo_id}/large.jpeg",
            "medium": f"https://images.pexels.com/photos/{photo_id}/medium.jpeg",
        },
    }
    item.update(overrides)
    return item


def unsplash_search_url():
    return "https://api.unsplash.com/search/photos"


@pytest.mark.django_db
class TestSearch:
    def test_not_configured_returns_empty_page(self, api, settings, net):
        settings.UNSPLASH_ACCESS_KEY = settings.PEXELS_API_KEY = ""
        res = api.get(SEARCH, {"q": "cat"})
        assert res.status_code == 200
        assert res.json() == {
            "configured": False,
            "provider": "",
            "total": 0,
            "next_page": None,
            "results": [],
        }
        assert net.calls == []

    def test_requires_authentication(self, db):
        from rest_framework.test import APIClient

        assert APIClient().get(SEARCH).status_code == 401

    def test_unsplash_search_maps_results(self, api, unsplash, net):
        net.add(unsplash_search_url(), FakeResponse(payload={"total": 60, "results": [unsplash_item()]}))
        body = api.get(SEARCH, {"q": "cat", "per_page": 20}).json()
        assert body["configured"] is True and body["provider"] == "unsplash"
        assert body["total"] == 60 and body["next_page"] == 2
        photo = body["results"][0]
        assert photo["id"] == UNSPLASH_ID and photo["provider"] == "unsplash"
        assert photo["thumb_url"].endswith("w=400") and photo["preview_url"].endswith("w=1080")
        assert (photo["width"], photo["height"], photo["author"]) == (4000, 3000, "Ada Lovelace")
        assert "utm_source=doory" in photo["author_url"] and "utm_source=doory" in photo["source_url"]
        call = net.calls[0]
        assert call["params"] == {"page": 1, "per_page": 20, "query": "cat"}
        assert call["headers"]["Authorization"] == "Client-ID unsplash-secret"
        assert call["allow_redirects"] is False and call["timeout"] == providers.API_TIMEOUT

    def test_last_page_has_no_next_page(self, api, unsplash, net):
        net.add(unsplash_search_url(), FakeResponse(payload={"total": 3, "results": [unsplash_item()]}))
        assert api.get(SEARCH, {"q": "cat", "per_page": 24}).json()["next_page"] is None

    def test_unsplash_without_query_lists_editorial_photos(self, api, unsplash, net):
        net.add("https://api.unsplash.com/photos", FakeResponse(payload=[unsplash_item()]))
        body = api.get(SEARCH, {"per_page": 1}).json()
        assert len(body["results"]) == 1 and body["next_page"] == 2

    def test_pexels_search(self, api, pexels, net):
        net.add(
            "https://api.pexels.com/v1/search",
            FakeResponse(payload={"total_results": 100, "photos": [pexels_item()]}),
        )
        body = api.get(SEARCH, {"q": "sea"}).json()
        assert body["provider"] == "pexels" and body["next_page"] == 2
        assert body["results"][0]["id"] == "77" and body["results"][0]["author"] == "Grace Hopper"
        assert net.calls[0]["headers"]["Authorization"] == "pexels-secret"

    def test_pexels_curated_without_query(self, api, pexels, net):
        net.add(
            "https://api.pexels.com/v1/curated",
            FakeResponse(
                payload={"photos": [pexels_item()], "next_page": "https://api.pexels.com/v1/curated?page=2"}
            ),
        )
        body = api.get(SEARCH).json()
        assert len(body["results"]) == 1 and body["next_page"] == 2

    def test_provider_param_selects_provider(self, api, settings, net):
        settings.UNSPLASH_ACCESS_KEY, settings.PEXELS_API_KEY = "u", "p"
        net.add(
            "https://api.pexels.com/v1/search",
            FakeResponse(payload={"total_results": 1, "photos": [pexels_item()]}),
        )
        assert api.get(SEARCH, {"q": "x", "provider": "pexels"}).json()["provider"] == "pexels"

    def test_first_configured_provider_is_default(self, api, settings, net):
        settings.UNSPLASH_ACCESS_KEY, settings.PEXELS_API_KEY = "u", "p"
        net.add(unsplash_search_url(), FakeResponse(payload={"total": 1, "results": [unsplash_item()]}))
        assert api.get(SEARCH, {"q": "x"}).json()["provider"] == "unsplash"

    def test_unconfigured_requested_provider(self, api, unsplash, net):
        body = api.get(SEARCH, {"q": "x", "provider": "pexels"}).json()
        assert body["configured"] is False and body["provider"] == "pexels" and net.calls == []

    def test_unknown_provider_is_a_400(self, api, unsplash):
        assert api.get(SEARCH, {"provider": "evil"}).status_code == 400

    @pytest.mark.parametrize(
        "params",
        [{"per_page": 31}, {"per_page": 0}, {"page": 0}, {"page": 101}, {"q": "x" * 101}, {"page": "abc"}],
    )
    def test_parameter_validation(self, api, unsplash, params):
        assert api.get(SEARCH, params).status_code == 400

    def test_results_are_cached_for_the_providers_cache_time(self, api, unsplash, net, monkeypatch):
        net.add(unsplash_search_url(), FakeResponse(payload={"total": 1, "results": [unsplash_item()]}))
        stored = {}
        monkeypatch.setattr("apps.assets.stock.cache.set", lambda k, v, t: stored.update({k: (v, t)}))
        api.get(SEARCH, {"q": "Cat"})
        ttl = {
            key.rsplit(":", 1)[-1]: t
            for key, (_, t) in stored.items()
            if key.startswith("stock:v2:unsplash:")
        }
        assert ttl == {"24": 3600, "stale": 7200}

    def test_second_identical_search_hits_the_cache(self, api, unsplash, net):
        net.add(unsplash_search_url(), FakeResponse(payload={"total": 1, "results": [unsplash_item()]}))
        first = api.get(SEARCH, {"q": "cat"}).json()
        second = api.get(SEARCH, {"q": " CAT "}).json()
        assert first == second and len(net.calls) == 1

    def test_provider_failure_is_a_502(self, api, unsplash, net):
        net.add(unsplash_search_url(), FakeResponse(status=500))
        res = api.get(SEARCH, {"q": "cat"})
        assert res.status_code == 502 and res.json()["error"]["code"] == "stock_unavailable"

    def test_rate_limited_by_provider_is_a_429_with_retry_after(self, api, unsplash, net):
        net.add(unsplash_search_url(), FakeResponse(status=429, headers={"Retry-After": "30"}))
        res = api.get(SEARCH, {"q": "cat"})
        assert res.status_code == 429 and res["Retry-After"] == "30"
        assert res.json()["error"]["code"] == "stock_busy" and res.json()["error"]["retry_after"] == 30

    def test_network_error_is_a_502_and_not_cached(self, api, unsplash, net):
        net.add(unsplash_search_url(), requests.ConnectTimeout())
        assert api.get(SEARCH, {"q": "cat"}).status_code == 502
        net.add(unsplash_search_url(), FakeResponse(payload={"total": 1, "results": [unsplash_item()]}))
        assert api.get(SEARCH, {"q": "cat"}).status_code == 200

    @pytest.mark.parametrize("payload", [{"unexpected": True}, ["x"], "text", None])
    def test_garbage_from_provider_is_a_502(self, api, unsplash, net, payload):
        net.add(unsplash_search_url(), FakeResponse(payload=payload))
        assert api.get(SEARCH, {"q": "cat"}).status_code == 502

    def test_photos_pointing_off_cdn_are_dropped(self, api, unsplash, net):
        evil = unsplash_item(
            "evilEVIL1",
            urls={"small": "https://evil.example/a.jpg", "regular": "https://images.unsplash.com/ok"},
        )
        http = unsplash_item(
            "httpHTTP1",
            urls={"small": "http://images.unsplash.com/a.jpg", "regular": "https://images.unsplash.com/ok"},
        )
        net.add(
            unsplash_search_url(),
            FakeResponse(payload={"total": 3, "results": [evil, http, unsplash_item()]}),
        )
        assert [p["id"] for p in api.get(SEARCH, {"q": "x"}).json()["results"]] == [UNSPLASH_ID]

    def test_unsafe_author_links_are_blanked(self, api, unsplash, net):
        item = unsplash_item(
            user={"name": "X", "links": {"html": "javascript:alert(1)"}},
            links={"html": "data:text/html,boom"},
        )
        net.add(unsplash_search_url(), FakeResponse(payload={"total": 1, "results": [item]}))
        photo = api.get(SEARCH, {"q": "x"}).json()["results"][0]
        assert photo["author_url"] == "" and photo["source_url"] == ""

    def test_malformed_author_url_does_not_crash(self, api, unsplash, net):
        item = unsplash_item(user={"name": "X", "links": {"html": "https://[::1/profile"}})
        net.add(unsplash_search_url(), FakeResponse(payload={"total": 1, "results": [item]}))
        res = api.get(SEARCH, {"q": "x"})
        assert res.status_code == 200 and res.json()["results"][0]["author_url"] == ""

    def test_malformed_items_are_skipped(self, api, unsplash, net):
        net.add(
            unsplash_search_url(),
            FakeResponse(payload={"total": 3, "results": [None, {"id": 5}, unsplash_item()]}),
        )
        assert len(api.get(SEARCH, {"q": "x"}).json()["results"]) == 1


def stub_unsplash_import(net, *, download=None, photo_id=UNSPLASH_ID, item=None):
    net.add(
        f"https://api.unsplash.com/photos/{photo_id}", FakeResponse(payload=item or unsplash_item(photo_id))
    )
    net.add(f"https://api.unsplash.com/photos/{photo_id}/download", FakeResponse(payload={"url": "x"}))
    image = download if download is not None else image_bytes("JPEG", (80, 40))
    final = f"https://images.unsplash.com/photo-{photo_id}?ixid=abc&w=2400&q=85&fm=jpg&fit=max"
    net.add(final, FakeResponse(body=image, headers={"Content-Length": str(len(image))}))
    return final


@pytest.mark.django_db
class TestImport:
    def test_import_stores_asset_with_attribution(self, api, user, unsplash, net):
        final = stub_unsplash_import(net)
        res = api.post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json")
        assert res.status_code == 201
        body = res.json()
        assert body["kind"] == "image" and body["name"] == "Photo by Ada Lovelace"
        assert (
            body["attribution"]["author"] == "Ada Lovelace" and body["attribution"]["provider"] == "unsplash"
        )
        assert "unsplash.com/@ada" in body["attribution"]["author_url"]
        asset = Asset.objects.get(pk=body["id"])
        assert asset.owner == user and asset.meta["photo_id"] == UNSPLASH_ID
        assert final in net.urls()
        assert f"https://api.unsplash.com/photos/{UNSPLASH_ID}/download" in net.urls()

    def test_api_key_only_goes_to_the_api_host(self, api, unsplash, net):
        stub_unsplash_import(net)
        api.post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json")
        for call in net.calls:
            has_key = "Authorization" in call.get("headers", {})
            assert has_key == call["url"].startswith("https://api.unsplash.com/")

    def test_download_never_follows_redirects_automatically(self, api, unsplash, net):
        stub_unsplash_import(net)
        api.post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json")
        assert all(call["allow_redirects"] is False for call in net.calls)
        assert all(call["timeout"] == (3.05, 10) for call in net.calls)

    def test_importing_twice_returns_the_existing_asset(self, api, unsplash, net):
        stub_unsplash_import(net)
        first = api.post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json")
        calls = len(net.calls)
        second = api.post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json")
        assert second.status_code == 200 and second.json()["id"] == first.json()["id"]
        assert len(net.calls) == calls and Asset.objects.count() == 1

    def test_another_user_importing_the_same_photo_gets_their_own_asset(self, api, other_api, unsplash, net):
        stub_unsplash_import(net)
        a = api.post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json").json()
        b = other_api.post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json").json()
        assert a["id"] != b["id"] and Asset.objects.count() == 2

    def test_pexels_import(self, api, pexels, net):
        net.add("https://api.pexels.com/v1/photos/77", FakeResponse(payload=pexels_item()))
        image = image_bytes("JPEG", (50, 50))
        net.add("https://images.pexels.com/photos/77/large2x.jpeg", FakeResponse(body=image))
        res = api.post(IMPORT, {"provider": "pexels", "id": "77"}, format="json")
        assert res.status_code == 201 and res.json()["attribution"]["author"] == "Grace Hopper"

    def test_not_configured(self, api, settings, net):
        settings.UNSPLASH_ACCESS_KEY = settings.PEXELS_API_KEY = ""
        res = api.post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json")
        assert res.status_code == 400 and res.json()["error"]["code"] == "stock_not_configured"

    @pytest.mark.parametrize(
        "body",
        [
            {"provider": "unsplash", "id": "../../etc/passwd"},
            {"provider": "unsplash", "id": "abc"},
            {"provider": "unsplash", "id": "https://evil.example/x.jpg"},
            {"provider": "unsplash", "id": "a" * 41},
            {"provider": "evil", "id": UNSPLASH_ID},
            {"provider": "unsplash"},
            {"id": UNSPLASH_ID},
        ],
    )
    def test_invalid_requests(self, api, unsplash, net, body):
        assert api.post(IMPORT, body, format="json").status_code == 400
        assert net.calls == []

    def test_pexels_ids_must_be_numeric(self, api, pexels, net):
        assert api.post(IMPORT, {"provider": "pexels", "id": "12ab"}, format="json").status_code == 400
        assert api.post(IMPORT, {"provider": "pexels", "id": "١٢٣"}, format="json").status_code == 400

    def test_client_cannot_supply_a_url(self, api, unsplash, net):
        stub_unsplash_import(net)
        res = api.post(
            IMPORT,
            {"provider": "unsplash", "id": UNSPLASH_ID, "url": "http://169.254.169.254/latest/meta-data/"},
            format="json",
        )
        assert res.status_code == 201
        assert all("169.254" not in url for url in net.urls())

    def test_requires_authentication(self, db):
        from rest_framework.test import APIClient

        assert (
            APIClient().post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json").status_code
            == 401
        )

    def test_provider_download_url_off_allow_list_is_refused(self, api, unsplash, net):
        item = unsplash_item()
        item["urls"]["raw"] = "https://169.254.169.254/latest/meta-data/"
        net.add(f"https://api.unsplash.com/photos/{UNSPLASH_ID}", FakeResponse(payload=item))
        net.add(f"https://api.unsplash.com/photos/{UNSPLASH_ID}/download", FakeResponse(payload={}))
        net.add(
            f"https://images.unsplash.com/photo-{UNSPLASH_ID}?w=1080",
            FakeResponse(body=image_bytes("JPEG")),
        )
        res = api.post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json")
        assert res.status_code == 201
        assert all("169.254" not in url for url in net.urls())

    def test_redirect_off_allow_list_is_blocked(self, api, unsplash, net):
        final = stub_unsplash_import(net)
        net.add(final, FakeResponse(status=302, headers={"Location": "https://evil.example/steal.jpg"}))
        res = api.post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json")
        assert res.status_code == 502
        assert "https://evil.example/steal.jpg" not in net.urls()
        assert Asset.objects.count() == 0

    @pytest.mark.parametrize(
        "target",
        [
            "http://images.unsplash.com/a.jpg",
            "https://images.unsplash.com:8443/a.jpg",
            "https://user:pw@images.unsplash.com/a.jpg",
            "https://images.unsplash.com.evil.example/a.jpg",
            "https://evil.example/images.unsplash.com/a.jpg",
            "file:///etc/passwd",
            "//evil.example/a.jpg",
            "https://127.0.0.1/a.jpg",
            "https://images.pexels.com/a.jpg",
            "https://images.unsplash.com\\@evil.example/a.jpg",
            "https://evil.example\\@images.unsplash.com/a.jpg",
            "https://images.unsplash.com/a b.jpg",
            "https://images.unsplash.com/a\r\nHost: evil.example",
            "https://images.unsp\u0430sh.com/a.jpg",
            "https://images.unsplash.com./a.jpg",
            "https://[::1/a.jpg",
        ],
    )
    def test_dangerous_redirect_targets(self, api, unsplash, net, target):
        final = stub_unsplash_import(net)
        net.add(final, FakeResponse(status=301, headers={"Location": target}))
        res = api.post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json")
        assert res.status_code == 502
        assert target not in net.urls()

    def test_redirect_within_allow_list_is_followed(self, api, unsplash, net):
        final = stub_unsplash_import(net)
        image = image_bytes("JPEG", (30, 30))
        net.add(final, FakeResponse(status=302, headers={"Location": "/real/photo.jpg"}))
        net.add("https://images.unsplash.com/real/photo.jpg", FakeResponse(body=image))
        assert api.post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json").status_code == 201

    def test_redirect_loops_are_cut_off(self, api, unsplash, net):
        final = stub_unsplash_import(net)
        net.add(final, FakeResponse(status=302, headers={"Location": final}))
        assert api.post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json").status_code == 502
        assert net.urls().count(final) == providers.MAX_REDIRECTS + 1

    def test_declared_size_over_cap_is_413(self, api, unsplash, net, settings):
        settings.MAX_UPLOAD_BYTES = 1_000
        final = stub_unsplash_import(net)
        net.add(final, FakeResponse(body=b"", headers={"Content-Length": "999999"}))
        res = api.post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json")
        assert res.status_code == 413 and res.json()["error"]["code"] == "file_too_large"

    def test_streamed_size_over_cap_is_413_even_when_headers_lie(self, api, unsplash, net, settings):
        settings.MAX_UPLOAD_BYTES = 1_000
        final = stub_unsplash_import(net)
        net.add(final, FakeResponse(body=b"x" * 50_000, headers={"Content-Length": "10"}))
        assert api.post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json").status_code == 413

    def test_non_image_payload_is_rejected(self, api, unsplash, net):
        stub_unsplash_import(net, download=b"<html><script>alert(1)</script></html>")
        res = api.post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json")
        assert res.status_code == 400 and res.json()["error"]["code"] == "invalid_file"
        assert Asset.objects.count() == 0

    def test_download_timeout_is_a_502(self, api, unsplash, net):
        final = stub_unsplash_import(net)
        net.add(final, requests.ReadTimeout())
        assert api.post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json").status_code == 502

    def test_interrupted_stream_is_a_502(self, api, unsplash, net):
        final = stub_unsplash_import(net)
        net.add(final, FakeResponse(chunk_error=requests.ConnectionError("reset")))
        assert api.post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json").status_code == 502

    def test_slow_drip_download_hits_the_deadline(self, api, unsplash, net, monkeypatch):
        final = stub_unsplash_import(net)
        net.add(final, FakeResponse(body=b"x" * 1000))
        monkeypatch.setattr(providers, "DOWNLOAD_DEADLINE_SECONDS", -1)
        assert api.post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json").status_code == 502

    def test_unknown_photo_is_a_502(self, api, unsplash, net):
        net.add(f"https://api.unsplash.com/photos/{UNSPLASH_ID}", FakeResponse(status=404))
        assert api.post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json").status_code == 502

    def test_failed_usage_ping_does_not_fail_the_import(self, api, unsplash, net):
        stub_unsplash_import(net)
        net.add(f"https://api.unsplash.com/photos/{UNSPLASH_ID}/download", FakeResponse(status=500))
        assert api.post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json").status_code == 201

    def test_usage_ping_to_foreign_host_is_ignored(self, api, unsplash, net):
        item = unsplash_item()
        item["links"]["download_location"] = "https://evil.example/ping"
        stub_unsplash_import(net, item=item)
        assert api.post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json").status_code == 201
        assert "https://evil.example/ping" not in net.urls()

    def test_quota_applies_to_imports(self, api, unsplash, net, settings):
        settings.USER_STORAGE_QUOTA_BYTES = 5
        stub_unsplash_import(net)
        res = api.post(IMPORT, {"provider": "unsplash", "id": UNSPLASH_ID}, format="json")
        assert res.status_code == 413 and res.json()["error"]["code"] == "quota_exceeded"
