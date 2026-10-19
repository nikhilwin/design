import hashlib
import io
import tarfile

import pytest
import requests

from apps.elements import sources
from apps.elements.manifest import NpmSource, UrlFile, UrlsSource
from apps.elements.sources import (
    DirectorySource,
    HttpPackSource,
    IntegrityError,
    NoSource,
    SourceError,
    SourceUnavailable,
    archive_path,
    glob_regex,
    matcher,
    read_directory,
    read_tarball,
    verify_integrity,
)

from .packhelpers import integrity_of, make_tarball

# ---- globs and paths -----------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("pattern", "path", "expected"),
    [
        ("icons/*.svg", "icons/a.svg", True),
        ("icons/*.svg", "icons/sub/a.svg", False),
        ("icons/**/*.svg", "icons/sub/deep/a.svg", True),
        ("icons/**/*.svg", "icons/a.svg", True),
        ("**/*.svg", "a/b/c.svg", True),
        ("icons/?.svg", "icons/a.svg", True),
        ("icons/?.svg", "icons/ab.svg", False),
        ("icons/a.svg", "icons/a.svg", True),
        ("icons/a.svg", "icons/aXsvg", False),
        ("*.json", "tags.json", True),
        ("icons/*.svg", "icons/a.svg.bak", False),
    ],
)
def test_glob_matching(pattern, path, expected):
    assert bool(glob_regex(pattern).match(path)) is expected


def test_matcher_accepts_any_pattern():
    wanted = matcher(["a/*.svg", "LICENSE"])
    assert wanted("a/x.svg") and wanted("LICENSE") and not wanted("b/x.svg")


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("package/icons/a.svg", "icons/a.svg"),
        ("package/./dist", "dist"),
        ("pkg/LICENSE", "LICENSE"),
        ("/etc/passwd", None),
        ("package/../../etc/passwd", None),
        ("../x", None),
        ("LICENSE", None),
        ("package//x", "x"),
        ("package\\..\\x", None),
    ],
)
def test_archive_paths_drop_the_top_folder_and_refuse_traversal(name, expected):
    assert archive_path(name) == expected


# ---- archives -------------------------------------------------------------------------------------------------


def test_read_tarball_returns_only_wanted_regular_files():
    data = make_tarball(
        {"icons/a.svg": b"<a/>", "icons/b.png": b"png", "LICENSE": b"MIT", "dist/x.js": b"js"}
    )
    assert read_tarball(data, ["icons/*.svg", "LICENSE"]) == {"icons/a.svg": b"<a/>", "LICENSE": b"MIT"}


def test_read_tarball_ignores_links_devices_and_unsafe_names():
    def extra(archive):
        link = tarfile.TarInfo("package/icons/link.svg")
        link.type, link.linkname = tarfile.SYMTYPE, "/etc/passwd"
        archive.addfile(link)
        evil = tarfile.TarInfo("package/../../evil.svg")
        evil.size = 1
        archive.addfile(evil, io.BytesIO(b"x"))
        absolute = tarfile.TarInfo("/abs.svg")
        absolute.size = 1
        archive.addfile(absolute, io.BytesIO(b"x"))

    data = make_tarball({"icons/ok.svg": b"<ok/>"}, extra=extra)
    assert read_tarball(data, ["**/*.svg", "*.svg"]) == {"icons/ok.svg": b"<ok/>"}


def test_read_tarball_enforces_size_limits(monkeypatch):
    data = make_tarball({"icons/big.svg": b"x" * 200})
    monkeypatch.setattr(sources, "MAX_MEMBER_BYTES", 100)
    with pytest.raises(SourceError, match="larger than"):
        read_tarball(data, ["icons/*.svg"])
    monkeypatch.setattr(sources, "MAX_MEMBER_BYTES", 10_000)
    monkeypatch.setattr(sources, "MAX_TOTAL_BYTES", 150)
    with pytest.raises(SourceError, match="size limit"):
        read_tarball(make_tarball({"icons/a.svg": b"x" * 100, "icons/b.svg": b"x" * 100}), ["icons/*.svg"])
    monkeypatch.setattr(sources, "MAX_TOTAL_BYTES", 10_000)
    monkeypatch.setattr(sources, "MAX_ARCHIVE_MEMBERS", 1)
    with pytest.raises(SourceError, match="too many"):
        read_tarball(make_tarball({"a": b"1", "b": b"2", "c": b"3"}), ["*"])


