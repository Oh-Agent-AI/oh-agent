---
name: blender-mecha-asset
description: Build game-ready hard-surface mech / robot / mechanical character assets in Blender from concept art, via the Blender MCP add-on or headless scripts, ending in a rigid-jointed animated GLB that passes automated checks. Covers turning a concept board into measurable inputs (crops, proportion table, part cards, silhouette IoU), mirror-first hard-surface modeling (profile-intersect armor, bent plates, bevel tiers, panel breaks), AI image-to-3D (Hunyuan, Tripo) as reference proxies, empties-based rigid rigs, clip keying, palette materials, glTF export and three.js checks. Use it whenever the user wants to model, rebuild, polish or animate a mech, robot, armored or rigid-part character in Blender, turn concept art into a 3D model, mentions Blender MCP, cleaning image-to-3D output, a model that looks blocky or unlike its concept, or a GLB character for three.js — even without naming these steps.
---

# Hard-surface mech assets in Blender

The job is not "make a 3D model". It is: make a model that **measurably** matches the concept,
is cleanly rigid-rigged, and passes the runtime contract. Two earlier attempts taught why each
part of this workflow exists:

- An AI image-to-3D mesh had the right shapes but double sheets, ~1500 UV islands and wrong part
  splits. Cleaning it cost more than modeling.
- A hand model built from axis-aligned boxes with one uniform bevel passed every technical check
  and still looked like toy bricks: silhouette IoU 0.59 vs the concept. Proportions were never
  locked, the signature parts were shrunk to fit a width rule, and nothing was compared against
  the concept until the end.

So: inputs before modeling, form before detail, numbers at every gate.

## Workflow and gates

Score each stage before moving on. Show the user the overlay images at M1 and whenever a gate
fails three times.

| Stage | Do | Gate |
|---|---|---|
| **M0 Reference pack** | Split the board, measure proportions from three sources, part spec cards, palette, missing-info list, detail tiers. Write a per-character modeling spec. → `references/reference-pack.md` | User confirms proportions and any conflict with runtime rules |
| **M1 Blockout + proportion lock** | Joints at measured pivots; symmetric body as rough masses (right half + mirror); proxy slab for any carried item; concept rest pose | Joint heights within ~3%; widths/depths within 5%; silhouette IoU ≥ 0.80 at the matched camera |
| **M2 Primary forms** | Rebuild each mass with `profile_intersect` / `bent_plate`, plates layered over a dark frame | IoU ≥ 0.85; visual score ≥ 7/10 |
| **M3 Depth** | Panel breaks with `cut()`, steps, recesses, exposed frame | Visual score ≥ 8/10 |
| **M4 Asymmetric add-ons** | One-sided hands/weapons, markings, bolts, hoses | Part spec cards ticked; mirrored halves still match |
| **M5 Carried item** | Delete the proxy; model the shield/weapon separately; install on its joint | Grip aligned (≤ 0.1 m); full IoU ≥ 0.85; no penetration in any clip |
| **M6 Materials** | 8-slot palette + separate faction emissive | Adjacent-panel contrast ≥ 15%; glow not blown out |
| **M7 Rig + clips** | `finalize_rigid.py`, motion module, `animate_rigid.py` | `glb_check.ts` ALL CHECKS PASS; finalize report has no problems |
| **M8 Export + in-game look** | Budgets, four-view and per-clip renders, real game camera | Within triangle / draw-call / size budgets |

## Core rules

- **Mirror-first.** For symmetric characters build only the right half: centre-line parts with
  `mirror_center()`, paired parts under `_r` joints, then `mirror_pass()` after every edit.
  Asymmetric add-ons and carried items stay in their own collections. Model the carried item last
  and install it. Details in `references/hard-surface.md` §1.
- **Do not change agreed proportions to satisfy another rule.** If the concept conflicts with a
  footprint or size limit, show the numbers and let the user choose. Shrinking a shield to fit a
  width limit is what made the earlier model unrecognizable.
- **Form tools, not boxes.** Boxes are for blockout and hidden filler. Primary armor is shaped
  from intersected front/side outlines or bent plates. Use tiered bevels, never one width.
