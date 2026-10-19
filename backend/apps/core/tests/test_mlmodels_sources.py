import hashlib

import pytest
import requests

from apps.core.mlmodels import sources
from apps.core.mlmodels.sources import (
    DirectorySource,
    HttpModelSource,
    IntegrityError,
    SourceError,
    SourceUnavailable,
)

from .mlhelpers import PAYLOAD, FakeResponse, FakeSession, make_spec

URL = "https://github.com/example/demo/releases/download/v1/demo.onnx"


def source_for(handler, **kwargs):
    session = FakeSession(handler)
    waits: list[float] = []
    return HttpModelSource(session, sleep=waits.append, **kwargs), session, waits


def test_a_plain_download_writes_the_file_and_reports_progress(tmp_path):
    source, session, _ = source_for(lambda url, headers: FakeResponse(200, PAYLOAD))
    seen: list[tuple[int, int]] = []
    target = tmp_path / "demo.part"
    source.fetch(make_spec(), target, lambda done, total: seen.append((done, total)))
    assert target.read_bytes() == PAYLOAD
    assert seen[-1] == (len(PAYLOAD), len(PAYLOAD))
    assert session.requests[0][0] == URL and "Range" not in session.requests[0][1]


def test_redirects_are_followed_by_hand_and_only_to_allowed_hosts(tmp_path):
    hops = {
        URL: FakeResponse(
            302, headers={"Location": "https://release-assets.githubusercontent.com/blob/abc?sig=1"}
        ),
        "https://release-assets.githubusercontent.com/blob/abc?sig=1": FakeResponse(200, PAYLOAD),
    }
    source, session, _ = source_for(lambda url, headers: hops[url])
    source.fetch(make_spec(), tmp_path / "m.part")
    assert (tmp_path / "m.part").read_bytes() == PAYLOAD
    assert [r[0] for r in session.requests] == list(hops)

    evil = {URL: FakeResponse(302, headers={"Location": "https://evil.example/model.onnx"})}
    source, session, _ = source_for(lambda url, headers: evil[url])
    with pytest.raises(SourceError, match=r"Refusing to download from evil.example"):
        source.fetch(make_spec(), tmp_path / "n.part")
    assert [r[0] for r in session.requests] == [URL], "the disallowed host is never contacted"


def test_a_redirect_to_plain_http_or_a_redirect_loop_is_refused(tmp_path):
    source, _, _ = source_for(
        lambda url, headers: FakeResponse(302, headers={"Location": "http://github.com/x.onnx"})
    )
    with pytest.raises(SourceError, match="Refusing"):
        source.fetch(make_spec(), tmp_path / "a.part")

    source, _, _ = source_for(lambda url, headers: FakeResponse(302, headers={"Location": URL}))
    with pytest.raises(SourceError, match="Too many redirects"):
        source.fetch(make_spec(), tmp_path / "b.part")

    source, _, _ = source_for(lambda url, headers: FakeResponse(302))
    with pytest.raises(SourceError, match="without a target"):
        source.fetch(make_spec(), tmp_path / "c.part")


def test_a_partial_file_is_resumed_with_a_range_request(tmp_path):
    target = tmp_path / "demo.part"
    target.write_bytes(PAYLOAD[:500])

    def handler(url, headers):
        assert headers == {"Range": "bytes=500-"}
        return FakeResponse(
            206, PAYLOAD[500:], {"Content-Range": f"bytes 500-{len(PAYLOAD) - 1}/{len(PAYLOAD)}"}
        )

    source, _, _ = source_for(handler)
    source.fetch(make_spec(), target)
    assert target.read_bytes() == PAYLOAD


def test_a_server_that_ignores_range_restarts_from_zero(tmp_path):
    target = tmp_path / "demo.part"
    target.write_bytes(b"stale-bytes")
    source, _, _ = source_for(lambda url, headers: FakeResponse(200, PAYLOAD))
    source.fetch(make_spec(), target)
    assert target.read_bytes() == PAYLOAD


