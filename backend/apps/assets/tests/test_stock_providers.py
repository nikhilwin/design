"""Pixabay, the per-provider settings, caching and limits, the providers endpoint and the "All" search."""

import base64
import json
import logging
import threading
import time

import pytest
import requests
from django.core.cache import cache

from apps.assets import providers, stock, stocklimits
from apps.assets.models import Asset

from .helpers import image_bytes
from .test_stock import IMPORT, SEARCH, FakeNetwork, FakeResponse, pexels_item, unsplash_item

PROVIDERS_URL = "/api/v1/stock/providers/"
PIXABAY_API = "https://pixabay.com/api/"
UNSPLASH_SEARCH = "https://api.unsplash.com/search/photos"
PEXELS_SEARCH = "https://api.pexels.com/v1/search"
KEY = "pixabay-secret-key-123"


@pytest.fixture
def net(monkeypatch):
    network = FakeNetwork()
    monkeypatch.setattr(providers, "http_get", network)
    return network


@pytest.fixture
def pixabay(settings):
    settings.UNSPLASH_ACCESS_KEY = settings.PEXELS_API_KEY = ""
    settings.PIXABAY_API_KEY = KEY


@pytest.fixture
def every(settings):
    settings.UNSPLASH_ACCESS_KEY, settings.PEXELS_API_KEY, settings.PIXABAY_API_KEY = "u", "p", KEY


def pixabay_item(photo_id=195893, **overrides):
    item = {
        "id": photo_id,
        "pageURL": f"https://pixabay.com/en/blossom-bloom-flower-{photo_id}/",
        "previewURL": f"https://cdn.pixabay.com/photo/2013/10/15/09/12/flower-{photo_id}_150.jpg",
        "webformatURL": f"https://pixabay.com/get/35bbf209e13e39d2_640.jpg?id={photo_id}",
        "largeImageURL": f"https://pixabay.com/get/ed6a99fd0a76647_1280.jpg?id={photo_id}",
        "imageWidth": 4000,
        "imageHeight": 2250,
        "user": "Josch13",
        "user_id": 48777,
    }
    item.update(overrides)
    return item


def pixabay_page(hits, total_hits=None):
    return FakeResponse(
        payload={"total": 4692, "totalHits": len(hits) if total_hits is None else total_hits, "hits": hits}
    )


def last_params(net):
    return net.calls[-1]["params"]


def cursor(pages):
    return base64.urlsafe_b64encode(json.dumps(pages, separators=(",", ":")).encode()).decode().rstrip("=")


def expire_fresh_copies():
    """Drop the fresh search copies, as if their cache time ran out; the stale copies stay."""
    for key in [k.split(":", 2)[2] for k in list(cache._cache) if ":stock:v2:" in k]:
        if not key.endswith(":stale"):
            cache.delete(key)


