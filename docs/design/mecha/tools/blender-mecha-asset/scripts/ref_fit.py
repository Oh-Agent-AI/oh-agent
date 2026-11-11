# Fit hand-built parts to an AI image-to-3D reference mesh, part by part (run inside Blender after
# exec(open(MK).read()); then exec(open(REF_FIT).read())).
#
# Why: a reference ghost you only eyeball gets copied loosely, so plates stay wide slabs while the
# reference has tilted shells and faceted plates. This turns a reference part into numbers:
#   - orthographic masks of its triangles in front (XZ), side (YZ) and top (XY) views,
#   - simplified outlines of those masks, ready for mk.profile_intersect(front, side, top_xy=top),
#   - a per-view IoU between your part and the reference part (the per-part acceptance score).
# Optionally in a rotated local frame: the visual hull of a TILTED shell (pauldron) is a fat block in
# world axes, but nearly the shell itself in the shell's own frame.
import numpy as np

PLANES = {"XZ": (0, 2), "YZ": (1, 2), "XY": (0, 1)}


def tris_of(objs, crop=None, frame=None):
    """World-space triangles (N, 3, 3) of the evaluated meshes. crop = (lo, hi) world box tested on
    triangle centroids. frame = 4x4 Matrix: triangles are returned in that frame (frame⁻¹ · world)."""
    dg = bpy.context.evaluated_depsgraph_get()
    out = []
    inv = np.array(frame.inverted()) if frame is not None else None
    for o in objs:
        if o.type != "MESH":
            continue
        oe = o.evaluated_get(dg)
        me = oe.to_mesh(); me.calc_loop_triangles()
        mw = np.array(o.matrix_world)
        co = np.array([v.co[:] for v in me.vertices], dtype=float)
        tri = np.array([t.vertices[:] for t in me.loop_triangles], dtype=int)
        oe.to_mesh_clear()
        if len(tri) == 0:
            continue
        w = co @ mw[:3, :3].T + mw[:3, 3]
        t = w[tri]
        if crop is not None:
            c = t.mean(axis=1); lo, hi = np.array(crop[0]), np.array(crop[1])
            t = t[np.all((c >= lo) & (c <= hi), axis=1)]
        if inv is not None and len(t):
            t = t @ inv[:3, :3].T + inv[:3, 3]
        out.append(t)
    return np.concatenate(out) if out else np.zeros((0, 3, 3))


def symmetrize(t, cx):
    """AI meshes are rarely symmetric and often off-centre (the Assault torso sits +0.55 m in x).
    For a centre-line part: shift by -cx so the part's own centre is x=0, then join its mirror
    image, so the fit and the score use the symmetric average of both halves."""
    s = t.copy(); s[:, :, 0] -= cx
    m = s.copy(); m[:, :, 0] *= -1
    return np.concatenate([s, m])


def ref_tris(ref, crop=None, sym_cx=None, frame=None):
    t = tris_of(ref, crop, frame)
    return symmetrize(t, sym_cx) if sym_cx is not None and len(t) else t


def raster(tris, plane, lo, shape, cell):
    """Boolean mask (rows = second axis, cols = first axis) of the triangles projected on plane."""
    a, b = PLANES[plane]
    m = np.zeros(shape, dtype=bool)
    P = tris[:, :, [a, b]]
    for p in P:
        i0 = max(int((p[:, 0].min() - lo[0]) / cell), 0); i1 = min(int((p[:, 0].max() - lo[0]) / cell) + 1, shape[1])
        j0 = max(int((p[:, 1].min() - lo[1]) / cell), 0); j1 = min(int((p[:, 1].max() - lo[1]) / cell) + 1, shape[0])
        if i1 <= i0 or j1 <= j0:
            continue
        xs = lo[0] + (np.arange(i0, i1) + 0.5) * cell; ys = lo[1] + (np.arange(j0, j1) + 0.5) * cell
        X, Y = np.meshgrid(xs, ys)
        (x0, y0), (x1, y1), (x2, y2) = p
        d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(d) < 1e-12:
            continue
        l0 = ((y1 - y2) * (X - x2) + (x2 - x1) * (Y - y2)) / d
        l1 = ((y2 - y0) * (X - x2) + (x0 - x2) * (Y - y2)) / d
        inside = (l0 >= -1e-6) & (l1 >= -1e-6) & (1 - l0 - l1 >= -1e-6)
        m[j0:j1, i0:i1] |= inside
    return m


def _grid(trisets, plane, cell, pad=0.2):
    a, b = PLANES[plane]
    pts = np.concatenate([t.reshape(-1, 3) for t in trisets if len(t)])
    lo = (pts[:, a].min() - pad, pts[:, b].min() - pad)
    hi = (pts[:, a].max() + pad, pts[:, b].max() + pad)
    shape = (int((hi[1] - lo[1]) / cell) + 1, int((hi[0] - lo[0]) / cell) + 1)
    return lo, shape