def test_a_206_that_starts_elsewhere_is_not_appended(tmp_path):
    target = tmp_path / "demo.part"
    target.write_bytes(PAYLOAD[:500])
    source, _, _ = source_for(
        lambda url, headers: FakeResponse(206, PAYLOAD, {"Content-Range": f"bytes 0-{len(PAYLOAD) - 1}/x"})
    )
    source.fetch(make_spec(), target)
    assert target.read_bytes() == PAYLOAD


def test_an_oversized_partial_file_is_discarded_and_a_416_restarts(tmp_path):
    target = tmp_path / "demo.part"
    target.write_bytes(PAYLOAD + b"extra")
    source, session, _ = source_for(lambda url, headers: FakeResponse(200, PAYLOAD))
    source.fetch(make_spec(), target)
    assert target.read_bytes() == PAYLOAD and "Range" not in session.requests[0][1]

    target.write_bytes(PAYLOAD[:10])
    answers = iter([FakeResponse(416), FakeResponse(200, PAYLOAD)])
    source, session, waits = source_for(lambda url, headers: next(answers))
    source.fetch(make_spec(), target)
    assert target.read_bytes() == PAYLOAD and waits == [1]


def test_a_response_larger_than_the_pinned_size_is_refused(tmp_path):
    source, _, _ = source_for(lambda url, headers: FakeResponse(200, PAYLOAD + b"more"))
    with pytest.raises(SourceError, match="larger than"):
        source.fetch(make_spec(), tmp_path / "x.part")


def test_transient_statuses_are_retried_with_backoff_and_retry_after(tmp_path):
    answers = iter(
        [FakeResponse(429, headers={"Retry-After": "7"}), FakeResponse(503), FakeResponse(200, PAYLOAD)]
    )
    source, _, waits = source_for(lambda url, headers: next(answers))
    source.fetch(make_spec(), tmp_path / "x.part")
    assert waits == [7, 2]  # the server's hint beats the 1 s backoff, then exponential


def test_persistent_failures_give_a_readable_error(tmp_path):
    source, _, waits = source_for(lambda url, headers: FakeResponse(500))
    with pytest.raises(SourceError, match="HTTP 500"):
        source.fetch(make_spec(), tmp_path / "x.part")
    assert len(waits) == 2

    source, _, _ = source_for(lambda url, headers: FakeResponse(404))
    with pytest.raises(SourceError, match=r"HTTP 404 from github.com"):
        source.fetch(make_spec(), tmp_path / "y.part")


def test_an_unreachable_host_is_reported_as_unavailable(tmp_path):
    def handler(url, headers):
        raise requests.ConnectionError("no route")

    source, _, waits = source_for(handler)
    with pytest.raises(SourceUnavailable, match=r"Cannot reach github.com"):
        source.fetch(make_spec(), tmp_path / "x.part")
    assert len(waits) == 2


def test_a_connection_dropped_mid_body_is_retried(tmp_path):
    class Dropping(FakeResponse):
        def iter_content(self, chunk_size):
            yield self.body[:10]
            raise requests.exceptions.ChunkedEncodingError("dropped")

    resumed = FakeResponse(
        206, PAYLOAD[10:], {"Content-Range": f"bytes 10-{len(PAYLOAD) - 1}/{len(PAYLOAD)}"}
    )
    answers = iter([Dropping(200, PAYLOAD), resumed])
    source, _, _ = source_for(lambda url, headers: next(answers))
    target = tmp_path / "x.part"
    source.fetch(make_spec(), target)
    assert target.read_bytes() == PAYLOAD, "the second attempt resumed after the first 10 bytes"


