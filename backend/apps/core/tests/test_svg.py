from xml.sax.saxutils import quoteattr

import pytest

from apps.core.svg import SvgError, safe_link, sanitize_svg, svg_colors, svg_info

SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" {attrs}>{body}</svg>'
)


def clean(body: str, attrs: str = 'viewBox="0 0 10 10"') -> str:
    return sanitize_svg(SVG.format(attrs=attrs, body=body).encode()).decode()


def test_keeps_benign_shapes_gradients_and_internal_refs():
    out = clean(
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#ff0000"/></linearGradient></defs>'
        '<rect width="5" height="5" fill="url(#g)"/><use xlink:href="#a"/>'
    )
    assert "<rect" in out and "linearGradient" in out and 'fill="url(#g)"' in out and 'xlink:href="#a"' in out


@pytest.mark.parametrize(
    "body",
    [
        "<script>alert(1)</script>",
        '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>',
        '<set attributeName="href" to="javascript:alert(1)"/>',
        '<animate attributeName="href" values="javascript:alert(1)"/>',
        '<iframe src="http://evil"/>',
    ],
)
def test_removes_dangerous_elements(body):
    out = clean(f"<g>{body}</g>").lower()
    for bad in ("script", "foreignobject", "<set", "<animate", "iframe"):
        assert bad not in out


def test_strips_event_handlers_and_js_urls():
    out = clean(
        '<rect onclick="x()" onload="y()" width="1" height="1"/><a href="javascript:alert(1)"><path d="M0 0"/></a>'
    )
    assert "onclick" not in out and "onload" not in out and "javascript" not in out and "<a" not in out


def test_external_references_are_dropped():
    out = clean(
        '<use href="https://evil.example/x.svg#a"/><image href="http://evil.example/p.png" width="1" height="1"/>'
    )
    assert "evil.example" not in out


def test_allows_small_raster_data_image_only():
    ok = clean('<image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>')
    assert "data:image/png" in ok
    bad = clean('<image href="data:text/html;base64,PHNjcmlwdD4=" width="1" height="1"/>')
    assert "data:text/html" not in bad


def test_css_with_external_urls_or_imports_is_rejected():
    assert "<style" not in clean("<style>@import url(http://evil/x.css);</style><rect/>")
    assert "<style" not in clean("<style>.a{background:url(http://evil/x.png)}</style><rect/>")
    assert "<style" in clean("<style>.a{fill:#f00}</style><rect/>")
    assert "evil" not in clean('<rect style="fill:url(http://evil/x)" width="1" height="1"/>')


@pytest.mark.parametrize(
    "css",
    [
        r"@\69mport 'https://evil.example/x.css';",
        r".a{fill:u\72l(https://evil.example/x.svg#a)}",
        r".a{fill:\75 \72 \6c (https://evil.example/x.svg#a)}",
        r".a{background:ur\6c(https://evil.example/x.png)}",
        '.a{fill:image-set("https://evil.example/x.png" 1x)}',
        '.a{fill:-webkit-image-set("https://evil.example/x.png" 1x)}',
        '@font-face{font-family:f;src:\\75rl("https://evil.example/f.woff")}',
        ".a{fill:UR\\4c(https://evil.example/x.png)}",
    ],
)
def test_css_escapes_cannot_hide_an_external_reference(css):
    assert "evil.example" not in clean(f"<style>{css}</style><rect/>")
    assert "evil.example" not in clean(f'<rect width="1" height="1" style={quoteattr(css)}/>')


@pytest.mark.parametrize("attribute", ["fill", "stroke", "filter", "mask", "clip-path"])
def test_escaped_url_in_a_presentation_attribute_is_dropped(attribute):
    out = clean(f'<rect width="1" height="1" {attribute}="u\\72l(https://evil.example/x.svg#a)"/>')
    assert "evil.example" not in out


