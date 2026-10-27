# Blender -b <model.blend> --python finalize_rigid.py -- <out_rig.blend> <report.json> [config.json]
#
# Modeling scene → runtime asset:
#   apply modifiers (bevels, booleans) → flat shading → bake vertices to world space →
#   join meshes per joint under contract names → swap materials for an 8×1 nearest-filtered
#   palette + a separate faction-accent emissive → add marker empties → self-check every part
#   (signed volume, open edges, non-manifold edges) and count draw calls.
#
# config.json (all optional; defaults reproduce the Agent City Assault contract):
# {
#   "collection": "ASSAULT",                     # modeling collection
#   "drop_collections": ["REF_ai_lowpoly"],      # reference ghosts etc. removed before export
#   "mesh_names": {"forearm_r": "gauntlet-right", "forearm_l": "gauntlet-left",
#                  "body": "body_armor", "head": "head_armor"},
#   "default_suffix": "_armor",                  # other joints: <joint>_armor
#   "split": [{"joint": "forearm_l", "prefixes": ["shield_outer", ...], "name": "shield"}],
#   Naming override (preferred for new models): a part named "<target>__<anything>", e.g.
#   "shield__rib_0", always goes into mesh "<target>" under its joint — no prefix guessing.
#   "palette": ["armor", "trim", "dark", "metal", "rubber", "hi", "white", "glass"],   # ≤ 8 names
#   "accent": "accent",                          # material name that becomes faction_accent
#   "accent_strength": 1.0,
#   "markers": [{"name": "front", "parent": "head", "loc": [0, 2.4, 18.3]}]
# }
import bpy, bmesh, sys, json, os, mathutils

argv = sys.argv[sys.argv.index("--") + 1:]
out_blend, out_json = argv[0], argv[1]
cfg = json.load(open(argv[2])) if len(argv) > 2 and os.path.exists(argv[2]) else {}
COL = cfg.get("collection", "ASSAULT")
NAMES = cfg.get("mesh_names", {"forearm_r": "gauntlet-right", "forearm_l": "gauntlet-left",
                               "body": "body_armor", "head": "head_armor"})
SUFFIX = cfg.get("default_suffix", "_armor")
# Exact prefixes: a bare "shield_" also swallowed the shield ARM ("shield_arm_*", "shield_hand"),
# so gauntlet-left vanished. Prefer the "<target>__part" naming override for new models.
SPLIT = cfg.get("split", [{"joint": "forearm_l", "name": "shield",
                           "prefixes": ["shield_outer", "shield_frame", "shield_rib", "shield_emblem", "shield_step",
                                        "shield_spine", "shield_bolt", "shield_light", "shield_plate", "shield_rim"]}])
PAL = cfg.get("palette", ["armor", "trim", "dark", "metal", "rubber", "hi", "white", "glass"])
ACCENT = cfg.get("accent", "accent")
# Emission 3.0 blows out to pure white under the game's ACES tone mapping; 1.0 keeps the hue.
ACCENT_STRENGTH = cfg.get("accent_strength", 1.0)
MARKERS = cfg.get("markers", [{"name": "front", "parent": "head", "loc": [0, 2.4, 18.3]}])
assert len(PAL) <= 8, "palette is 8x1"
D = bpy.data
report = {}

for n in cfg.get("drop_collections", ["REF_ai_lowpoly"]):
    c = D.collections.get(n)
    if c:
        for o in list(c.objects):
            D.objects.remove(o, do_unlink=True)
        D.collections.remove(c)
for n in ("SHOTCAM",):
    o = D.objects.get(n)
    if o:
        D.objects.remove(o, do_unlink=True)
C = D.collections[COL]
bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()

# 1) apply modifiers, flat shade, vertices to world space (rest pose: matrix_world == modeling coords)
meshes = [o for o in C.objects if o.type == "MESH" and not o.hide_render]
for o in [o for o in C.objects if o.type == "MESH" and o.hide_render]:   # boolean cutters
    D.objects.remove(o, do_unlink=True)
for o in meshes:
    me = D.meshes.new_from_object(o.evaluated_get(dg))
    me.transform(o.matrix_world)
    old = o.data
    o.modifiers.clear()
    o.data = me
    D.meshes.remove(old)
    o.matrix_basis = mathutils.Matrix.Identity(4)   # parent inverse = inverse(parent world) → world = identity
    me.shade_flat()
report["meshes_before_merge"] = len(meshes)


def target_name(o):
    j = o.parent.name
    if "__" in o.name:
        return o.name.split("__", 1)[0]
    for s in SPLIT:
        if s["joint"] == j and o.name.startswith(tuple(s["prefixes"])):
            return s["name"]
    return NAMES.get(j, j + SUFFIX)


# 2) join per joint
groups = {}
for o in meshes:
    assert o.parent, "mesh %s has no joint parent" % o.name
    groups.setdefault((o.parent.name, target_name(o)), []).append(o)
merged = {}
for (_, tname), objs in sorted(groups.items()):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = tname; o.data.name = tname + "_mesh"
    merged[tname] = o


# 3) palette material. 8-bit sRGB image pixels are DISPLAY values: convert linear → sRGB first,
#    or every color comes out darker/oranger in the GLB.
def lin2srgb(x):
    return 12.92 * x if x <= 0.0031308 else 1.055 * (x ** (1 / 2.4)) - 0.055


def bsdf(m):
    return m.node_tree.nodes.get("Principled BSDF") if m and m.node_tree else None


N = 8
col = D.images.new("palette", N, 1, alpha=False); col.colorspace_settings.name = "sRGB"
mr = D.images.new("palette_mr", N, 1, alpha=False); mr.colorspace_settings.name = "Non-Color"
cp, mp = [0.0, 0.0, 0.0, 1.0] * N, [1.0, 0.5, 0.0, 1.0] * N
used_pal = set()
for o in merged.values():
    used_pal |= {m.name for m in o.data.materials if m}   # empty slots (boolean cutters) handled below
