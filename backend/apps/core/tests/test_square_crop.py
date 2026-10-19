from __future__ import annotations

from io import BytesIO

import pytest
from PIL import Image

from apps.core.images import ImageError, square_crop_webp


def encode(size, fmt="PNG", mode="RGB", **save) -> bytes:
    buf = BytesIO()
    color = {"RGB": (225, 29, 72), "RGBA": (225, 29, 72, 100), "L": 128, "P": 3}[mode]
    Image.new(mode, size, color).save(buf, fmt, **save)
    return buf.getvalue()


def decode(data: bytes) -> Image.Image:
    image = Image.open(BytesIO(data))
    image.load()
    return image


@pytest.mark.parametrize("size", [(300, 100), (100, 300), (512, 512), (10, 10), (2000, 1500)])
def test_output_is_always_the_requested_square(size):
    image = decode(square_crop_webp(encode(size)))
    assert image.format == "WEBP" and image.size == (512, 512)


def test_custom_size():
    assert decode(square_crop_webp(encode((300, 100)), size=64)).size == (64, 64)


def test_crop_is_centred():
    wide = Image.new("RGB", (300, 100), (255, 0, 0))
    wide.paste(Image.new("RGB", (100, 100), (0, 0, 255)), (100, 0))  # blue square in the middle
    buf = BytesIO()
    wide.save(buf, "PNG")
    out = decode(square_crop_webp(buf.getvalue(), size=100)).convert("RGB")
    for point in ((50, 50), (2, 50), (97, 50)):  # centre and both edges: the red flanks are cut away
        r, _, b = out.getpixel(point)
        assert b > 200 and r < 60


def test_alpha_is_kept():
    image = decode(square_crop_webp(encode((30, 30), mode="RGBA")))
    assert "A" in image.getbands()
    assert image.convert("RGBA").getpixel((5, 5))[3] < 255


@pytest.mark.parametrize("mode", ["L", "P"])
def test_other_modes_are_converted(mode):
    assert decode(square_crop_webp(encode((20, 20), mode=mode))).size == (512, 512)


def test_metadata_is_stripped():
    exif = Image.Exif()
    exif[0x010E] = "private description"
    data = encode((40, 40), "JPEG", exif=exif)
    assert b"private description" in data
    assert b"private description" not in square_crop_webp(data)


def test_exif_orientation_is_applied():
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 degrees clockwise to display
    img = Image.new("RGB", (200, 100), (255, 0, 0))
    img.paste(Image.new("RGB", (100, 100), (0, 0, 255)), (100, 0))
    buf = BytesIO()
    img.save(buf, "JPEG", exif=exif, quality=100)
    out = decode(square_crop_webp(buf.getvalue(), size=100)).convert("RGB")
    top, bottom = out.getpixel((50, 10)), out.getpixel((50, 90))
    assert top[0] > 200 and bottom[2] > 200  # red moved to the top, blue to the bottom


def test_animated_input_uses_the_first_frame():
    frames = [Image.new("RGB", (40, 40), c) for c in ((255, 0, 0), (0, 0, 255))]
    buf = BytesIO()
    frames[0].save(buf, "GIF", save_all=True, append_images=frames[1:], duration=40, loop=0)
    out = decode(square_crop_webp(buf.getvalue(), size=40)).convert("RGB")
    assert out.getpixel((20, 20))[0] > 200


@pytest.mark.parametrize("data", [b"", b"not an image", b"\x89PNG\r\n\x1a\n"])
def test_garbage_is_rejected(data):
    with pytest.raises(ImageError):
        square_crop_webp(data)


def test_process_image_upload_can_cap_pixels_below_the_global_limit():
    from apps.core.images import process_image_upload

    data = BytesIO(encode((300, 300)))
    with pytest.raises(ImageError, match="dimensions"):
        process_image_upload(data, max_bytes=1_000_000, max_pixels=10_000)
    assert (
        process_image_upload(BytesIO(encode((300, 300))), max_bytes=1_000_000, max_pixels=100_000).width
        == 300
    )