@pytest.mark.django_db
class TestPixabaySearch:
    def test_search_maps_results(self, api, pixabay, net):
        net.add(PIXABAY_API, pixabay_page([pixabay_item()], total_hits=480))
        body = api.get(SEARCH, {"q": "yellow flower", "per_page": 20}).json()
        assert body["provider"] == "pixabay" and body["total"] == 480 and body["next_page"] == 2
        photo = body["results"][0]
        assert photo["id"] == "195893" and photo["provider"] == "pixabay"
        assert photo["thumb_url"] == "https://pixabay.com/get/35bbf209e13e39d2_340.jpg?id=195893"
        assert photo["preview_url"].endswith("_640.jpg?id=195893")
        assert (photo["width"], photo["height"], photo["author"]) == (4000, 2250, "Josch13")
        assert photo["author_url"] == "https://pixabay.com/users/Josch13-48777/"
        assert photo["source_url"].startswith("https://pixabay.com/en/blossom")
        assert last_params(net) == {
            "key": KEY,
            "q": "yellow flower",
            "page": 1,
            "per_page": 20,
            "image_type": "photo",
            "safesearch": "true",
            "lang": "en",
        }
        assert net.calls[0]["allow_redirects"] is False

    def test_empty_query_lists_popular_images(self, api, pixabay, net):
        net.add(PIXABAY_API, pixabay_page([pixabay_item()]))
        api.get(SEARCH)
        assert "q" not in last_params(net)

    def test_total_is_capped_at_what_the_api_pages_through(self, api, pixabay, net):
        net.add(PIXABAY_API, pixabay_page([pixabay_item()], total_hits=9000))
        assert api.get(SEARCH, {"q": "x", "per_page": 30, "page": 16}).json()["next_page"] == 17
        net.add(PIXABAY_API, pixabay_page([pixabay_item()], total_hits=9000))
        body = api.get(SEARCH, {"q": "x", "per_page": 30, "page": 17}).json()
        assert body["total"] == 500 and body["next_page"] is None

    def test_per_page_below_pixabays_minimum(self, api, pixabay, net):
        hits = [pixabay_item(i) for i in (1, 2, 3)]
        net.add(PIXABAY_API, pixabay_page(hits, total_hits=100))
        body = api.get(SEARCH, {"q": "x", "per_page": 2}).json()
        assert last_params(net)["per_page"] == 3
        assert [p["id"] for p in body["results"]] == ["1", "2"] and body["next_page"] is None

    @pytest.mark.parametrize(("lang", "sent"), [("de", "de"), ("de-AT", "de"), ("xx", "en"), (None, "en")])
    def test_ui_language(self, api, pixabay, net, lang, sent):
        net.add(PIXABAY_API, pixabay_page([pixabay_item()]))
        api.get(SEARCH, {"q": "Blume", **({"lang": lang} if lang else {})})
        assert last_params(net)["lang"] == sent

    def test_unsplash_safe_search_when_turned_on(self, api, net, settings):
        settings.UNSPLASH_ACCESS_KEY = "u"
        values = settings.STOCK_PROVIDER_SETTINGS
        settings.STOCK_PROVIDER_SETTINGS = {**values, "unsplash": {**values["unsplash"], "safesearch": True}}
        net.add(UNSPLASH_SEARCH, FakeResponse(payload={"total": 1, "results": [unsplash_item()]}))
        api.get(SEARCH, {"q": "x", "provider": "unsplash"})
        assert last_params(net)["content_filter"] == "high"

    def test_ui_language_can_be_turned_off(self, api, pixabay, net, settings):
        settings.STOCK_LANG_FROM_UI = False
        net.add(PIXABAY_API, pixabay_page([pixabay_item()]))
        api.get(SEARCH, {"q": "Blume", "lang": "de"})
        assert last_params(net)["lang"] == "en"

    def test_image_type_and_safesearch_settings(self, api, pixabay, net, settings):
        settings.STOCK_PIXABAY_IMAGE_TYPE = "vector"
        settings.STOCK_PROVIDER_SETTINGS = {
            **settings.STOCK_PROVIDER_SETTINGS,
            "pixabay": {**settings.STOCK_PROVIDER_SETTINGS["pixabay"], "safesearch": False},
        }
        net.add(PIXABAY_API, pixabay_page([pixabay_item()]))
        api.get(SEARCH, {"q": "x"})
        assert last_params(net)["image_type"] == "vector" and last_params(net)["safesearch"] == "false"

    def test_unknown_image_type_falls_back_to_photo(self, api, pixabay, net, settings):
        settings.STOCK_PIXABAY_IMAGE_TYPE = "evil"
        net.add(PIXABAY_API, pixabay_page([pixabay_item()]))
        api.get(SEARCH, {"q": "x"})
        assert last_params(net)["image_type"] == "photo"

    def test_off_host_and_non_get_urls_are_dropped(self, api, pixabay, net):
        evil = pixabay_item(
            1, webformatURL="https://evil.example/x_640.jpg", previewURL="https://evil.example/p.jpg"
        )
        page = pixabay_item(
            2, webformatURL="https://pixabay.com/en/photos/x_640.jpg", previewURL="https://evil.example/p.jpg"
        )
        net.add(PIXABAY_API, pixabay_page([evil, page, pixabay_item(3)]))
        assert [p["id"] for p in api.get(SEARCH, {"q": "x"}).json()["results"]] == ["3"]

    def test_garbage_is_a_502(self, api, pixabay, net):
        net.add(PIXABAY_API, FakeResponse(payload={"hits": "nope"}))
        assert api.get(SEARCH, {"q": "x"}).status_code == 502

    def test_not_offered_without_its_key(self, api, settings, net):
        settings.UNSPLASH_ACCESS_KEY, settings.PIXABAY_API_KEY = "u", ""
        assert api.get(SEARCH, {"q": "x", "provider": "pixabay"}).json()["configured"] is False
        assert net.calls == []

    @pytest.mark.parametrize(
        ("cache_seconds", "stored"),
        [
            (86400, [86400]),  # the default: a stale copy would outlive the 24 h image URLs
            (172800, [86400]),  # a longer cache time is capped at the URLs' lifetime
            (60000, [60000, 86400]),  # the stale copy ends when the URLs do
            (3600, [3600, 7200]),
        ],
    )
    def test_results_never_outlive_the_image_urls(
        self, api, pixabay, net, monkeypatch, settings, cache_seconds, stored
    ):
        set_cache(settings, "pixabay", cache_seconds)
        net.add(PIXABAY_API, pixabay_page([pixabay_item()]))
        found = {}
        monkeypatch.setattr("apps.assets.stock.cache.set", lambda k, v, t: found.update({k: t}))
        api.get(SEARCH, {"q": "x"})
        assert sorted(t for k, t in found.items() if k.startswith("stock:v2:pixabay:")) == stored

    def test_no_stale_copy_past_the_url_lifetime(self, api, pixabay, net):
        net.add(PIXABAY_API, pixabay_page([pixabay_item()]))
        api.get(SEARCH, {"q": "x"})
        expire_fresh_copies()
        net.add(PIXABAY_API, FakeResponse(status=500))
        assert api.get(SEARCH, {"q": "x"}).status_code == 502


