import pytest
from django.core.files.storage import default_storage

from apps.elements.bulk import ImportEntry
from apps.elements.models import Element

from .factories import CURRENT_COLOR, EVIL, RED_SQUARE, make_pack

pytestmark = pytest.mark.django_db


def entry(key="box", svg=RED_SQUARE, **kwargs):
    kwargs.setdefault("name", key.title())
    return ImportEntry(key=key, svg=svg.encode() if isinstance(svg, str) else svg, **kwargs)


def stored_files(pack):
    return sorted(default_storage.listdir(f"elements/{pack.slug}")[1]) if pack.elements.exists() else []


def stored(element: Element) -> str:
    with element.svg.open("rb") as handle:
        return handle.read().decode()


def test_bulk_create_stays_disabled_because_it_would_skip_the_sanitiser():
    with pytest.raises(NotImplementedError, match="bulk_import"):
        Element.objects.bulk_create([])


def test_creates_elements_with_derived_metadata():
    pack = make_pack("icons", kind="icon")

    summary = Element.objects.bulk_import(
        pack, [entry("home", name="Home", style="outline", tags=["House", "Building"], sort_order=3)]
    )

    assert (summary.created, summary.updated, summary.unchanged, summary.skipped) == (1, 0, 0, [])
    element = Element.objects.get()
    assert (element.name, element.key, element.kind, element.style, element.sort_order) == (
        "Home",
        "home",
        "icon",
        "outline",
        3,
    )
    assert element.tags == ["house", "building"]
    assert (element.search_name, element.search_tags) == ("home", " house building ")
    assert (element.width, element.height, element.colors, element.is_recolorable) == (
        40,
        20,
        ["#e11d48"],
        True,
    )
    assert len(element.content_hash) == 64
    assert element.svg.name.startswith("elements/icons/") and element.svg.name.endswith(".svg")


def test_kind_defaults_to_the_pack_and_can_be_overridden():
    pack = make_pack("mixed", kind="sticker")
    Element.objects.bulk_import(pack, [entry("a"), entry("b", kind="icon")])
    assert dict(Element.objects.values_list("key", "kind")) == {"a": "sticker", "b": "icon"}


def test_every_svg_is_sanitised_before_it_is_stored():
    pack = make_pack()
    Element.objects.bulk_import(pack, [entry("evil", svg=EVIL)])

    text = stored(Element.objects.get())
    for forbidden in ("script", "foreignObject", "onload", "onclick", "javascript", "evil.example"):
        assert forbidden not in text
    assert "<rect" in text


def test_unusable_svgs_and_bad_entries_are_skipped_with_a_reason_and_the_rest_imported():
    pack = make_pack()
    entries = [
        entry("ok"),
        entry("empty", svg=b""),
        entry("junk", svg=b"not xml"),
        entry("", svg=RED_SQUARE),
        entry("noname", name="  "),
        entry("badkind", kind="banana"),
        entry("badstyle", style="neon"),
        entry("x" * 300),
    ]

    summary = Element.objects.bulk_import(pack, entries)

    assert summary.created == 1 and Element.objects.get().key == "ok"
    assert {key for key, _ in summary.skipped} == {
        "empty",
        "junk",
        "",
        "noname",
        "badkind",
        "badstyle",
        "x" * 300,
    }
    assert all(reason for _, reason in summary.skipped)


def test_duplicate_keys_in_one_import_keep_the_first():
    pack = make_pack()
    summary = Element.objects.bulk_import(pack, [entry("a", name="First"), entry("a", name="Second")])
    assert summary.created == 1 and summary.skipped == [("a", "duplicate key")]
    assert Element.objects.get().name == "First"


def test_a_repeat_import_changes_nothing_and_writes_no_files():
    pack = make_pack()
    entries = [entry(f"e{i}", tags=["x"]) for i in range(5)]
    Element.objects.bulk_import(pack, entries)
    before = (stored_files(pack), list(Element.objects.order_by("key").values_list("id", "updated_at")))

    summary = Element.objects.bulk_import(pack, entries)

    assert (summary.created, summary.updated, summary.unchanged) == (0, 0, 5)
    assert (
        stored_files(pack),
        list(Element.objects.order_by("key").values_list("id", "updated_at")),
    ) == before


def test_changed_artwork_replaces_the_file_and_removes_the_old_one():
    pack = make_pack()
    Element.objects.bulk_import(pack, [entry("a")])
    old = Element.objects.get().svg.name

    summary = Element.objects.bulk_import(pack, [entry("a", svg=CURRENT_COLOR)])

    element = Element.objects.get()
    assert (summary.created, summary.updated, summary.unchanged) == (0, 1, 0)
    assert element.is_recolorable is False and (element.width, element.height) == (24, 24)
    assert not default_storage.exists(old) or element.svg.name == old
    assert default_storage.exists(element.svg.name) and "currentColor" in stored(element)
    assert len(stored_files(pack)) == 1


