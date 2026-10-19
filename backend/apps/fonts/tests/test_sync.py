from io import StringIO
from pathlib import Path

import pytest
from django.core.files.storage import default_storage
from django.core.management import CommandError, call_command

from apps.fonts.catalog import EDITOR_FONTS, SCRIPT_FONTS, curated_fonts
from apps.fonts.management.commands.sync_fonts import Command
from apps.fonts.models import FontFamily, FontVariant
from apps.fonts.sources import SourceError, SourceUnavailable
from apps.fonts.sync import (
    SyncOptions,
    check_woff2,
    import_font_directory,
    is_permissive_license,
    resolve_ids,
    sync_families,
)

from .fakes import WOFF2, FakeSource, meta

pytestmark = pytest.mark.django_db

OPTIONS = SyncOptions(subsets=("latin",), weights=(400, 700), styles=("normal", "italic"))


def run_sync(source, ids, options=OPTIONS):
    lines = []
    report = sync_families(source, ids, options, lines.append)
    return report, lines


def triples(family):
    return sorted(family.variants.values_list("weight", "style", "subset"))


def test_sync_downloads_the_planned_files_and_registers_the_family():
    source = FakeSource(meta("roboto", "Roboto"))

    report, lines = run_sync(source, ["roboto"])

    family = FontFamily.objects.get(slug="roboto")
    assert (family.family, family.category, family.source, family.owner) == (
        "Roboto",
        "sans-serif",
        "fontsource",
        None,
    )
    assert family.popularity == 1  # rank from the curated list
    assert family.license == "OFL-1.1" and family.is_variable is False and family.scripts == ["latin"]
    assert triples(family) == [
        (400, "italic", "latin"),
        (400, "normal", "latin"),
        (700, "italic", "latin"),
        (700, "normal", "latin"),
    ]
    variant = family.variants.get(weight=400, style="normal")
    assert variant.file.name == "fonts/system/roboto/roboto-latin-400-normal.woff2"
    assert variant.format == "woff2" and variant.size == len(WOFF2) and variant.unicode_range == "U+0000-00FF"
    with default_storage.open(variant.file.name, "rb") as handle:
        assert handle.read() == WOFF2
    assert report.downloaded == 4 and lines[0].startswith("[1/1] roboto: 4 downloaded")


def test_unknown_family_gets_the_unranked_default_and_source_category():
    run_sync(FakeSource(meta("zine-display", "Zine Display", category="display")), ["zine-display"])
    family = FontFamily.objects.get(slug="zine-display")
    assert (family.popularity, family.category) == (9999, "display")


def test_the_plan_respects_what_the_family_actually_offers():
    source = FakeSource(
        meta("thin", "Thin", weights=(100, 400), styles=("normal",), subsets=("latin", "greek"))
    )
    run_sync(source, ["thin"])
    assert sorted(source.fetched) == [("thin", "latin", 400, "normal")]


def test_the_availability_map_prevents_requests_for_missing_files():
    available = frozenset({(400, "normal", "latin"), (700, "normal", "latin")})
    source = FakeSource(meta("partial", "Partial", available=available))
    run_sync(source, ["partial"])
    assert sorted(source.fetched) == [
        ("partial", "latin", 400, "normal"),
        ("partial", "latin", 700, "normal"),
    ]


def test_files_the_source_does_not_have_are_counted_not_failed():
    source = FakeSource(meta("gap", "Gap"))
    source.missing = {("gap", "latin", 700, "italic")}
    report, lines = run_sync(source, ["gap"])
    assert report.results[0].not_offered == 1 and report.failures == [] and report.downloaded == 3
    assert "1 not offered" in lines[0]


def test_second_run_is_a_no_op():
    source = FakeSource(meta("roboto", "Roboto"))
    run_sync(source, ["roboto"])
    fetched_before = len(source.fetched)

    report, lines = run_sync(source, ["roboto"])

    assert len(source.fetched) == fetched_before
    assert (report.downloaded, report.existing) == (0, 4) and "0 downloaded, 4 already stored" in lines[0]
    assert FontVariant.objects.count() == 4 and FontFamily.objects.count() == 1


