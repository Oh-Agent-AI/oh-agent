#!/usr/bin/env python3
"""Measure a concept view: crop a region, find the figure, print its width profile per 5% of height
in METERS, and save a zoomed copy with height gridlines for reading joint heights by eye.

    python3 ref_measure.py board.png --box X0 Y0 X1 Y1 --height-m 19.6 --out side_grid.png
                           [--mode bg|dark] [--bg R G B] [--tol 45]

--mode bg   : figure = pixels that differ from the background colour (painted views)
--mode dark : figure = dark pixels (silhouette insets)

Use a near-orthographic view (side/front) for heights. A 3/4 perspective view is good for matching a
camera, not for measuring. Check the printed bbox: if it touches the crop box the crop cut the figure.
"""
import argparse

from PIL import Image, ImageDraw


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--box", type=int, nargs=4, required=True)
    ap.add_argument("--height-m", type=float, required=True)
    ap.add_argument("--out")
    ap.add_argument("--mode", choices=["bg", "dark"], default="bg")
    ap.add_argument("--bg", type=int, nargs=3)
    ap.add_argument("--tol", type=int, default=45)
    a = ap.parse_args()
    im = Image.open(a.image).convert("RGB")
    px = im.load()
    X0, Y0, X1, Y1 = a.box
    bg = tuple(a.bg) if a.bg else px[X1 - 2, Y0 + 2]
    if a.mode == "dark":
        fg = lambda p: sum(p) < 200
    else:
        fg = lambda p: abs(p[0] - bg[0]) + abs(p[1] - bg[1]) + abs(p[2] - bg[2]) > a.tol
    ys = [y for y in range(Y0, Y1) if any(fg(px[x, y]) for x in range(X0, X1))]
    xs = [x for x in range(X0, X1) if any(fg(px[x, y]) for y in range(Y0, Y1))]
    top, bot, L, R = min(ys), max(ys) + 1, min(xs), max(xs)
    H = bot - top
    m = a.height_m / H
    print("figure bbox x %d..%d y %d..%d  (%d px tall, %.4f m/px)  W/H=%.3f" % (L, R, top, bot, H, m, (R - L + 1) / H))
    if L <= X0 or top <= Y0 or R >= X1 - 1 or bot >= Y1:
        print("WARNING: figure touches the crop box — widen --box, the crop may cut the figure")
    for k in range(20, -1, -1):
        y = int(bot - 1 - H * k / 20)
        segs, s = [], None
        for x in range(X0, X1 + 1):
            d = x < X1 and fg(px[x, y])
            if d and s is None:
                s = x
            if not d and s is not None:
                segs.append((s, x - 1)); s = None
        print("%3d%%  z=%5.2f m  spans(m from left): %s" % (
            k * 5, k * 0.05 * a.height_m, ", ".join("%.1f-%.1f" % ((p - L) * m, (q - L) * m) for p, q in segs if q - p > 1)))
    if a.out:
        c = im.crop((L - 4, top - 4, R + 4, bot + 4)); s = 3
        c = c.resize((c.width * s, c.height * s)); d = ImageDraw.Draw(c)
        for k in range(21):
            y = 4 * s + H * s * k / 20
            d.line([(0, y), (c.width, y)], fill=(255, 0, 0) if k % 2 == 0 else (255, 170, 0), width=1)
            if k % 2 == 0:
                d.text((2, y + 1), "%d%%" % (100 - 5 * k), fill=(255, 0, 0))
        c.save(a.out)
        print("grid:", a.out)


if __name__ == "__main__":
    main()
