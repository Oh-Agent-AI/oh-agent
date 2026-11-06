# Structural CollisionIndex

`apps/agent-city/ui/src/game/driving/CollisionIndex.ts` is a CPU-only solid query module. It owns copied structure geometry from `compileSurface.ts`; it does not read Three.js, visible meshes, quality settings or mutable host objects. `COLLISION_RULES_VERSION = 1` is separate from surface geometry and physics versions.

## API and coordinate contract

- `buildCollisionIndex({ revision, obstacles }, limits?)` produces `{ status: "ready", index }` or `unresolved` with invalid-input/budget reason.
- `index.overlap(pose, dimensions)` checks a complete oriented body box.
- `index.sweep(from, to, dimensions)` checks linear centre interpolation and literal linear heading/pitch/roll interpolation. A caller wanting the short heading arc must unwrap its endpoints explicitly.
- `pose.x/y/z` is the **body box centre**, not wheel support height. Heading 0 points +X, pitch raises the nose. Dimensions are positive halfLength/halfWidth/halfHeight.
- Results carry the supplied world revision, rules version is exported separately. `clear` certifies the entire path; `contact` stops conservatively at a skin; `unresolved` cannot release a road or authorize movement. `lastSafeFraction` certifies only the prefix reached by the checker. Initial overlap is explicit; no random depenetration is attempted.

The supporting deck must lie below the body collision volume. Do not omit a support slab globally or filter obstacles by layer: the same slab must block cars underneath it, and a pier can cross several height layers. Choose the vehicle body centre/offset from its actual collider definition and keep wheel/support validation separate.

## Geometry and continuous checking

The immutable BVH uses AABBs only for broad phase. Narrow phase uses convex 3D SAT, including both polyhedra's face normals and edge cross products. Structural boxes may be pitched/rolled. Simple concave island rings are validated and ear-clipped into triangular prisms, preserving their recesses. Malformed/non-simple prisms and non-planar/non-convex box faces fail construction explicitly. Box inputs that arrive as center + half-axes (every SolidInput box, in both `buildVersionedCollisionIndex` and the legacy array form of `buildCollisionIndex`) are affine by construction and keep their half-axes; only corner-only obstacles go through the face-planarity check, whose tolerance scales with the absolute coordinates as well as the solid's extent. (2026-10-22: the legacy array path re-proved planarity from world corners with an extent-only tolerance — 8 of 68k city boxes, 0.3 m railings at |x| ≈ 500, failed on rounding alone and 12 more sat within 2× of the threshold.)

At each time, the maximum separating-axis projection gap is a conservative lower bound on Euclidean separation. Taking the minimum across all candidates gives a safe advancement distance. Centre travel plus body bounding-sphere radius times the sum of angular travel bounds the speed of **every** box point. This provides continuous coverage during translation and rotation; no endpoint-only or fixed spatial sampling certificate is used. Floating-point projection allowance reduces the gap, and inadequate coordinate precision returns unresolved.

`contact.toi` is the conservative time reached before/on the contact skin, not an analytically exact impact time. `point` is a body support witness along the reported axis, not a mesh triangle intersection point. Contact normals point away from the obstacle along the SAT separating/penetration axis. Stable obstacle ID sorts break simultaneous ties. Close misses can conservatively stop or exhaust iterations; they never become clear merely because iteration budget expired.

Build/query budgets bound source count/vertices, BVH nodes, candidates, tests and advancement iterations. No partial index or partial-clear result is published on exhaustion. Large nonconvex prism triangulation also consumes the build test budget.

## Scope and remaining integration

This module currently consumes `StructureObstacle` boxes/prisms only: bridge/highway slabs, piers, rails/trusses and channelized islands. It does **not** certify complete city collision coverage, consume arbitrary rendered building/landmark triangle soups, solve support/portal traversal, perform tangential sliding or recover an initial overlap. Surface revision invalidation remains the owning host's responsibility: an old index must be discarded when its capture is invalidated. A result's revision must match the active full world snapshot before it is applied or reported.

Meaningful verification: `node scripts/verify-city-driving-collision.mjs`, optionally `--cities`. Fixtures exercise fast thin-pier crossings with clear endpoints, full intermediate yaw rotation, pitch rotation, tilted undersides, underpass separation, concave-island recesses, owned source data, stable ties, malformed geometry and bounded failures. The cities mode builds the fifteen synthetic city layouts and checks every actual structural box centre blocks; this is geometry ingestion evidence, not a vehicle route-pass certificate.

## Surface world binding

`createStructureCollisionBinding({ surfaceRevision, worldRevision, index, dimensions, centerHeight, isCurrent })` freezes explicit collider dimensions and declares `coverage: "structures-only"`. Index revision must match worldRevision; the adapters separately check surfaceRevision against regions.revision. `SurfaceDrivingEnvironment` accepts this optional binding as its fourth constructor argument, after regions/footprint/footprintParams. `SurfaceWorldValidator` accepts it as its fifth argument, after regions/progress/footprint/footprintParams. Existing support-only call sites retain their behavior.

`centerHeight` displaces the box centre along the fitted body's up vector, including pitch and roll. The architecture layer deliberately provides no guessed production offset. A collider touching the support slab is a contact, so the caller must explicitly model a body volume/clearance above that slab; the bridge slab is not removed from collision queries. Positive roll raises the positive lateral (+Z at heading 0) side, matching footprintSupport.

Spawn checks complete support and static solid overlap. Motion checks complete support plus the full collision primitive from the independently fitted start/end body poses; state y disagreement is rejected. The independent validator recomputes this rather than trusting kernel blocked/surface flags. This primitive is linear in body centre/angles; a future solver using a different support-following trajectory must submit/check those pieces instead of treating the endpoint primitive as evidence for a different path. The adapter currently stops the entire rejected step, with no TOI advancement/sliding. It still rejects all region changes even when geometric portals exist.

The lease is checked before and after results; revoked or mismatched bindings cannot spawn, move or pass independent validation. `node scripts/verify-city-driving-structure-world.mjs` checks same-kernel pier stopping, guardrail crossing, rejected forged movement, spawn overlap, longitudinal/cross-slope body offset and revision/lifetime failures.