@pytest.mark.django_db
class TestPixabayImport:
    def stub(self, net, item=None):
        net.add(
            PIXABAY_API, FakeResponse(payload={"total": 1, "totalHits": 1, "hits": [item or pixabay_item()]})
        )

    def test_import_downloads_the_large_image(self, api, pixabay, net):
        self.stub(net)
        image = image_bytes("JPEG", (64, 36))
        net.add("https://pixabay.com/get/ed6a99fd0a76647_1280.jpg?id=195893", FakeResponse(body=image))
        res = api.post(IMPORT, {"provider": "pixabay", "id": "195893"}, format="json")
        assert res.status_code == 201
        assert res.json()["attribution"] == {
            "provider": "pixabay",
            "author": "Josch13",
            "author_url": "https://pixabay.com/users/Josch13-48777/",
            "source_url": "https://pixabay.com/en/blossom-bloom-flower-195893/",
        }
        assert net.calls[0]["params"] == {"key": KEY, "id": "195893"}

    def test_full_hd_url_is_preferred_when_present(self, api, pixabay, net):
        self.stub(net, pixabay_item(fullHDURL="https://pixabay.com/get/full_1920.jpg"))
        net.add("https://pixabay.com/get/full_1920.jpg", FakeResponse(body=image_bytes("JPEG")))
        assert api.post(IMPORT, {"provider": "pixabay", "id": "195893"}, format="json").status_code == 201

    @pytest.mark.parametrize(
        "large",
        ["https://evil.example/x.jpg", "http://pixabay.com/get/x.jpg", "https://pixabay.com/api/?key=x"],
    )
    def test_download_off_the_allow_list_is_refused(self, api, pixabay, net, large):
        self.stub(net, pixabay_item(largeImageURL=large))
        res = api.post(IMPORT, {"provider": "pixabay", "id": "195893"}, format="json")
        assert res.status_code == 502 and large not in net.urls()

    def test_an_answer_for_another_id_is_refused(self, api, pixabay, net):
        self.stub(net, pixabay_item(999))
        assert api.post(IMPORT, {"provider": "pixabay", "id": "195893"}, format="json").status_code == 502

    @pytest.mark.parametrize("photo_id", ["12ab", "1 OR 1", "../1", "١٢٣", "1" * 13])
    def test_ids_must_be_numeric(self, api, pixabay, net, photo_id):
        assert api.post(IMPORT, {"provider": "pixabay", "id": photo_id}, format="json").status_code == 400
        assert net.calls == []

    def test_resolve_is_cached(self, api, other_api, pixabay, net):
        self.stub(net)
        net.add(
            "https://pixabay.com/get/ed6a99fd0a76647_1280.jpg?id=195893",
            FakeResponse(body=image_bytes("JPEG")),
        )
        api.post(IMPORT, {"provider": "pixabay", "id": "195893"}, format="json")
        other_api.post(IMPORT, {"provider": "pixabay", "id": "195893"}, format="json")
        assert net.urls().count(PIXABAY_API) == 1 and Asset.objects.count() == 2


