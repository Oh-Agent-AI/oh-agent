# Hard-surface modeling for mechs (script-driven, via Blender MCP)

Why this file exists: the first hand-built Assault was made of ~320 axis-aligned boxes with one
uniform 0.3–0.6 m bevel. Every check passed and it still looked like a stack of toy bricks
(silhouette IoU 0.59). Detail cannot fix form. These are the techniques that produce form.

## Contents
1. Mirror-first build order
2. Shaping tools (mk.py)
3. Bevel tiers
4. Depth before detail
5. Layering: frame → mechanics → armor
6. Pose is part of the silhouette
7. Anti-patterns

## 1. Mirror-first build order

For a left/right-symmetric character, treat the body as perfectly symmetric and keep everything
that breaks symmetry out of it until the end:

| Layer | Content | How |
|---|---|---|
| Symmetric body | torso, head, pelvis, legs, shoulder armor, upper arms, forearm shells | Centre-line parts: model the +X half, `mirror_center(o)` (live Mirror, clip + merge seam). Paired parts: only `_r` objects under `_r` joints; after each edit run `mirror_pass(collection, joints)` — it deletes the previous generated `_l` copies and regenerates them (data mirror + face reversal, never negative scale). |
| Asymmetric add-ons | a single weapon hand, a grip hand, markings/numbers on one side | Own collection, built after the body; never named `*_r` (or tagged `no_mirror`) so `mirror_pass` skips them. |
| Carried item | shield, separate weapon | Own collection, modeled **after** the character is complete, then installed onto its joint (e.g. `forearm_l`) and aligned to the grip hand. |

Why: half the work and guaranteed symmetry; asymmetric pieces never leak to the other side; the
body's proportions, stance and motion get validated clean before a big carried object hides them.

The carried item usually dominates the silhouette, so early silhouette scoring needs it: place a
plain **proxy slab** at its locked size/position for scoring only, and delete it when the real one
is installed. Installation gate: grip aligned to the hand (gap ≤ 0.1 m), full-character IoU passes,
and the item does not pass through torso/legs in any clip.

## 2. Shaping tools (mk.py)

| Tool | Use for | Why |
|---|---|---|
| `profile_intersect(name, front_xz, side_yz, loc, top_xy=None)` | every primary armor block (chest, thigh, shin, forearm, head, fist) | Intersects a front outline with a side outline (and optionally a top one). Gives tapered, multi-faceted plates whose front and side silhouettes are both controlled — boxes cannot. Draw the outlines from the measured proportion table and the concept views. |
| `bent_plate(name, polyline, thickness, width, loc)` | pauldrons, chest/shin front plates, shield rims | Folded sheet metal with real thickness: an open polyline thickened inward. Reads as armor shell, not as a solid brick. |
| `stepped_axle(name, [(r, d), ...], loc, axis)` | shoulder/hip axles, ring joints | Concentric rings, each protruding further; add a hex nut cylinder (`cyl(..., verts=6)`) at the centre. |
| `cut(o, cutter)` | panel grooves, vent slots, recessed bays, notches | Live EXACT boolean; the cutter is hidden and removed at finalize. Bevel is moved after the boolean. |
| `box(...)` | blockout and hidden filler only | — |
| `attach(o, base, loc)` | stripes, discs, bolts on tilted plates | Places in the base part's local frame, keeping the part's own axis. |

Outline tips: put the widest point where the concept has it (pauldrons wide at the top/outside,
fists wide at the knuckles, shins wide at the ankle flare); use 6–10 points per outline; break
every long straight edge with at least one chamfer facet.

## 3. Bevel tiers

Scale real-world prop values up to the asset (a 20 m mech):

| Tier | Width | Segments |
|---|---|---|
| Primary silhouette edges | 0.10–0.20 m | 1–2 |
| Panel-break edges | 0.03–0.05 m | 1 |
| Micro detail | 0.01–0.02 m | 1 |

`mk.TIER` holds these. Use angle-limited bevels plus WeightedNormal (mk.bevel does both). Never one
width for the whole model; a uniform large bevel is the single fastest way to look like a soft toy.

## 4. Depth before detail

Order: silhouette → primary forms → **depth** (panel breaks, steps, recessed panels, ribs,
exposed frame) → greebles (bolts, lights, hoses, decals). Depth comes from geometry:
`cut()` grooves 0.05–0.1 m deep, inset plates, stepped edges. Stickers (thin boxes glued onto flat
faces) add noise without depth; the v2 Assault's second pass added 150 such parts and the
silhouette did not move.

**Triangle budget: measure before cutting shapes.** List evaluated vs. base triangles per part:
on the Assault, about 10k of 21.3k were modifier overhead, almost all angle-limited bevel on
faceted fitted parts. Cheapest first, and re-score both gates and the per-part IoU after each step:
1. bevel angle limit 30° → 45°;
2. `bmesh.ops.dissolve_limit` at 1° with a material delimit (re-triangulate n-gons);
3. decimate hidden cores (ratio about 0.35) and halve segments on hidden joint balls;
4. only then coarsen the fitted outlines: tolerance 0.15 for big shells, 0.2 for limbs.

Together these took the body from 21.3k to 14.2k with both gates unchanged and per-part scores
within ±0.012.

**Material check (M6), measured not eyeballed.** Sample the concept per colour class (hue and
saturation buckets, median) and compare in CIE L*. Check the adjacent-panel contrast rule as an L*
difference ≥ 15. The Assault armor/armor_shade pair started at 8.6, which is why raised plates on a
"darker" hull did not read. Check the glow in an EEVEE render (Workbench shows no emission) by
counting cyan vs blown-white pixels per view transform. Blender's default AgX desaturates cyan
emission towards pale blue; judge glow in Standard or Khronos PBR Neutral and re-check the game's
own tone mapping at export. A flat two-light preview rig renders about 14 L* darker than a concept
painting; adjust exposure before comparing colours by eye.

Adjacent armor panels need value contrast (≥ 15% lightness): use an `armor_shade` palette entry
for secondary plates and facets.

## 5. Layering: frame → mechanics → armor

Concept mechs read as three layers: a dark load-bearing frame, gunmetal joints/actuators, and
colored armor plates floating 0.1–0.3 m above the frame with visible gaps at the waist, joints and
between plates. Model the frame first (simple, dark), then joints, then plates offset outward.
Plates touching each other everywhere make the model read as one block.

## 6. Pose is part of the silhouette

Model the rest pose the concept shows (e.g. A-stance with legs abducted ~13°, knees bent ~10°,
torso leaning ~5°, arms out). Joint empties keep identity rotation at rest (runtime contract), so
the pose lives in where the geometry sits, not in joint rotations. An upright "attention" pose
with correct part sizes still fails the silhouette.

## 7. Anti-patterns (each one observed)

- Axis-aligned boxes for primary armor → brick stack.
- One bevel width everywhere → soft toy.
- Shrinking the signature parts to satisfy an unrelated limit without asking → lost identity.
- Building the whole robot, then looking → errors found too late; score every stage.
- Detail as stickers → busy but flat.
- Mirroring with negative scale → flipped normals; mirroring asymmetric parts → a second fist.