def test_the_next_mirror_is_tried_when_the_first_fails_or_has_the_wrong_bytes(tmp_path):
    spec = make_spec(
        urls=[URL, "https://huggingface.co/example/demo/resolve/abc/onnx/model.onnx"],
    )

    def verify(path):
        if hashlib.sha256(path.read_bytes()).hexdigest() != spec.sha256:
            raise IntegrityError("wrong bytes")

    answers = {URL: FakeResponse(200, b"x" * len(PAYLOAD)), spec.urls[1]: FakeResponse(200, PAYLOAD)}
    source, session, _ = source_for(lambda url, headers: answers[url])
    target = tmp_path / "m.part"
    source.fetch(spec, target, verify=verify)
    assert target.read_bytes() == PAYLOAD and [r[0] for r in session.requests] == [URL, spec.urls[1]]

    broken = {URL: FakeResponse(404), spec.urls[1]: FakeResponse(200, b"short")}
    source, _, _ = source_for(lambda url, headers: broken[url])
    with pytest.raises(SourceError) as info:
        source.fetch(spec, tmp_path / "n.part", verify=verify)
    assert "HTTP 404 from github.com" in str(info.value) and "wrong bytes" in str(info.value)


def test_all_mirrors_unreachable_stops_at_the_first(tmp_path):
    spec = make_spec(urls=[URL, "https://huggingface.co/a/b/resolve/c/d.onnx"])

    def handler(url, headers):
        raise requests.Timeout("slow")

    source, session, _ = source_for(handler)
    with pytest.raises(SourceUnavailable):
        source.fetch(spec, tmp_path / "x.part")
    assert {r[0] for r in session.requests} == {URL}


def test_range_header_parsing():
    parse = HttpModelSource._range_start
    assert parse(FakeResponse(206, headers={"Content-Range": "bytes 100-999/1000"})) == 100
    assert parse(FakeResponse(206, headers={"Content-Range": "items 1-2/3"})) is None
    assert parse(FakeResponse(206)) is None
    assert parse(FakeResponse(206, headers={"Content-Range": "bytes */1000"})) is None


def test_the_user_agent_identifies_doory():
    session = FakeSession(lambda url, headers: FakeResponse(200, b""))
    HttpModelSource(session)
    assert session.headers["User-Agent"] == sources.USER_AGENT


# ---- DirectorySource -----------------------------------------------------------------------------------------


def test_directory_source_copies_the_file_by_either_layout(tmp_path):
    spec = make_spec()
    (tmp_path / "in").mkdir()
    (tmp_path / "in" / "demo.onnx").write_bytes(PAYLOAD)
    seen = []
    DirectorySource(tmp_path / "in").fetch(spec, tmp_path / "out.part", lambda d, t: seen.append((d, t)))
    assert (tmp_path / "out.part").read_bytes() == PAYLOAD and seen == [(len(PAYLOAD),) * 2]

    (tmp_path / "nested" / "demo").mkdir(parents=True)
    (tmp_path / "nested" / "demo" / "demo.onnx").write_bytes(PAYLOAD)
    DirectorySource(tmp_path / "nested").fetch(spec, tmp_path / "out2.part")
    assert (tmp_path / "out2.part").read_bytes() == PAYLOAD


def test_directory_source_refuses_symlinks_missing_and_oversized_files(tmp_path):
    spec = make_spec()
    (tmp_path / "real.onnx").write_bytes(PAYLOAD)
    (tmp_path / "demo.onnx").symlink_to(tmp_path / "real.onnx")
    with pytest.raises(SourceError, match="was found"):
        DirectorySource(tmp_path).fetch(spec, tmp_path / "x.part")

    other = tmp_path / "other"
    other.mkdir()
    with pytest.raises(SourceError, match=r"Neither demo.onnx nor demo/demo.onnx"):
        DirectorySource(other).fetch(spec, tmp_path / "y.part")

    big = tmp_path / "big"
    big.mkdir()
    (big / "demo.onnx").write_bytes(PAYLOAD + b"!")
    with pytest.raises(SourceError, match="larger than"):
        DirectorySource(big).fetch(spec, tmp_path / "z.part")