def test_css_that_only_looks_odd_still_passes():
    assert "<style" in clean(r"<style>/* note */ .a{font-family:'Fancy\ Font';fill:url(#g)}</style><rect/>")
    assert 'transform="translate(1 2)"' in clean('<rect width="1" height="1" transform="translate(1 2)"/>')


def test_doctype_entities_and_xxe_are_rejected():
    bomb = b'<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><svg xmlns="http://www.w3.org/2000/svg">&b;</svg>'
    xxe = b'<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>'
    for payload in (bomb, xxe):
        with pytest.raises(SvgError):
            sanitize_svg(payload)


@pytest.mark.parametrize("payload", [b"", b"not xml", b"<html/>", b'<svg xmlns="http://example.com/other"/>'])
def test_rejects_non_svg(payload):
    with pytest.raises(SvgError):
        sanitize_svg(payload)


def test_rejects_oversized_and_overly_deep_documents():
    with pytest.raises(SvgError):
        sanitize_svg(b"<svg xmlns='http://www.w3.org/2000/svg'>" + b"<g>" * 200 + b"</g>" * 200 + b"</svg>")
    with pytest.raises(SvgError):
        sanitize_svg(
            b"<svg xmlns='http://www.w3.org/2000/svg'><!--" + b"a" * (6 * 1024 * 1024) + b"--></svg>"
        )


def test_foreign_namespaces_are_removed():
    out = clean(
        '<sodipodi:namedview xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"/><rect inkscape:x="1" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="1" height="1"/>'
    )
    assert "sodipodi" not in out and "inkscape" not in out


def test_info_and_colors():
    data = sanitize_svg(
        b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><path fill="#F00" stroke="#00ff00" d="M0 0"/></svg>'
    )
    info = svg_info(data)
    assert (info.width, info.height) == (200, 100)
    assert svg_colors(data) == ["#ff0000", "#00ff00"]
    with_units = sanitize_svg(b'<svg xmlns="http://www.w3.org/2000/svg" width="2in" height="1in"/>')
    assert svg_info(with_units).width == 192


# ---- hyperlinks (opt-in, used by the PDF export) ----------------------------------------------------


def linked(href: str, attr: str = "href", **options) -> str:
    body = f'<a {attr}={quoteattr(href)}><rect width="5" height="5"/></a>'
    return sanitize_svg(SVG.format(attrs='viewBox="0 0 10 10"', body=body).encode(), **options).decode()


@pytest.mark.parametrize(
    "href",
    [
        "https://example.com",
        "http://example.com/a/b?x=1&y=2#frag",
        "HTTPS://EXAMPLE.COM/Path",
        "https://example.com:8443/x",
        "https://[2001:db8::1]/x",
        "mailto:someone@example.com",
        "mailto:someone@example.com?subject=Hello%20there",
        "https://münchen.example/straße",
    ],
)
@pytest.mark.parametrize("attr", ["href", "xlink:href"])
def test_safe_links_survive_when_links_are_allowed(href, attr):
    out = linked(href, attr, allow_links=True)
    assert "<a" in out and "<rect" in out
    assert (href.replace("&", "&amp;")) in out


@pytest.mark.parametrize(
    "href",
    [
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        " javascript:alert(1)",
        "java\tscript:alert(1)",
        "java&#10;script:alert(1)",
        "&#106;avascript:alert(1)",
        "vbscript:msgbox(1)",
        "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
        "data:image/svg+xml,<svg/>",
        "file:///etc/passwd",
        "ftp://example.com/x",
        "tel:+15551234567",
        "sms:+15551234567",
        "blob:https://example.com/uuid",
        "ws://example.com",
        "//evil.example/x",
        "/relative/path",
        "relative/path",
        "../up",
        "?query=only",
        "example.com",
        "https:/example.com",
        "https:///nohost",
        "https://",
        "http://user:pass@example.com/",
        "https://trusted.example@evil.example/",
        "https://example.com/a b",
        "https://exa​mple.com",
        "https://example.com:99999999/",
        "https://example.com:abc/",
        "mailto:",
        "mailto://example.com",
        "x" * 3000,
        "",
        "   ",
    ],
)
@pytest.mark.parametrize("attr", ["href", "xlink:href"])
def test_unsafe_links_lose_their_address(href, attr):
    out = linked(href, attr, allow_links=True).lower()
    assert "href" not in out and "javascript" not in out and "evil.example" not in out


