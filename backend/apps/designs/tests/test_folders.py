import uuid

import pytest
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.designs import folders
from apps.designs.models import Design, Folder

from .helpers import make_design

URL = "/api/v1/folders/"


def detail(folder_id) -> str:
    return f"{URL}{folder_id}/"


def mk(owner, name, parent=None) -> Folder:
    return Folder.objects.create(owner=owner, name=name, parent=parent)


def chain(owner, depth) -> list[Folder]:
    nodes: list[Folder] = []
    for level in range(depth):
        nodes.append(mk(owner, f"L{level + 1}", nodes[-1] if nodes else None))
    return nodes


@pytest.mark.django_db
class TestCreateAndList:
    def test_create_root_and_nested(self, api, user):
        root = api.post(URL, {"name": "Clients"}, format="json")
        assert root.status_code == 201
        body = root.json()
        assert set(body) == {"id", "name", "parent", "design_count", "created_at"}
        assert body["parent"] is None and body["design_count"] == 0
        child = api.post(URL, {"name": "Acme", "parent": body["id"]}, format="json").json()
        assert child["parent"] == body["id"]
        assert Folder.objects.get(pk=child["id"]).owner == user

    def test_list_is_scoped_ordered_and_paginated(self, api, user, other):
        mk(user, "banana"), mk(user, "Apple")
        mk(other, "theirs")
        body = api.get(URL).json()
        assert [f["name"] for f in body["results"]] == ["Apple", "banana"]
        assert set(body) == {"count", "next", "previous", "results"} and body["count"] == 2

    def test_list_can_be_filtered_by_parent(self, api, user):
        parent = mk(user, "P")
        mk(user, "child", parent)
        assert [f["name"] for f in api.get(URL, {"parent": str(parent.pk)}).json()["results"]] == ["child"]
        assert [f["name"] for f in api.get(URL, {"parent": "root"}).json()["results"]] == ["P"]
        assert api.get(URL, {"parent": "nope"}).status_code == 400

    def test_design_count_ignores_trashed_designs(self, api, user):
        folder = mk(user, "F")
        make_design(user, folder=folder), make_design(user, folder=folder)
        make_design(user, folder=folder, trashed_at=timezone.now())
        assert api.get(URL).json()["results"][0]["design_count"] == 2
        assert api.get(detail(folder.pk)).json()["design_count"] == 2

    def test_list_query_count(self, api, user, django_assert_max_num_queries):
        for i in range(10):
            make_design(user, folder=mk(user, f"f{i}"))
        with django_assert_max_num_queries(2):
            assert api.get(URL).json()["count"] == 10

    @pytest.mark.parametrize("name", ["", "   ", "‮\x07", "x" * 121])
    def test_name_validation(self, api, name):
        res = api.post(URL, {"name": name}, format="json")
        assert res.status_code == 400 and "name" in res.json()["error"]["fields"]

    def test_name_is_required_and_cleaned(self, api):
        assert api.post(URL, {}, format="json").status_code == 400
        assert api.post(URL, {"name": "  My   Stuff\x07 "}, format="json").json()["name"] == "My Stuff"

    def test_parent_must_be_owned(self, api, other):
        theirs = mk(other, "Theirs")
        res = api.post(URL, {"name": "x", "parent": str(theirs.pk)}, format="json")
        assert res.status_code == 400 and "parent" in res.json()["error"]["fields"]

    def test_folder_limit(self, api, user, monkeypatch):
        monkeypatch.setattr(folders, "MAX_FOLDERS_PER_USER", 2)
        mk(user, "a"), mk(user, "b")
        res = api.post(URL, {"name": "c"}, format="json")
        assert res.status_code == 409 and res.json()["error"]["code"] == "limit_reached"

    def test_requires_authentication(self, db):
        from rest_framework.test import APIClient

        assert APIClient().get(URL).status_code == 401