@pytest.mark.django_db
class TestKeyNeverLeaks:
    def test_not_in_errors_or_logs_when_the_request_fails(self, api, pixabay, net, caplog):
        caplog.set_level(logging.DEBUG)
        net.add(PIXABAY_API, requests.ConnectionError(f"Max retries exceeded with url: /api/?key={KEY}&q=x"))
        res = api.get(SEARCH, {"q": "x"})
        assert res.status_code == 502
        assert KEY not in res.content.decode() and KEY not in caplog.text

    def test_not_in_errors_on_a_bad_answer(self, api, pixabay, net, caplog):
        caplog.set_level(logging.DEBUG)
        net.add(PIXABAY_API, FakeResponse(status=400, payload={"error": f"bad key {KEY}"}))
        res = api.get(SEARCH, {"q": "x"})
        assert KEY not in res.content.decode() and KEY not in caplog.text

    def test_not_in_search_results(self, api, pixabay, net):
        net.add(PIXABAY_API, pixabay_page([pixabay_item()]))
        assert KEY not in api.get(SEARCH, {"q": "x"}).content.decode()

    def test_masked_in_urllib3_debug_logs(self, caplog):
        caplog.set_level(logging.DEBUG, logger="urllib3.connectionpool")
        logging.getLogger("urllib3.connectionpool").debug(
            '%s://%s:%s "%s %s %s" %s %s',
            "https",
            "pixabay.com",
            443,
            "GET",
            f"/api/?key={KEY}&q=x",
            "HTTP/1.1",
            200,
            10,
        )
        assert KEY not in caplog.text and "key=***" in caplog.text


class TestConfig:
    @pytest.mark.parametrize(
        ("rate", "parsed"),
        [
            ("100/m", (100, 60)),
            ("50/h", (50, 3600)),
            ("200/hour", (200, 3600)),
            ("20000/30d", (20000, 2592000)),
            ("5/10s", (5, 10)),
            ("", None),
            ("lots", None),
        ],
    )
    def test_parse_rate(self, rate, parsed):
        assert stocklimits.parse_rate(rate) == parsed

    def test_defaults(self, settings):
        # No cap of our own unless STOCK_<P>_RATE is set, and Unsplash unfiltered as before.
        assert stocklimits.config_for("unsplash") == stocklimits.StockConfig(3600, "", False)
        assert stocklimits.config_for("pexels") == stocklimits.StockConfig(3600, "", True)
        assert stocklimits.config_for("pixabay") == stocklimits.StockConfig(86400, "", True)

    def test_no_cap_unless_a_rate_is_set(self, db):
        assert all(stocklimits.acquire("pixabay", "") is None for _ in range(500))

    def test_stock_providers_sets_order_and_turns_providers_off(self, every, settings):
        settings.STOCK_PROVIDERS = ["Pixabay", "unsplash", "nope"]
        assert [p.name for p in providers.configured_providers()] == ["pixabay", "unsplash"]
        assert providers.PROVIDERS["pexels"].configured is False