def test_the_link_wrapper_keeps_its_content_but_never_a_target_or_ping():
    body = '<a href="https://example.com" target="_blank" ping="https://t.example/p" download="x" rel="opener" onclick="x()"><path d="M0 0"/></a>'
    out = sanitize_svg(SVG.format(attrs='viewBox="0 0 10 10"', body=body).encode(), allow_links=True).decode()
    assert 'href="https://example.com"' in out and "<path" in out
    for banned in ("target", "ping", "download", "rel=", "onclick", "t.example"):
        assert banned not in out


def test_links_are_removed_with_their_content_unless_allowed():
    out = linked("https://example.com")
    assert "<a" not in out and "<rect" not in out and "example.com" not in out


def test_a_link_to_an_element_inside_the_drawing_is_kept_only_when_links_are_allowed():
    assert "#part" in linked("#part", allow_links=True)
    assert "<a" not in linked("#part")


def test_other_elements_never_keep_an_external_address():
    out = sanitize_svg(
        SVG.format(attrs='viewBox="0 0 10 10"', body='<use href="https://example.com/x.svg#a"/>').encode(),
        allow_links=True,
    ).decode()
    assert "example.com" not in out


def test_nested_and_transformed_links():
    body = '<g><a href="https://a.example"><a href="https://b.example" transform="translate(1 2)"><rect width="1" height="1"/></a></a></g>'
    out = sanitize_svg(SVG.format(attrs='viewBox="0 0 10 10"', body=body).encode(), allow_links=True).decode()
    assert out.count("<a") == 2 and 'transform="translate(1 2)"' in out


@pytest.mark.parametrize(
    "value",
    [
        "https://example.com/\u0000",
        "https://example.com/\x07",
        "https://exa\u00a0mple.com",
        "https://exa\u2028mple.com",
    ],
)
def test_control_characters_and_odd_spaces_are_refused_even_where_xml_cannot_carry_them(value):
    assert safe_link(value) is None


def test_safe_link_strips_surrounding_space_only():
    assert safe_link("  https://example.com/x \n") == "https://example.com/x"


def _use_bomb(levels: int, fan_out: int) -> str:
    """`levels` groups, each drawing the previous one `fan_out` times: fan_out ** levels rectangles."""
    groups = ['<g id="g0"><rect width="1" height="1"/></g>']
    for level in range(1, levels):
        groups.append(f'<g id="g{level}">' + f'<use href="#g{level - 1}"/>' * fan_out + "</g>")
    return f'<defs>{"".join(groups)}</defs><use href="#g{levels - 1}"/>'


def test_a_small_drawing_that_expands_exponentially_is_refused():
    with pytest.raises(SvgError, match="too complex"):
        clean(_use_bomb(10, 10))


def test_a_use_cycle_is_refused():
    with pytest.raises(SvgError, match="too complex"):
        clean('<g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g>')


def test_a_very_long_chain_of_uses_is_refused_without_a_stack_overflow():
    chain = "".join(f'<g id="c{i}"><use href="#c{i - 1}"/></g>' for i in range(399, 0, -1))
    chain += '<g id="c0"><rect width="1" height="1"/></g>'
    with pytest.raises(SvgError, match="too complex"):
        clean(chain)


def test_ordinary_sprites_and_repeated_symbols_are_fine():
    out = clean(
        '<defs><symbol id="s"><path d="M0 0h1v1z"/><circle r="1"/></symbol></defs>'
        + "".join(f'<use href="#s" x="{i}"/>' for i in range(2000))
    )
    assert out.count("<use") == 2000