@pytest.mark.django_db
class TestNames:
    def test_duplicate_names_are_rejected_case_insensitively_within_a_parent(self, api, user):
        mk(user, "Invoices")
        res = api.post(URL, {"name": "INVOICES"}, format="json")
        assert res.status_code == 400 and "name" in res.json()["error"]["fields"]
        parent = mk(user, "P")
        mk(user, "Sub", parent)
        assert api.post(URL, {"name": "sub", "parent": str(parent.pk)}, format="json").status_code == 400

    def test_same_name_in_different_parents_or_for_different_users_is_fine(self, api, user, other):
        a, b = mk(user, "A"), mk(user, "B")
        mk(user, "Shared", a)
        assert api.post(URL, {"name": "Shared", "parent": str(b.pk)}, format="json").status_code == 201
        assert api.post(URL, {"name": "Shared"}, format="json").status_code == 201
        mk(other, "Clients")
        assert api.post(URL, {"name": "Clients"}, format="json").status_code == 201

    def test_rename_conflicts(self, api, user):
        mk(user, "Taken")
        target = mk(user, "Other")
        assert api.patch(detail(target.pk), {"name": "taken"}, format="json").status_code == 400
        assert api.patch(detail(target.pk), {"name": "OTHER"}, format="json").status_code == 200

    def test_database_constraints_back_up_the_checks(self, user):
        mk(user, "Dup")
        parent = mk(user, "P")
        mk(user, "Dup2", parent)
        with pytest.raises(IntegrityError), transaction.atomic():
            Folder.objects.create(owner=user, name="dup")
        with pytest.raises(IntegrityError), transaction.atomic():
            Folder.objects.create(owner=user, name="DUP2", parent=parent)


@pytest.mark.django_db
class TestDepthAndCycles:
    def test_five_levels_are_allowed_a_sixth_is_not(self, api, user):
        nodes = chain(user, 5)
        res = api.post(URL, {"name": "too deep", "parent": str(nodes[-1].pk)}, format="json")
        assert res.status_code == 400 and "parent" in res.json()["error"]["fields"]
        assert api.post(URL, {"name": "ok", "parent": str(nodes[-2].pk)}, format="json").status_code == 201

    def test_moving_a_subtree_checks_its_height(self, api, user):
        deep = chain(user, 4)
        other_root = mk(user, "Other root")
        leaf = mk(user, "leaf under other", other_root)
        too_deep = api.patch(detail(deep[0].pk), {"parent": str(leaf.pk)}, format="json")
        assert too_deep.status_code == 400 and "parent" in too_deep.json()["error"]["fields"]
        assert api.patch(detail(deep[0].pk), {"parent": str(other_root.pk)}, format="json").status_code == 200
        pair = chain_with_prefix(user, "S", 2)
        assert api.patch(detail(pair[0].pk), {"parent": str(deep[2].pk)}, format="json").status_code == 400
        assert api.patch(detail(pair[1].pk), {"parent": str(deep[2].pk)}, format="json").status_code == 200

    def test_a_folder_cannot_become_its_own_parent(self, api, user):
        folder = mk(user, "F")
        res = api.patch(detail(folder.pk), {"parent": str(folder.pk)}, format="json")
        assert res.status_code == 400 and "parent" in res.json()["error"]["fields"]

    def test_a_folder_cannot_move_into_its_descendant(self, api, user):
        a, b, c = chain(user, 3)
        res = api.patch(detail(a.pk), {"parent": str(c.pk)}, format="json")
        assert res.status_code == 400
        assert Folder.objects.get(pk=a.pk).parent is None and Folder.objects.get(pk=c.pk).parent == b

    def test_moving_up_and_to_the_top_level(self, api, user):
        a, _, c = chain(user, 3)
        assert api.patch(detail(c.pk), {"parent": str(a.pk)}, format="json").json()["parent"] == str(a.pk)
        assert api.patch(detail(c.pk), {"parent": None}, format="json").json()["parent"] is None

    def test_move_into_other_users_folder_refused(self, api, user, other):
        folder, theirs = mk(user, "F"), mk(other, "T")
        assert api.patch(detail(folder.pk), {"parent": str(theirs.pk)}, format="json").status_code == 400

    def test_move_that_collides_by_name_is_refused(self, api, user):
        parent = mk(user, "P")
        mk(user, "Same", parent)
        loose = mk(user, "same")
        assert api.patch(detail(loose.pk), {"parent": str(parent.pk)}, format="json").status_code == 400