def view_iou(ta, tb, plane, cell=0.05):
    lo, shape = _grid([ta, tb], plane, cell)
    ma, mb = raster(ta, plane, lo, shape, cell), raster(tb, plane, lo, shape, cell)
    u = (ma | mb).sum()
    return float((ma & mb).sum() / u) if u else 0.0


OBLIQUES = ((-35, 4), (45, 35))   # matched hero camera; a high 3/4 view like the tactics camera


def _view_rot(az, el):
    """Rotation taking world to a view frame whose XZ plane is the image of a camera at (az, el)
    (az=0 on +Y looking at the front, as in mk.shot)."""
    return (Matrix.Rotation(math.radians(-el), 4, "X") @ Matrix.Rotation(math.radians(az), 4, "Z"))


def _rot(t, M):
    R = np.array(M)[:3, :3]
    return t @ R.T


def part_iou(ours, ref, crop=None, planes=("XZ", "YZ", "XY"), obliques=OBLIQUES, cell=0.05, sym_cx=None):
    """Per-view IoU of our part objects vs the reference objects (cropped). "axis" is the mean of
    the three orthographic views; "mean" also includes the oblique views.

    A visual hull built from the same three axis views scores high on them by construction, so
    gate on "mean": the obliques catch filled undersides and wrong tilts the axis views cannot."""
    ta, tb = tris_of(ours), ref_tris(ref, crop, sym_cx)
    r = {p: round(view_iou(ta, tb, p, cell), 3) for p in planes}
    r["axis"] = round(sum(r[p] for p in planes) / len(planes), 3)
    for az, el in obliques:
        M = _view_rot(az, el)
        r["ob%d_%d" % (az, el)] = round(view_iou(_rot(ta, M), _rot(tb, M), "XZ", cell), 3)
    keys = list(planes) + ["ob%d_%d" % o for o in obliques]
    r["mean"] = round(sum(r[k] for k in keys) / len(keys), 3)
    return r


def _rdp(pts, tol):
    if len(pts) < 3:
        return pts
    a, b = np.array(pts[0]), np.array(pts[-1]); ab = b - a; L = np.linalg.norm(ab)
    d = [abs(np.cross(ab, np.array(p) - a)) / L if L > 1e-9 else np.linalg.norm(np.array(p) - a) for p in pts]
    k = int(np.argmax(d))
    if d[k] <= tol:
        return [pts[0], pts[-1]]
    return _rdp(pts[:k + 1], tol)[:-1] + _rdp(pts[k:], tol)


def outline(tris, plane, cell=0.05, tol=0.1):
    """Closed outline of the projected mask: per row, the leftmost and rightmost filled cells (a
    row-span hull — exact for shapes convex along rows, fills interior notches otherwise), then
    Ramer-Douglas-Peucker. Returns [(a, b), ...] counter-clockwise in plane coordinates."""
    lo, shape = _grid([tris], plane, cell, pad=0.0)
    m = raster(tris, plane, lo, shape, cell)
    left, right = [], []
    for j in range(shape[0]):
        cols = np.nonzero(m[j])[0]
        if len(cols) == 0:
            continue
        bj = lo[1] + (j + 0.5) * cell
        left.append((lo[0] + cols[0] * cell, bj)); right.append((lo[0] + (cols[-1] + 1) * cell, bj))
    if not left:
        return []
    # close the top and bottom rows exactly at the cell edges
    b0, b1 = left[0][1] - cell / 2, left[-1][1] + cell / 2
    ring = [(left[0][0], b0)] + left + [(left[-1][0], b1), (right[-1][0], b1)] + right[::-1] + [(right[0][0], b0)]
    ring = [(round(float(x), 3), round(float(y), 3)) for x, y in ring]
    half = len(ring) // 2
    poly = _rdp(ring[:half + 1], tol)[:-1] + _rdp(ring[half:] + [ring[0]], tol)[:-1]
    return poly


def fit_profiles(ref, crop=None, frame=None, cell=0.05, tol=0.1, views=("XZ", "YZ", "XY"), sym_cx=None):
    """Outlines of a reference part for profile_intersect, in world axes or in `frame`.
    Returns {"front": [...], "side": [...], "top": [...]}; build with
    profile_intersect(name, r["front"], r["side"], (0,0,0), m, c, bev, top_xy=r["top"]) and, when a
    frame was used, transform the new mesh by frame (build_fit does both)."""
    t = ref_tris(ref, crop, sym_cx, frame)
    names = {"XZ": "front", "YZ": "side", "XY": "top"}
    return {names[v]: outline(t, v, cell, tol) for v in views}