@pytest.mark.django_db
class TestCaching:
    def test_changing_a_setting_does_not_serve_old_results(self, api, pixabay, net, settings):
        net.add(PIXABAY_API, pixabay_page([pixabay_item()]))
        api.get(SEARCH, {"q": "x"})
        api.get(SEARCH, {"q": "x"})
        settings.STOCK_PIXABAY_IMAGE_TYPE = "illustration"
        api.get(SEARCH, {"q": "x"})
        assert len(net.calls) == 2

    def test_empty_results_are_cached_briefly(self, api, pixabay, net, monkeypatch):
        net.add(PIXABAY_API, pixabay_page([]))
        stored = {}
        monkeypatch.setattr("apps.assets.stock.cache.set", lambda k, v, t: stored.update({k: t}))
        api.get(SEARCH, {"q": "xyzzy"})
        assert [t for k, t in stored.items() if k.startswith("stock:v2:")] == [stock.EMPTY_CACHE_SECONDS]

    def test_stale_copy_is_served_when_the_provider_fails(self, api, pixabay, net, settings):
        set_cache(settings, "pixabay", 3600)
        net.add(PIXABAY_API, pixabay_page([pixabay_item()]))
        fresh = api.get(SEARCH, {"q": "x"}).json()
        expire_fresh_copies()
        net.add(PIXABAY_API, FakeResponse(status=500))
        stale = api.get(SEARCH, {"q": "x"})
        assert stale.status_code == 200 and stale.json() == {**fresh, "stale": True}

    def test_identical_searches_wait_for_the_one_in_flight(self, api, pixabay, net, monkeypatch):
        options = providers.PROVIDERS["pixabay"].search_options("")
        key = stock._cache_key("pixabay", options, "x", 1, stock.DEFAULT_PER_PAGE)
        cache.add(f"{key}:lock", 1, 30)
        answer = {"configured": True, "provider": "pixabay", "total": 0, "next_page": None, "results": []}
        monkeypatch.setattr(stock.time, "sleep", lambda s: cache.set(key, answer, 60))
        assert api.get(SEARCH, {"q": "x"}).json() == answer and net.calls == []

    def test_a_waiter_that_gives_up_leaves_the_holders_lock(self, api, pixabay, net, monkeypatch):
        options = providers.PROVIDERS["pixabay"].search_options("")
        lock = f"{stock._cache_key('pixabay', options, 'x', 1, stock.DEFAULT_PER_PAGE)}:lock"
        cache.add(lock, 1, 30)
        monkeypatch.setattr(stock, "LOCK_WAIT_SECONDS", 0.05)
        monkeypatch.setattr(stock, "LOCK_POLL_SECONDS", 0.01)
        net.add(PIXABAY_API, pixabay_page([pixabay_item()]))
        api.get(SEARCH, {"q": "x"})
        assert cache.get(lock) == 1

    def test_without_caching_there_is_no_lock_and_no_wait(self, api, pixabay, net, monkeypatch, settings):
        set_cache(settings, "pixabay", 0)
        options = providers.PROVIDERS["pixabay"].search_options("")
        cache.add(f"{stock._cache_key('pixabay', options, 'x', 1, stock.DEFAULT_PER_PAGE)}:lock", 1, 30)
        monkeypatch.setattr(stock, "_wait_for", lambda key: pytest.fail("waited for a cache that is off"))
        net.add(PIXABAY_API, pixabay_page([pixabay_item()]))
        assert api.get(SEARCH, {"q": "x"}).status_code == 200
        api.get(SEARCH, {"q": "x"})
        assert len(net.calls) == 2

    def test_a_stuck_lock_does_not_block_forever(self, api, pixabay, net, monkeypatch):
        options = providers.PROVIDERS["pixabay"].search_options("")
        cache.add(f"{stock._cache_key('pixabay', options, 'x', 1, stock.DEFAULT_PER_PAGE)}:lock", 1, 30)
        monkeypatch.setattr(stock, "LOCK_WAIT_SECONDS", 0.05)
        monkeypatch.setattr(stock, "LOCK_POLL_SECONDS", 0.01)
        net.add(PIXABAY_API, pixabay_page([pixabay_item()]))
        assert api.get(SEARCH, {"q": "x"}).status_code == 200 and len(net.calls) == 1


def set_cache(settings, name, seconds):
    values = settings.STOCK_PROVIDER_SETTINGS
    settings.STOCK_PROVIDER_SETTINGS = {**values, name: {**values[name], "cache_seconds": seconds}}


def set_rate(settings, name, rate):
    values = settings.STOCK_PROVIDER_SETTINGS
    settings.STOCK_PROVIDER_SETTINGS = {**values, name: {**values[name], "rate": rate}}


