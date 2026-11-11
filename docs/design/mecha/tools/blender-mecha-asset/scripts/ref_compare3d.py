# 3D similarity of hand-built parts vs an AI reference mesh, per part (run inside Blender after
# exec(open(MK).read()); exec(open(REF_FIT).read()); exec(open(REF_COMPARE3D).read())).
#
# Why 3D and not images: silhouette IoU at one camera rewards anything that covers the same pixels
# (a box can score like a shell), and says nothing about depth, the back, or where a part sits.
# These metrics compare the geometry itself:
#   - vox_iou     volumetric IoU of the two SOLIDS (voxelized; interior = not reachable from outside,
#                 so AI meshes with double sheets and small holes still fill correctly)
#   - cd_mean     symmetric mean surface distance (m): area-uniform samples on each surface, distance
#                 to the nearest point of the other surface, averaged both ways
#   - d95         95th percentile of those distances (m): "how far are the worst places"
#   Surface metrics use OUTER surface only (samples buried > erode voxels inside their own solid are
#   dropped), so hidden axles, cores and an AI mesh's inner sheets do not count as shape error.
#   - f_score     F-score at tau (m): precision = share of our surface within tau of the reference,
#                 recall = share of the reference surface within tau of ours
#   - centroid_off  distance between solid centroids (m) = placement error
# Each part is scored twice: "raw" (as placed: shape + placement) and "aligned" (our solid translated
# so the centroids coincide: shape only). A part that is good aligned but bad raw is misplaced;
# bad in both is a shape difference.
import numpy as np
from mathutils.bvhtree import BVHTree


def _area_samples(t, n, rng):
    a = np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1) / 2
    if a.sum() <= 0:
        return np.zeros((0, 3))
    idx = rng.choice(len(t), size=n, p=a / a.sum())
    r1, r2 = rng.random(n), rng.random(n)
    s = np.sqrt(r1)
    u, v, w = 1 - s, s * (1 - r2), s * r2
    tt = t[idx]
    return tt[:, 0] * u[:, None] + tt[:, 1] * v[:, None] + tt[:, 2] * w[:, None]


def _bvh(t):
    verts = [tuple(p) for p in t.reshape(-1, 3)]
    polys = [(3 * i, 3 * i + 1, 3 * i + 2) for i in range(len(t))]
    return BVHTree.FromPolygons(verts, polys, all_triangles=True)


def _dists(points, tree):
    out = np.empty(len(points))
    for i, p in enumerate(points):
        loc, _, _, d = tree.find_nearest(Vector(p))
        out[i] = d if loc is not None else 1e9
    return out


def _dilate(m, k):
    for _ in range(k):
        g = m.copy()
        g[1:] |= m[:-1]; g[:-1] |= m[1:]; g[:, 1:] |= m[:, :-1]; g[:, :-1] |= m[:, 1:]
        g[:, :, 1:] |= m[:, :, :-1]; g[:, :, :-1] |= m[:, :, 1:]
        m = g
    return m


def _solid(t, lo, shape, res, rng, seal=1):
    """Voxel solid: mark surface voxels (dense samples), flood the exterior from the border,
    everything not exterior is solid.
    seal: the surface is dilated by `seal` voxels before flooding and the solid eroded back after,
    so gaps < 2·seal voxels do not let the flood into the interior. Hand-built parts with grooves,
    raised plates and engraved pockets are often not watertight; unsealed, the Assault left and
    right shin armour (mirror images) measured 125 vs 16 m³, depending only on grid alignment."""
    a = np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1).sum() / 2
    n = int(min(4e6, max(2e4, a / (res * res) * 12)))
    p = _area_samples(t, n, rng)
    ijk = np.floor((p - lo) / res).astype(int)
    ijk = ijk[np.all((ijk >= 0) & (ijk < shape), axis=1)]
    surf = np.zeros(shape, bool); surf[ijk[:, 0], ijk[:, 1], ijk[:, 2]] = True
    ext = np.zeros(shape, bool)
    barrier = _dilate(surf, seal) if seal else surf
    ext[0, :, :] = ext[-1, :, :] = ext[:, 0, :] = ext[:, -1, :] = ext[:, :, 0] = ext[:, :, -1] = True
    ext &= ~barrier
    while True:
        g = ext.copy()
        g[1:] |= ext[:-1]; g[:-1] |= ext[1:]; g[:, 1:] |= ext[:, :-1]; g[:, :-1] |= ext[:, 1:]
        g[:, :, 1:] |= ext[:, :, :-1]; g[:, :, :-1] |= ext[:, :, 1:]
        g &= ~barrier
        if (g == ext).all():
            break
        ext = g
    return ~_dilate(ext, seal) if seal else ~ext   # erode the solid back by the seal width