def test_read_tarball_reports_a_corrupt_archive():
    with pytest.raises(SourceError, match="could not be read"):
        read_tarball(b"definitely not a tarball", ["*"])


def test_integrity_is_verified_with_sha512():
    verify_integrity(b"data", integrity_of(b"data"), "x")
    with pytest.raises(IntegrityError, match="does not match"):
        verify_integrity(b"other", integrity_of(b"data"), "x")
    with pytest.raises(IntegrityError, match="algorithm"):
        verify_integrity(b"data", "sha1-abc", "x")


def test_read_directory_skips_symlinks_and_enforces_limits(tmp_path, monkeypatch):
    (tmp_path / "icons").mkdir()
    (tmp_path / "icons" / "a.svg").write_bytes(b"<a/>")
    (tmp_path / "outside.svg").write_bytes(b"<out/>")
    (tmp_path / "icons" / "link.svg").symlink_to(tmp_path / "outside.svg")
    (tmp_path / "linked").symlink_to(tmp_path / "icons")
    assert read_directory(tmp_path, ["**/*.svg"]) == {"icons/a.svg": b"<a/>", "outside.svg": b"<out/>"}
    monkeypatch.setattr(sources, "MAX_MEMBER_BYTES", 2)
    with pytest.raises(SourceError, match="larger than"):
        read_directory(tmp_path, ["icons/*.svg"])


# ---- DirectorySource -------------------------------------------------------------------------------------------


def test_directory_source_reads_an_npm_tarball_and_verifies_it(tmp_path):
    tarball = make_tarball({"icons/a.svg": b"<a/>"})
    spec = NpmSource("demo-icons", "1.0.0", integrity_of(tarball))
    (tmp_path / spec.tarball_name).write_bytes(tarball)

    assert DirectorySource(tmp_path).fetch(spec, ["icons/*.svg"]) == {"icons/a.svg": b"<a/>"}

    tampered = NpmSource("demo-icons", "1.0.0", integrity_of(b"something else"))
    with pytest.raises(IntegrityError):
        DirectorySource(tmp_path).fetch(tampered, ["icons/*.svg"])


def test_directory_source_reads_an_unpacked_folder_for_scoped_packages(tmp_path):
    spec = NpmSource("@scope/icons", "2.0.0", "sha512-x")
    folder = tmp_path / "scope-icons" / "icons"
    folder.mkdir(parents=True)
    (folder / "a.svg").write_bytes(b"<a/>")
    assert DirectorySource(tmp_path).fetch(spec, ["icons/*.svg"]) == {"icons/a.svg": b"<a/>"}


def test_directory_source_explains_what_it_is_missing(tmp_path):
    with pytest.raises(SourceError, match=r"demo-icons-1\.0\.0\.tgz"):
        DirectorySource(tmp_path).fetch(NpmSource("demo-icons", "1.0.0", "sha512-x"), ["*"])
    spec = UrlsSource("set.json", (UrlFile("a.svg", "https://x.example/a.svg", "0" * 64),))
    with pytest.raises(SourceError, match="folder set/"):
        DirectorySource(tmp_path).fetch(spec, ["*"])


def test_directory_source_checks_file_hashes_of_url_packs(tmp_path):
    data = b"<svg/>"
    spec = UrlsSource(
        "set.json",
        (UrlFile("a.svg", "https://x.example/a.svg", hashlib.sha256(data).hexdigest()),),
    )
    folder = tmp_path / "set"
    folder.mkdir()
    (folder / "a.svg").write_bytes(data)
    (folder / "unlisted.svg").write_bytes(b"<x/>")
    assert DirectorySource(tmp_path).fetch(spec, ["*.svg"]) == {"a.svg": data}
    (folder / "a.svg").write_bytes(b"<tampered/>")
    with pytest.raises(IntegrityError):
        DirectorySource(tmp_path).fetch(spec, ["*.svg"])


