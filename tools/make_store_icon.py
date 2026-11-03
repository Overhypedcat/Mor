"""Draws Mor's icon (extension/icons/mor.svg: a purple smiley, white eyes and smile) as the PNG the add-on store's
listing takes, drawn 8 times bigger and scaled down so every edge is smooth. Needs Pillow:

    python tools/make_store_icon.py            -> store/icon-128.png
"""
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 128
SCALE = 8  # drawn this many times bigger, then scaled down: smooth edges
PURPLE = (145, 70, 255, 255)  # #9146ff
WHITE = (255, 255, 255, 255)


def draw(size=SIZE, scale=SCALE):
    big = size * scale
    k = big / 128  # the SVG's units (a 128 box) to pixels
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([(64 - 62) * k, (64 - 62) * k, (64 + 62) * k, (64 + 62) * k], fill=PURPLE)
    for cx in (44, 84):  # eyes: ellipses 9 x 13 around (cx, 50)
        d.ellipse([(cx - 9) * k, (50 - 13) * k, (cx + 9) * k, (50 + 13) * k], fill=WHITE)
    # the smile: the SVG's quadratic curve M34 76 Q64 108 94 76, 11 wide with round ends
    points = []
    for i in range(201):
        t = i / 200
        x = (1 - t) ** 2 * 34 + 2 * (1 - t) * t * 64 + t ** 2 * 94
        y = (1 - t) ** 2 * 76 + 2 * (1 - t) * t * 108 + t ** 2 * 76
        points.append((x * k, y * k))
    r = 5.5 * k
    for x, y in points:
        d.ellipse([x - r, y - r, x + r, y + r], fill=WHITE)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    out = Path(__file__).resolve().parents[1] / "store" / "icon-128.png"
    out.parent.mkdir(exist_ok=True)
    draw().save(out)
    print(out)
