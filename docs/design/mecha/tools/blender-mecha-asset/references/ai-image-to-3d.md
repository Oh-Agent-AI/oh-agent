# AI image-to-3D: what it is good for, and how it failed as a final mesh

## Recommended role

Use generated meshes as **references**, not as the shipped hard-surface mesh:

- a semi-transparent 3D **proxy** in the Blender scene for volumes, widths, depths and the back
  that concept boards never draw (prefix its objects `REF_`, set `display_type='WIRE'`,
  `hide_select=True`);
- a color source when a texture must be baked;
- fast concept exploration and silhouette alternatives.

For organic / biomechanical characters a cleaned generated mesh may still be the better base; for
rigid hard-surface mechs hand modeling wins (below).

## Fitting hand-built parts to the reference, part by part (`scripts/ref_fit.py`)

Eyeballing a ghost is not enough: the Assault M3 kept wide stacked slabs (visual score 4/10)
while the proxy had tilted shells and faceted plates. Fitting each part to the proxy numerically
fixed that where it applies:

1. **Score first**: `part_iou(our_parts, [REF_part], crop, sym_cx=...)`. It reports three
   orthographic views plus two oblique views. A visual hull built from the same three axis views
   scores high on those views by construction, so gate on `mean`, which includes the obliques.
   Assault baseline: 0.33–0.72 per part.
2. **Fit**: `fit_profiles` → front/side/top outlines (row-span hull + RDP), then
   `profile_intersect(..., top_xy=top)`. Freeze the outlines in a JSON file so the build does not
   need the proxy loaded and outlines can be hand-edited. Outline tolerance: 0.08 for big shells,
   0.15 for limbs (0.08 crumples limbs into facet noise and costs ~2k triangles).
3. **Centre-line parts**: AI meshes are off-centre and asymmetric (the Assault torso sat +0.55 m in
   x). Pass `sym_cx` to fit against the symmetric average of both halves, then add `mirror_center()`.
4. **Keep the old part's frame**: transform the fitted mesh by the old object's inverse matrix and
   keep the matrix, so seams and vents placed in the limb's local frame still land.