def test_a_partial_failure_is_reported_and_the_next_run_finishes_the_job():
    source = FakeSource(meta("roboto", "Roboto"))
    source.failures = {("roboto", "latin", 700, "normal"): SourceError("HTTP 503")}

    first, lines = run_sync(source, ["roboto"])

    assert first.downloaded == 3 and len(first.failures) == 1 and "1 FAILED" in lines[0]
    assert "700 normal: HTTP 503" in first.failures[0]
    assert FontVariant.objects.count() == 3

    source.failures.clear()
    source.fetched.clear()
    second, _ = run_sync(source, ["roboto"])

    assert source.fetched == [("roboto", "latin", 700, "normal")]
    assert (second.downloaded, second.existing, second.failures) == (1, 3, [])
    assert FontVariant.objects.count() == 4


def test_a_row_whose_file_vanished_is_downloaded_again():
    source = FakeSource(meta("roboto", "Roboto", styles=("normal",), weights=(400,)))
    run_sync(source, ["roboto"])
    variant = FontVariant.objects.get()
    default_storage.delete(variant.file.name)

    report, _ = run_sync(source, ["roboto"])

    assert report.downloaded == 1 and default_storage.exists(variant.file.name)
    assert FontVariant.objects.count() == 1


def test_a_family_that_fails_completely_leaves_no_empty_family():
    source = FakeSource(meta("broken", "Broken"))
    source.failures = {
        ("broken", "latin", w, s): SourceError("boom") for w in (400, 700) for s in ("normal", "italic")
    }
    report, _ = run_sync(source, ["broken"])
    assert len(report.failures) == 4 and not FontFamily.objects.exists()


@pytest.mark.parametrize("body", [b"", b"wOF2", b"<html>nope</html>" + b"x" * 200, b"OTTO" + b"\x00" * 200])
def test_downloads_that_are_not_woff2_are_rejected(body):
    source = FakeSource(meta("odd", "Odd", weights=(400,), styles=("normal",)), content=body)
    report, _ = run_sync(source, ["odd"])
    assert report.downloaded == 0 and len(report.failures) == 1 and not FontVariant.objects.exists()


def test_unknown_licences_and_non_text_fonts_are_skipped_without_downloads():
    source = FakeSource(
        meta("proprietary", "Proprietary", license="Commercial"),
        meta("unlicensed", "Unlicensed", license=""),
        meta("glyphs", "Glyphs", is_font=False),
        meta("apache-one", "Apache One", license="Apache-2.0"),
        meta("ubuntu-like", "Ubuntu Like", license="UFL-1.0"),
    )
    report, lines = run_sync(
        source, ["proprietary", "unlicensed", "glyphs", "apache-one", "ubuntu-like", "ghost"]
    )

    assert source.fetched and all(key[0] in {"apache-one", "ubuntu-like"} for key in source.fetched)
    assert sorted(FontFamily.objects.values_list("slug", flat=True)) == ["apache-one", "ubuntu-like"]
    assert dict(report.skipped)["proprietary"].startswith("licence")
    assert report.not_found == ["ghost"] and any("ghost: skipped" in line for line in lines)


@pytest.mark.parametrize(
    ("name", "ok"),
    [
        ("OFL-1.1", True),
        ("OFL", True),
        ("SIL Open Font License", True),
        ("Apache-2.0", True),
        ("UFL-1.0", True),
        ("Ubuntu Font Licence 1.0", True),
        ("MIT", False),
        ("CC-BY-4.0", False),
        ("", False),
        ("Proprietary", False),
    ],
)
def test_licence_allow_list(name, ok):
    assert is_permissive_license(name) is ok


def test_several_subsets_are_stored_and_scripts_are_ordered():
    source = FakeSource(meta("open-sans", "Open Sans", weights=(400,), styles=("normal",)))
    run_sync(
        source,
        ["open-sans"],
        SyncOptions(subsets=("cyrillic", "latin-ext", "latin"), weights=(400,), styles=("normal",)),
    )

    family = FontFamily.objects.get()
    assert family.scripts == ["latin", "latin-ext", "cyrillic"]
    assert family.variants.get(subset="cyrillic").unicode_range == "U+0400-045F"
    assert family.variants.get(subset="latin-ext").unicode_range.startswith("U+0100-02BA")  # shipped fallback


