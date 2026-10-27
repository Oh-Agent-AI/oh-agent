# Hard-surface modeling helpers for Blender (run inside Blender: exec(open(MK).read())).
# Conventions: meters, Z up, the asset faces +Y in Blender (= -Z in glTF after export), right hand = +X.
#
# Every helper builds a real mesh with an optional chamfer Bevel modifier (applied later by
# finalize_rigid.py). Nothing here uses negative scale or keeps stale parent inverses — both broke
# earlier builds silently (see references/blender-mcp.md).
import os
import math
import tempfile
import bpy
import bmesh
import mathutils
import mathutils.bvhtree
from mathutils import Vector, Matrix

D = bpy.data

# Bevel tiers for a ~20 m mech. Props in the real world use mm-level bevels; scale to the asset.
# Never bevel every part with the same width — that is what makes a model read as a soft toy.
TIER = {"primary": 0.15, "panel": 0.04, "micro": 0.015}


def coll(name, parent=None):
    c = D.collections.get(name)
    if not c:
        c = D.collections.new(name)
        (parent or bpy.context.scene.collection).children.link(c)
    return c


def reset_collection(name):
    c = D.collections.get(name)
    if c:
        for o in list(c.objects):
            D.objects.remove(o, do_unlink=True)
    return coll(name)


def mat(name, rgb, rough=0.5, metal=0.0, emit=None, emit_strength=0.0):
    """rgb is LINEAR. diffuse_color is what Workbench previews show."""
    m = D.materials.get(name) or D.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1)
        b.inputs["Emission Strength"].default_value = emit_strength
    m.diffuse_color = (*rgb, 1)
    return m


def bevel(o, width, segs=1, angle=30, weighted=True):
    """Add an angle-limited chamfer. Use TIER widths; pass width=0 to skip."""
    if not width:
        return o
    bv = o.modifiers.new("Bevel", "BEVEL")
    bv.width = width
    bv.segments = segs
    bv.limit_method = "ANGLE"
    bv.angle_limit = math.radians(angle)
    bv.harden_normals = True
    if weighted:
        wn = o.modifiers.new("WeightedNormal", "WEIGHTED_NORMAL")
        wn.keep_sharp = True
    return o


def _finish(o, name, loc, m, c, bev, segs=1):
    o.name = name
    if o.name != name:
        # Blender silently renamed it (e.g. "foot_r.001" because a JOINT is called "foot_r").
        # mirror_pass only mirrors names ending in "_r", so the left copy would silently vanish.
        taken = name
        D.objects.remove(o, do_unlink=True)
        raise ValueError("object name %r is already taken (joint or earlier part); pick another name" % taken)
    o.data.name = name + "_mesh"
    o.location = loc
    for col in list(o.users_collection):
        col.objects.unlink(o)
    (c or bpy.context.collection).objects.link(o)
    if m:
        o.data.materials.append(m)
    bevel(o, bev, segs)
    for p in o.data.polygons:
        p.use_smooth = False
    return o


def _new(name):
    me = D.meshes.new(name)
    return D.objects.new(name, me), me


def box(name, size, loc, m=None, c=None, bev=TIER["primary"], rot=(0, 0, 0), taper=None):
    """Blockout / filler only. Primary armor should come from profile_intersect or bent_plate:
    a model built from axis-aligned boxes reads as stacked toy bricks no matter how much detail is added."""
    o, me = _new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= size[0]; v.co.y *= size[1]; v.co.z *= size[2]
        if taper and v.co.z > 0:
            v.co.x *= taper[0]; v.co.y *= taper[1]
    bm.to_mesh(me); bm.free()
    o.rotation_euler = rot
    return _finish(o, name, loc, m, c, bev)


def _p3(plane, a, b, t):
    return {"YZ": Vector((t, a, b)), "XZ": Vector((a, t, b)), "XY": Vector((a, b, t))}[plane]


