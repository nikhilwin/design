from contextlib import contextmanager
from importlib import import_module
from unittest import mock

import pytest
from django.apps import apps as django_apps
from django.db import DatabaseError

from apps.elements.models import Element

from .factories import make_element, make_pack

migration = import_module("apps.elements.migrations.0002_catalog_content")
pytestmark = pytest.mark.django_db


def test_the_backfill_fills_search_columns_of_elements_that_predate_them():
    pack = make_pack()
    make_element(pack, name="Piñata Party", tags=["Fiesta", "FUN"])
    Element.objects.update(search_name="", search_tags="")

    migration.backfill_search_columns(django_apps, None)

    element = Element.objects.get()
    assert (element.search_name, element.search_tags) == ("pinata party", " fiesta fun ")


def test_the_backfill_copes_with_untagged_elements_and_many_rows():
    pack = make_pack()
    for index in range(3):
        make_element(pack, name=f"Plain {index}", tags=[])
    Element.objects.update(search_name="", search_tags="x")

    migration.backfill_search_columns(django_apps, None)

    assert set(Element.objects.values_list("search_tags", flat=True)) == {""}
    assert Element.objects.filter(search_name__startswith="plain").count() == 3


class FakeConnection:
    def __init__(self, vendor, fail_extension=False):
        self.vendor, self.alias, self.fail_extension = vendor, "default", fail_extension
        self.statements: list[str] = []

    @contextmanager
    def cursor(self):
        connection = self

        class Cursor:
            def execute(self, sql):
                if connection.fail_extension and "CREATE EXTENSION" in sql:
                    raise DatabaseError("permission denied to create extension")
                connection.statements.append(sql)

        yield Cursor()


class FakeSchemaEditor:
    def __init__(self, connection):
        self.connection = connection

    def quote_name(self, name):
        return f'"{name}"'


@pytest.fixture(autouse=True)
def _no_real_savepoints():
    with mock.patch.object(migration.transaction, "atomic", lambda **kw: _noop()):
        yield


@contextmanager
def _noop():
    yield


def test_trigram_indexes_are_only_created_on_postgresql():
    sqlite = FakeConnection("sqlite")
    migration.add_trigram_indexes(None, FakeSchemaEditor(sqlite))
    assert sqlite.statements == []

    postgres = FakeConnection("postgresql")
    migration.add_trigram_indexes(None, FakeSchemaEditor(postgres))
    assert postgres.statements[0] == "CREATE EXTENSION IF NOT EXISTS pg_trgm"
    assert len(postgres.statements) == 3 and all("gin_trgm_ops" in s for s in postgres.statements[1:])
    assert {"search_name", "search_tags"} == {s.split('"')[3] for s in postgres.statements[1:]}


def test_a_database_that_refuses_the_extension_still_migrates_without_indexes():
    postgres = FakeConnection("postgresql", fail_extension=True)
    migration.add_trigram_indexes(None, FakeSchemaEditor(postgres))
    assert postgres.statements == []


def test_the_trigram_indexes_can_be_dropped_again():
    postgres = FakeConnection("postgresql")
    migration.drop_trigram_indexes(None, FakeSchemaEditor(postgres))
    assert [s.split('"')[1] for s in postgres.statements] == [
        "elements_el_search_name_trgm",
        "elements_el_search_tags_trgm",
    ]
    sqlite = FakeConnection("sqlite")
    migration.drop_trigram_indexes(None, FakeSchemaEditor(sqlite))
    assert sqlite.statements == []
