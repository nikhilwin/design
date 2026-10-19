from __future__ import annotations

from typing import Any

from django.core.files.base import ContentFile

from apps.elements.models import Element, ElementPack

RED_SQUARE = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20" width="40" height="20">'
    '<rect width="40" height="20" fill="#e11d48"/></svg>'
)
CURRENT_COLOR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="currentColor"/></svg>'
EVIL = (
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" '
    'onload="alert(1)"><script>alert(1)</script><foreignObject><div>x</div></foreignObject>'
    '<a xlink:href="javascript:alert(1)"><circle r="1"/></a>'
    '<rect width="10" height="10" fill="#ff0000" onclick="x()"/>'
    '<image href="https://evil.example/x.png" width="1" height="1"/></svg>'
)


def make_pack(slug: str = "shapes", **kwargs: Any) -> ElementPack:
    kwargs.setdefault("name", slug.replace("-", " ").title())
    kwargs.setdefault("license", "CC0-1.0")
    return ElementPack.objects.create(slug=slug, **kwargs)


def make_element(
    pack: ElementPack | None = None, name: str = "Square", svg: str = RED_SQUARE, **kwargs: Any
) -> Element:
    element = Element(
        pack=pack or ElementPack.objects.first() or make_pack(),
        name=name,
        svg=ContentFile(svg.encode(), name="x.svg"),
        **kwargs,
    )
    element.save()
    return element