def _prism_bm(pts, t0, t1, plane):
    bm = bmesh.new()
    v0 = [bm.verts.new(_p3(plane, a, b, t0)) for a, b in pts]
    v1 = [bm.verts.new(_p3(plane, a, b, t1)) for a, b in pts]
    bm.faces.new(v0[::-1]); bm.faces.new(v1)
    n = len(pts)
    for i in range(n):
        bm.faces.new((v0[i], v0[(i + 1) % n], v1[(i + 1) % n], v1[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def prism(name, pts, thickness, loc, m=None, c=None, bev=TIER["primary"], plane="YZ", center=True):
    """Extrude a closed 2D outline. plane=YZ: side outline extruded along X; XZ: front outline along Y;
    XY: top outline along Z. Points are (a, b) in that plane, relative to loc."""
    o, me = _new(name)
    t0, t1 = (-thickness / 2, thickness / 2) if center else (0, thickness)
    bm = _prism_bm(pts, t0, t1, plane)
    bm.to_mesh(me); bm.free()
    return _finish(o, name, loc, m, c, bev)


def profile_intersect(name, front_xz, side_yz, loc, m=None, c=None, bev=TIER["primary"], top_xy=None):
    """The main armor-shaping tool: intersect a front outline (X,Z) extruded along Y with a side
    outline (Y,Z) extruded along X (optionally also a top outline). The result has the tapered,
    faceted planes concept art uses — the thing boxes can never produce."""
    span = 1000.0
    bm_f = _prism_bm(front_xz, -span, span, "XZ")
    o, me = _new(name)
    bm_f.to_mesh(me); bm_f.free()
    cutters = []
    for i, (pts, plane) in enumerate(((side_yz, "YZ"), (top_xy, "XY"))):
        if not pts:
            continue
        co, cme = _new(name + "_cut%d" % i)
        bmc = _prism_bm(pts, -span, span, plane)
        bmc.to_mesh(cme); bmc.free()
        bpy.context.scene.collection.objects.link(co)
        cutters.append(co)
    bpy.context.scene.collection.objects.link(o)
    for co in cutters:
        md = o.modifiers.new("isect", "BOOLEAN")
        md.operation = "INTERSECT"; md.solver = "EXACT"; md.object = co
    dg = bpy.context.evaluated_depsgraph_get()
    newme = D.meshes.new_from_object(o.evaluated_get(dg))
    newme.materials.clear()   # the EXACT boolean adds an empty slot per operand; faces would point at it (renders grey)
    o.modifiers.clear()
    old = o.data; o.data = newme; D.meshes.remove(old)
    for co in cutters:
        cm = co.data; D.objects.remove(co, do_unlink=True); D.meshes.remove(cm)
    return _finish(o, name, loc, m, c, bev)


def bent_plate(name, polyline, thickness, width, loc, m=None, c=None, bev=TIER["panel"], plane="YZ"):
    """Folded sheet-metal armor (pauldrons, chest plates, shin fronts): an OPEN 2D polyline is
    thickened inward by `thickness` and extruded by `width`. Reads as a plate with real thickness,
    not as a solid block. Polyline order defines the outside (left side of travel is thickened)."""
    pts = [Vector(p) for p in polyline]
    off = []
    for i, p in enumerate(pts):
        a = pts[i - 1] if i > 0 else p
        b = pts[i + 1] if i < len(pts) - 1 else p
        d = (b - a).normalized()
        nrm = Vector((-d.y, d.x))
        off.append(p + nrm * thickness)
    outline = [tuple(p) for p in pts] + [tuple(p) for p in reversed(off)]
    return prism(name, outline, width, loc, m, c, bev, plane)


def cyl(name, r, depth, loc, axis="Z", m=None, c=None, verts=24, bev=0.0, r2=None):
    o, me = _new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=verts, radius1=r, radius2=(r if r2 is None else r2), depth=depth)
    bm.to_mesh(me); bm.free()
    if axis == "X":
        o.rotation_euler = (0, math.pi / 2, 0)
    elif axis == "Y":
        o.rotation_euler = (math.pi / 2, 0, 0)
    return _finish(o, name, loc, m, c, bev)


def stepped_axle(name, radii_depths, loc, axis="X", mats=None, c=None, verts=24):
    """Concentric stepped rings (shoulder axles, hip joints): [(r, depth), ...] outer→inner, each
    successive ring sticks out further. Returns the list of objects."""
    out = []
    for i, (r, d) in enumerate(radii_depths):
        out.append(cyl("%s_%d" % (name, i), r, d, loc, axis, (mats or [None])[min(i, len(mats or [None]) - 1)], c, verts))
    return out


def cut(o, cutter, op="DIFFERENCE"):
    """Live boolean (EXACT). Keep cutters in a hidden collection; finalize_rigid applies modifiers.
    Use for panel grooves, vent slots, recessed bays — depth before stickers."""
    md = o.modifiers.new("cut_" + cutter.name, "BOOLEAN")
    md.operation = op; md.solver = "EXACT"; md.object = cutter
    cutter.hide_render = True; cutter.display_type = "WIRE"
    # Bevel must come after booleans in the stack
    for name in ("Bevel", "WeightedNormal"):
        if name in o.modifiers:
            o.modifiers.move(o.modifiers.find(name), len(o.modifiers) - 1)
    return md


def cutter(name, size, loc, ref=None, rot=(0, 0, 0), c=None):
    """Cutter box for engrave(). With ref, size/loc/rot are in ref's local frame (a limb segment's
    frame: z along the bone, x lateral), so grooves follow tilted parts."""
    c = c or coll("CUTTERS")
    o = box(name, size, (0, 0, 0), None, c, 0)
    base = ref.matrix_world if ref else Matrix.Identity(4)
    o.matrix_world = base @ Matrix.Translation(Vector(loc)) @ mathutils.Euler(rot).to_matrix().to_4x4()
    o.display_type = "WIRE"; o.hide_render = True
    return o


def slit(name, ref, at, axis="Z", gap=0.12, span=40.0):
    """Thin full-width slab cutter across ref at local coordinate `at` along axis: cuts a plate in
    two with a gap. Put a darker core (core_of) or frame part behind it so the gap reads as depth."""
    size = {"X": (gap, span, span), "Y": (span, gap, span), "Z": (span, span, gap)}[axis]
    loc = {"X": (at, 0, 0), "Y": (0, at, 0), "Z": (0, 0, at)}[axis]
    return cutter(name, size, loc, ref)


def engrave(o, cutters, fill=None):
    """Bake boolean cuts into o's mesh (other modifiers stay live). Use this, not cut(), on parts
    that mirror_pass will copy: mirror_part copies modifiers verbatim, so a live boolean on a _r
    part makes the _l copy point at the right-side cutter and the left side silently loses every
    groove. Cut faces take the host's first material, or `fill` (e.g. the dark frame material) so
    groove floors read dark however deep they are; the cutters are deleted."""
    if not cutters:
        return o
    bpy.context.view_layer.update()
    saved = [(md, md.show_viewport) for md in o.modifiers]
    for md, _ in saved:
        md.show_viewport = False
    mods = []
    for ct in cutters:
        md = o.modifiers.new("eng_" + ct.name, "BOOLEAN")
        md.operation = "DIFFERENCE"; md.solver = "EXACT"; md.object = ct
        try:
            md.material_mode = "INDEX"
        except (AttributeError, TypeError):
            pass
        mods.append(md)
    bpy.context.view_layer.update()
    me = D.meshes.new_from_object(o.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    for md in mods:
        o.modifiers.remove(md)
    for md, v in saved:
        md.show_viewport = v
    old, mats = o.data, list(o.data.materials)
    o.data = me
    if old.users == 0:
        D.meshes.remove(old)
    me.name = o.name + "_mesh"
    me.materials.clear()
    for m in mats:
        me.materials.append(m)
    # EXACT booleans leave concave n-gons around pockets (an outer loop joined to the pocket rim);
    # the viewport/exporter can triangulate those into overlapping fans that render as a hatched
    # triangle. Triangulate them here, deterministically.
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4], quad_method="BEAUTY", ngon_method="EAR_CLIP")
    bm.to_mesh(me); bm.free()
    for pl in me.polygons:
        pl.use_smooth = False
        pl.material_index = min(pl.material_index, max(len(mats) - 1, 0))
    if fill is not None:
        # cut faces = faces whose centre lies on/inside a cutter box (cutter-local bbox, 1 cm slack)
        if fill.name not in [m.name for m in me.materials if m]:
            me.materials.append(fill)
        fi = [m.name if m else None for m in me.materials].index(fill.name)
        boxes = []
        for ct in cutters:
            vs = [v.co for v in ct.data.vertices]
            lo = Vector([min(v[i] for v in vs) - 0.01 for i in range(3)]); hi = Vector([max(v[i] for v in vs) + 0.01 for i in range(3)])
            boxes.append((ct.matrix_world.inverted() @ o.matrix_world, lo, hi))
        for pl in me.polygons:
            for M_, lo, hi in boxes:
                p = M_ @ pl.center
                if all(lo[i] <= p[i] <= hi[i] for i in range(3)):
                    pl.material_index = fi
                    break
    for ct in cutters:
        D.objects.remove(ct, do_unlink=True)
    return o


def _bake_booleans(o, ops):
    """Apply [(operand, 'INTERSECT'|'DIFFERENCE'|'UNION'), ...] to o's own mesh (EXACT), other modifiers off."""
    bpy.context.view_layer.update()
    saved = [(md, md.show_viewport) for md in o.modifiers]
    for md, _ in saved:
        md.show_viewport = False
    mods = []
    for ob, op in ops:
        md = o.modifiers.new("bk_" + ob.name, "BOOLEAN"); md.operation = op; md.solver = "EXACT"; md.object = ob
        # hole-tolerant: hulls that have been engraved are often non-manifold (open edges where
        # cuts meet bevel-free corners); without it EXACT silently keeps whole operands
        md.use_hole_tolerant = True
        try:
            md.material_mode = "INDEX"
        except (AttributeError, TypeError):
            pass
        mods.append(md)
    bpy.context.view_layer.update()
    me = D.meshes.new_from_object(o.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    for md in mods:
        o.modifiers.remove(md)
    for md, v in saved:
        md.show_viewport = v
    old, mats = o.data, list(o.data.materials)
    o.data = me
    if old.users == 0:
        D.meshes.remove(old)
    me.name = o.name + "_mesh"; me.materials.clear()
    for m in mats:
        me.materials.append(m)
    for pl in me.polygons:
        pl.use_smooth = False; pl.material_index = 0
    return o


def _offset_copy(o, name, d):
    """Copy of o's mesh with every vertex pushed d along its vertex normal (outset d>0, inset d<0)."""
    bm = bmesh.new(); bm.from_mesh(o.data); bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * d
    me = D.meshes.new(name + "_mesh"); bm.to_mesh(me); bm.free()
    n = D.objects.new(name, me); coll("CUTTERS").objects.link(n)
    n.matrix_world = o.matrix_world.copy(); n.display_type = "WIRE"; n.hide_render = True
    return n


def conform_plate(name, outline_xz, base, proud=0.25, embed=0.2, m=None, c=None, bev=TIER["panel"], axis="Y"):
    """A bent armor plate with real thickness that follows the curvature of `base` (a hull):
    the front (X,Z) outline extruded through the part, intersected with base pushed out by `proud`,
    minus base pushed in by `embed`. Its front face sits `proud` metres off the hull everywhere,
    including over facet cuts, so it reads as a separate plate laid over the body, not a groove
    pattern. Outside the hull's footprint the plate simply ends (no floating pieces).
    axis="Y": a front plate, outline in (X, Z), seen from +Y. axis="X": an outer-side plate on a
    right-side (+X) part, outline in (Y, Z), seen from +X."""
    # Extrude only from just behind the front surface forward. Through the whole part, the
    # intersection keeps the hull's back skin too and the "plate" wraps the body (first version).
    bpy.context.view_layer.update()
    be = base.evaluated_get(bpy.context.evaluated_depsgraph_get()); inv = base.matrix_world.inverted()
    xs = [p[0] for p in outline_xz]; zs = [p[1] for p in outline_xz]
    samples = list(outline_xz) + [(sum(xs) / len(xs), sum(zs) / len(zs))]
    hits = []
    k = 1 if axis == "Y" else 0
    for a_, z in samples:
        org = Vector((a_, 50, z)) if axis == "Y" else Vector((50, a_, z))
        dirw = Vector((0, -1, 0)) if axis == "Y" else Vector((-1, 0, 0))
        ok, loc, _, _ = be.ray_cast(inv @ org, (inv.to_3x3() @ dirw).normalized())
        if ok:
            hits.append((base.matrix_world @ loc)[k])
    t0 = (min(hits) if hits else 0.0) - embed - 0.6
    loc0 = (0, t0, 0) if axis == "Y" else (t0, 0, 0)
    o = prism(name, outline_xz, 40.0, loc0, m, c, 0, plane="XZ" if axis == "Y" else "YZ", center=False)
    o.data.transform(Matrix.Translation(o.location)); o.location = (0, 0, 0)
    outer = _offset_copy(base, name + "_out", proud); inner = _offset_copy(base, name + "_in", -embed)
    # Pushing a small, sharply faceted hull inward along vertex normals makes it intersect itself
    # (the Assault shin: 52 overlapping face pairs), and EXACT then silently returns an EMPTY
    # plate. Fall back to subtracting the hull itself: the plate then sits exactly on the surface.
    bm_ = bmesh.new(); bm_.from_mesh(inner.data)
    broken = len(mathutils.bvhtree.BVHTree.FromBMesh(bm_).overlap(mathutils.bvhtree.BVHTree.FromBMesh(bm_))) > 0
    bm_.free()
    _bake_booleans(o, [(outer, "INTERSECT"), (base if broken else inner, "DIFFERENCE")])
    for ob in (outer, inner):
        me_ = ob.data; D.objects.remove(ob, do_unlink=True); D.meshes.remove(me_)
    if not o.data.vertices:
        raise ValueError("conform_plate %r came out empty: outline outside the hull, or the hull is broken" % name)
    bevel(o, bev)
    return o


def core_of(o, name, m, k=0.9):
    """Dark inner core: o's mesh shrunk by k about its bbox centre, same transform and parent.
    Panel gaps and slits cut into o then show frame instead of empty space (exposed frame)."""
    me = o.data.copy(); me.name = name + "_mesh"
    lo = Vector([min(v.co[i] for v in me.vertices) for i in range(3)])
    hi = Vector([max(v.co[i] for v in me.vertices) for i in range(3)])
    ctr = (lo + hi) / 2
    for v in me.vertices:
        v.co = ctr + (v.co - ctr) * k
    me.materials.clear(); me.materials.append(m)
    for pl in me.polygons:
        pl.material_index = 0
    n = D.objects.new(name, me)
    for col in o.users_collection:
        col.objects.link(n)
    n.matrix_world = o.matrix_world.copy()
    if o.parent:
        parent_keep(n, o.parent)
    return n


def sphere(name, r, loc, m=None, c=None, seg=20):
    o, me = _new(name)
    bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=seg // 2, radius=r)
    bm.to_mesh(me); bm.free()
    return _finish(o, name, loc, m, c, 0)


def empty(name, loc, parent=None, c=None, size=0.8, kind="PLAIN_AXES"):
    """Joint node at a WORLD position. Updates the depsgraph first: without it the parent's
    matrix_world is stale and every child pivot ends up offset twice (renders fine, rotates wrong)."""
    e = D.objects.new(name, None); e.empty_display_type = kind; e.empty_display_size = size
    (c or bpy.context.collection).objects.link(e)
    if parent:
        bpy.context.view_layer.update()
        e.parent = parent
        e.matrix_parent_inverse = Matrix.Identity(4)
        e.location = Vector(loc) - parent.matrix_world.translation  # rest pose has no rotation
    else:
        e.location = loc
    return e


def parent_keep(o, p):
    bpy.context.view_layer.update()
    o.parent = p
    o.matrix_parent_inverse = p.matrix_world.inverted()


def mirror_part(o, name, parent=None):
    """Mirror across world X=0 by negating vertex x and reversing faces (never negative scale).
    Euler (rx, ry, rz) mirrors to (rx, -ry, -rz). Modifiers are copied."""
    me = o.data.copy(); me.name = name + "_mesh"
    bm = bmesh.new(); bm.from_mesh(me)
    for v in bm.verts:
        v.co.x = -v.co.x
    bmesh.ops.reverse_faces(bm, faces=bm.faces)
    bm.to_mesh(me); bm.free()
    n = D.objects.new(name, me)
    for col in o.users_collection:
        col.objects.link(n)
    n.location = Vector((-o.location.x, o.location.y, o.location.z))
    n.rotation_euler = (o.rotation_euler.x, -o.rotation_euler.y, -o.rotation_euler.z)
    n.scale = o.scale
    for m in o.data.materials:
        me.materials.append(m)
    for md in o.modifiers:
        nm = n.modifiers.new(md.name, md.type)
        for prop in md.bl_rna.properties:
            if not prop.is_readonly and prop.identifier not in ("name", "type"):
                try:
                    setattr(nm, prop.identifier, getattr(md, prop.identifier))
                except Exception:
                    pass
    for pl in me.polygons:
        pl.use_smooth = False
    if parent:
        parent_keep(n, parent)
    return n


def mirror_name(n):
    return n[:-2] + "_l" if n.endswith("_r") else n + "_l"


# ---------------------------------------------------------------- mirror-first workflow
# Symmetric characters: build only the right half, then generate the left. Asymmetric add-ons
# (a single weapon hand, markings) live in their own collection; a carried item (shield) is
# modeled last in its own collection and installed onto its joint. See references/hard-surface.md.

def mirror_center(o, bisect=True):
    """Centre-line part (torso, head, pelvis): model the +X half, keep a live X mirror.
    Clipping + merge welds the seam, so the two halves stay one closed shell."""
    md = o.modifiers.new("MirrorX", "MIRROR")
    md.use_axis[0] = True; md.use_bisect_axis[0] = bisect; md.use_clip = True; md.use_mirror_merge = True
    # mirror before bevel, so the bevel runs on the full shape
    o.modifiers.move(o.modifiers.find("MirrorX"), 0)
    return o


def mirror_pass(collection_name, joints, side_from="_r", side_to="_l"):
    """Regenerate every left-side part from its right-side source. Re-runnable: deletes the
    previous generated copies (tagged with 'mirror_of') first, so edit the right half, then call
    this again. Only parts whose names end with side_from are mirrored; joint names map _r → _l
    (centre joints such as 'body' stay). Returns the number of parts generated."""
    C = D.collections[collection_name]
    for o in [o for o in C.objects if o.get("mirror_of")]:
        D.objects.remove(o, do_unlink=True)
    n = 0
    for o in list(C.objects):
        if o.type != "MESH" or not o.name.endswith(side_from) or o.get("no_mirror"):
            continue
        pj = o.parent.name if o.parent else None
        target_joint = joints.get(pj[:-len(side_from)] + side_to if pj and pj.endswith(side_from) else pj) if pj else None
        m = mirror_part(o, o.name[:-len(side_from)] + side_to, target_joint)
        m["mirror_of"] = o.name
        n += 1
    return n


def attach(o, base, loc, rot=(0, 0, 0)):
    """Place o in base's local frame (inherits base's tilt). Composes with o's own rotation so a
    cylinder's axis survives. Use for stripes, discs and bolts sitting on slanted plates."""
    bpy.context.view_layer.update()
    o.matrix_world = (base.matrix_world @ Matrix.Translation(Vector(loc))
                      @ mathutils.Euler(rot).to_matrix().to_4x4() @ o.rotation_euler.to_matrix().to_4x4())
    return o


# ---------------------------------------------------------------- offscreen review renders
# The Blender splash screen blocks the viewport until a real mouse event arrives, so viewport
# screenshots are unreliable from MCP. Workbench renders show the same solid shading and work
# headless too. Read the PNG afterwards to look at it.
SHOTDIR = os.environ.get("BLENDER_SHOTDIR", os.path.join(tempfile.gettempdir(), "blender_shots"))
os.makedirs(SHOTDIR, exist_ok=True)


def shot(name, az=35, el=15, dist=60, target=(0, 0, 10), ortho=None, res=(1100, 800), hide=(), show=(),
         color_type="MATERIAL", lens=55, silhouette=False):
    """az=0 puts the camera on +Y looking at the asset's front; az=90 is the +X side.
    hide/show: collection names to toggle for this render only. silhouette=True renders flat black
    on white for IoU against a concept silhouette (see silhouette_iou.py)."""
    sc = bpy.context.scene
    cam = D.objects.get("SHOTCAM") or D.objects.new("SHOTCAM", D.cameras.new("SHOTCAM"))
    if cam.name not in sc.collection.objects:
        sc.collection.objects.link(cam)
    sc.camera = cam
    cd = cam.data
    if ortho:
        cd.type = "ORTHO"; cd.ortho_scale = ortho
    else:
        cd.type = "PERSP"; cd.lens = lens
    cd.clip_start = 0.1; cd.clip_end = 1000
    a, e = math.radians(az), math.radians(el)
    cam.location = Vector(target) + Vector((math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e))) * dist
    cam.rotation_euler = (Vector(target) - cam.location).to_track_quat("-Z", "Y").to_euler()
    sc.render.engine = "BLENDER_WORKBENCH"
    sh = sc.display.shading
    if silhouette:
        sh.light = "FLAT"; sh.color_type = "SINGLE"; sh.single_color = (0, 0, 0)
        sh.show_cavity = False; sh.show_object_outline = False; sh.show_specular_highlight = False
    else:
        sh.light = "STUDIO"; sh.color_type = color_type; sh.show_cavity = True; sh.cavity_type = "BOTH"
        sh.cavity_ridge_factor = 0.8; sh.cavity_valley_factor = 1.0; sh.show_object_outline = True
        sh.show_specular_highlight = True
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    if not sc.world:
        sc.world = D.worlds.new("studio")
    sc.world.color = (1, 1, 1) if silhouette else (0.62, 0.60, 0.57)
    sh.background_type = "WORLD"
    sc.display.render_aa = "8"
    prev = {}
    for n, val in [(n, True) for n in hide] + [(n, False) for n in show]:
        cl = D.collections.get(n)
        if cl:
            prev[n] = cl.hide_render; cl.hide_render = val
    path = os.path.join(SHOTDIR, name + ".png")
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    for n, v in prev.items():
        D.collections[n].hide_render = v
    return path


def bounds(collection_name):
    """World-space bbox (with modifiers) of all meshes in a collection: (min, max, size)."""
    dg = bpy.context.evaluated_depsgraph_get()
    lo = Vector((1e9,) * 3); hi = -lo
    for o in D.collections[collection_name].objects:
        if o.type != "MESH":
            continue
        ev = o.evaluated_get(dg); me = ev.to_mesh()
        for v in me.vertices:
            w = ev.matrix_world @ v.co
            lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
        ev.to_mesh_clear()
    return lo, hi, hi - lo
