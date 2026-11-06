# Rigid rig, animation, GLB export and checks

## Rig: empties, not skinning

Mech armor must not deform, so each rigid part hangs under a joint **empty**; clips rotate the
empties. three.js plays node animation exactly like bone animation, and shields/plates keep their
shape. Skinned auto-rigs (e.g. tripo/rig) bend plates and invent their own bone names.

- Create joints first, at their mechanical axes, root to leaf, with `mk.empty()`.
- Rest rotation of every joint is identity (a typical runtime check); put the rest pose in the
  geometry, not in joint rotations.
- Parent parts with `mk.parent_keep()`; they keep world coordinates at rest.
- Name nodes plainly and uniquely: GLTFLoader strips `:` `.` `/` and suffixes duplicates.
- Add marker empties the runtime looks up (e.g. `front` in front of the visor).
- Optional GLB-only child joints (piston, recoil carriage, tool) must be registered in the
  project's contract before use.

## Finalize (scripts/finalize_rigid.py)

Applies modifiers → flat shading → world-space vertices → joins parts per joint into contract mesh
names → 8×1 palette material (Closest filtering; per-face constant UV, so mip level is always 0 and
colors never bleed) + a separate `faction_accent` emissive → single-sided materials → markers →
per-part self-check. Configure names/palette with a JSON file (header of the script). Name parts
`<target>__<part>` to route them into a specific mesh (e.g. `shield__rib_0`) instead of relying on
prefixes: a bare `shield_` prefix once swallowed the whole shield arm.

Draw calls = sum over meshes of material count (palette = 1, plus 1 if it has accent faces).

## Animation (scripts/animate_rigid.py + a motion module)

Write a per-character motion module (copy `motion_example_assault.py`): channels, clip durations,
`pose(clip, t, dur)`. The runner handles keying and export. Rules it enforces, and why:

- Every clip keys every channel — AnimationMixer never resets untouched nodes.
- Loop clips use angular frequency 2π/duration so first and last frames match.
- Dense keys (120/s) + per-key ground lift of the `visual` root (except clips whose lift the
  runtime handles, e.g. a backward fall).
- Ankles counter-rotate (foot = −(thigh + shin)) so soles stay flat; without ankles every step
  stabs the toes into the ground.
- Knees bend with negative X rotation in Blender (+Y forward); positive pushes the foot forward
  (reverse knee).
- Axis map Blender ↔ three.js: about three X = Blender X; three Y = Blender Z; three Z = Blender −Y.
- NLA tracks muted during keying; export with force sampling, FPS 100, image format AUTO.

## Checks (all must pass before calling it done)

1. `finalize_rigid.py` report: no part with volume ≤ 0, open edges, or non-manifold edges.
2. `python3 strip_textures.py asset.glb asset_notex.glb` (Node cannot decode images), then from a
   directory where `three` resolves:
   `node --experimental-strip-types glb_check.ts asset_notex.glb asset.manifest.json`
   → hierarchy/parents, identity rest rotation, markers, unique names, faces −Z, clip durations,
   no sinking in any sampled frame, loop seams, idle@0 = bind pose. Put `hierarchy` / `markers`
   in the manifest for non-humanoid characters.
3. `silhouette_iou.py` at the matched camera ≥ the stage gate.
4. `render_views.py` (four views on the footprint cell) and `render_clips.py` (one frame per clip)
   for a human look.
5. Budget: triangles, draw calls, GLB size against the project's limits; decode the palette PNG from
   the GLB and check the bytes once.

Known checker trap: right after `play()`, `mixer.setTime(0)` has not applied the clip yet and reads
the bind pose — compare loop seams from t = 1e-4.
