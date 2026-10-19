import os
from io import StringIO
from pathlib import Path

import pytest
from django.core.management import CommandError, call_command

from apps.elements.importer import (
    element_key,
    element_name,
    element_tags,
    ensure_pack,
    import_directory,
    import_svg,
)
from apps.elements.models import Element, ElementPack

from .factories import CURRENT_COLOR, EVIL, RED_SQUARE, make_pack

pytestmark = pytest.mark.django_db


def run(*args, **kwargs):
    out, err = StringIO(), StringIO()
    call_command(*args, stdout=out, stderr=err, **kwargs)
    return out.getvalue(), err.getvalue()


def write(path: Path, text: str = RED_SQUARE) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def test_element_name_title_cases_the_stem():
    assert element_name("arrow-right_2") == "Arrow Right 2"
    assert element_name("  --  ") == "Element"
    assert element_name("x" * 300) == "X" + "x" * 119


def test_element_tags_come_from_folders_and_name_words():
    assert element_tags(("Arrows", "big-ones"), "Arrow Right 2") == [
        "arrows",
        "big",
        "ones",
        "arrow",
        "right",
    ]
    assert element_tags((), "A 7") == []
    assert (
        len(element_tags((), " ".join(f"word{chr(97 + i % 26)}{chr(97 + i // 26)}" for i in range(60)))) <= 20
    )


def test_element_key_slugifies_each_path_part():
    assert element_key(Path("Arrows/Right Arrow.svg")) == "arrows/right-arrow"
    with pytest.raises(ValueError):
        element_key(Path("!!!.svg"))


def test_import_svg_creates_updates_and_detects_no_change():
    pack = make_pack()
    kwargs = {"key": "box", "name": "Box", "tags": ["box"]}

    assert import_svg(pack, data=RED_SQUARE.encode(), **kwargs) == "created"
    assert import_svg(pack, data=RED_SQUARE.encode(), **kwargs) == "unchanged"
    assert import_svg(pack, data=CURRENT_COLOR.encode(), **kwargs) == "updated"
    assert Element.objects.count() == 1
    assert Element.objects.get().is_recolorable is False


def test_updating_artwork_keeps_staff_edits():
    pack = make_pack()
    import_svg(pack, key="box", name="Box", tags=["box"], data=RED_SQUARE.encode())
    Element.objects.update(name="Staff Name", tags=["custom"], is_published=False, kind="icon")

    import_svg(pack, key="box", name="Box", tags=["box"], data=CURRENT_COLOR.encode())

    element = Element.objects.get()
    assert (element.name, element.tags, element.is_published, element.kind) == (
        "Staff Name",
        ["custom"],
        False,
        "icon",
    )


def test_import_svg_sanitises_before_storing():
    pack = make_pack()
    import_svg(pack, key="evil", name="Evil", tags=[], data=EVIL.encode())
    with Element.objects.get().svg.open("rb") as handle:
        assert b"script" not in handle.read()


def test_import_directory_is_recursive_and_idempotent(tmp_path):
    write(tmp_path / "arrow-right.svg")
    write(tmp_path / "Social" / "heart-icon.SVG")
    write(tmp_path / "social" / "deep" / "star.svg")
    (tmp_path / "notes.txt").write_text("ignore me")
    pack = make_pack(kind="icon")

    first = import_directory(pack, tmp_path)
    second = import_directory(pack, tmp_path)

    assert (first.created, first.unchanged, first.skipped) == (3, 0, [])
    assert (second.created, second.updated, second.unchanged) == (0, 0, 3)
    assert Element.objects.count() == 3
    heart = Element.objects.get(name="Heart Icon")
    assert (
        heart.key == "social/heart-icon"
        and heart.tags == ["social", "heart", "icon"]
        and heart.kind == "icon"
    )


def test_import_directory_updates_changed_files_only(tmp_path):
    changing, steady = write(tmp_path / "a.svg"), write(tmp_path / "b.svg")
    pack = make_pack()
    import_directory(pack, tmp_path)
    changing.write_text(CURRENT_COLOR)

    summary = import_directory(pack, tmp_path)

    assert (summary.updated, summary.unchanged) == (1, 1)
    assert steady.exists()


def test_import_directory_skips_bad_files_with_a_reason(tmp_path):
    write(tmp_path / "good.svg")
    write(tmp_path / "not-svg.svg", "<html><body>hi</body></html>")
    write(tmp_path / "garbage.svg", "this is not xml")
    write(tmp_path / "!!!.svg")
    messages = []

    summary = import_directory(
        make_pack(), tmp_path, progress=lambda outcome, detail: messages.append((outcome, detail))
    )

    assert summary.created == 1
    assert sorted(label for label, _ in summary.skipped) == ["!!!.svg", "garbage.svg", "not-svg.svg"]
    assert all(outcome == "skipped" or detail == "good.svg" for outcome, detail in messages)