@pytest.mark.django_db
class TestLimits:
    def test_shared_budget_across_users(self, api, other_api, pixabay, net, settings):
        set_rate(settings, "pixabay", "2/m")
        net.add(PIXABAY_API, pixabay_page([pixabay_item()]))
        assert api.get(SEARCH, {"q": "a"}).status_code == 200
        assert other_api.get(SEARCH, {"q": "b"}).status_code == 200
        res = api.get(SEARCH, {"q": "c"})
        assert res.status_code == 429 and 1 <= int(res["Retry-After"]) <= 60
        assert len(net.calls) == 2

    def test_over_the_budget_serves_the_cache(self, api, pixabay, net, settings):
        set_rate(settings, "pixabay", "1/m")
        net.add(PIXABAY_API, pixabay_page([pixabay_item()]))
        api.get(SEARCH, {"q": "a"})
        assert api.get(SEARCH, {"q": "a"}).status_code == 200 and len(net.calls) == 1

    def test_pixabay_remaining_zero_pauses_until_reset(self, api, pixabay, net):
        headers = {"X-RateLimit-Limit": "100", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "42"}
        net.add(
            PIXABAY_API, FakeResponse(payload={"totalHits": 1, "hits": [pixabay_item()]}, headers=headers)
        )
        assert api.get(SEARCH, {"q": "a"}).status_code == 200
        res = api.get(SEARCH, {"q": "b"})
        assert res.status_code == 429 and 40 <= int(res["Retry-After"]) <= 42 and len(net.calls) == 1

    def test_pexels_monthly_reset_is_a_unix_time(self, api, pexels, net):
        reset = str(int(time.time()) + 3 * 86400)
        headers = {"x-ratelimit-remaining": "0", "x-ratelimit-reset": reset}
        net.add(
            PEXELS_SEARCH,
            FakeResponse(payload={"total_results": 1, "photos": [pexels_item()]}, headers=headers),
        )
        api.get(SEARCH, {"q": "a"})
        res = api.get(SEARCH, {"q": "b"})
        assert res.status_code == 429 and int(res["Retry-After"]) > 2 * 86400

    def test_unsplash_429_without_reset_pauses_for_the_fallback(self, api, unsplash, net):
        net.add(UNSPLASH_SEARCH, FakeResponse(status=429))
        assert api.get(SEARCH, {"q": "a"}).status_code == 429
        assert stocklimits.paused_for("unsplash") > 500
        api.get(SEARCH, {"q": "b"})
        assert len(net.calls) == 1

    def test_busy_serves_a_stale_copy(self, api, pixabay, net, settings):
        set_cache(settings, "pixabay", 3600)
        net.add(PIXABAY_API, pixabay_page([pixabay_item()]))
        api.get(SEARCH, {"q": "x"})
        expire_fresh_copies()
        stocklimits.pause("pixabay", 30)
        res = api.get(SEARCH, {"q": "x"})
        assert res.status_code == 200 and res.json()["stale"] is True and len(net.calls) == 1

    def test_busy_import_is_a_429(self, api, pixabay, net):
        stocklimits.pause("pixabay", 30)
        res = api.post(IMPORT, {"provider": "pixabay", "id": "1"}, format="json")
        assert res.status_code == 429 and res.json()["error"]["code"] == "stock_busy" and net.calls == []


@pytest.mark.django_db
class TestProvidersEndpoint:
    def test_lists_configured_providers_in_order(self, api, every):
        body = api.get(PROVIDERS_URL).json()
        assert [p["name"] for p in body["providers"]] == ["unsplash", "pexels", "pixabay"]
        assert body["providers"][1] == {
            "name": "pexels",
            "label": "Pexels",
            "attribution": "Photos provided by Pexels",
            "url": "https://www.pexels.com/",
        }
        assert "utm_source=doory" in body["providers"][0]["url"]
        assert body["all"] == ["unsplash", "pexels", "pixabay"] and body["default"] == "all"
        assert KEY not in json.dumps(body)

    def test_one_provider_has_no_all_tab(self, api, pixabay):
        assert api.get(PROVIDERS_URL).json() == {
            "providers": [
                {
                    "name": "pixabay",
                    "label": "Pixabay",
                    "attribution": "Images from Pixabay",
                    "url": "https://pixabay.com/",
                }
            ],
            "all": [],
            "default": "pixabay",
        }

    def test_all_providers_and_default_tab_settings(self, api, every, settings):
        settings.STOCK_ALL_PROVIDERS = ["pexels", "pixabay"]
        settings.STOCK_DEFAULT_TAB = "pixabay"
        body = api.get(PROVIDERS_URL).json()
        assert body["all"] == ["pexels", "pixabay"] and body["default"] == "pixabay"

    def test_unknown_default_tab_falls_back(self, api, every, settings):
        settings.STOCK_DEFAULT_TAB = "nope"
        assert api.get(PROVIDERS_URL).json()["default"] == "all"

    def test_nothing_configured(self, api, settings):
        assert api.get(PROVIDERS_URL).json() == {"providers": [], "all": [], "default": ""}

    def test_requires_authentication(self, db):
        from rest_framework.test import APIClient

        assert APIClient().get(PROVIDERS_URL).status_code == 401


