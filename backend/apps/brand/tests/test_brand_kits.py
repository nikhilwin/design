import uuid

import pytest
from django.db import IntegrityError, transaction
from django.test import Client

from apps.accounts.models import User
from apps.assets.models import Asset
from apps.assets.tests.helpers import image_bytes, upload
from apps.brand import serializers as brand_serializers
from apps.brand.models import BrandKit

URL = "/api/v1/brand-kits/"


def detail(kit_id) -> str:
    return f"{URL}{kit_id}/"


def color(i=1, hex_="#ff0000", name="Brand red"):
    return {"id": f"c{i}", "name": name, "hex": hex_}


def upload_asset(api, name="logo.png") -> dict:
    res = api.post("/api/v1/assets/", {"file": upload(image_bytes(), name)}, format="multipart")
    assert res.status_code == 201
    return res.json()


def make_kit(api, **overrides) -> dict:
    res = api.post(URL, {"name": "Acme", **overrides}, format="json")
    assert res.status_code == 201, res.content
    return res.json()


@pytest.mark.django_db
class TestCreate:
    def test_minimal_kit(self, api, user):
        res = api.post(URL, {"name": "  Acme  "}, format="json")
        assert res.status_code == 201
        body = res.json()
        assert set(body) == {
            "id",
            "name",
            "is_default",
            "colors",
            "fonts",
            "logos",
            "created_at",
            "updated_at",
        }
        assert (body["name"], body["is_default"], body["colors"], body["fonts"], body["logos"]) == (
            "Acme", False, [], [], [],
        )  # fmt: skip
        assert BrandKit.objects.get(pk=body["id"]).owner == user

    def test_full_kit_round_trips(self, api):
        asset = upload_asset(api)
        payload = {
            "name": "Acme",
            "is_default": True,
            "colors": [color(1, "#E63946", "Red"), color(2, "#fff", "White")],
            "fonts": [{"role": "heading", "family": "Poppins"}, {"role": "body", "family": "Inter"}],
            "logo_ids": [asset["id"]],
        }
        body = api.post(URL, payload, format="json").json()
        assert body["colors"] == [color(1, "#e63946", "Red"), color(2, "#fff", "White")]
        assert body["fonts"] == payload["fonts"] and body["is_default"] is True
        assert [logo["id"] for logo in body["logos"]] == [asset["id"]]
        assert set(body["logos"][0]) == set(asset)
        assert "logo_ids" not in body
        assert api.get(detail(body["id"])).json() == body

    def test_name_is_required_and_validated(self, api):
        for payload in ({}, {"name": ""}, {"name": "   "}, {"name": "x" * 81}, {"name": "‮\x07"}):
            res = api.post(URL, payload, format="json")
            assert res.status_code == 400 and "name" in res.json()["error"]["fields"]

    def test_mass_assignment_is_ignored(self, api, user, other):
        body = make_kit(api, owner=str(other.pk), id=str(uuid.uuid4()), created_at="2000-01-01T00:00:00Z")
        kit = BrandKit.objects.get(pk=body["id"])
        assert kit.owner == user and kit.created_at.year >= 2024

    def test_limit_of_twenty_kits(self, api, user):
        for i in range(20):
            BrandKit.objects.create(owner=user, name=f"k{i}")
        res = api.post(URL, {"name": "one too many"}, format="json")
        assert res.status_code == 409 and res.json()["error"]["code"] == "limit_reached"

    def test_limit_is_per_user(self, api, other):
        for i in range(20):
            BrandKit.objects.create(owner=other, name=f"k{i}")
        assert api.post(URL, {"name": "mine"}, format="json").status_code == 201

    def test_requires_authentication(self, db):
        from rest_framework.test import APIClient

        assert APIClient().post(URL, {"name": "x"}, format="json").status_code == 401