def test_import_directory_skips_oversized_files(tmp_path):
    write(
        tmp_path / "huge.svg",
        "<svg xmlns='http://www.w3.org/2000/svg'>" + " " * (5 * 1024 * 1024 + 1) + "</svg>",
    )
    summary = import_directory(make_pack(), tmp_path)
    assert summary.created == 0 and "larger than 5 MB" in summary.skipped[0][1]


def test_import_directory_never_follows_symlinks(tmp_path):
    outside = tmp_path / "outside"
    write(outside / "secret.svg")
    inside = tmp_path / "inside"
    write(inside / "ok.svg")
    os.symlink(outside / "secret.svg", inside / "link.svg")
    os.symlink(outside, inside / "linked-dir")

    summary = import_directory(make_pack(), inside)

    assert summary.created == 1
    assert list(Element.objects.values_list("name", flat=True)) == ["Ok"]


def test_ensure_pack_requires_a_licence_for_new_packs_and_validates_kind():
    with pytest.raises(ValueError, match="licence"):
        ensure_pack("new", name="New")
    with pytest.raises(ValueError, match="kind"):
        ensure_pack("new", license="MIT", kind="widget")
    pack, created = ensure_pack("new", name="New", license="MIT", kind="icon")
    assert created and (pack.kind, pack.license) == ("icon", "MIT")
    again, created = ensure_pack("new", source_url="https://example.com/icons")
    assert not created and again.pk == pack.pk and again.source_url == "https://example.com/icons"
    assert again.name == "New" and again.kind == "icon"


def test_import_elements_command_creates_the_pack_and_prints_a_summary(tmp_path):
    write(tmp_path / "arrows" / "up.svg")
    write(tmp_path / "bad.svg", "nope")

    out, err = run(
        "import_elements",
        str(tmp_path),
        pack="my-icons",
        name="My Icons",
        kind="icon",
        license="MIT",
        source_url="https://example.com/icons",
    )

    pack = ElementPack.objects.get(slug="my-icons")
    assert (pack.name, pack.kind, pack.license, pack.source_url) == (
        "My Icons",
        "icon",
        "MIT",
        "https://example.com/icons",
    )
    assert "1 created, 0 updated, 0 unchanged, 1 skipped" in out
    assert "bad.svg" in err
    element = Element.objects.get()
    assert element.kind == "icon" and element.tags == ["arrows", "up"]


def test_import_elements_command_is_idempotent(tmp_path):
    write(tmp_path / "up.svg")
    args = {"pack": "p", "license": "CC0-1.0"}
    run("import_elements", str(tmp_path), **args)
    out, _ = run("import_elements", str(tmp_path), **args)
    assert "0 created, 0 updated, 1 unchanged" in out
    assert Element.objects.count() == 1 and ElementPack.objects.count() == 1


def test_import_elements_command_sanitises(tmp_path):
    write(tmp_path / "evil.svg", EVIL)
    run("import_elements", str(tmp_path), pack="p", license="CC0-1.0")
    with Element.objects.get().svg.open("rb") as handle:
        content = handle.read().decode()
    assert "script" not in content and "onload" not in content and "evil.example" not in content


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"pack": "new"}, "licence"),
        ({"pack": "new", "license": "not valid!"}, "license"),
        ({"pack": "Bad Slug", "license": "MIT"}, "slug"),
    ],
)
def test_import_elements_command_rejects_bad_pack_arguments(tmp_path, kwargs, message):
    write(tmp_path / "a.svg")
    with pytest.raises(CommandError, match=message):
        run("import_elements", str(tmp_path), **kwargs)
    assert not Element.objects.exists()


def test_import_elements_command_rejects_a_missing_directory(tmp_path):
    with pytest.raises(CommandError, match="not a directory"):
        run("import_elements", str(tmp_path / "nope"), pack="p", license="MIT")


def test_seed_elements_creates_the_builtin_packs_and_is_idempotent():
    out, _ = run("seed_elements")

    assert list(ElementPack.objects.order_by("sort_order").values_list("name", flat=True)) == [
        "Basic Shapes",
        "Lines & Dividers",
        "Frames & Masks",
        "Arrows & Callouts",
        "Backgrounds & Patterns",
        "Frames & Badges",
        "Dividers & Borders",
        "Speech Bubbles & Callouts",
        "Social Media",
        "Sale & Promo",
        "Charts",
        "Doodle Accents",
    ]
    total = Element.objects.count()
    assert total >= 300 and f"{total} elements in 12 packs" in out
    assert set(ElementPack.objects.values_list("license", flat=True)) == {"CC0-1.0"}
    assert Element.objects.filter(is_recolorable=False).count() == 0
    assert set(Element.objects.values_list("kind", flat=True)) >= {
        "shape",
        "line",
        "frame",
        "graphic",
        "icon",
    }

    second, _ = run("seed_elements")
    assert Element.objects.count() == total
    assert "0 created, 0 updated" in second
    assert "up to date" in second