def test_changed_metadata_alone_updates_the_row_but_keeps_the_file():
    pack = make_pack()
    Element.objects.bulk_import(pack, [entry("a", name="Old", tags=["x"])])
    before = Element.objects.get()

    summary = Element.objects.bulk_import(pack, [entry("a", name="New", tags=["y"], style="filled")])

    after = Element.objects.get()
    assert summary.updated == 1
    assert (after.name, after.tags, after.style, after.search_name, after.search_tags) == (
        "New",
        ["y"],
        "filled",
        "new",
        " y ",
    )
    assert after.svg.name == before.svg.name and after.id == before.id


def test_the_importer_keeps_staff_publication_choices():
    pack = make_pack()
    Element.objects.bulk_import(pack, [entry("a")])
    Element.objects.update(is_published=False)

    Element.objects.bulk_import(pack, [entry("a", name="Renamed")])

    element = Element.objects.get()
    assert element.name == "Renamed" and element.is_published is False


def test_elements_are_scoped_to_their_pack():
    one, two = make_pack("one"), make_pack("two")
    Element.objects.bulk_import(one, [entry("same")])
    Element.objects.bulk_import(two, [entry("same")])
    assert Element.objects.count() == 2


def test_dry_run_reports_the_counts_and_writes_nothing():
    pack = make_pack()
    Element.objects.bulk_import(pack, [entry("keep"), entry("change")])
    files = stored_files(pack)

    summary = Element.objects.bulk_import(
        pack,
        [entry("keep"), entry("change", svg=CURRENT_COLOR), entry("new"), entry("bad", svg=b"x")],
        dry_run=True,
    )

    assert (summary.created, summary.updated, summary.unchanged, len(summary.skipped)) == (1, 1, 1, 1)
    assert Element.objects.count() == 2 and stored_files(pack) == files


def test_batches_commit_independently_so_an_interrupted_import_can_resume(monkeypatch):
    pack = make_pack()
    entries = [entry(f"e{i:02d}") for i in range(10)]
    from apps.elements import bulk

    real = bulk._write_files
    calls = []

    def flaky(plan, workers, written):
        calls.append(1)
        if len(calls) == 3:
            raise OSError("disk full")
        return real(plan, workers, written)

    monkeypatch.setattr(bulk, "_write_files", flaky)
    with pytest.raises(OSError, match="disk full"):
        Element.objects.bulk_import(pack, entries, batch_size=3)
    assert Element.objects.count() == 6 and len(stored_files(pack)) == 6

    monkeypatch.setattr(bulk, "_write_files", real)
    summary = Element.objects.bulk_import(pack, entries, batch_size=3)
    assert (summary.created, summary.unchanged) == (4, 6)
    assert Element.objects.count() == 10 and len(stored_files(pack)) == 10


def test_a_failing_database_write_leaves_no_orphan_files(monkeypatch):
    pack = make_pack()

    def boom(*args, **kwargs):
        raise RuntimeError("database went away")

    monkeypatch.setattr("apps.elements.bulk.models.QuerySet.bulk_create", boom)
    with pytest.raises(RuntimeError):
        Element.objects.bulk_import(pack, [entry("a"), entry("b")], workers=2)

    assert not Element.objects.exists() and stored_files(pack) == []


def test_files_can_be_written_by_several_threads():
    pack = make_pack()
    entries = [entry(f"e{i}", svg=RED_SQUARE.replace('width="40"', f'width="{40 + i}"')) for i in range(30)]
    summary = Element.objects.bulk_import(pack, entries, workers=4, batch_size=12)
    assert summary.created == 30 and len(stored_files(pack)) == 30
    assert {e.width for e in Element.objects.all()} == {40 + i for i in range(30)}


def test_progress_is_reported_after_every_batch():
    pack = make_pack()
    seen = []
    Element.objects.bulk_import(
        pack, [entry(f"e{i}") for i in range(7)], batch_size=3, progress=lambda s: seen.append(s.created)
    )
    assert seen == [3, 6, 7]


def test_names_with_surrounding_spaces_do_not_count_as_changes_on_every_run():
    pack = make_pack()
    entries = [entry("a", name="  Padded Name  ")]
    Element.objects.bulk_import(pack, entries)

    summary = Element.objects.bulk_import(pack, entries)

    assert (summary.updated, summary.unchanged) == (0, 1) and Element.objects.get().name == "Padded Name"


def test_a_storage_that_overwrites_in_place_keeps_the_new_file(monkeypatch, settings):
    from django.core.files.storage import FileSystemStorage

    class OverwritingStorage(FileSystemStorage):
        def get_available_name(self, name, max_length=None):
            self.delete(name)
            return name

    field = Element._meta.get_field("svg")
    monkeypatch.setattr(field, "storage", OverwritingStorage(location=settings.MEDIA_ROOT))
    pack = make_pack()
    Element.objects.bulk_import(pack, [entry("a")])
    name = Element.objects.get().svg.name

    summary = Element.objects.bulk_import(pack, [entry("a", svg=CURRENT_COLOR)])

    element = Element.objects.get()
    assert summary.updated == 1 and element.svg.name == name
    assert "currentColor" in stored(element)