def stub_all(net, *, unsplash=None, pexels=None, pixabay=None):
    net.add(
        UNSPLASH_SEARCH,
        unsplash
        or FakeResponse(payload={"total": 60, "results": [unsplash_item("uuuuu1"), unsplash_item("uuuuu2")]}),
    )
    net.add(
        PEXELS_SEARCH,
        pexels or FakeResponse(payload={"total_results": 2, "photos": [pexels_item(1), pexels_item(2)]}),
    )
    net.add(PIXABAY_API, pixabay or pixabay_page([pixabay_item(7)], total_hits=900))


@pytest.mark.django_db
class TestAllSearch:
    def test_mixes_providers_in_turn(self, api, every, net):
        stub_all(net)
        body = api.get(SEARCH, {"q": "x", "provider": "all"}).json()
        assert [(p["provider"], p["id"]) for p in body["results"]] == [
            ("unsplash", "uuuuu1"),
            ("pexels", "1"),
            ("pixabay", "7"),
            ("unsplash", "uuuuu2"),
            ("pexels", "2"),
        ]
        assert body["provider"] == "all" and body["skipped"] == [] and body["total"] == 60 + 2 + 500
        assert json.loads(base64.urlsafe_b64decode(body["next_page"] + "==")) == {"pixabay": 2, "unsplash": 2}

    def test_searches_share_one_bounded_pool(self, api, every, net, monkeypatch):
        monkeypatch.setattr(stock, "ThreadPoolExecutor", lambda *a, **k: pytest.fail("a pool per request"))
        stub_all(net)
        assert api.get(SEARCH, {"q": "x", "provider": "all"}).status_code == 200
        assert stock._POOL._max_workers == stock.SEARCH_THREADS

    def test_no_duplicates(self, api, every, net):
        same = FakeResponse(
            payload={"total": 2, "results": [unsplash_item("uuuuu1"), unsplash_item("uuuuu1")]}
        )
        stub_all(net, unsplash=same)
        ids = [
            (p["provider"], p["id"]) for p in api.get(SEARCH, {"q": "x", "provider": "all"}).json()["results"]
        ]
        assert len(ids) == len(set(ids))

    def test_cursor_only_calls_providers_with_more(self, api, every, net):
        stub_all(net)
        body = api.get(SEARCH, {"q": "x", "provider": "all", "cursor": cursor({"pixabay": 2})}).json()
        assert {c["url"] for c in net.calls} == {PIXABAY_API} and net.calls[0]["params"]["page"] == 2
        assert body["next_page"] == cursor({"pixabay": 3})

    @pytest.mark.parametrize(
        "bad",
        [
            "!!!",
            cursor({"evil": 2}),
            cursor({"pexels": 0}),
            cursor({"pexels": True}),
            cursor([1]),
            cursor({}),
        ],
    )
    def test_invalid_cursor_is_a_400(self, api, every, net, bad):
        assert api.get(SEARCH, {"provider": "all", "cursor": bad}).status_code == 400 and net.calls == []

    def test_one_provider_failing_is_skipped(self, api, every, net):
        stub_all(
            net,
            pexels=FakeResponse(status=500),
            pixabay=FakeResponse(status=429, headers={"Retry-After": "9"}),
        )
        body = api.get(SEARCH, {"q": "x", "provider": "all"}).json()
        assert {p["provider"] for p in body["results"]} == {"unsplash"}
        assert sorted(body["skipped"], key=lambda s: s["provider"]) == [
            {"provider": "pexels", "reason": "unavailable", "retry_after": None},
            {"provider": "pixabay", "reason": "busy", "retry_after": 9},
        ]
        # The busy provider stays in the cursor at the page it missed; the one that failed outright does not.
        assert body["next_page"] == cursor({"pixabay": 1, "unsplash": 2})

    def test_a_failing_provider_is_not_asked_again(self, api, every, net):
        stub_all(net, pixabay=FakeResponse(status=403))
        body = api.get(SEARCH, {"q": "x", "provider": "all", "cursor": cursor({"pixabay": 2})})
        assert body.status_code == 502
        body = api.get(
            SEARCH, {"q": "x", "provider": "all", "cursor": cursor({"pixabay": 2, "unsplash": 2})}
        ).json()
        assert body["next_page"] == cursor({"unsplash": 3})

    def test_a_timed_out_provider_keeps_its_page(self, api, every, net, settings):
        settings.STOCK_ALL_TIMEOUT_SECONDS = 0.1
        release = threading.Event()

        def slow():
            release.wait(5)
            return pixabay_page([pixabay_item(7)])

        stub_all(net, pixabay=slow)
        try:
            body = api.get(
                SEARCH, {"q": "x", "provider": "all", "cursor": cursor({"pixabay": 3, "unsplash": 2})}
            ).json()
            assert body["next_page"] == cursor({"pixabay": 3, "unsplash": 3})
        finally:
            release.set()

    def test_a_skipped_provider_keeps_its_page(self, api, every, net):
        stub_all(net, pixabay=FakeResponse(status=429, headers={"Retry-After": "9"}))
        body = api.get(
            SEARCH, {"q": "x", "provider": "all", "cursor": cursor({"pixabay": 2, "unsplash": 2})}
        ).json()
        assert body["next_page"] == cursor({"pixabay": 2, "unsplash": 3})
        net.add(PIXABAY_API, pixabay_page([pixabay_item(8)], total_hits=900))
        cache.delete("stock:pause:pixabay")  # the pause is over
        again = api.get(SEARCH, {"q": "x", "provider": "all", "cursor": cursor({"pixabay": 2})}).json()
        assert [p["id"] for p in again["results"]] == ["8"] and net.calls[-1]["params"]["page"] == 2

    def test_slow_provider_times_out_but_fills_the_cache(self, api, every, net, settings):
        settings.STOCK_ALL_TIMEOUT_SECONDS = 0.2
        release = threading.Event()

        def slow():
            release.wait(5)
            return pixabay_page([pixabay_item(7)])

        stub_all(net, pixabay=slow)
        body = api.get(SEARCH, {"q": "x", "provider": "all"}).json()
        assert {"provider": "pixabay", "reason": "timeout", "retry_after": None} in body["skipped"]
        release.set()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not any(":stock:v2:pixabay:" in k for k in cache._cache):
            time.sleep(0.02)
        assert len(api.get(SEARCH, {"q": "x", "provider": "pixabay"}).json()["results"]) == 1
        assert net.urls().count(PIXABAY_API) == 1

    def test_all_and_single_tabs_share_the_cache(self, api, every, net):
        stub_all(net)
        api.get(SEARCH, {"q": "x", "provider": "all"})
        calls = len(net.calls)
        for name in ("unsplash", "pexels", "pixabay"):
            api.get(SEARCH, {"q": "x", "provider": name})
        api.get(SEARCH, {"q": "x", "provider": "all"})
        assert len(net.calls) == calls == 3

    def test_all_providers_setting_filters(self, api, every, net, settings):
        settings.STOCK_ALL_PROVIDERS = ["pexels", "pixabay"]
        stub_all(net)
        body = api.get(SEARCH, {"q": "x", "provider": "all"}).json()
        assert {p["provider"] for p in body["results"]} == {"pexels", "pixabay"}
        assert UNSPLASH_SEARCH not in net.urls()

    def test_every_provider_busy_is_a_429(self, api, every, net):
        for name, wait in (("unsplash", 50), ("pexels", 20), ("pixabay", 30)):
            stocklimits.pause(name, wait)
        res = api.get(SEARCH, {"q": "x", "provider": "all"})
        assert res.status_code == 429 and 19 <= int(res["Retry-After"]) <= 20 and net.calls == []

    def test_every_provider_down_is_a_502(self, api, every, net):
        stub_all(
            net,
            unsplash=FakeResponse(status=500),
            pexels=FakeResponse(status=500),
            pixabay=FakeResponse(status=500),
        )
        res = api.get(SEARCH, {"q": "x", "provider": "all"})
        assert res.status_code == 502 and res.json()["error"]["code"] == "stock_unavailable"

    def test_nothing_configured(self, api, settings, net):
        assert api.get(SEARCH, {"provider": "all"}).json()["configured"] is False


@pytest.fixture
def unsplash(settings):
    settings.UNSPLASH_ACCESS_KEY, settings.PEXELS_API_KEY, settings.PIXABAY_API_KEY = "u", "", ""


@pytest.fixture
def pexels(settings):
    settings.UNSPLASH_ACCESS_KEY, settings.PEXELS_API_KEY, settings.PIXABAY_API_KEY = "", "p", ""