def test_directory_source_refuses_an_incomplete_url_pack(tmp_path):
    data = b"<svg/>"
    digest = hashlib.sha256(data).hexdigest()
    spec = UrlsSource(
        "set.json",
        (
            UrlFile("a.svg", "https://x.example/a.svg", digest),
            UrlFile("b.svg", "https://x.example/b.svg", digest),
        ),
    )
    (tmp_path / "set").mkdir()
    (tmp_path / "set" / "a.svg").write_bytes(data)
    with pytest.raises(SourceError, match=r"1 of 2 files are missing .*\(first: b\.svg\)"):
        DirectorySource(tmp_path).fetch(spec, ["*.svg"])


def test_no_source_refuses_to_download():
    with pytest.raises(SourceError, match="needs a download source"):
        NoSource().fetch(NpmSource("a", "1.0.0", "sha512-x"), [])


# ---- HTTP ---------------------------------------------------------------------------------------------------------


class FakeResponse:
    def __init__(self, status=200, body=b"", headers=None):
        self.status_code, self.body, self.headers = status, body, headers or {}
        self.closed = False

    def iter_content(self, size):
        for start in range(0, len(self.body), size):
            yield self.body[start : start + size]

    def close(self):
        self.closed = True


class FakeSession:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []
        self.headers = {}

    def get(self, url, **kwargs):
        self.requests.append((url, kwargs))
        item = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        if isinstance(item, Exception):
            raise item
        return item


def http(session, **kwargs):
    kwargs.setdefault("sleep", lambda _: None)
    return HttpPackSource(session, **kwargs)


NPM = NpmSource("demo-icons", "1.0.0", "sha512-x")


def test_fetching_an_npm_release_downloads_one_tarball_and_checks_the_pinned_hash():
    tarball = make_tarball({"icons/a.svg": b"<a/>", "LICENSE": b"MIT"})
    spec = NpmSource("demo-icons", "1.0.0", integrity_of(tarball))
    session = FakeSession(FakeResponse(body=tarball))

    files = http(session).fetch(spec, ["icons/*.svg"])

    assert files == {"icons/a.svg": b"<a/>"}
    url, kwargs = session.requests[0]
    assert url == "https://registry.npmjs.org/demo-icons/-/demo-icons-1.0.0.tgz"
    assert kwargs["allow_redirects"] is False and kwargs["timeout"] == (10, 60)
    assert session.headers["User-Agent"].startswith("Doory-element-sync")


def test_a_tampered_tarball_is_refused():
    session = FakeSession(FakeResponse(body=make_tarball({"icons/a.svg": b"<a/>"})))
    with pytest.raises(IntegrityError):
        http(session).fetch(NpmSource("demo-icons", "1.0.0", integrity_of(b"other")), ["*"])


def test_transient_errors_are_retried_with_backoff_and_retry_after():
    tarball = make_tarball({"icons/a.svg": b"<a/>"})
    spec = NpmSource("demo-icons", "1.0.0", integrity_of(tarball))
    sleeps = []
    session = FakeSession(
        FakeResponse(503), FakeResponse(429, headers={"Retry-After": "7"}), FakeResponse(body=tarball)
    )

    assert http(session, sleep=sleeps.append, attempts=3).fetch(spec, ["icons/*.svg"]) == {
        "icons/a.svg": b"<a/>"
    }
    assert len(session.requests) == 3 and sleeps == [1, 7]


def test_connection_failures_mean_the_source_is_unavailable():
    session = FakeSession(requests.ConnectionError("down"))
    with pytest.raises(SourceUnavailable, match=r"registry\.npmjs\.org"):
        http(session, attempts=2).fetch(NPM, ["*"])
    assert len(session.requests) == 2
    with pytest.raises(SourceUnavailable):
        http(FakeSession(requests.Timeout("slow")), attempts=1).fetch(NPM, ["*"])


