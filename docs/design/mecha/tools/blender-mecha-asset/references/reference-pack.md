# Concept art → modeling inputs (the reference pack)

A concept board is a picture, not a spec. Before modeling, turn it into things you can **measure,
overlay and score**. Skipping this is how a model ends up "detailed but wrong": the Assault v2 had
hundreds of parts and still scored IoU 0.59 against the concept silhouette, because proportions
were never locked.

## Contents
1. Split the board
2. Measure proportions (three sources)
3. Part spec cards
4. Palette and markings
5. Missing-information list
6. Detail tiers by game camera
7. Acceptance: matched camera + silhouette IoU
8. Deliverable layout

## 1. Split the board

Crop every view into its own file and write down what each is for:

| View type | Use it for | Do not use it for |
|---|---|---|
| Hero 3/4 render | plate layering, mood, colors; camera-match background | measuring (perspective) |
| Side / front orthographic-ish view | **heights and depths** | — |
| Detail insets | part spec cards (§3) | overall scale |
| Silhouette | **acceptance score** (§7) | measuring widths if it is 3/4 (it usually is) |

- Paint over titles and annotation text; board text is not engineering data.
- **Verify every crop's pixel size after writing it.** `sips -c` silently returns the uncropped image
  when the box touches the edge; that once sent a whole multi-view board to an image-to-3D service,
  which then modeled every figure on the board (wasted money and an hour).

## 2. Measure proportions — three sources that must agree

1. **Heights** from the most orthographic view:
   `python3 scripts/ref_measure.py board.png --box X0 Y0 X1 Y1 --height-m 19.6 --out grid.png`
   It prints the figure bbox, a width profile every 5% of height, and saves a zoomed copy with
   gridlines. Read joint heights (shoulder axle, elbow, hip, knee, ankle, weapon top/bottom) off it.
   If it warns the figure touches the box, widen the box — the crop cut the figure.
2. **Widths and depths** from a 3D proxy (an AI image-to-3D mesh scaled to the target height; see
   `ai-image-to-3d.md`). Measure per-part world extents in Blender.
3. **Cross-check** with the silhouette and the side view. Independent sources agreeing (e.g. fist
   centre +6.85 m vs +6.9 m, foot length 8.5 m vs 8.65 m) gives confidence; disagreement means one
   source is wrong — the AI proxy over-sized the Assault shield (10.9 m deep vs ~6 m in the side view).

Write the result as a table (part, value in meters, source, tolerance). **Lock it before any detail.**
Also record the rest pose (stance width, knee bend, torso lean, arm angles): an upright "attention"
pose kills a heroic silhouette even with correct part sizes.

If the locked proportions conflict with a runtime rule (footprint width, height band), surface the
conflict and let the user decide. Do not quietly scale parts down to fit: that is what turned the
Assault's giant shield into a 0.8 m slab.

## 3. Part spec cards

One card per detail inset (and per hero mechanism), always with these four lines:

- **Shape** — forms, layers, rough dimensions (meters), stepped rings, plate thickness, gaps.
- **Connection** — which joint node owns it; what is fixed vs moving.
- **Motion constraint** — e.g. "raising the arm must not pass through the pauldron" (measure the
  max angle later), "piston extends 0.8 m on punch".
- **Missing views** — what the inset does not show.

Example (Assault shoulder): stepped axle, outer Ø≈2.4 m, 2–3 rings, chrome cap; pauldron is a 0.5 m
thick folded shell with front/back flanges, 0.4–0.6 m clearance over the axle, cyan stripe along the
front flange; pauldron is fixed to the torso, axle belongs to the upper arm.

## 4. Palette and markings

- Sample 5–8 colors from the render: main armor, armor shade (≥15% darker, for plate contrast),
  frame/recess, gunmetal joints, chrome, marking white, glass, faction glow.
- The faction glow is a **separate emissive material**, never a palette entry, so the runtime can
  recolor it (ally cyan ↔ enemy coral).
- List every marking with position and method (mesh text, thin mesh decal, emissive strip).

## 5. Missing-information list

Back, top, inner sides, soles and occluded hands are usually not drawn. For each: use the 3D proxy's
guess as a reference, or mark "free design". Never silently invent. List what was invented in the
acceptance record.

## 6. Detail tiers by game camera

Estimate the on-screen height in the real game camera (a 20 m mech on a tactics board may be
100–200 px). Then:

| Tier | Examples | Where it is made |
|---|---|---|
| Silhouette (geometry, mandatory) | giant shield, giant fist, shoulder mass, stance, head size | blockout + primary forms |
| Mid-distance | faceted plates, ring joints, pistons, plate layering | primary forms + depth |
| Close-up only | bolts, small text, hoses | detail pass; cut first if over budget |

## 7. Acceptance: matched camera + silhouette IoU

- Build a Blender camera whose angle matches the hero view / silhouette (azimuth, elevation, lens).
  Iterate a few azimuths and keep the best; 3/4 concept silhouettes need 3/4 renders.
- Render a flat black silhouette: `shot(name, az=..., silhouette=True)` (mk.py).
- Score: `python3 scripts/silhouette_iou.py concept_silhouette.png render.png --overlay ov.png`.
  It normalizes by height and bottom-centres, so width/stance errors still count.
- Read the overlay: **red = concept only** (missing mass), **cyan = model only** (excess mass),
  grey = shared. It doubles as the fix list.
- Gates: blockout ≥ 0.80, primary forms ≥ 0.85. Reference: the box-built Assault v2 scored 0.59.
- **Measure the ceiling before trusting an absolute gate.** Concept boards are drawings; their
  silhouette inset is often not an exact projection of any 3D object. Score the AI image-to-3D
  proxy (made from the same art) at the same camera: for the Assault it reached only 0.777, so a
  0.80 gate was unreachable by construction. Express gates relative to that ceiling (e.g. blockout
  ≥ 0.90×, primary forms ≥ 0.95×) and also score model-vs-proxy at the matched camera, which is
  3D-consistent and can go higher.
- **Views on one board can contradict each other.** The Assault side view put the shield behind
  the body while the hero view has it at the side, so side-view silhouette IoU was meaningless
  (0.42 ours, 0.52 for the proxy). Use such views for joint heights only: draw the measured height
  lines across the concept view and the model's orthographic render side by side.
- The best-matching camera from a sweep should agree for the model and the proxy (Assault: both
  az −35°, el 4°). If they disagree, the camera is compensating for model errors — fix the model.
- **Fix the stance before local shapes.** On the Assault, three M2 rounds of fist/shield/pauldron
  tweaks moved IoU vs the proxy only 0.824 → 0.842; splaying the legs to the measured 13°
  (knee and ankle pushed out along the abduction angle, heights unchanged) took it to 0.858 in one
  step. When the overlay shows excess/missing bands along whole limbs, the pose is wrong, not the
  part.
- Add a 10-item visual score (silhouette, proportion, stance, and the 3–4 hero features, layering,
  palette, markings): each Match/Close = 1 point. Pass ≥ 8/10. Max 3 fix rounds per stage, then
  report the gap list to the user.

## 8. Deliverable layout

```
<design dir>/<character>_ref/
  main_3q.png  side.png  silhouette.png  detail_*.png
<design dir>/<CHARACTER>_MODELING_SPEC.md
  0 lessons/why   1 acceptance   2 reference pack table   3 reference analysis
  4 proportion table + rest pose   5 parts → joint nodes + pivots   6 part spec cards
  7 palette + markings   8 missing info   9 detail tiers   10 method   11 stage gates
  12 budget   13 motion notes   14 decisions confirmed by the user
```
