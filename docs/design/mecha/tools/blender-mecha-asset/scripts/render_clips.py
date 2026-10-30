# Blender -b <final.blend> --python render_clips.py -- <out.png>
# One representative frame per clip (solo each NLA track), 3/4 view with textures, in one row.
# Workbench does not show emission: accent parts render grey here although they glow in the GLB.
import bpy, sys, math, mathutils
out = sys.argv[sys.argv.index("--") + 1:][0]
sc = bpy.context.scene
FPS = sc.render.fps
picks = [("idle", 0.0), ("move", 0.2), ("attack", 0.45), ("hit", 0.12), ("defeat", 0.85)]
sc.render.engine = "BLENDER_WORKBENCH"; sc.display.shading.light = "STUDIO"; sc.display.shading.color_type = "TEXTURE"
sc.world = bpy.data.worlds.new("w"); sc.world.color = (0.86, 0.87, 0.89); sc.display.shading.background_type = "WORLD"
sc.render.resolution_x = sc.render.resolution_y = 640
bpy.ops.mesh.primitive_plane_add(size=16, location=(0, 0, -0.02))
g = bpy.context.active_object; m = bpy.data.materials.new("cell"); m.diffuse_color = (0.3, 0.75, 0.9, 1); g.data.materials.append(m)
g.modifiers.new("w", "WIREFRAME").thickness = 0.25
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam
cam.data.type = "ORTHO"; cam.data.ortho_scale = 27
ctr = mathutils.Vector((0, 0, 10)); a = math.radians(35)
cam.location = ctr + mathutils.Vector((100 * math.sin(a), 100 * math.cos(a), 30))
cam.rotation_euler = (ctr - cam.location).to_track_quat("-Z", "Y").to_euler()
paths = []
animated = [o for o in sc.objects if o.animation_data and o.animation_data.nla_tracks]
for clip, t in picks:
    for o in animated:
        for tr in o.animation_data.nla_tracks:
            tr.mute = tr.name != clip
    sc.frame_set(round(t * FPS))
    if clip == "defeat":  # the runtime lifts the fall (rearExtent); not emulated in this preview
        v = sc.objects["visual"]; bpy.context.view_layer.update()
        v.location.z = 0
    p = out.replace(".png", f"_{clip}.png"); sc.render.filepath = p; bpy.ops.render.render(write_still=True); paths.append(p)
imgs = [bpy.data.images.load(p) for p in paths]
w = sc.render.resolution_x; N = len(imgs)
sheet = bpy.data.images.new("sheet", w * N, w); px = [0.0] * (w * N * w * 4)
for k, im in enumerate(imgs):
    sp = list(im.pixels)
    for y in range(w):
        px[(y * w * N + k * w) * 4:(y * w * N + k * w) * 4 + w * 4] = sp[y * w * 4:(y + 1) * w * 4]
sheet.pixels = px; sheet.filepath_raw = out; sheet.file_format = "PNG"; sheet.save()