def test_persistent_server_errors_and_unexpected_statuses_are_errors():
    with pytest.raises(SourceError, match="HTTP 502"):
        http(FakeSession(FakeResponse(502)), attempts=2).fetch(NPM, ["*"])
    with pytest.raises(SourceError, match="HTTP 403"):
        http(FakeSession(FakeResponse(403))).fetch(NPM, ["*"])
    with pytest.raises(SourceError, match="HTTP 301"):
        http(FakeSession(FakeResponse(301, headers={"Location": "https://evil.example/"}))).fetch(NPM, ["*"])


def test_a_missing_release_is_reported_by_name():
    with pytest.raises(SourceError, match=r"demo-icons@1\.0\.0 was not found"):
        http(FakeSession(FakeResponse(404))).fetch(NPM, ["*"])


def test_responses_larger_than_the_cap_are_refused(monkeypatch):
    monkeypatch.setattr(sources, "MAX_ARCHIVE_BYTES", 100)
    with pytest.raises(SourceError, match="larger than"):
        http(FakeSession(FakeResponse(body=b"x" * 500))).fetch(NPM, ["*"])


def test_hosts_outside_the_allow_list_are_never_contacted():
    session = FakeSession(FakeResponse())
    source = http(session)
    for url in (
        "https://evil.example/x.tgz",
        "http://registry.npmjs.org/x.tgz",
        "ftp://registry.npmjs.org/x",
    ):
        with pytest.raises(SourceError, match="Refusing"):
            source._get(url, limit=10)
    assert session.requests == []


def test_url_packs_are_fetched_per_file_and_verified():
    one, two = b"<one/>", b"<two/>"
    spec = UrlsSource(
        "set.json",
        (
            UrlFile(
                "one.svg",
                "https://opendoodles.s3-us-west-1.amazonaws.com/one.svg",
                hashlib.sha256(one).hexdigest(),
            ),
            UrlFile(
                "two.svg",
                "https://opendoodles.s3-us-west-1.amazonaws.com/two.svg",
                hashlib.sha256(two).hexdigest(),
            ),
        ),
    )

    class ByUrl(FakeSession):
        def get(self, url, **kwargs):
            self.requests.append((url, kwargs))
            return FakeResponse(body={"one.svg": one, "two.svg": two}[url.rsplit("/", 1)[-1]])

    session = ByUrl(FakeResponse())
    assert http(session, concurrency=2).fetch(spec, []) == {"one.svg": one, "two.svg": two}
    assert len(session.requests) == 2

    bad = UrlsSource("set.json", (UrlFile("one.svg", spec.files[0].url, "0" * 64),))
    with pytest.raises(IntegrityError, match="SHA-256"):
        http(ByUrl(FakeResponse())).fetch(bad, [])
    with pytest.raises(SourceError, match="was not found"):
        http(FakeSession(FakeResponse(404))).fetch(spec, [])


def test_simultaneous_requests_never_exceed_the_concurrency_limit():
    import threading
    import time

    spec = UrlsSource(
        "set.json",
        tuple(
            UrlFile(
                f"{i}.svg",
                f"https://opendoodles.s3-us-west-1.amazonaws.com/{i}.svg",
                hashlib.sha256(b"x").hexdigest(),
            )
            for i in range(12)
        ),
    )
    state = {"now": 0, "peak": 0}
    lock = threading.Lock()

    class Slow(FakeSession):
        def get(self, url, **kwargs):
            with lock:
                state["now"] += 1
                state["peak"] = max(state["peak"], state["now"])
            time.sleep(0.01)
            with lock:
                state["now"] -= 1
            return FakeResponse(body=b"x")

    http(Slow(FakeResponse()), concurrency=3).fetch(spec, [])
    assert 1 <= state["peak"] <= 3