def test_scripts_grow_when_more_subsets_are_synced_later():
    source = FakeSource(meta("open-sans", "Open Sans", weights=(400,), styles=("normal",)))
    run_sync(source, ["open-sans"], SyncOptions(subsets=("latin",), weights=(400,), styles=("normal",)))
    run_sync(
        source, ["open-sans"], SyncOptions(subsets=("latin", "cyrillic"), weights=(400,), styles=("normal",))
    )
    assert FontFamily.objects.get().scripts == ["latin", "cyrillic"]
    assert FontVariant.objects.count() == 2


def test_staff_decisions_survive_a_sync():
    source = FakeSource(meta("roboto", "Roboto"))
    run_sync(source, ["roboto"])
    FontFamily.objects.update(is_published=False)
    run_sync(source, ["roboto"])
    assert FontFamily.objects.get().is_published is False


def test_downloads_run_concurrently_but_never_more_than_four_at_once():
    source = FakeSource(
        meta("wide", "Wide", weights=(100, 200, 300, 400, 500, 600, 700, 800), styles=("normal",)), delay=0.05
    )
    run_sync(
        source,
        ["wide"],
        SyncOptions(weights=(100, 200, 300, 400, 500, 600, 700, 800), styles=("normal",), concurrency=4),
    )
    assert 2 <= source.max_running <= 4
    assert FontVariant.objects.count() == 8


def test_concurrency_can_be_one():
    source = FakeSource(meta("wide", "Wide", weights=(400, 700), styles=("normal",)), delay=0.02)
    run_sync(source, ["wide"], SyncOptions(weights=(400, 700), styles=("normal",), concurrency=1))
    assert source.max_running == 1


def test_an_unreachable_source_stops_the_run_but_keeps_earlier_work():
    source = FakeSource(meta("one", "One"), meta("two", "Two"), meta("three", "Three"))
    source.unavailable_for = {"two"}

    report, lines = run_sync(source, ["one", "two", "three"])

    assert report.aborted.startswith("Cannot reach") and "three" not in source.metadata_calls
    assert sorted(FontFamily.objects.values_list("slug", flat=True)) == ["one"]
    assert "Stopping; run again to resume" in lines[-1]


def test_a_source_that_dies_mid_download_aborts_cleanly():
    source = FakeSource(meta("one", "One"))
    source.failures = {("one", "latin", 400, "normal"): SourceUnavailable("Cannot reach cdn.jsdelivr.net")}
    report, _ = run_sync(source, ["one"])
    assert report.aborted.startswith("Cannot reach")


def test_invalid_ids_are_never_looked_up():
    source = FakeSource()
    report, _ = run_sync(source, ["../etc/passwd", "Has Space", ""])
    assert source.metadata_calls == [] and len(report.not_found) == 3


def test_metadata_errors_are_recorded_per_family():
    class Flaky(FakeSource):
        def metadata(self, font_id):
            if font_id == "bad":
                raise SourceError("HTTP 500")
            return super().metadata(font_id)

    report, _ = run_sync(Flaky(meta("good", "Good")), ["bad", "good"])
    assert report.failures == ["bad: metadata: HTTP 500"] and FontFamily.objects.filter(slug="good").exists()


def test_check_woff2():
    assert check_woff2(WOFF2) is None
    assert check_woff2(b"wOF2") == "unexpected file size"
    assert check_woff2(b"x" * 100) == "not a woff2 file"
    assert check_woff2(b"wOF2" + b"\x00" * (6 * 1024 * 1024)) == "unexpected file size"


def test_resolve_ids_accepts_names_and_ids():
    assert resolve_ids(["Open Sans", "roboto", " Playfair Display ", "Some New Font"]) == [
        "open-sans",
        "roboto",
        "playfair-display",
        "some-new-font",
    ]


# ---- the management command -----------------------------------------------------------------------------


def command(source, *args, **options):
    out, err = StringIO(), StringIO()
    call_command(Command(source=source), *args, stdout=out, stderr=err, **options)
    return out.getvalue()


def catalog_source():
    return FakeSource(
        *(
            meta(i, f.title())
            for i, f in (
                ("roboto", "roboto"),
                ("open-sans", "open sans"),
                ("noto-sans", "noto sans"),
                ("lato", "lato"),
            )
        )
    )


