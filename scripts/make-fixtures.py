#!/usr/bin/env python3
"""
Generate the test fixture set described in PLAN.md §7.

Run:  npm run fixtures      (or: python3 scripts/make-fixtures.py)

Fixtures are committed, so this only needs re-running when the set changes.
Images are kept deliberately small — what matters is aspect ratio, metadata
and filename shape, not absolute pixel count. The one exception is
`square-3000.jpg`, which must really be 3000x3000 to exercise the no-op path.

The Adobe RGB profile is read from the macOS ColorSync directory. On a machine
without it, that one fixture is skipped with a warning rather than failing the
whole run.
"""

import os
import struct
import sys

from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "test", "fixtures")
ADOBE_RGB = "/System/Library/ColorSync/Profiles/AdobeRGB1998.icc"


def gradient(w: int, h: int) -> Image.Image:
    """A recognisable, compressible test pattern with orientation cues."""
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    for x in range(0, w, 4):
        shade = int(255 * x / max(w - 1, 1))
        d.rectangle([x, 0, x + 4, h], fill=(shade, 80, 255 - shade))
    # A marker in the top-left corner so rotation bugs are visible by eye.
    d.rectangle([0, 0, w // 6, h // 12], fill=(255, 255, 0))
    return img


def save(img: Image.Image, name: str, **kw) -> None:
    path = os.path.join(OUT, name)
    img.save(path, **kw)
    print(f"  {name:<34} {os.path.getsize(path):>9,} bytes")


def exif_with_orientation(orientation: int) -> bytes:
    """
    Hand-build a minimal little-endian TIFF/EXIF block carrying just an
    Orientation tag. PIL's Exif helper is fine for this, but building it by
    hand keeps the fixture's bytes predictable for the unit tests.
    """
    # TIFF header: II, 42, offset-to-IFD0 = 8
    tiff = b"II" + struct.pack("<HI", 42, 8)
    # One entry: tag 0x0112 (Orientation), type 3 (SHORT), count 1
    entries = struct.pack("<HHIHH", 0x0112, 3, 1, orientation, 0)
    ifd = struct.pack("<H", 1) + entries + struct.pack("<I", 0)
    return b"Exif\x00\x00" + tiff + ifd


def inject_app1(jpeg_path: str, exif_payload: bytes) -> None:
    """Insert an APP1 segment straight after SOI of an existing JPEG."""
    with open(jpeg_path, "rb") as f:
        data = f.read()
    assert data[:2] == b"\xff\xd8", "not a JPEG"
    segment = b"\xff\xe1" + struct.pack(">H", len(exif_payload) + 2) + exif_payload
    with open(jpeg_path, "wb") as f:
        f.write(data[:2] + segment + data[2:])


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    print(f"Writing fixtures to {os.path.normpath(OUT)}")

    # 1. Already at target — the no-op case. Must genuinely be 3000x3000.
    save(gradient(3000, 3000), "square-3000.jpg", quality=70)

    # 2. Landscape 3:2 — heaviest stretch, compared against sips output.
    save(gradient(600, 400), "landscape-3x2.jpg", quality=85)

    # 3. Portrait carrying EXIF Orientation 6 (rotate 90° CW).
    #    The double-rotation trap: the decoder bakes the rotation into pixels,
    #    so the copied EXIF must come out as Orientation 1.
    p = os.path.join(OUT, "portrait-orientation6.jpg")
    gradient(400, 600).save(p, quality=85)
    inject_app1(p, exif_with_orientation(6))
    print(f"  {'portrait-orientation6.jpg':<34} {os.path.getsize(p):>9,} bytes  (EXIF Orientation=6)")

    # 4. Adobe RGB — proves we never emit sRGB pixels tagged as Adobe RGB.
    if os.path.exists(ADOBE_RGB):
        with open(ADOBE_RGB, "rb") as f:
            profile = f.read()
        save(gradient(500, 500), "adobergb-square.jpg", quality=85, icc_profile=profile)
    else:
        print(f"  !! skipped adobergb-square.jpg — {ADOBE_RGB} not found", file=sys.stderr)

    # 5. Filenames with spaces and accents — called out as a real gotcha in task.md.
    save(gradient(500, 500), "CARAMELCAFÉ.jpg", quality=80)
    save(gradient(500, 500), "OFF WHITE 90H.jpg", quality=80)

    # 6. PNG with transparency — lossless path, no metadata splice.
    rgba = Image.new("RGBA", (400, 400), (0, 0, 0, 0))
    ImageDraw.Draw(rgba).ellipse([50, 50, 350, 350], fill=(220, 40, 90, 255))
    save(rgba, "transparent.png")

    # 7. Triage cases: a real TIFF, and a text file wearing a .jpg extension.
    save(gradient(300, 300), "unsupported.tif", format="TIFF")
    with open(os.path.join(OUT, "corrupt.jpg"), "wb") as f:
        f.write(b"this is definitely not a JPEG\n")
    print(f"  {'corrupt.jpg':<34} {'30':>9} bytes  (deliberately invalid)")

    print("Done.")


if __name__ == "__main__":
    main()