@pytest.mark.django_db
class TestColors:
    @pytest.mark.parametrize("hex_", ["#fff", "#FFF", "#a1b2c3", "#A1B2C3", "#000000"])
    def test_valid_hex(self, api, hex_):
        body = make_kit(api, colors=[color(1, hex_)])
        assert body["colors"][0]["hex"] == hex_.lower()

    @pytest.mark.parametrize(
        "hex_",
        [
            "red",
            "ff0000",
            "#ff",
            "#ffff",
            "#fffff",
            "#fffffff",
            "#ff0000ff",
            "#GGGGGG",
            "#ff 000",
            "#ff0000\n",
            "rgb(1,2,3)",
            "",
            "#",
        ],
    )
    def test_invalid_hex(self, api, hex_):
        res = api.post(URL, {"name": "x", "colors": [color(1, hex_)]}, format="json")
        assert res.status_code == 400 and "colors" in res.json()["error"]["fields"]

    @pytest.mark.parametrize(
        "colors",
        [
            "red",
            {"id": "a", "hex": "#fff"},
            [{"name": "no id", "hex": "#fff"}],
            [{"id": "a", "name": "n"}],
            [{"id": "has space", "name": "n", "hex": "#fff"}],
            [{"id": "a", "name": "x" * 41, "hex": "#fff"}],
            [{"id": "a" * 65, "name": "n", "hex": "#fff"}],
            [None],
            ["#fff"],
        ],
    )
    def test_invalid_shapes(self, api, colors):
        assert api.post(URL, {"name": "x", "colors": colors}, format="json").status_code == 400

    def test_duplicate_color_ids_rejected(self, api):
        res = api.post(URL, {"name": "x", "colors": [color(1), color(1, "#00ff00")]}, format="json")
        assert res.status_code == 400

    def test_color_limit(self, api):
        hundred = [color(i) for i in range(100)]
        assert api.post(URL, {"name": "x", "colors": hundred}, format="json").status_code == 201
        assert (
            api.post(URL, {"name": "x", "colors": [*hundred, color(100)]}, format="json").status_code == 400
        )

    def test_name_is_optional_and_unknown_keys_are_dropped(self, api):
        res = api.post(
            URL, {"name": "x", "colors": [{"id": "a", "hex": "#fff", "evil": "<script>"}]}, format="json"
        )
        assert res.json()["colors"] == [{"id": "a", "name": "", "hex": "#fff"}]
        assert "evil" not in str(BrandKit.objects.get(pk=res.json()["id"]).colors)


@pytest.mark.django_db
class TestFonts:
    def test_roles_must_be_known_and_unique(self, api):
        assert (
            api.post(
                URL, {"name": "x", "fonts": [{"role": "title", "family": "A"}]}, format="json"
            ).status_code
            == 400
        )
        dup = [{"role": "body", "family": "A"}, {"role": "body", "family": "B"}]
        assert api.post(URL, {"name": "x", "fonts": dup}, format="json").status_code == 400

    @pytest.mark.parametrize("family", ["", "   ", "x" * 101, "\x07"])
    def test_family_validation(self, api, family):
        res = api.post(URL, {"name": "x", "fonts": [{"role": "body", "family": family}]}, format="json")
        assert res.status_code == 400

    def test_all_three_roles(self, api):
        fonts = [{"role": r, "family": f"F{i}"} for i, r in enumerate(("heading", "subheading", "body"))]
        assert api.post(URL, {"name": "x", "fonts": fonts}, format="json").json()["fonts"] == fonts

    def test_family_is_trimmed(self, api):
        body = api.post(
            URL, {"name": "x", "fonts": [{"role": "body", "family": "  Open   Sans "}]}, format="json"
        ).json()
        assert body["fonts"][0]["family"] == "Open Sans"