def chain_with_prefix(owner, prefix, depth) -> list[Folder]:
    nodes: list[Folder] = []
    for level in range(depth):
        nodes.append(mk(owner, f"{prefix}{level + 1}", nodes[-1] if nodes else None))
    return nodes


@pytest.mark.django_db
class TestDelete:
    def test_designs_and_subfolders_move_to_the_parent(self, api, user):
        top = mk(user, "Top")
        middle = mk(user, "Middle", top)
        child = mk(user, "Child", middle)
        design = make_design(user, folder=middle)
        trashed = make_design(user, folder=middle, trashed_at=timezone.now())
        assert api.delete(detail(middle.pk)).status_code == 204
        assert not Folder.objects.filter(pk=middle.pk).exists()
        assert Folder.objects.get(pk=child.pk).parent == top
        assert Design.objects.get(pk=design.pk).folder == top
        assert Design.objects.get(pk=trashed.pk).folder == top

    def test_deleting_a_top_level_folder_moves_content_to_the_top(self, api, user):
        folder = mk(user, "F")
        child = mk(user, "C", folder)
        design = make_design(user, folder=folder)
        api.delete(detail(folder.pk))
        assert Folder.objects.get(pk=child.pk).parent is None
        assert Design.objects.get(pk=design.pk).folder is None
        assert Design.objects.filter(pk=design.pk).exists()

    def test_name_clashes_after_reparenting_are_resolved_by_renaming(self, api, user):
        top = mk(user, "Top")
        mk(user, "Reports", top)
        middle = mk(user, "Middle", top)
        moved = mk(user, "reports", middle)
        also = mk(user, "Reports (2)", middle)
        assert api.delete(detail(middle.pk)).status_code == 204
        names = sorted(Folder.objects.filter(parent=top).values_list("name", flat=True))
        assert len(names) == 3 and "Reports" in names and len({n.lower() for n in names}) == 3
        assert Folder.objects.get(pk=moved.pk).parent == top and Folder.objects.get(pk=also.pk).parent == top

    def test_other_users_folder_is_untouched(self, api, other_api, user):
        folder = mk(user, "Mine")
        assert other_api.delete(detail(folder.pk)).status_code == 404
        assert Folder.objects.filter(pk=folder.pk).exists()

    def test_deleting_does_not_delete_designs_of_other_folders(self, api, user):
        keep, drop = mk(user, "Keep"), mk(user, "Drop")
        design = make_design(user, folder=keep)
        api.delete(detail(drop.pk))
        assert Design.objects.get(pk=design.pk).folder == keep


@pytest.mark.django_db
class TestAuthorization:
    def test_other_users_folder_is_404_everywhere(self, api, other_api, user):
        folder = mk(user, "Mine")
        assert other_api.get(detail(folder.pk)).status_code == 404
        assert other_api.patch(detail(folder.pk), {"name": "Hijack"}, format="json").status_code == 404
        assert Folder.objects.get(pk=folder.pk).name == "Mine"

    def test_unknown_and_malformed_ids(self, api):
        assert api.get(detail(uuid.uuid4())).status_code == 404
        assert api.get(f"{URL}nope/").status_code == 404

    def test_mass_assignment_is_ignored(self, api, user, other):
        folder = mk(user, "F")
        api.patch(detail(folder.pk), {"name": "G", "owner": str(other.pk), "design_count": 99}, format="json")
        assert Folder.objects.get(pk=folder.pk).owner == user

    def test_put_is_not_allowed(self, api, user):
        assert api.put(detail(mk(user, "F").pk), {"name": "x"}, format="json").status_code == 405
