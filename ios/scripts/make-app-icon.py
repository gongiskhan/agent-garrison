#!/usr/bin/env python3
"""Render the companion's app icon: the Garrison palisade in the companion's
own palette.

The mark is Garrison's (four pickets, the outer pair short, the inner pair
tall, crossed by a rail) so the association reads at a glance. The palette is
the companion's, sampled from the icon it replaces - deep navy ground, ice
pickets, and the green accent standing in for Garrison's brass rail - so the
two apps never get confused in a dock or a notification.

    python3 ios/scripts/make-app-icon.py [variant] [out.png]

Output is 1024x1024 RGB with NO alpha channel (App Store rejects alpha).
Requires Pillow (pip install pillow).
"""
import sys

from PIL import Image, ImageDraw

# Sampled from the waveform icon this replaces.
NAVY_TOP = (24, 44, 76)
NAVY_BOTTOM = (11, 26, 51)
ICE = (237, 241, 247)
GREEN = (89, 172, 141)

S = 1024


def background():
    """Diagonal navy gradient, drawn small and upscaled for a smooth ramp."""
    n = 64
    ramp = Image.new("RGB", (n, n))
    px = ramp.load()
    for y in range(n):
        for x in range(n):
            # Diagonal: top-left lightest, bottom-right darkest.
            t = (x / (n - 1) * 0.35) + (y / (n - 1) * 0.65)
            px[x, y] = tuple(
                round(NAVY_TOP[i] + (NAVY_BOTTOM[i] - NAVY_TOP[i]) * t) for i in range(3)
            )
    return ramp.resize((S, S), Image.BICUBIC)


def shade(color, factor):
    return tuple(max(0, min(255, round(c * factor))) for c in color)


def picket(draw, x, top_y, width, bottom_y, peak_h):
    """One picket: a rectangle with a pointed head, lit from the left."""
    apex = (x + width / 2, top_y)
    left = (x, top_y + peak_h)
    right = (x + width, top_y + peak_h)
    draw.polygon([apex, right, (x + width, bottom_y), (x, bottom_y), left], fill=ICE)
    # Side shading: a light edge left, a darker edge right, so the pickets read
    # as timber rather than flat bars at small sizes.
    edge = max(2, round(width * 0.09))
    draw.rectangle([x, top_y + peak_h, x + edge, bottom_y], fill=shade(ICE, 1.02))
    draw.rectangle([x + width - edge, top_y + peak_h, x + width, bottom_y], fill=shade(ICE, 0.80))
    # Faint grain.
    for frac in (0.32, 0.62):
        gx = round(x + width * frac)
        draw.line([(gx, top_y + peak_h + 6), (gx, bottom_y - 6)], fill=shade(ICE, 0.90), width=2)


def vignette(img):
    """Push the corners back so the mark sits forward - same trick as the
    Garrison icon, and it keeps the palisade from crowding iOS's rounded
    mask."""
    n = 128
    mask = Image.new("L", (n, n), 0)
    md = ImageDraw.Draw(mask)
    for i in range(n // 2, 0, -1):
        # 0 at the centre, up to ~90 at the corners.
        v = round(58 * (1 - i / (n / 2)) ** 2)
        md.ellipse([n / 2 - i, n / 2 - i, n / 2 + i, n / 2 + i], fill=v)
    mask = Image.eval(mask, lambda v: 58 - v).resize((S, S), Image.BICUBIC)
    return Image.composite(Image.new("RGB", (S, S), (0, 0, 0)), img, mask.point(lambda v: v))


def render(variant="palisade"):
    img = background()
    draw = ImageDraw.Draw(img)

    # Geometry ported from public/icons/icon.svg (the Garrison mark), doubled
    # to 1024 and nudged so the whole palisade sits inside iOS's rounded mask
    # with the optical centre a touch above the geometric one.
    width = 128
    gap = 64
    left = 160
    body_bottom = 820
    tall_top, tall_peak = 204, 104
    short_top, short_peak = 248, 100

    if variant != "floating":
        # Garrison's earthwork band, kept subtle: a step of a few values, not a
        # stripe, so iOS's rounded mask never turns it into a bright chord.
        draw.rectangle([0, body_bottom, S, S], fill=shade(NAVY_BOTTOM, 0.74))
        draw.rectangle([0, body_bottom, S, body_bottom + 3], fill=shade(NAVY_TOP, 1.06))

    xs = [left + i * (width + gap) for i in range(4)]
    for i, x in enumerate(xs):
        if i % 2 == 0:
            picket(draw, x, short_top, width, body_bottom, short_peak)
        else:
            picket(draw, x, tall_top, width, body_bottom, tall_peak)

    # The rail - Garrison's brass, in the companion's green.
    rail_y, rail_h = 496, 56
    rail_x0, rail_x1 = left - 24, xs[-1] + width + 24
    # Contact shadow, so the rail sits ON the pickets instead of beside them.
    draw.rounded_rectangle(
        [rail_x0, rail_y + rail_h - 2, rail_x1, rail_y + rail_h + 14], radius=8, fill=shade(ICE, 0.72)
    )
    draw.rounded_rectangle([rail_x0, rail_y, rail_x1, rail_y + rail_h], radius=8, fill=GREEN)
    draw.rounded_rectangle(
        [rail_x0, rail_y, rail_x1, rail_y + round(rail_h * 0.34)], radius=8, fill=shade(GREEN, 1.16)
    )
    draw.rectangle([rail_x0, rail_y + rail_h - 8, rail_x1, rail_y + rail_h], fill=shade(GREEN, 0.68))

    # Pin heads where the rail crosses each picket.
    for x in xs:
        cx, cy = x + width / 2, rail_y + rail_h / 2
        r = 7
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=shade(GREEN, 0.60))

    return vignette(img).convert("RGB")  # no alpha, ever


if __name__ == "__main__":
    variant = sys.argv[1] if len(sys.argv) > 1 else "palisade"
    out = sys.argv[2] if len(sys.argv) > 2 else "AppIcon-1024.png"
    render(variant).save(out, "PNG")
    print(f"wrote {out} ({variant})")