@pytest.mark.django_db
class TestLogos:
    def test_logos_must_be_the_users_own_assets(self, api, other_api):
        theirs = upload_asset(other_api)
        res = api.post(URL, {"name": "x", "logo_ids": [theirs["id"]]}, format="json")
        assert res.status_code == 400 and "logo_ids" in res.json()["error"]["fields"]
        assert BrandKit.objects.count() == 0

    def test_unknown_logo_id_is_rejected(self, api):
        assert api.post(URL, {"name": "x", "logo_ids": [str(uuid.uuid4())]}, format="json").status_code == 400
        assert api.post(URL, {"name": "x", "logo_ids": ["nope"]}, format="json").status_code == 400

    def test_mixed_own_and_foreign_logos_attach_nothing(self, api, other_api):
        mine, theirs = upload_asset(api), upload_asset(other_api)
        res = api.post(URL, {"name": "x", "logo_ids": [mine["id"], theirs["id"]]}, format="json")
        assert res.status_code == 400 and BrandKit.objects.count() == 0

    def test_duplicate_logo_ids_collapse(self, api):
        asset = upload_asset(api)
        body = make_kit(api, logo_ids=[asset["id"], asset["id"]])
        assert len(body["logos"]) == 1

    def test_logo_limit(self, api, user, monkeypatch):
        monkeypatch.setattr(brand_serializers, "MAX_LOGOS", 2)
        ids = [str(uuid.uuid4()) for _ in range(21)]
        res = api.post(URL, {"name": "x", "logo_ids": ids}, format="json")
        assert res.status_code == 400

    def test_twenty_logos_allowed(self, api):
        ids = [upload_asset(api, f"{i}.png")["id"] for i in range(20)]
        assert len(make_kit(api, logo_ids=ids)["logos"]) == 20

    def test_replace_clear_and_keep_logos_on_patch(self, api):
        a, b = upload_asset(api, "a.png"), upload_asset(api, "b.png")
        kit = make_kit(api, logo_ids=[a["id"]])
        replaced = api.patch(detail(kit["id"]), {"logo_ids": [b["id"]]}, format="json").json()
        assert [logo["id"] for logo in replaced["logos"]] == [b["id"]]
        renamed = api.patch(detail(kit["id"]), {"name": "Renamed"}, format="json").json()
        assert [logo["id"] for logo in renamed["logos"]] == [b["id"]]
        cleared = api.patch(detail(kit["id"]), {"logo_ids": []}, format="json").json()
        assert cleared["logos"] == []

    def test_deleting_an_asset_removes_it_from_kits(self, api):
        asset = upload_asset(api)
        kit = make_kit(api, logo_ids=[asset["id"]])
        api.delete(f"/api/v1/assets/{asset['id']}/")
        assert api.get(detail(kit["id"])).json()["logos"] == []
        assert not Asset.objects.filter(pk=asset["id"]).exists()

    def test_logos_are_listed_oldest_first(self, api):
        first, second = upload_asset(api, "1.png"), upload_asset(api, "2.png")
        kit = make_kit(api, logo_ids=[second["id"], first["id"]])
        assert [logo["id"] for logo in kit["logos"]] == [first["id"], second["id"]]

    def test_patch_cannot_attach_foreign_logo(self, api, other_api):
        theirs = upload_asset(other_api)
        kit = make_kit(api)
        assert api.patch(detail(kit["id"]), {"logo_ids": [theirs["id"]]}, format="json").status_code == 400
        assert api.get(detail(kit["id"])).json()["logos"] == []


@pytest.mark.django_db
class TestDefaultKit:
    def test_setting_a_default_clears_the_previous_one(self, api, user):
        first = make_kit(api, name="A", is_default=True)
        second = make_kit(api, name="B", is_default=True)
        assert second["is_default"] is True
        assert api.get(detail(first["id"])).json()["is_default"] is False
        assert BrandKit.objects.filter(owner=user, is_default=True).count() == 1

    def test_patch_to_default_moves_the_flag(self, api, user):
        a = make_kit(api, name="A", is_default=True)
        b = make_kit(api, name="B")
        assert api.patch(detail(b["id"]), {"is_default": True}, format="json").json()["is_default"] is True
        assert api.get(detail(a["id"])).json()["is_default"] is False

    def test_unsetting_the_default_leaves_none(self, api, user):
        kit = make_kit(api, is_default=True)
        api.patch(detail(kit["id"]), {"is_default": False}, format="json")
        assert BrandKit.objects.filter(owner=user, is_default=True).count() == 0

    def test_defaults_are_per_user(self, api, other_api, other):
        make_kit(other_api, name="Theirs", is_default=True)
        make_kit(api, name="Mine", is_default=True)
        assert BrandKit.objects.filter(owner=other, is_default=True).count() == 1

    def test_database_rejects_a_second_default(self, user):
        BrandKit.objects.create(owner=user, name="A", is_default=True)
        with pytest.raises(IntegrityError), transaction.atomic():
            BrandKit.objects.create(owner=user, name="B", is_default=True)

    def test_default_kit_is_listed_first(self, api):
        make_kit(api, name="Zeta", is_default=True)
        make_kit(api, name="Alpha")
        assert [k["name"] for k in api.get(URL).json()["results"]] == ["Zeta", "Alpha"]

    def test_deleting_the_default_does_not_promote_another(self, api, user):
        default = make_kit(api, name="A", is_default=True)
        make_kit(api, name="B")
        api.delete(detail(default["id"]))
        assert BrandKit.objects.filter(owner=user, is_default=True).count() == 0