def editor_font_ids(exclude=()):
    by_family = {font.family: font.id for font in curated_fonts()}
    return [by_family[name] for name in (*EDITOR_FONTS, *SCRIPT_FONTS) if by_family[name] not in exclude]


def test_command_popular_n_uses_the_curated_list_without_listing_the_source():
    source = catalog_source()
    out = command(source, popular=3)
    top = ["roboto", "open-sans", "noto-sans"]
    assert source.metadata_calls[:3] == top
    total = 3 + len(editor_font_ids(exclude=top))
    assert f"Syncing {total} families" in out
    # Of the extra fonts the fake source only has Lato. Every family offers latin, latin-ext and cyrillic, and
    # `auto` (the default) takes all three: 4 families x 3 subsets x 2 weights x 2 styles.
    assert "Done: 48 files downloaded" in out


def test_command_popular_n_always_brings_the_fonts_the_editor_uses_by_default():
    source = catalog_source()
    command(source, popular=1)
    by_family = {font.family: font for font in curated_fonts()}
    assert by_family["Plus Jakarta Sans"].popularity > 100, (
        "the default heading font ranks below the Docker cut"
    )
    assert source.metadata_calls == ["roboto", *editor_font_ids(exclude=["roboto"])]
    assert "plus-jakarta-sans" in source.metadata_calls


def test_command_named_families_accept_names_and_ids():
    source = catalog_source()
    command(source, "Open Sans", "lato", subsets="latin", weights="400", styles="normal")
    assert sorted(FontFamily.objects.values_list("slug", flat=True)) == ["lato", "open-sans"]
    assert FontVariant.objects.count() == 2


def test_command_all_walks_the_whole_source_in_popularity_order():
    source = FakeSource(meta("zzz-new", "Zzz New"), meta("lato", "Lato"), meta("roboto", "Roboto"))
    command(source, all=True, weights="400", styles="normal")
    assert source.metadata_calls == ["roboto", "lato", "zzz-new"]


def test_auto_subsets_take_every_script_a_family_has_but_cjk():
    source = FakeSource(
        meta("noto-sans", "Noto Sans", subsets=("latin", "arabic", "japanese", "devanagari", "math"))
    )
    command(source, "noto-sans", weights="400", styles="normal")
    assert sorted(subset for _, subset, _, _ in source.fetched) == ["arabic", "devanagari", "latin"]


def test_the_script_fonts_are_ones_the_curated_list_knows():
    known = {font.family for font in curated_fonts()}
    assert set(SCRIPT_FONTS) <= known
    scripts = {s for font in curated_fonts() if font.family in SCRIPT_FONTS for s in font.scripts}
    assert {"arabic", "hebrew", "bengali", "devanagari", "thai"} <= scripts


def test_command_options_are_applied():
    source = catalog_source()
    out = command(
        source, "open-sans", subsets="latin,cyrillic", weights="700", styles="italic", concurrency=2
    )
    assert "subsets latin,cyrillic; weights 700; styles italic; 2 at a time" in out
    assert sorted(source.fetched) == [
        ("open-sans", "cyrillic", 700, "italic"),
        ("open-sans", "latin", 700, "italic"),
    ]


def test_command_reports_failures_with_a_nonzero_exit():
    source = catalog_source()
    source.failures = {("lato", "latin", 400, "normal"): SourceError("HTTP 500")}
    with pytest.raises(CommandError, match=r"1 file.*failed.*again"):
        command(source, "lato", subsets="latin", weights="400", styles="normal")
    assert not FontVariant.objects.exists()
    source.failures.clear()
    command(source, "lato", subsets="latin", weights="400", styles="normal")
    assert FontVariant.objects.count() == 1


def test_command_explains_what_to_do_when_the_network_is_unreachable():
    source = catalog_source()
    source.unavailable_for = {"roboto"}
    with pytest.raises(CommandError) as caught:
        command(source, "roboto")
    message = str(caught.value)
    assert "Cannot reach" in message and "--from-dir" in message and "HTTPS_PROXY" in message


