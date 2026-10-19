import pytest

from apps.assets import credits, freesound, providers
from apps.assets.models import Asset

from .audio_helpers import mp3_bytes, ogg_vorbis_bytes
from .test_stock import FakeNetwork, FakeResponse

SEARCH = "/api/v1/stock/audio/"
INFO = "/api/v1/stock/audio/info/"
IMPORT = "/api/v1/stock/audio/import/"
API_SEARCH = "https://freesound.org/apiv2/search/text/"
CC0 = "http://creativecommons.org/publicdomain/zero/1.0/"
BY = "https://creativecommons.org/licenses/by/4.0/"
NC = "http://creativecommons.org/licenses/by-nc/3.0/"


def sound(sound_id=101, license=CC0, **overrides):
    item = {
        "id": sound_id,
        "name": "Whoosh fast",
        "username": "foley_guy",
        "url": f"https://freesound.org/people/foley_guy/sounds/{sound_id}/",
        "license": license,
        "duration": 1.5,
        "category": "Sound effects",
        "subcategory": "Electronic / Design",
        "tags": ["whoosh", "transition"],
        "previews": {
            "preview-lq-mp3": f"https://cdn.freesound.org/previews/0/{sound_id}-lq.mp3",
            "preview-hq-ogg": f"https://cdn.freesound.org/previews/0/{sound_id}-hq.ogg",
        },
    }
    item.update(overrides)
    return item


def page(*items, count=None, more=False):
    return FakeResponse(
        payload={
            "count": len(items) if count is None else count,
            "next": "x" if more else None,
            "results": list(items),
        }
    )


@pytest.fixture
def net(monkeypatch):
    network = FakeNetwork()
    monkeypatch.setattr(providers, "http_get", network)
    return network


@pytest.fixture
def key(settings):
    settings.FREESOUND_API_KEY = "fs-secret"
    settings.FREESOUND_LICENSES = ["cc0"]


class TestLicences:
    @pytest.mark.parametrize(
        ("url", "code"),
        [
            (CC0, "cc0"),
            ("https://creativecommons.org/publicdomain/zero/1.0/", "cc0"),
            (BY, "by"),
            ("http://creativecommons.org/licenses/by/3.0/", "by"),
            (NC, None),
            ("http://creativecommons.org/licenses/sampling+/1.0/", None),
            ("https://creativecommons.org/licenses/by-sa/4.0/", None),
            ("https://evil.example/licenses/by/4.0/", None),
            (None, None),
        ],
    )
    def test_only_cc0_and_cc_by_are_recognised(self, url, code):
        found = freesound.license_of(url)
        assert (found.code if found else None) == code

    def test_unknown_names_fall_back_to_cc0(self, settings):
        settings.FREESOUND_LICENSES = ["nc", "sampling+"]
        assert freesound.allowed_licenses() == ["cc0"]
        settings.FREESOUND_LICENSES = [" BY ", "cc0", "by"]
        assert freesound.allowed_licenses() == ["by", "cc0"]

    def test_filter_always_carries_the_licence(self, settings):
        settings.FREESOUND_LICENSES = ["cc0"]
        assert freesound.search_filter("all", "", "any") == 'license:"Creative Commons 0" duration:[0 TO 900]'
        settings.FREESOUND_LICENSES = ["cc0", "by"]
        built = freesound.search_filter("effects", "Animals", "short")
        assert built == (
            'license:("Creative Commons 0" OR "Attribution") category:"Sound effects" '
            'subcategory:"Animals" duration:[0 TO 5]'
        )

    def test_unknown_subcategory_is_dropped(self, key):
        assert "subcategory" not in freesound.search_filter("music", 'x" OR license:"Attribution', "any")


