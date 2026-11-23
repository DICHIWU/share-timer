#!/usr/bin/env python3
"""Generate the app icons (PNG) for 小組分享計時.

Usage:  python3 scripts/make-icons.py
Requires Pillow (pip install pillow). Output goes to ./icons/.
The generated PNGs are committed, so the app itself needs no build step.
"""
import math
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "icons")

BG = (21, 128, 61)        # #15803d (app green)
FACE = (255, 255, 255)
ACCENT = (220, 38, 38)    # #dc2626 (warning red)
HAND = (30, 41, 59)       # #1e293b

SS = 4  # supersampling factor for smooth edges


def draw_icon(size, glyph_scale, rounded=False):
    """Draw a stopwatch glyph centred on a solid background.

    glyph_scale: fraction of the canvas the stopwatch body diameter uses.
    rounded: round the background corners (for favicon only; iOS/Android mask themselves).
    """
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if rounded:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=BG)
    else:
        d.rectangle([0, 0, s, s], fill=BG)

    cx = s / 2
    cy = s / 2 + s * glyph_scale * 0.06  # nudge down to leave room for the crown
    r = s * glyph_scale / 2

    # Crown (top button) and stem
    stem_w = r * 0.22
    stem_h = r * 0.22
    d.rectangle([cx - stem_w / 2, cy - r - stem_h, cx + stem_w / 2, cy - r + r * 0.05], fill=FACE)
    crown_w = r * 0.5
    crown_h = r * 0.16
    d.rounded_rectangle(
        [cx - crown_w / 2, cy - r - stem_h - crown_h, cx + crown_w / 2, cy - r - stem_h + crown_h * 0.2],
        radius=int(crown_h / 2), fill=FACE,
    )
    # Side button (tilted, upper right)
    ang = math.radians(-45)
    bx = cx + math.cos(ang) * r * 1.02
    by = cy + math.sin(ang) * r * 1.02
    br = r * 0.11
    d.ellipse([bx - br, by - br, bx + br, by + br], fill=FACE)

    # Body ring
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=FACE)
    inner = r * 0.84
    d.ellipse([cx - inner, cy - inner, cx + inner, cy + inner], fill=BG)
    face = r * 0.76
    d.ellipse([cx - face, cy - face, cx + face, cy + face], fill=FACE)

    # Red "last 20 seconds" sector, like the app's warning colour
    d.pieslice([cx - face * 0.92, cy - face * 0.92, cx + face * 0.92, cy + face * 0.92],
               start=-90, end=-30, fill=ACCENT)
    cover = face * 0.62
    d.ellipse([cx - cover, cy - cover, cx + cover, cy + cover], fill=FACE)

    # Tick marks
    for i in range(12):
        a = math.radians(i * 30 - 90)
        outer = face * 0.93
        inner_t = face * (0.78 if i % 3 == 0 else 0.84)
        w = r * (0.07 if i % 3 == 0 else 0.04)
        d.line([cx + math.cos(a) * inner_t, cy + math.sin(a) * inner_t,
                cx + math.cos(a) * outer, cy + math.sin(a) * outer], fill=HAND, width=max(1, int(w)))

    # Hand pointing to "time's up" boundary (towards the red sector)
    a = math.radians(-30)
    hl = face * 0.7
    d.line([cx, cy, cx + math.cos(a) * hl, cy + math.sin(a) * hl], fill=HAND, width=int(r * 0.09))
    hub = r * 0.09
    d.ellipse([cx - hub, cy - hub, cx + hub, cy + hub], fill=HAND)

    return img.resize((size, size), Image.LANCZOS)


def save(img, name, flatten=True):
    path = os.path.join(OUT, name)
    if flatten:
        # Opaque PNGs (iOS renders transparency as black)
        bg = Image.new("RGB", img.size, BG)
        bg.paste(img, mask=img.split()[3])
        img = bg
    img.save(path, optimize=True)
    print("wrote", os.path.relpath(path, ROOT))


def main():
    os.makedirs(OUT, exist_ok=True)
    save(draw_icon(180, 0.66), "icon-180.png")
    save(draw_icon(192, 0.66), "icon-192.png")
    save(draw_icon(512, 0.66), "icon-512.png")
    # Maskable: keep the glyph inside the central 80% safe zone
    save(draw_icon(512, 0.54), "icon-maskable-512.png")
    save(draw_icon(32, 0.72, rounded=True), "favicon-32.png", flatten=False)


if __name__ == "__main__":
    main()