missing = sorted(used_pal - set(PAL) - {ACCENT})
assert not missing, "materials not in palette config: %s" % missing
for i, n in enumerate(PAL):
    b = bsdf(D.materials.get(n))
    if not b:
        continue   # unused slot (materials with no users are dropped on save)
    cp[i * 4:i * 4 + 3] = [lin2srgb(x) for x in b.inputs["Base Color"].default_value[:3]]
    mp[i * 4:i * 4 + 3] = (1.0, b.inputs["Roughness"].default_value, b.inputs["Metallic"].default_value)
col.pixels = cp; mr.pixels = mp
col.pack(); mr.pack()
pal = D.materials.new("armor_palette"); pal.use_nodes = True
nt = pal.node_tree; nt.nodes.clear()
out = nt.nodes.new("ShaderNodeOutputMaterial"); bs = nt.nodes.new("ShaderNodeBsdfPrincipled")
t1 = nt.nodes.new("ShaderNodeTexImage"); t1.image = col; t1.interpolation = "Closest"; t1.extension = "EXTEND"
t2 = nt.nodes.new("ShaderNodeTexImage"); t2.image = mr; t2.interpolation = "Closest"; t2.extension = "EXTEND"
sp = nt.nodes.new("ShaderNodeSeparateColor")
nt.links.new(t1.outputs["Color"], bs.inputs["Base Color"])
nt.links.new(t2.outputs["Color"], sp.inputs["Color"])
nt.links.new(sp.outputs["Green"], bs.inputs["Roughness"])
nt.links.new(sp.outputs["Blue"], bs.inputs["Metallic"])
nt.links.new(bs.outputs["BSDF"], out.inputs["Surface"])
acc = D.materials.new("faction_accent"); acc.use_nodes = True
b2 = acc.node_tree.nodes["Principled BSDF"]
src_acc = bsdf(D.materials.get(ACCENT))
ecol = tuple(src_acc.inputs["Emission Color"].default_value[:3]) if src_acc else (0.08, 0.69, 1.0)
b2.inputs["Base Color"].default_value = (*[c * 0.25 for c in ecol], 1); b2.inputs["Roughness"].default_value = 0.3
b2.inputs["Emission Color"].default_value = (*ecol, 1); b2.inputs["Emission Strength"].default_value = ACCENT_STRENGTH
# Single-sided: every shell is checked outward below. Halves fragment cost and exposes flipped faces.
pal.use_backface_culling = True
acc.use_backface_culling = True
for o in merged.values():
    me = o.data
    names = [m.name if m else None for m in me.materials]
    # faces cut by an EXACT boolean point at the cutter's empty slot: give them the host part's color
    host = next((n for n in names if n and n != ACCENT), PAL[0])
    names = [n or host for n in names]
    uv = me.uv_layers.new(name="UVMap")
    idxs, has_acc = [], False
    for pl in me.polygons:
        n = names[pl.material_index] if names else PAL[0]
        if n == ACCENT:
            idx, u, has_acc = 1, 0.5 / N, True
        else:
            idx, u = 0, (PAL.index(n) + 0.5) / N
        idxs.append(idx)
        for li in pl.loop_indices:
            uv.data[li].uv = (u, 0.5)   # constant UV per face → zero derivatives → always mip 0, no bleed
    me.materials.clear(); me.materials.append(pal); me.materials.append(acc)
    for pl, idx in zip(me.polygons, idxs):
        pl.material_index = idx
    if not has_acc:
        me.materials.pop()
for n in PAL + [ACCENT]:
    m = D.materials.get(n)
    if m:
        D.materials.remove(m)

# 4) marker empties
for mk in MARKERS:
    if D.objects.get(mk["name"]):
        continue
    e = D.objects.new(mk["name"], None); e.empty_display_size = 0.5
    C.objects.link(e)
    e.location = mk["loc"]
    p = D.objects[mk["parent"]]
    e.parent = p; e.matrix_parent_inverse = p.matrix_world.inverted()

# 5) self-check (weld coincident verts first: flat shading splits them per face)
checks = {}
for name, o in merged.items():
    bm = bmesh.new(); bm.from_mesh(o.data)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    vol = sum(f.verts[0].co.dot(f.verts[1].co.cross(f.verts[2].co)) / 6 for f in bm.faces)
    tris = len(bm.faces)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    open_e = sum(1 for ed in bm.edges if len(ed.link_faces) == 1)
    nonman = sum(1 for ed in bm.edges if len(ed.link_faces) > 2)
    checks[name] = {"tris": tris, "volume": round(vol, 1), "open_edges": open_e, "nonmanifold": nonman,
                    "materials": len(o.data.materials), "parent": o.parent.name}
    bm.free()
report["parts"] = checks
report["totals"] = {"meshes": len(merged), "tris": sum(c["tris"] for c in checks.values()),
                    "draw_calls": sum(c["materials"] for c in checks.values())}
report["problems"] = {n: c for n, c in checks.items() if c["volume"] <= 0 or c["open_edges"] or c["nonmanifold"]}
json.dump(report, open(out_json, "w"), indent=1)
for n, c in sorted(checks.items()):
    print("PART %-20s parent=%-12s tris=%6d vol=%8.1f open=%3d nonman=%2d mats=%d" % (
        n, c["parent"], c["tris"], c["volume"], c["open_edges"], c["nonmanifold"], c["materials"]))
print("TOTALS", json.dumps(report["totals"]), "PROBLEMS", sorted(report["problems"]))
bpy.ops.wm.save_as_mainfile(filepath=out_blend)