def extra_view_outlines(ref, crop=None, sym_cx=None, views=(), cell=0.05, tol=0.12):
    """Outlines of the reference part seen from extra directions (az, el), for carving.
    Three axis views give a visual hull that fills every concavity those views cannot see (the
    Assault pauldron came out 1.65x the reference volume, the head 2.2x). Each extra view adds one
    more silhouette cut: [{"az", "el", "pts"}], pts in that view's XZ plane."""
    t = ref_tris(ref, crop, sym_cx)
    out = []
    for az, el in views:
        M = _view_rot(az, el)
        out.append({"az": az, "el": el, "pts": outline(_rot(t, M), "XZ", cell, tol)})
    return out


def carve_views(o, extra, span=80.0):
    """Intersect a world-space fitted object with the extruded silhouette of each extra view."""
    cuts = []
    for i, e in enumerate(extra):
        if len(e["pts"]) < 3:
            continue
        c = prism("%s_view%d" % (o.name, i), [tuple(p) for p in e["pts"]], span, (0, 0, 0), None, coll("CUTTERS"), 0, plane="XZ")
        c.data.transform(_view_rot(e["az"], e["el"]).inverted())
        c.display_type = "WIRE"; c.hide_render = True
        cuts.append(c)
    if cuts:
        _bake_booleans(o, [(c, "INTERSECT") for c in cuts])
        for c in cuts:
            me_ = c.data; D.objects.remove(c, do_unlink=True); D.meshes.remove(me_)
    return o


def ref_envelope(ref, crop=None, sym_cx=None, offset=0.15, voxel=0.12, name="ref_env"):
    """Watertight envelope of the reference part, pushed out by `offset` m: triangle soup →
    voxel remesh (fuses double sheets, small holes) → push along normals. Intersect a fitted part
    with it to carve concavities silhouettes cannot see (carve_envelope)."""
    t = ref_tris(ref, crop, sym_cx)
    me = D.meshes.new(name + "_mesh")
    me.from_pydata([tuple(p) for p in t.reshape(-1, 3)], [], [(3 * i, 3 * i + 1, 3 * i + 2) for i in range(len(t))])
    o = D.objects.new(name, me); coll("CUTTERS").objects.link(o)
    rm = o.modifiers.new("Remesh", "REMESH"); rm.mode = "VOXEL"; rm.voxel_size = voxel
    bpy.context.view_layer.update()
    m2 = D.meshes.new_from_object(o.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    o.modifiers.clear(); o.data = m2; D.meshes.remove(me)
    bm = bmesh.new(); bm.from_mesh(m2); bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * offset
    bm.to_mesh(m2); bm.free()
    o.display_type = "WIRE"; o.hide_render = True
    return o


def carve_envelope(o, env, dissolve_deg=4.0):
    """o ∩ envelope, then dissolve the near-coplanar fragments the dense envelope leaves behind.
    Uses the FAST solver: EXACT silently returned an EMPTY mesh against the dense voxel envelope
    (Assault head shell, with and without hole_tolerant)."""
    bpy.context.view_layer.update()
    saved = [(md, md.show_viewport) for md in o.modifiers]
    for md, _ in saved:
        md.show_viewport = False
    b = o.modifiers.new("env_isect", "BOOLEAN"); b.operation = "INTERSECT"; b.object = env
    try:
        b.solver = "FLOAT"
    except TypeError:
        b.solver = "FAST"
    bpy.context.view_layer.update()
    me = D.meshes.new_from_object(o.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    o.modifiers.remove(b)
    for md, v in saved:
        md.show_viewport = v
    if not me.vertices:
        D.meshes.remove(me)
        raise ValueError("envelope carve of %s came out empty" % o.name)
    old, mats = o.data, list(o.data.materials)
    o.data = me; me.materials.clear()
    for m in mats:
        me.materials.append(m)
    if old.users == 0:
        D.meshes.remove(old)
    me.name = o.name + "_mesh"
    bm = bmesh.new(); bm.from_mesh(o.data)
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(dissolve_deg), verts=bm.verts, edges=bm.edges)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4], quad_method="BEAUTY", ngon_method="EAR_CLIP")
    bm.to_mesh(o.data); bm.free()
    return o


def build_fit(name, ref, m, c, bev, crop=None, frame=None, tol=0.1, use_top=True):
    """profile_intersect from the reference part's three outlines (visual hull, in `frame`)."""
    r = fit_profiles(ref, crop, frame, tol=tol)
    o = profile_intersect(name, r["front"], r["side"], (0, 0, 0), m, c, bev, top_xy=r["top"] if use_top else None)
    if frame is not None:
        o.data.transform(frame)   # bake into the mesh: objects keep identity transforms like every other part
    return o, r