class TestSearch:
    def test_not_configured(self, api, net):
        assert api.get(INFO).json() == {"configured": False}
        assert api.get(SEARCH, {"q": "rain"}).json()["configured"] is False
        assert net.calls == []

    def test_info(self, api, key):
        body = api.get(INFO).json()
        assert body["configured"] is True and body["licenses"] == ["cc0"]
        assert "Animals" in body["types"]["effects"]

    def test_search_maps_results_and_sends_the_key_in_a_header(self, api, key, net):
        net.add(API_SEARCH, page(sound(), count=40, more=True))
        res = api.get(SEARCH, {"q": "whoosh", "type": "effects", "sort": "rating", "per_page": 20})
        assert res.status_code == 200
        body = res.json()
        assert body["total"] == 40 and body["next_page"] == 2
        hit = body["results"][0]
        assert hit["id"] == "101" and hit["type"] == "effects" and hit["license"] == "CC0 1.0"
        assert hit["credit_required"] is False and hit["duration_ms"] == 1500
        assert "preview_url" not in hit and "download_url" not in hit
        call = net.calls[0]
        assert call["headers"]["Authorization"] == "Token fs-secret"
        assert "fs-secret" not in str(call["params"])
        assert call["params"]["sort"] == "rating_desc"
        assert 'category:"Sound effects"' in call["params"]["filter"]

    def test_results_with_a_licence_not_allowed_are_dropped(self, api, key, net):
        net.add(API_SEARCH, page(sound(1), sound(2, license=BY), sound(3, license=NC)))
        ids = [r["id"] for r in api.get(SEARCH).json()["results"]]
        assert ids == ["1"]

    def test_cc_by_when_allowed_needs_credit(self, api, key, settings, net):
        settings.FREESOUND_LICENSES = ["cc0", "by"]
        net.add(API_SEARCH, page(sound(2, license=BY)))
        hit = api.get(SEARCH).json()["results"][0]
        assert hit["license"] == "CC BY 4.0" and hit["credit_required"] is True

    def test_results_off_the_cdn_are_dropped(self, api, key, net):
        bad = sound(
            previews={
                "preview-lq-mp3": "https://evil.example/a.mp3",
                "preview-hq-ogg": "https://evil.example/a.ogg",
            }
        )
        net.add(API_SEARCH, page(bad))
        assert api.get(SEARCH).json()["results"] == []

    def test_searches_are_cached_and_a_stale_copy_is_served(self, api, key, net, monkeypatch):
        from django.core.cache import cache

        from apps.assets import audio_stock

        keys = []
        real = audio_stock._cache_key
        monkeypatch.setattr(audio_stock, "_cache_key", lambda options: keys.append(real(options)) or keys[-1])
        net.add(API_SEARCH, page(sound()))
        api.get(SEARCH, {"q": "rain"})
        api.get(SEARCH, {"q": "rain"})
        assert len(net.calls) == 1
        cache.delete(keys[0])  # the fresh copy expires; the stale one is kept longer
        net.add(API_SEARCH, FakeResponse(status=500))
        body = api.get(SEARCH, {"q": "rain"}).json()
        assert body["stale"] is True and body["results"][0]["id"] == "101"

    def test_provider_failure_without_cache_is_502(self, api, key, net):
        net.add(API_SEARCH, FakeResponse(status=500))
        assert api.get(SEARCH, {"q": "rain"}).status_code == 502

    def test_429_is_reported_as_busy(self, api, key, net):
        net.add(API_SEARCH, FakeResponse(status=429, headers={"Retry-After": "30"}))
        res = api.get(SEARCH, {"q": "rain"})
        assert res.status_code == 429


