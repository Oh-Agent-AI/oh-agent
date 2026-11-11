# Blender -b --python render_views.py -- <in.glb> <out.png> <cell_m> <cells>
# Four views (front / 3-4 / side / back) of a GLB in one sheet, with the footprint cell drawn on the
# ground — the quickest scale and proportion sanity check. Workbench, headless.
import bpy, sys, math, mathutils
argv = sys.argv[sys.argv.index("--") + 1:]
src, out, cell, cells = argv[0], argv[1], float(argv[2]), int(argv[3])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
sc = bpy.context.scene
meshes = [o for o in sc.objects if o.type == "MESH"]
pts = [o.matrix_world @ mathutils.Vector(c) for o in meshes for c in o.bound_box]
lo = mathutils.Vector((min(p[i] for p in pts) for i in range(3)))
hi = mathutils.Vector((max(p[i] for p in pts) for i in range(3)))
# footprint cell outline, centred on the origin
half = cell * cells / 2
bpy.ops.mesh.primitive_plane_add(size=cell * cells, location=(0, 0, -0.02))
grid = bpy.context.active_object
mat = bpy.data.materials.new("cell"); mat.diffuse_color = (0.3, 0.75, 0.9, 1); grid.data.materials.append(mat)
wire = grid.modifiers.new("w", "WIREFRAME"); wire.thickness = 0.25
sc.render.engine = "BLENDER_WORKBENCH"
sc.display.shading.light = "STUDIO"; sc.display.shading.color_type = "TEXTURE"
sc.display.shading.show_object_outline = True
sc.render.film_transparent = False
sc.world = bpy.data.worlds.new("w"); sc.world.color = (0.86, 0.87, 0.89)
sc.display.shading.background_type = "WORLD"
sc.render.resolution_x = sc.render.resolution_y = 720
size = max(hi.z - lo.z, hi.x - lo.x, hi.y - lo.y, cell * cells) * 1.15
ctr = mathutils.Vector((0, 0, (hi.z + lo.z) / 2))
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam
cam.data.type = "ORTHO"; cam.data.ortho_scale = size
paths = []
# asset faces glTF -Z = Blender +Y; azimuth 0 = front
for name, az, el in [("front", 0, 8), ("three_quarter", 35, 18), ("side", 90, 8), ("back", 180, 8)]:
    a, e, r = math.radians(az), math.radians(el), size * 4
    cam.location = ctr + mathutils.Vector((r * math.sin(a) * math.cos(e), r * math.cos(a) * math.cos(e), r * math.sin(e)))
    cam.rotation_euler = (ctr - cam.location).to_track_quat("-Z", "Y").to_euler()
    p = out.replace(".png", f"_{name}.png"); sc.render.filepath = p
    bpy.ops.render.render(write_still=True); paths.append(p)
# stitch the four renders side by side
imgs = [bpy.data.images.load(p) for p in paths]
w = sc.render.resolution_x
sheet = bpy.data.images.new("sheet", w * len(imgs), w)
px = [0.0] * (w * len(imgs) * w * 4)
for k, im in enumerate(imgs):
    src_px = list(im.pixels)
    for y in range(w):
        row = src_px[y * w * 4:(y + 1) * w * 4]
        start = (y * w * len(imgs) + k * w) * 4
        px[start:start + w * 4] = row
sheet.pixels = px
sheet.filepath_raw = out; sheet.file_format = "PNG"; sheet.save()
print("BOUNDS", tuple(round(v, 2) for v in lo), tuple(round(v, 2) for v in hi))
