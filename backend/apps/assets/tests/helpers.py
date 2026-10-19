"""Builders for in-memory test files (shared by the workspace apps' tests)."""

from __future__ import annotations

import os
from io import BytesIO

from django.core.files.uploadedfile import SimpleUploadedFile
from PIL import Image

SAFE_SVG = b'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#ff0000"/></svg>'

HOSTILE_SVG = b"""<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
  width="100" height="50" onload="alert(1)">
  <script>alert(document.cookie)</script>
  <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
  <a xlink:href="javascript:alert(1)"><rect width="10" height="10" fill="#00f" onclick="alert(2)"/></a>
  <image href="https://evil.example/track.png" width="5" height="5"/>
  <circle cx="5" cy="5" r="5" fill="#123456"/>
</svg>"""


def image_bytes(fmt: str = "PNG", size: tuple[int, int] = (64, 32), mode: str = "RGB", **save) -> bytes:
    buffer = BytesIO()
    color = {"RGB": (200, 30, 60), "RGBA": (200, 30, 60, 128), "L": 128}[mode]
    Image.new(mode, size, color).save(buffer, fmt, **save)
    return buffer.getvalue()


def noisy_png(size: tuple[int, int] = (200, 200)) -> bytes:
    """An incompressible PNG, so its byte size is predictable and large."""
    buffer = BytesIO()
    Image.frombytes("RGB", size, os.urandom(size[0] * size[1] * 3)).save(buffer, "PNG")
    return buffer.getvalue()


def jpeg_with_exif(orientation: int = 6, size: tuple[int, int] = (40, 20)) -> bytes:
    exif = Image.Exif()
    exif[0x0112] = orientation
    exif[0x010F] = "SecretCameraMaker"
    return image_bytes("JPEG", size, exif=exif.tobytes())


def upload(data: bytes, name: str = "file.png", content_type: str = "image/png") -> SimpleUploadedFile:
    return SimpleUploadedFile(name, data, content_type=content_type)