class TestImport:
    def test_import_stores_the_hq_ogg_with_its_credit(self, api, user, key, net):
        net.add(API_SEARCH, page(sound()))
        api.get(SEARCH)
        net.add("https://cdn.freesound.org/previews/0/101-hq.ogg", FakeResponse(body=ogg_vorbis_bytes()))
        res = api.post(IMPORT, {"id": "101"}, format="json")
        assert res.status_code == 201
        body = res.json()
        assert body["kind"] == "audio" and body["name"] == "Whoosh fast"
        assert body["credit"]["license"] == "CC0 1.0" and body["credit"]["required"] is False
        assert body["attribution"]["provider"] == "freesound"
        asset = Asset.objects.get(pk=body["id"])
        assert asset.owner == user and asset.meta["sound_id"] == "101"
        # The search answer was enough: no extra API call, and the key never went to the CDN.
        assert [c["url"] for c in net.calls] == [
            API_SEARCH,
            "https://cdn.freesound.org/previews/0/101-hq.ogg",
        ]
        assert "Authorization" not in net.calls[1]["headers"]

    def test_import_twice_returns_the_same_asset(self, api, key, net):
        net.add("https://freesound.org/apiv2/sounds/101/", FakeResponse(payload=sound()))
        net.add("https://cdn.freesound.org/previews/0/101-hq.ogg", FakeResponse(body=ogg_vorbis_bytes()))
        first = api.post(IMPORT, {"id": "101"}, format="json")
        second = api.post(IMPORT, {"id": "101"}, format="json")
        assert second.status_code == 200 and second.json()["id"] == first.json()["id"]

    def test_a_forged_id_with_a_licence_not_allowed_is_refused(self, api, key, net):
        net.add("https://freesound.org/apiv2/sounds/7/", FakeResponse(payload=sound(7, license=NC)))
        res = api.post(IMPORT, {"id": "7"}, format="json")
        assert res.status_code == 400 and Asset.objects.count() == 0

    def test_cc_by_is_refused_unless_allowed(self, api, key, net):
        net.add("https://freesound.org/apiv2/sounds/8/", FakeResponse(payload=sound(8, license=BY)))
        assert api.post(IMPORT, {"id": "8"}, format="json").status_code == 400

    def test_bad_id_and_no_key(self, api, key, settings, net):
        assert api.post(IMPORT, {"id": "../1"}, format="json").status_code == 400
        settings.FREESOUND_API_KEY = ""
        assert api.post(IMPORT, {"id": "1"}, format="json").status_code == 400
        assert net.calls == []

    def test_preview_is_relayed(self, api, key, net):
        net.add(API_SEARCH, page(sound()))
        api.get(SEARCH)
        net.add("https://cdn.freesound.org/previews/0/101-lq.mp3", FakeResponse(body=mp3_bytes()))
        res = api.get("/api/v1/stock/audio/101/preview/")
        assert res.status_code == 200 and res["Content-Type"] == "audio/mpeg"
        assert res.content == mp3_bytes()


class TestCredits:
    def test_design_credits_come_from_the_asset_and_list_only_cc_by(self, user):
        by = Asset.objects.create(
            owner=user,
            kind="audio",
            mime="audio/ogg",
            meta={
                "credit": {
                    "source": "freesound",
                    "id": "5",
                    "title": "Rainy Lo-fi",
                    "author": "jdoe",
                    "url": "https://freesound.org/people/jdoe/sounds/5/",
                    "license": "CC BY 4.0",
                    "required": True,
                }
            },
        )
        cc0 = {"source": "freesound", "id": "6", "title": "Click", "license": "CC0 1.0", "required": False}
        document = {
            "audioTracks": [
                {"kind": "music", "assetId": str(by.pk), "credit": {"title": "forged", "license": "CC0 1.0"}},
                {"kind": "sfx", "credit": cc0},
                {"kind": "music", "assetId": str(by.pk)},
                {"kind": "sfx", "assetId": "not-a-uuid"},
                "junk",
            ]
        }
        out = credits.design_credits(document, user)
        assert out["required"] is True
        assert [c["title"] for c in out["credits"]] == ["Rainy Lo-fi", "Click"]
        assert (
            out["credits_text"]
            == 'Music: "Rainy Lo-fi" by jdoe (freesound.org/people/jdoe/sounds/5), CC BY 4.0'
        )

    def test_nothing_to_credit(self, user):
        assert credits.design_credits({}, user) == {"credits": [], "required": False, "credits_text": ""}


def test_previews_have_their_own_throttle(api, key, net, monkeypatch):
    from apps.assets.throttling import StockPreviewRateThrottle, StockRateThrottle

    monkeypatch.setattr(StockRateThrottle, "THROTTLE_RATES", {"stock": "1/min"})
    monkeypatch.setattr(StockPreviewRateThrottle, "THROTTLE_RATES", {"stock_preview": "2/min"})
    net.add(API_SEARCH, page(sound()))
    assert api.get(SEARCH).status_code == 200  # the one search this minute
    net.add("https://cdn.freesound.org/previews/0/101-lq.mp3", FakeResponse(body=mp3_bytes()))
    for _ in range(2):
        assert api.get("/api/v1/stock/audio/101/preview/").status_code == 200
    assert api.get("/api/v1/stock/audio/101/preview/").status_code == 429