def compare3d(ta, tb, res=0.12, tau=0.3, n=20000, seed=0, erode=2):
    """ta = our triangles, tb = reference triangles (N, 3, 3) in world metres."""
    rng = np.random.default_rng(seed)
    out = {}
    pts = np.concatenate([ta.reshape(-1, 3), tb.reshape(-1, 3)])
    lo = pts.min(0) - 3 * res; hi = pts.max(0) + 3 * res
    shape = tuple(np.ceil((hi - lo) / res).astype(int) + 1)
    sa, sb = _solid(ta, lo, shape, res, rng), _solid(tb, lo, shape, res, rng)
    grid = np.stack(np.meshgrid(*[np.arange(s) for s in shape], indexing="ij"), -1)
    ca = (grid[sa].mean(0) + 0.5) * res + lo; cb = (grid[sb].mean(0) + 0.5) * res + lo
    tree_a, tree_b = _bvh(ta), _bvh(tb)
    pa, pb = _area_samples(ta, n, rng), _area_samples(tb, n, rng)
    # Outer surface only: drop samples buried inside their own solid (eroded by `erode` voxels).
    # Hidden geometry (axles through a leg, inner cores, an AI mesh's inner double sheet) is not
    # "extra shape", but counted as far-from-reference surface it cost the Assault right leg 7
    # points and made correct axles look like a regression.
    if erode:
        def _outer(p, s, lo_, shape_):
            e = s.copy()
            for _ in range(erode):
                e2 = e.copy()
                e2[1:] &= e[:-1]; e2[:-1] &= e[1:]; e2[:, 1:] &= e[:, :-1]; e2[:, :-1] &= e[:, 1:]
                e2[:, :, 1:] &= e[:, :, :-1]; e2[:, :, :-1] &= e[:, :, 1:]
                e2[0] = e2[-1] = False; e2[:, 0] = e2[:, -1] = False; e2[:, :, 0] = e2[:, :, -1] = False
                e = e2
            ijk = np.clip(np.floor((p - lo_) / res).astype(int), 0, np.array(shape_) - 1)
            return p[~e[ijk[:, 0], ijk[:, 1], ijk[:, 2]]]
        pa, pb = _outer(pa, sa, lo, shape), _outer(pb, sb, lo, shape)
    out["outer_samples"] = [len(pa), len(pb)]
    for mode in ("raw", "aligned"):
        if mode == "aligned":
            d = cb - ca
            ta2 = ta + d
            pts = np.concatenate([ta2.reshape(-1, 3), tb.reshape(-1, 3)])
            lo2 = pts.min(0) - 3 * res; hi2 = pts.max(0) + 3 * res
            shape2 = tuple(np.ceil((hi2 - lo2) / res).astype(int) + 1)
            s_a, s_b = _solid(ta2, lo2, shape2, res, rng), _solid(tb, lo2, shape2, res, rng)
            t_a = _bvh(ta2); p_a = pa + d
        else:
            s_a, s_b, t_a, p_a = sa, sb, tree_a, pa
        iou = float((s_a & s_b).sum() / max(1, (s_a | s_b).sum()))
        dab, dba = _dists(p_a, tree_b), _dists(pb, t_a)
        prec, rec = float((dab < tau).mean()), float((dba < tau).mean())
        f = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
        out[mode] = {"vox_iou": round(iou, 3), "cd_mean": round(float((dab.mean() + dba.mean()) / 2), 3),
                     "d95": round(float(np.percentile(np.concatenate([dab, dba]), 95)), 3),
                     "precision": round(prec, 3), "recall": round(rec, 3), "f_score": round(f, 3),
                     "score": round(100 * (0.5 * iou + 0.5 * f), 1)}
    vol = lambda s: float(s.sum() * res ** 3)
    out["centroid_off"] = round(float(np.linalg.norm(cb - ca)), 3)
    out["centroid_delta"] = [round(float(v), 2) for v in (cb - ca)]   # reference minus ours
    out["volume_ratio"] = round(vol(sa) / max(1e-9, vol(sb)), 3)      # ours / reference
    ext = lambda t: [round(float(v), 2) for v in (t.reshape(-1, 3).max(0) - t.reshape(-1, 3).min(0))]
    out["size_ours"], out["size_ref"] = ext(ta), ext(tb)
    return out


def our_distance_colors(objs, tb, name="ref_dev", cap=1.0):
    """Paint each of our vertices by its distance to the reference surface (blue 0 → red ≥ cap m),
    into a color attribute `name`, for a deviation heat-map render (Workbench color_type ATTRIBUTE)."""
    tree = _bvh(tb)
    for o in objs:
        me = o.data
        if name in me.color_attributes:
            me.color_attributes.remove(me.color_attributes[name])
        ca = me.color_attributes.new(name, "BYTE_COLOR", "POINT")
        mw = o.matrix_world
        for i, v in enumerate(me.vertices):
            loc, _, _, d = tree.find_nearest(mw @ v.co)
            x = min(1.0, (d if loc is not None else cap) / cap)
            ca.data[i].color = (x, max(0.0, 1 - abs(x - 0.5) * 2) * 0.8, 1 - x, 1.0)
        me.color_attributes.active_color = ca
