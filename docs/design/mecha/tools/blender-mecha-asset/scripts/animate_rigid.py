# Blender -b <rig.blend> --python animate_rigid.py -- <out_prefix> <motion.py>
#
# Keys rigid-joint animation clips from a motion module and exports GLB + manifest.
# The motion module (see motion_example_assault.py) defines:
#   ID, ROLE, FOOTPRINT, ACTION_MAP, MATERIALS
#   CH     = [(node, "location"|"rotation_euler", axis_index), ...]  — every animated channel
#   CLIPS  = {name: (duration_s, loop_bool)}
#   pose(clip, t, dur) -> {channel: delta_from_rest}
#   NO_GROUND_LIFT = {"defeat"}   — clips whose lift the runtime handles
#
# Hard-won rules baked in here (each one produced a wrong GLB that looked fine in a still render):
#   * EVERY clip keys EVERY channel: three.js AnimationMixer never resets nodes a clip doesn't
#     touch, so a torso twist from `attack` would stay stuck into `idle`.
#   * FPS = 100 so durations like 0.95 / 0.48 / 0.85 s land on whole frames; the exporter
#     snaps clip length to frames.
#   * Keys are sampled densely (KEYS_PER_S) and the visual root is lifted per key so the lowest
#     vertex never goes below the ground; 30–60 keys/s let linear interpolation sink toes.
#   * Each clip's NLA track is MUTED while later clips are keyed: otherwise evaluating the scene
#     for the ground check lets the previous track overwrite the pose you just set, and the
#     first key of the clip silently records the wrong value.
#   * Export with force_sampling=True: unsampled export computed the first frame's
#     Euler→quaternion wrong.
import bpy, sys, math, json, os, importlib.util

argv = sys.argv[sys.argv.index("--") + 1:]
out, motion_path = argv[0], argv[1]
spec = importlib.util.spec_from_file_location("motion", motion_path)
mo = importlib.util.module_from_spec(spec); spec.loader.exec_module(mo)
FPS = getattr(mo, "FPS", 100)
KEYS_PER_S = getattr(mo, "KEYS_PER_S", 120)
NO_LIFT = getattr(mo, "NO_GROUND_LIFT", {"defeat"})
sc = bpy.context.scene
sc.render.fps = FPS
O = bpy.data.objects
CH = mo.CH
rest = {}
for n, path, i in CH:
    o = O[n]; o.rotation_mode = "XYZ"   # glTF import leaves quaternion mode; rotation_euler would be ignored
    rest[(n, path, i)] = getattr(o, path)[i]
for o in O:
    o.animation_data_clear()
MESHES = [o for o in O if o.type == "MESH"]


def lowest_point():
    bpy.context.view_layer.update()
    return min((o.matrix_world @ v.co).z for o in MESHES for v in o.data.vertices)


lifts = {}
nodes = sorted({c[0] for c in CH})
for clip, (dur, loop) in mo.CLIPS.items():
    frames = max(2, round(dur * KEYS_PER_S))
    times = [dur * k / frames for k in range(frames + 1)]
    acts = {}
    for n in nodes:
        ad = O[n].animation_data or O[n].animation_data_create()
        acts[n] = bpy.data.actions.new(clip); ad.action = acts[n]
    lifts[clip] = 0.0
    for t in times:
        d = mo.pose(clip, t, dur)
        for ch in CH:
            n, path, i = ch
            getattr(O[n], path)[i] = rest[ch] + d.get(ch, 0.0)
        if clip not in NO_LIFT:
            low = lowest_point()
            if low < 0:
                low -= 0.03   # margin for interpolation between keys
                O["visual"].location[2] -= low
                lifts[clip] = max(lifts[clip], -low)
        for ch in CH:
            n, path, i = ch
            O[n].keyframe_insert(data_path=path, index=i, frame=t * FPS)
    for ch in CH:
        n, path, i = ch
        getattr(O[n], path)[i] = rest[ch]
    for n in nodes:
        ad = O[n].animation_data
        for fc in (acts[n].fcurves if hasattr(acts[n], "fcurves") else []):
            for kp in fc.keyframe_points:
                kp.interpolation = "LINEAR"
        tr = ad.nla_tracks.new(); tr.name = clip; tr.mute = True
        tr.strips.new(clip, 0, acts[n])
        ad.action = None
for o in O:
    if o.animation_data:
        o.animation_data.action = None
        for tr in o.animation_data.nla_tracks:
            tr.mute = False
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=out + ".glb", export_format="GLB",
                          export_image_format="AUTO",          # keeps the PNG palette lossless (no PNG enum in 5.x)
                          export_yup=True, export_animations=True, export_animation_mode="NLA_TRACKS",
                          export_force_sampling=True, export_frame_step=1, export_anim_slide_to_zero=True,
                          export_optimize_animation_keep_anim_object=True, export_optimize_animation_size=False)
bpy.ops.wm.save_as_mainfile(filepath=out + ".blend")
manifest = {
    "id": mo.ID, "version": getattr(mo, "VERSION", 1), "role": mo.ROLE, "footprint": mo.FOOTPRINT, "forward": "-Z",
    "clips": {k: ({"duration": round(v[0], 4), "loop": v[1]} | ({"holdLastFrame": True} if k == "defeat" else {}))
              for k, v in mo.CLIPS.items()},
    "actionMap": mo.ACTION_MAP,
    "materials": mo.MATERIALS,
}
json.dump(manifest, open(out + ".manifest.json", "w"), indent=2, ensure_ascii=False)
print("LIFTS", json.dumps({k: round(v, 3) for k, v in lifts.items()}))
print("EXPORTED", os.path.getsize(out + ".glb"))