@pytest.mark.parametrize(
    ("args", "options", "message"),
    [
        ((), {}, "Name families"),
        ((), {"popular": 0}, "positive"),
        (("lato",), {"weights": "450"}, "weights"),
        (("lato",), {"weights": "bold"}, "weights"),
        (("lato",), {"styles": "oblique"}, "styles"),
        (("lato",), {"subsets": " , "}, "subsets"),
    ],
)
def test_command_validates_its_arguments(args, options, message):
    source = catalog_source()
    with pytest.raises(CommandError, match=message):
        command(source, *args, **options)
    assert source.metadata_calls == []


def test_command_all_surfaces_a_listing_failure():
    class Broken(FakeSource):
        def list_ids(self):
            raise SourceError("HTTP 500")

    with pytest.raises(CommandError, match="Could not list fonts"):
        command(Broken(), all=True)


# ---- --from-dir ---------------------------------------------------------------------------------------


def write(directory: Path, name: str, data: bytes = WOFF2) -> Path:
    path = directory / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def test_from_dir_imports_files_by_their_fontsource_names(tmp_path):
    write(tmp_path, "open-sans-latin-400-normal.woff2")
    write(tmp_path, "open-sans-latin-ext-400-normal.woff2")
    write(tmp_path, "open-sans-cyrillic-700-italic.woff2")
    write(tmp_path / "nested", "brand-new-font-latin-400-normal.woff2")
    write(tmp_path, "notes.txt", b"ignore")
    write(tmp_path, "weird name.woff2")

    messages = []
    report = import_font_directory(tmp_path, log=messages.append)

    sans = FontFamily.objects.get(slug="open-sans")
    assert (sans.family, sans.popularity, sans.category) == (
        "Open Sans",
        2,
        "sans-serif",
    )  # from the curated list
    assert triples(sans) == [
        (400, "normal", "latin"),
        (400, "normal", "latin-ext"),
        (700, "italic", "cyrillic"),
    ]
    assert sans.scripts == ["latin", "latin-ext", "cyrillic"]
    assert sans.variants.get(subset="latin").unicode_range.startswith("U+0000-00FF")
    assert (
        sans.variants.get(subset="latin").file.name
        == "fonts/system/open-sans/open-sans-latin-400-normal.woff2"
    )
    new = FontFamily.objects.get(slug="brand-new-font")
    assert (new.family, new.popularity) == ("Brand New Font", 9999)
    assert report.downloaded == 4 and any("weird name.woff2" in m for m in messages)


def test_from_dir_is_idempotent_and_rejects_bad_files(tmp_path):
    write(tmp_path, "lato-latin-400-normal.woff2")
    write(tmp_path, "lato-latin-700-normal.woff2", b"<html>not a font</html>" * 10)
    first = import_font_directory(tmp_path)
    second = import_font_directory(tmp_path)

    assert (first.downloaded, len(first.failures)) == (1, 1)
    assert (second.downloaded, second.existing) == (0, 1)
    assert FontVariant.objects.count() == 1


def test_from_dir_skips_symlinks(tmp_path):
    outside = write(tmp_path / "outside", "lato-latin-400-normal.woff2")
    inside = tmp_path / "inside"
    inside.mkdir()
    (inside / "lato-latin-700-normal.woff2").symlink_to(outside)
    assert import_font_directory(inside).results == []


def test_from_dir_command_and_errors(tmp_path):
    write(tmp_path, "lato-latin-400-normal.woff2")
    out = command(None, from_dir=str(tmp_path), license="Apache-2.0")
    assert "1 files imported" in out and FontFamily.objects.get().license == "Apache-2.0"
    with pytest.raises(CommandError, match="not a directory"):
        command(None, from_dir=str(tmp_path / "nope"))
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(CommandError, match="No files named"):
        command(None, from_dir=str(empty))


def test_from_dir_rejects_corrupt_files_with_a_failing_exit(tmp_path):
    write(tmp_path, "lato-latin-400-normal.woff2", b"junk")
    with pytest.raises(CommandError, match="rejected"):
        command(None, from_dir=str(tmp_path))


def test_the_registered_command_can_be_called_by_name_and_reports_missing_arguments():
    with pytest.raises(CommandError, match="Name families"):
        call_command("sync_fonts")


def test_unavailable_error_type_is_a_source_error():
    assert issubclass(SourceUnavailable, SourceError)