- **Look at it, with numbers.** After each step render it with `mk.shot` (Workbench PNG, because
  the splash screen blocks the viewport) and compare at the matched camera with
  `silhouette_iou.py`. Red in the overlay is missing mass, cyan is excess mass.
- **Generated meshes are references.** Load them as `REF_` wire ghosts for volume and backs.
  Do not ship them for hard-surface work. Details in `references/ai-image-to-3d.md`.
- **Heavy steps run headless on a saved copy.** Finalize and animation run in a separate Blender
  process. Save the live scene first.

## Scripts (`scripts/`)

| Script | Purpose |
|---|---|
| `start_mcp.py` | Launch Blender with the official MCP server (`--online-mode`) |
| `mk.py` | Modeling helpers: `profile_intersect`, `bent_plate`, `conform_plate` (raised plate following a hull), `engrave` (baked cuts, `fill=` material for groove floors), `core_of`, `stepped_axle`, `cut`, `box`, `cyl`, `mirror_center`, `mirror_pass`, `mirror_part`, `attach`, `empty` (joint with correct pivots), `parent_keep`, `shot` (incl. `silhouette=True`), `bounds`, `TIER` |
| `ref_measure.py` | Concept view → height-profile table in meters + gridded zoom |
| `silhouette_iou.py` | Concept silhouette vs render silhouette → IoU + red/cyan overlay |
| `ref_fit.py` | Per-part fitting to an AI reference mesh: per-view + oblique IoU, outline extraction for `profile_intersect`, symmetrize off-centre parts (see `references/ai-image-to-3d.md`) |
| `finalize_rigid.py` | Apply modifiers, join per joint into contract names, palette + accent materials, markers, self-check |
| `animate_rigid.py` + `motion_example_assault.py` | Key clips from a motion module, ground lift, ankle compensation, GLB + manifest export |
| `strip_textures.py` | Texture-free GLB copy for Node-side checks |
| `glb_check.ts` | three.js contract check (hierarchy, rest rotation, markers, durations, grounding, loop seams) |
| `render_views.py` / `render_clips.py` | Four-view sheet on the footprint cell / one frame per clip |

Typical loop inside the MCP session:

```python
MK = "~/.claude/skills/blender-mecha-asset/scripts/mk.py"   # expand the path
exec(open(MK).read())              # every call: MCP does not keep Python state
# ... edit the right half, then:
mirror_pass("CHAR", {o.name: o for o in D.collections["CHAR"].objects if o.type == "EMPTY"})
shot("m2_3q", az=-30, el=8, dist=80, target=(0, 0, 9.8))
shot("m2_sil", az=-30, el=8, dist=80, target=(0, 0, 9.8), silhouette=True)
```

Then score it outside Blender:

```bash
python3 scripts/silhouette_iou.py ref/silhouette.png $BLENDER_SHOTDIR/m2_sil.png --overlay ov.png
```

Export chain (headless):

```bash
B=/Applications/Blender.app/Contents/MacOS/Blender
$B -b model.blend --python scripts/finalize_rigid.py -- rig.blend finalize.json [config.json]
$B -b rig.blend --python scripts/animate_rigid.py -- out/char motion_char.py
python3 scripts/strip_textures.py out/char.glb out/char_notex.glb
(cd <dir with three> && node --experimental-strip-types glb_check.ts out/char_notex.glb out/char.manifest.json)
```

## References

- `references/reference-pack.md`: concept board → crops, three-source measurements, part spec
  cards, palette, missing info, detail tiers, matched camera + IoU acceptance, spec layout.
- `references/hard-surface.md`: mirror-first order, shaping tools, bevel tiers,
  depth-before-detail, layering, pose, anti-patterns.
- `references/blender-mcp.md`: setup, viewing via renders, the table of silent failures and fixes.
  Read it before the first MCP call of a session.
- `references/ai-image-to-3d.md`: when generated meshes help; Hunyuan / Tripo facts, costs and
  pitfalls; data hygiene.
- `references/rig-anim-export.md`: rigid empties rig, finalize, animation rules, export, checks.

## Reporting

At every gate report a short table: stage, IoU, visual score, joint-height error, bbox
(W×H×D m), triangles, draw calls, and what failed. Attach the matched-camera render and the IoU
overlay. Be explicit about anything not verified (e.g. "glow judged in Workbench only").
