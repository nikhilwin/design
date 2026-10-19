import struct
import subprocess
import zlib

import pytest

from apps.fonts import inspector
from apps.fonts.inspector import FontError, clean_family_name, inspect_font, sniff_format

from .fontfiles import CYRILLIC, LATIN, make_font


def test_sniff_format_uses_the_magic_bytes_only():
    assert sniff_format(b"\x00\x01\x00\x00....") == "ttf"
    assert sniff_format(b"true....") == "ttf"
    assert sniff_format(b"OTTO....") == "otf"
    assert sniff_format(b"wOFF....") == "woff"
    assert sniff_format(b"wOF2....") == "woff2"
    for bad in (b"", b"PK\x03\x04", b"<svg", b"GIF8"):
        with pytest.raises(FontError):
            sniff_format(bad)
    with pytest.raises(FontError, match="collection"):
        sniff_format(b"ttcf....")


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Open Sans", "Open Sans"),
        ("  Open   Sans  ", "Open Sans"),
        ('Evil"; } <script>', "Evil script"),
        ("a/b\\c'd`e", "abcde"),
        ("Noto Sans (Bengali) & Co.", "Noto Sans (Bengali) & Co"),
        ("Hind Siliguri বাংলা", "Hind Siliguri বাংলা"),
        ("---", ""),
        ("\x00\x01​", ""),
        (None, ""),
        ("x" * 300, "x" * 100),
    ],
)
def test_clean_family_name(raw, expected):
    assert clean_family_name(raw) == expected


def test_inspect_reads_name_weight_style_and_scripts():
    info = inspect_font(make_font("Brand Sans", weight=700, italic=True, chars=LATIN + CYRILLIC))
    assert (info.format, info.family, info.weight, info.style) == ("ttf", "Brand Sans", 700, "italic")
    assert info.scripts == ("latin", "cyrillic") and info.is_variable is False


def test_weights_are_snapped_to_the_css_scale():
    assert inspect_font(make_font(weight=550)).weight == 600
    assert inspect_font(make_font(weight=1000)).weight == 900
    assert inspect_font(make_font(weight=1)).weight == 100


def test_woff_and_woff2_containers_are_parsed():
    assert inspect_font(make_font(flavor="woff")).format == "woff"
    assert inspect_font(make_font(flavor="woff2")).format == "woff2"


def test_probe_failures_become_font_errors(monkeypatch):
    class Finished:
        stdout = b"not json"

    monkeypatch.setattr(inspector.subprocess, "run", lambda *a, **k: Finished())
    with pytest.raises(FontError, match="parsed"):
        inspect_font(make_font())

    monkeypatch.setattr(
        inspector.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(OSError("no fork"))
    )
    with pytest.raises(FontError, match="Try again"):
        inspect_font(make_font())

    def hang(*args, **kwargs):
        raise subprocess.TimeoutExpired("probe", 1)

    monkeypatch.setattr(inspector.subprocess, "run", hang)
    with pytest.raises(FontError, match="too long"):
        inspect_font(make_font())


def test_a_hanging_probe_is_killed_by_the_timeout(monkeypatch, tmp_path):
    sleeper = tmp_path / "sleeper.py"
    sleeper.write_text("import time\ntime.sleep(30)\n")
    monkeypatch.setattr(inspector, "PROBE_SCRIPT", sleeper)
    monkeypatch.setattr(inspector, "PROBE_TIMEOUT_SECONDS", 1)
    with pytest.raises(FontError, match="too long"):
        inspect_font(make_font())


def test_a_decompression_bomb_cannot_exhaust_the_server():
    """A WOFF whose `name` table inflates to > 1 GiB is stopped by the probe's memory limit."""
    inflated = 1280 * 1024 * 1024
    compressor = zlib.compressobj(1)
    chunk = b"\x00" * (16 * 1024 * 1024)
    compressed = (
        b"".join(compressor.compress(chunk) for _ in range(inflated // len(chunk))) + compressor.flush()
    )
    glyf = b"\x00" * 16
    tables = [(b"glyf", glyf, len(glyf), len(glyf)), (b"name", compressed, len(compressed), inflated)]
    offset = 44 + 20 * len(tables)
    directory, body = b"", b""
    for tag, blob, comp_len, orig_len in tables:
        body += b"\x00" * (-len(body) % 4)
        directory += struct.pack(">4sIIII", tag, offset + len(body), comp_len, orig_len, 0)
        body += blob
    header = struct.pack(
        ">4sIIHHIHHIIIII",
        b"wOFF",
        0x00010000,
        offset + len(body),
        len(tables),
        0,
        inflated,
        1,
        0,
        0,
        0,
        0,
        0,
        0,
    )

    with pytest.raises(FontError, match="too large"):
        inspect_font(header + directory + body)
