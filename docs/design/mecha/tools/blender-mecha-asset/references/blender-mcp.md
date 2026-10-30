# Blender MCP: setup and pitfalls (official add-on, Blender 5.x)

Every item here cost a debugging round. Most fail **silently**: the render looks right and the
asset is wrong.

## Setup

- The add-on is the official "MCP" extension (`bl_ext.user_default.mcp`), server on
  `localhost:9876`. The MCP client fails with "Cannot connect" when Blender is not running or the
  server is not started.
- Start it without touching the user's preferences:
  `/Applications/Blender.app/Contents/MacOS/Blender --online-mode --python scripts/start_mcp.py`
  (background it). `--online-mode` is mandatory — the add-on refuses to serve with online access
  off. The script starts the server from a timer because it needs a window context.
- Check with `lsof -iTCP:9876 -sTCP:LISTEN`, then call the objects-summary tool.
- If the user installs a different Blender MCP (third-party packages use other tool names and a
  different port), read its README before trusting any of the tool names below.

## Looking at the scene

- The splash screen stays over the viewport until a real mouse event; `cursor_warp` does not
  dismiss it and `osascript` keystrokes hang on the accessibility prompt. Do not fight it.
- Instead render: `mk.shot(name, az, el, dist|ortho, target)` writes a Workbench PNG (same look as
  solid viewport shading) into `$BLENDER_SHOTDIR`; Read the PNG. Works headless too.
- Workbench does not show emission: emissive parts look grey. Judge glow in a material/EEVEE
  render or in the game.
- Render several angles per stage (front, 3/4, side, back) plus close-ups of hero parts.

## Running code

- `execute_blender_code` does not keep Python state between calls. Re-`exec` the helper library
  (`exec(open(MK).read())`) at the top of each call, and re-fetch objects by name.
- Keep build steps as idempotent script files (delete what the step created, then rebuild), so a
  fix is "edit the script, run again", not "patch the live scene by hand".
- Heavy or destructive steps (finalize, animation keying, export) run in a **separate headless
  Blender** on a saved copy: `Blender -b model.blend --python finalize_rigid.py -- ...`. Save the
  live scene first (`bpy.ops.wm.save_as_mainfile`).
- Never destructively modify a user's open scene without asking; a scene you just launched with
  the default cube is yours.

## Silent failures and their fixes

| Symptom | Cause | Fix |
|---|---|---|
| New objects get `.001` names; joint lookups fail | A reference collection already uses the names | Prefix reference objects (`REF_...`) right after loading |
| A mirrored part is missing on the left (e.g. left foot armor) | Part named like its joint (`foot_r`): Blender renamed it `foot_r.001`, which no longer ends in `_r`, so `mirror_pass` skipped it | Never reuse joint names for parts (`foot_armor_r`); `mk._finish` now raises on a taken name |
| Bolts float metres away from the part and the silhouette gets wider | `cyl(axis="Y")` keeps the axis rotation on the object; baking only `location` into the mesh before transforming it into a part frame drops that rotation | Bake the whole `matrix_world` into the mesh, then set it to identity, before any further `data.transform` |
| Grooves appear on the right limb only | `cut()` keeps a live boolean; `mirror_part` copies modifiers verbatim, so the `_l` copy points at the right-side cutter and cuts nothing | Use `mk.engrave()` on anything `mirror_pass` will copy (bakes the cut into the mesh) |
| A pocket cut lands about 1 m behind the plate (only a thin slit shows) | Mesh-data `tilt()` about a world pivot on a cutter whose position was in `object.location` | Put the position into the mesh data (object at the origin) before tilting |
| Hatched / flickering triangle inside a vent | Vent floor exactly coplanar with an inner frame face | Stop cuts ≥ 0.1 m short of any part behind them |
| Hatched fan across a cut face | EXACT boolean leaves a concave n-gon around a pocket | `engrave()` triangulates n-gons (beauty / ear clip) |
| Mesh renders in place but joints rotate around the wrong point (e.g. a walk needs a 1.2 m body lift) | Child empty created while the parent's `matrix_world` was stale → pivot offset applied twice | `mk.empty()`: update the view layer, identity parent inverse, local = world − parent world |
| Setting `rotation_euler` does nothing | glTF import leaves `rotation_mode = 'QUATERNION'` | Set `rotation_mode = 'XYZ'` first |
| Mirrored side shades inside-out | Negative scale | `mirror_part`: negate vertex x + `reverse_faces`; Euler (rx, −ry, −rz) |
| A disc on a slanted plate sticks out like a fin | Placement overwrote the cylinder's own axis rotation | `attach()` composes base frame × own rotation |
| Boolean result renders grey | EXACT boolean adds an empty material slot per operand | Clear slots after applying (`profile_intersect` does); finalize maps empty slots to the host color |
| Palette colors come out darker/oranger in the GLB | 8-bit sRGB image `pixels` are display values, not linear | Convert linear → sRGB before writing pixels; verify by decoding the PNG inside the GLB |
| Island/fragment cleanup deletes hundreds of valid pieces | glTF splits vertices at UV seams; every UV island looks like a loose part | Weld by distance **before** counting loose parts |
| Clip's first key holds the previous clip's pose | Previous clip's NLA track still evaluates while keying | Mute each finished track while keying later clips; unmute before export |
| First frame rotation wrong after export | Unsampled export converts Euler→quaternion wrongly at frame 0 | `export_force_sampling=True` |
| Clip lengths off by a frame | Exporter snaps clip length to frames | Scene FPS 100 so 0.95 / 0.48 / 0.85 s are whole frames |
| `export_image_format="PNG"` raises | 5.x enum is AUTO/JPEG/WEBP/NONE | Use `AUTO` (keeps PNG sources lossless) |
| Unused material vanished after save | Zero-user datablocks are not saved | Fall back to defaults for missing palette entries |
| Glow is pure white in game | Emission strength 3 saturates under ACES tone mapping | Emission strength ≈ 1.0 |
| Crop sent to a service was the whole board | `sips -c` silently no-ops when the box touches the edge | Check the output's pixel size every time |

## Quick checks worth scripting

- World bbox of the collection (`mk.bounds`) against the proportion table after every stage.
- Pivot world positions printed next to the measured joint heights.
- Per-part signed volume / open edges / non-manifold (finalize_rigid prints them).
- A backface-culled render (`Workbench shading.show_backface_culling = True`) reveals flipped faces.
