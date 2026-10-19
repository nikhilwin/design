import re
import xml.etree.ElementTree as ET

import pytest

from apps.core.svg import sanitize_svg, svg_colors, svg_info
from apps.elements.seed import BUILTIN_PACKS, load_shape_generator

NS = "{http://www.w3.org/2000/svg}"
EXPECTED_FAMILIES = [
    "square",
    "rectangle",
    "rounded",
    "circle",
    "ellipse",
    "triangle",
    "pentagon",
    "hexagon",
    "heptagon",
    "octagon",
    *[f"star-{n}" for n in (4, 5, 6, 7, 8, 9, 10, 12)],
    "heart",
    "arrow",
    "chevron",
    "bubble",
    "banner",
    "seal",
    "blob",
    "wave",
    "line-solid",
    "line-dashed",
    "line-dotted",
    "arrow-line",
    "bracket",
    "cross",
    "plus",
    "cloud",
    "lightning",
    "sparkle",
    "crown",
    "mask-circle",
    "mask-arch",
    "mask-heart",
    "mask-star",
    "frame-polaroid",
    "frame-film-strip",
]


@pytest.fixture(scope="module")
def generated(tmp_path_factory):
    root = tmp_path_factory.mktemp("shapes")
    files = load_shape_generator().generate(root)
    return root, files


def test_generates_a_large_original_set(generated):
    _, files = generated
    assert len(files) >= 60
    assert len({f.stem for f in files}) == len(files), "file names must be unique"


def test_packs_match_the_seeded_pack_slugs(generated):
    root, _ = generated
    assert sorted(p.name for p in root.iterdir()) == sorted(slug for slug, *_ in BUILTIN_PACKS)


@pytest.mark.parametrize("family", EXPECTED_FAMILIES)
def test_covers_the_requested_shape_families(generated, family):
    _, files = generated
    assert any(family in f.stem for f in files), f"no shape named like {family!r}"


def test_every_file_survives_the_sanitiser_unchanged_in_meaning(generated):
    _, files = generated
    for path in files:
        raw = path.read_bytes()
        clean = sanitize_svg(raw)
        original, cleaned = ET.fromstring(raw), ET.fromstring(clean)
        assert len(list(original.iter())) == len(list(cleaned.iter())), (
            f"{path.name}: sanitiser removed elements"
        )
        for a, b in zip(original.iter(), cleaned.iter(), strict=True):
            assert a.attrib == b.attrib, f"{path.name}: sanitiser changed attributes"


def test_every_file_is_recolourable_with_one_hex_colour(generated):
    _, files = generated
    for path in files:
        assert svg_colors(sanitize_svg(path.read_bytes())) == [load_shape_generator().COLOR], path.name


def test_every_file_has_a_sensible_viewbox_title_and_size(generated):
    _, files = generated
    for path in files:
        root = ET.fromstring(path.read_bytes())
        x, y, w, h = (float(v) for v in root.get("viewBox").split())
        assert (x, y) == (0, 0) and w > 0 and h > 0, path.name
        info = svg_info(sanitize_svg(path.read_bytes()))
        assert (info.width, info.height) == (w, h), path.name
        assert root.find(f"{NS}title") is not None and root.find(f"{NS}title").text, path.name


def test_simple_geometry_stays_inside_the_viewbox(generated):
    _, files = generated
    for path in files:
        root = ET.fromstring(path.read_bytes())
        w, h = (float(v) for v in root.get("viewBox").split()[2:])
        for poly in root.iter(f"{NS}polygon"):
            for pair in poly.get("points").split():
                px, py = (float(v) for v in pair.split(","))
                assert -0.01 <= px <= w + 0.01 and -0.01 <= py <= h + 0.01, f"{path.name}: {pair}"
        for rect in root.iter(f"{NS}rect"):
            x, y = float(rect.get("x", 0)), float(rect.get("y", 0))
            assert x >= 0 and y >= 0, path.name
            assert x + float(rect.get("width")) <= w + 0.01 and y + float(rect.get("height")) <= h + 0.01, (
                path.name
            )
        for circ in root.iter(f"{NS}circle"):
            cx, cy, r = (float(circ.get(k)) for k in ("cx", "cy", "r"))
            assert cx - r >= -0.01 and cy - r >= -0.01 and cx + r <= w + 0.01 and cy + r <= h + 0.01, (
                path.name
            )


def test_path_data_is_well_formed(generated):
    _, files = generated
    command = re.compile(r"^[MLCQAHVTSZ]")
    for path in files:
        for el in ET.fromstring(path.read_bytes()).iter(f"{NS}path"):
            d = el.get("d")
            assert command.match(d) and "nan" not in d.lower() and "inf" not in d.lower(), path.name


def test_output_is_deterministic(generated, tmp_path):
    root, files = generated
    again = load_shape_generator().generate(tmp_path)
    assert [f.relative_to(tmp_path) for f in again] == [f.relative_to(root) for f in files]
    assert all(a.read_bytes() == b.read_bytes() for a, b in zip(again, files, strict=True))


def test_generator_can_run_as_a_script(tmp_path):
    import subprocess
    import sys

    from apps.elements.seed import GENERATOR_PATH

    result = subprocess.run(
        [sys.executable, str(GENERATOR_PATH), str(tmp_path)], capture_output=True, text=True, check=True
    )
    assert "Wrote" in result.stdout and (tmp_path / "basic-shapes").is_dir()
