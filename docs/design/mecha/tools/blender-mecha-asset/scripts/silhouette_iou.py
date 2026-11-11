#!/usr/bin/env python3
"""Objective "does it look like the concept" score: IoU between two silhouettes.

    python3 silhouette_iou.py concept_silhouette.png render_silhouette.png [--overlay out.png]
                              [--ref-thresh 100] [--ours-thresh 128]

Both images are binarized (dark = shape), cropped to their shape bounding box, scaled to the same
HEIGHT (aspect kept, so width/stance errors still show), bottom-centred on a shared canvas, and
compared. Prints IoU plus width/height ratios. Render the model with mk.shot(..., silhouette=True)
from a camera matched to the concept's angle; a 3/4 concept needs a 3/4 render, not a front one.

Typical gates: blockout ≥ 0.80, primary forms ≥ 0.85.
"""
import argparse

from PIL import Image, ImageChops, ImageStat


def mask(path, thresh):
    im = Image.open(path).convert("L")
    m = im.point(lambda v: 255 if v < thresh else 0)
    bb = m.getbbox()
    if not bb:
        raise SystemExit("no shape found in %s (threshold %d)" % (path, thresh))
    return m.crop(bb)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ref"); ap.add_argument("ours")
    ap.add_argument("--overlay")
    ap.add_argument("--ref-thresh", type=int, default=100)
    ap.add_argument("--ours-thresh", type=int, default=128)
    ap.add_argument("--height", type=int, default=600)
    a = ap.parse_args()
    r, o = mask(a.ref, a.ref_thresh), mask(a.ours, a.ours_thresh)
    H = a.height
    r = r.resize((max(1, round(r.width * H / r.height)), H), Image.NEAREST)
    o = o.resize((max(1, round(o.width * H / o.height)), H), Image.NEAREST)
    W = max(r.width, o.width) + 20
    cr, co = Image.new("L", (W, H), 0), Image.new("L", (W, H), 0)
    cr.paste(r, ((W - r.width) // 2, 0)); co.paste(o, ((W - o.width) // 2, 0))
    inter = ImageStat.Stat(ImageChops.multiply(cr, co)).sum[0] / 255.0
    union = ImageStat.Stat(ImageChops.lighter(cr, co)).sum[0] / 255.0
    iou = inter / union if union else 0.0
    print("IoU=%.3f  ref W/H=%.3f  ours W/H=%.3f" % (iou, r.width / H, o.width / H))
    if a.overlay:
        # red = concept only, cyan = model only, dark grey = both
        only_r = ImageChops.subtract(cr, co); only_o = ImageChops.subtract(co, cr); both = ImageChops.multiply(cr, co)
        R = ImageChops.lighter(only_r, both.point(lambda v: 60 if v else 0))
        G = ImageChops.lighter(only_o, both.point(lambda v: 60 if v else 0))
        B = ImageChops.lighter(only_o, both.point(lambda v: 60 if v else 0))
        bg = Image.new("RGB", (W, H), (255, 255, 255))
        ov = Image.merge("RGB", (R, G, B))
        any_ = ImageChops.lighter(cr, co)
        bg.paste(ov, (0, 0), any_)
        bg.save(a.overlay)
        print("overlay:", a.overlay)


if __name__ == "__main__":
    main()