@pytest.mark.django_db
class TestListAndUpdate:
    def test_list_is_scoped_to_the_owner_and_paginated(self, api, other_api):
        make_kit(api, name="Mine")
        make_kit(other_api, name="Theirs")
        body = api.get(URL).json()
        assert set(body) == {"count", "next", "previous", "results"}
        assert [k["name"] for k in body["results"]] == ["Mine"]

    def test_list_query_count_is_constant(self, api, django_assert_max_num_queries):
        asset = upload_asset(api)
        for i in range(6):
            make_kit(api, name=f"k{i}", logo_ids=[asset["id"]], colors=[color(1)])
        with django_assert_max_num_queries(3):
            assert api.get(URL).json()["count"] == 6

    def test_patch_is_partial(self, api):
        kit = make_kit(api, colors=[color(1)], fonts=[{"role": "body", "family": "Inter"}])
        res = api.patch(detail(kit["id"]), {"name": "Renamed"}, format="json")
        assert res.status_code == 200
        body = res.json()
        assert body["name"] == "Renamed" and body["colors"] == kit["colors"] and body["fonts"] == kit["fonts"]

    def test_patch_replaces_colors(self, api):
        kit = make_kit(api, colors=[color(1)])
        body = api.patch(detail(kit["id"]), {"colors": [color(2, "#00ff00")]}, format="json").json()
        assert body["colors"] == [color(2, "#00ff00")]

    def test_patch_validation(self, api):
        kit = make_kit(api)
        assert api.patch(detail(kit["id"]), {"name": ""}, format="json").status_code == 400
        assert api.patch(detail(kit["id"]), {"colors": [color(1, "nope")]}, format="json").status_code == 400
        assert api.patch(detail(kit["id"]), {"is_default": "maybe"}, format="json").status_code == 400

    def test_patch_cannot_change_the_owner(self, api, user, other):
        kit = make_kit(api)
        api.patch(detail(kit["id"]), {"owner": str(other.pk), "name": "ok"}, format="json")
        assert BrandKit.objects.get(pk=kit["id"]).owner == user

    def test_put_is_not_allowed(self, api):
        assert api.put(detail(make_kit(api)["id"]), {"name": "x"}, format="json").status_code == 405

    def test_delete(self, api):
        kit = make_kit(api)
        assert api.delete(detail(kit["id"])).status_code == 204
        assert api.get(detail(kit["id"])).status_code == 404

    def test_updating_at_the_kit_limit_is_still_possible(self, api, user):
        for i in range(19):
            BrandKit.objects.create(owner=user, name=f"k{i}")
        kit = make_kit(api, name="twentieth")
        assert api.patch(detail(kit["id"]), {"name": "renamed"}, format="json").status_code == 200

    def test_nested_json_bomb_is_a_400(self, api):
        kit = make_kit(api)
        assert (
            api.patch(detail(kit["id"]), data="[" * 100_000, content_type="application/json").status_code
            == 400
        )


@pytest.mark.django_db
class TestAuthorization:
    def test_other_users_kits_are_404(self, api, other_api):
        kit = make_kit(api, name="Private")
        assert other_api.get(detail(kit["id"])).status_code == 404
        assert other_api.patch(detail(kit["id"]), {"name": "Hijacked"}, format="json").status_code == 404
        assert other_api.delete(detail(kit["id"])).status_code == 404
        assert BrandKit.objects.get(pk=kit["id"]).name == "Private"

    def test_unknown_and_malformed_ids(self, api):
        assert api.get(detail(uuid.uuid4())).status_code == 404
        assert api.get(f"{URL}nope/").status_code == 404

    def test_unauthenticated_requests_are_401(self, db):
        from rest_framework.test import APIClient

        client = APIClient()
        assert client.get(URL).status_code == 401
        assert client.get(detail(uuid.uuid4())).status_code == 401


@pytest.mark.django_db
class TestAdmin:
    def test_admin_pages(self, user):
        kit = BrandKit.objects.create(
            owner=user, name="Acme", colors=[color(1)], fonts=[{"role": "body", "family": "Inter"}]
        )
        admin = User.objects.create_superuser(email="root@example.com", password="correct-horse-battery-1")
        client = Client()
        client.force_login(admin)
        assert client.get("/admin/brand/brandkit/").status_code == 200
        res = client.get(f"/admin/brand/brandkit/{kit.pk}/change/")
        assert res.status_code == 200 and b"#ff0000" in res.content
        assert client.get("/admin/brand/brandkit/add/").status_code == 403