5. **Place recesses from measured surfaces** (ray-cast the fitted part's front), not from the
   coordinates written for the old part.
6. **Delete M2 filler parts the fitted part absorbs** (under-plates, knee guards, toes, heels,
   soles); otherwise they poke out or float.
7. **Re-check both whole-model gates after every group**, and leave a group out to find the
   culprit. The proxy is not the concept: on the Assault, fitting the shin scored 0.92 per part but
   dropped the concept IoU from 0.745 to 0.733, and shifting, slimming or cropping it could not
   recover. Keep the earlier part there and record the conflict.

8. **Plate-level shaping goes on top of the hull, as carving.** Render the proxy part orthographic
   (`mk.shot(ortho=10)`, 100 px/m), draw a metre grid in the proxy's symmetric coordinates, and
   trace plate edges. Then cut into the hull instead of replacing it, so the silhouette and both
   gates stay put:
   - grooves along the traced edges, each sub-segment's depth taken from a ray-cast of the
     surface (front-most of three samples);
   - facet plane cuts and pockets **before** the grooves are measured;
   - `engrave(..., fill=frame)`, so the groove floors are dark wherever they land. A core scaled
     toward the hull's centre lies deeper toward the sides, so depth alone leaves dashed yellow
     floors.
8b. **Raised plates with real thickness: `mk.conform_plate(name, outline_xz, hull, proud, embed)`.**
   It extrudes the traced front outline, intersects it with the hull pushed out along vertex
   normals by `proud`, and subtracts the hull pushed in by `embed`. The plate follows the hull's
   curvature and facet cuts at a constant offset. Build plates after facet and pocket cuts but
   before grooves, or the plates inherit the groove dents. Two silent failures, both fixed in the
   helper:
   - extruding through the whole body made the "plate" a skin wrapping the back of the hull;
   - non-manifold engraved hulls made EXACT keep the whole extrusion (now `use_hole_tolerant`).
   Put the hull one palette shade darker so bright plates read as a separate layer.
9. **Score a feature against everything in the proxy that forms it.** The Assault collar ring
   sits half in the proxy's head mesh and half in its body mesh. Scored against the head mesh
   alone it looked like a drop (0.919 → 0.839); against body + head it was a gain (0.911 → 0.919).

10. **When a fitted part costs the concept gate, swap one view at a time.** Rebuild the part
    with each of its three outlines taken from the earlier concept-friendly part in turn, and see
    which swap brings the concept score back. Then change only that outline, and only where it
    disagrees. On the Assault shin, cropping the calf or the inner edge did nothing. The culprit
    was the top-view front-inner corner, which the proxy cuts diagonally while the concept has
    mass there at the hero camera. Squaring that one corner passed both gates with the shin at
    0.89 vs the proxy.
11. **`conform_plate` on small faceted parts**: pushing the hull inward along vertex normals makes
    it intersect itself, and EXACT then returns an empty plate. The helper now checks the inset
    with a BVH self-overlap test and subtracts the hull itself instead, and raises if a plate comes
    out empty. Place recesses on a curved plate from a ray-cast at the recess centre, not from the
    plate's outermost point (that cut only a thin strip).

12. **Too fat? Measure where the extra volume sits before carving** (voxel solid of each part
    minus the reference solid). On the Assault:
    - Pauldrons (1.68×): an open cavity under a shell, filled by the hull and by an inner core.
      No silhouette can carve an opening that faces away from every view; hollow the part
      instead (subtract a shrunk, shifted copy; dark interior). Result 1.12×, score 61 → 80.
    - Concavities that some direction does see (thigh, hood): add oblique views with
      `extra_view_outlines` + `carve_views` (thigh armour 1.24 → 1.09).
    - Parts that belong to a different group in the reference (knee axle, collar ring): fix the
      grouping, not the geometry. Re-score the combined region (upper body 1.10 before and after
      — the "fat head" was a grouping artifact).
    - Do not intersect with an offset reference envelope: EXACT returned empty, FAST gave wrong
      volumes, scores dropped and triangles exploded.

13. **Check the reference's own symmetry before copying an asymmetry.** Mirror about the
    reference's centre, not x = 0: the Assault proxy sat +0.55 m off-centre, which made its left
    side look 1 m narrower. Compare whole limbs, not segments. The proxy's left thigh scored only
    56 against its mirrored right thigh, yet the whole legs scored 80 (volume 1.06). Its left shin
    simply started higher and took part of the thigh, so the difference was segmentation, not shape.
14. **Seal voxel solids.** Hand-built parts with grooves and raised plates are rarely watertight;
    an unsealed exterior flood leaks in depending on grid alignment (mirror-image shins measured
    125 vs 16 m³). `ref_compare3d._solid` dilates the surface one voxel before flooding and erodes
    back after. Re-score every version with the same metric before comparing.

Limits: a visual hull cannot represent dips or openings: the barrel chest with faceted pecs, a
collar ring open at the front, or a chest top that dips between raised collar bulges. A crop that
includes a raised side bulge lifts the whole hull (the first chest fit buried the head). Crop below
such bulges and give them their own part. Shapes with dips need plate-level modeling (bent plates
and cuts traced from proxy screenshots) on top of the hull.

## Why it failed as the final mesh (Assault, measured)

| Problem | Evidence |
|---|---|
| Double thin sheets | after welding, ~100 edges with contradictory winding; topology-based "make normals consistent" made it worse (255) |
| Unusable UVs | Smart UV on the reduced mesh → ~1500 islands, 17% of a 1K atlas used, ~10 px/m |
| Part segmentation wrong | part service fused head + right arm, did not split the right knee, merged both feet |
| Proportions not controlled | 21 m wide; shield depth over-sized (10.9 m vs ~6 m in the side view) |
| Remeshing a hard surface | voxel remesh rounds every sharp edge — fixes manifold, destroys the style |

Cleaning it did reach watertight parts (fan caps per directed boundary cycle, orientation from saved
original normals), but cost more than modeling, and the hand model passed every check in less time.

## Hunyuan 3D via the shengsuanyun router (tested 2026-10-26)

- Submit `POST https://router.shengsuanyun.com/api/v1/tasks/generations`, poll
  `GET .../tasks/generations/{request_id}`. Statuses seen: SUBMITTING, SUBMITTED, QUEUED,
  IN_PROGRESS, COMPLETED, FAILED — loop until a terminal status, not while in a whitelist.
- Result `data.file_urls` are signed URLs valid ~24 h (usable directly as input to the next job).
- Docs pages render client-side; the parameter schema is embedded JSON in the HTML (grep it).
- `tencent/hunyuan-3d-pro`: `image_base64` or `image_url` (or `prompt`), optional
  `multi_view_images` [{view_type: left|right|back, …}]. `generate_type` must be **capitalized**
  (`LowPoly`, `Normal`, `Geometry`, `Sketch`) — lowercase fails (free). `LowPoly` did **not**
  reduce: still ~500k tris + 4K texture (37 MB). ~¥3 per job.
- `tencent/hunyuan-3d-reduce-face`: `file_3d {type: GLB, url}`, `face_level` low/medium/high.
  `low` → 11.9k tris, clean topology, but **UVs and texture are dropped** (bake color back from the
  high mesh). ~¥6.
- `tencent/hunyuan-3d-part`: splits into parts but rebuilds each part dense (~3M tris total), no
  texture, imperfect semantics. Use only as per-face labels. ~¥3.6.
- `tripo/rig`: auto skin + skeleton for biped/quadruped meshes. Not suitable for rigid mechs
  (plates deform, bone names do not match a rigid-joint contract).

## Hygiene

- Send only approved concept art crops — never sessions, paths, logs or user data. Confirm the
  usage rights for the art and the provider terms.
- Keep API keys out of repos and skill files: a chmod-600 env file in a scratch directory,
  sourced per command; never echo the key back.
- Verify the crop you send (pixel size), then preview the result image before paying for
  follow-up jobs (reduce/part/texture).
