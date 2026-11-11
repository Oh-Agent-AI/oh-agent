import test from "node:test";
import assert from "node:assert/strict";
import { compileCreatorSceneColliders } from "../src/game/activity/creatorSceneColliders";
import type { CreatorPublishedMiniGameV1 } from "../src/game/activity/creatorMiniGame";
import { mergeCreatorCollisionSolids } from "../src/game/runtime/createCityCarSession";
import { buildCollisionIndex, carBody, type SolidInput } from "../src/game/driving/CollisionIndex";
import { CreatorColliderDebugVisuals } from "../src/game/activity/creatorColliderDebugVisuals";

const experience = (objects: readonly unknown[]): CreatorPublishedMiniGameV1 => ({
  releaseId: "release-0123456789abcdef0123456789abcdef",
  title: "Collider fixture",
  game: { schemaVersion: 1, id: "fixture", rulesVersion: 1, slots: {}, rules: { counters: {}, nodes: [] } },
  mount: { schemaVersion: 1, mountId: "mount", layout: { kind: "city-layout", id: "fixture", version: "1", digest: "world" },
    game: { kind: "city-minigame", id: "fixture", version: "1", digest: "game" }, entryAnchorId: "spawn", bindings: {}, parameterOverrides: {} },
  scenePackage: { scene: { schemaVersion: 1, objects } as never, assets: { schemaVersion: 1, entries: [] }, assetRefs: [] },
});

test("compiles explicit creator box colliders into frozen City collision solids", () => {
  const compiled = compileCreatorSceneColliders(experience([
    { id: "wall", kind: "collider", shape: "box", sizeMeters: { x: 4, y: 2, z: 6 },
      transform: { positionMeters: { x: 10, y: 1, z: -2 }, rotationRadians: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 1, z: 0.5 } } },
  ]));
  assert.equal(compiled.revision, "release-0123456789abcdef0123456789abcdef");
  assert.equal(compiled.solids.length, 1);
  assert.equal(compiled.solids[0]?.id, "creator:release-0123456789abcdef0123456789abcdef:wall");
  assert.equal(compiled.solids[0]?.role, "creator-static-obstacle");
  assert.equal(compiled.solids[0]?.kind, "box");
  assert.deepEqual(compiled.solids[0]?.center, { x: 5, y: 0.5, z: -1 });
  assert.deepEqual(compiled.solids[0]?.halfAxes, [{ x: 2, y: 0, z: 0 }, { x: 0, y: 0.5, z: 0 }, { x: 0, y: 0, z: 0.75 }]);
  assert.ok(Object.isFrozen(compiled) && Object.isFrozen(compiled.solids) && Object.isFrozen(compiled.solids[0]));
});

test("does not infer collision from visual model objects", () => {
  const compiled = compileCreatorSceneColliders(experience([
    { id: "decoration", kind: "model", asset: { package: { kind: "city-layout", id: "fixture", version: "1", digest: "asset" }, assetId: "tree", digest: "asset" },
      transform: { positionMeters: { x: 0, y: 0, z: 0 }, rotationRadians: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
  ]));
  assert.deepEqual(compiled.solids, []);
});

test("rejects invalid creator release identities and malformed collision transforms", () => {
  assert.throws(() => compileCreatorSceneColliders({ ...experience([]), releaseId: "untrusted" }), /creator_release_id_invalid/);
  assert.throws(() => compileCreatorSceneColliders(experience([
    { id: "bad", kind: "collider", shape: "box", sizeMeters: { x: 1, y: 1, z: 1 },
      transform: { positionMeters: { x: 0, y: 0, z: 0 }, rotationRadians: { x: 0, y: 0, z: 0 }, scale: { x: -1, y: 1, z: 1 } } },
  ])), /creator_scene_collider_invalid/);
});

test("pins creator solids into the frozen driving collision world and rejects unversioned or over-budget input", () => {
  const citySolid = { id: "city-wall", role: "structure", kind: "box", center: { x: 20, y: 0, z: 0 },
    halfAxes: [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }] } as SolidInput;
  const creatorSolid = { ...citySolid, id: "creator:release:wall", role: "creator-static-obstacle", center: { x: 0, y: 0.5, z: 0 } } as SolidInput;
  const merged = mergeCreatorCollisionSolids({ cityRevision: "city-r4", sceneSolids: [citySolid], additionalSolids: [creatorSolid], additionalSolidsRevision: "release-r2" });
  assert.equal(merged?.revision, "city-r4:release-r2");
  assert.deepEqual(merged?.sceneSolids.map(solid => solid.id), ["city-wall", "creator:release:wall"]);
  assert.ok(Object.isFrozen(merged) && Object.isFrozen(merged?.sceneSolids));
  const collision = buildCollisionIndex(merged!.sceneSolids);
  const hit = collision.hit(carBody({ x: 0, z: 0, heading: 0 }, { y: 0, pitch: 0, roll: 0 }, 0.5, 0.5));
  assert.equal(hit.status, "hit");
  if (hit.status === "hit") assert.equal(hit.solid.id, "creator:release:wall");
  assert.equal(mergeCreatorCollisionSolids({ cityRevision: "city-r4", sceneSolids: [citySolid], additionalSolids: [creatorSolid] }), null);
  assert.equal(mergeCreatorCollisionSolids({ cityRevision: "city-r4", sceneSolids: [citySolid], additionalSolids: Array.from({ length: 65 }, () => creatorSolid), additionalSolidsRevision: "release-r2" }), null);
});

test("Creator playtest wireframe uses the compiled collider corners and disposes its geometry", () => {
  const solid = compileCreatorSceneColliders(experience([
    { id: "turned-wall", kind: "collider", shape: "box", sizeMeters: { x: 2, y: 2, z: 4 },
      transform: { positionMeters: { x: 6, y: 2, z: 0 }, rotationRadians: { x: 0, y: Math.PI / 2, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
  ])).solids[0]!;
  const visuals = new CreatorColliderDebugVisuals([solid]);
  assert.equal(visuals.root.children.length, 1);
  const lines = visuals.root.children[0] as import("three").LineSegments;
  assert.equal(lines.name, solid.id);
  const position = lines.geometry.getAttribute("position");
  assert.equal(position.count, 24);
  const corners = new Set<string>();
  for (let i = 0; i < position.count; i++) corners.add([0, 1, 2].map(axis => Math.round(position.getComponent(i, axis) * 1000) / 1000).join(","));
  assert.equal(corners.size, 8);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const expected = [solid.center.x + solid.halfAxes[0].x * sx + solid.halfAxes[1].x * sy + solid.halfAxes[2].x * sz,
      solid.center.y + solid.halfAxes[0].y * sx + solid.halfAxes[1].y * sy + solid.halfAxes[2].y * sz,
      solid.center.z + solid.halfAxes[0].z * sx + solid.halfAxes[1].z * sy + solid.halfAxes[2].z * sz]
      .map(value => Math.round(value * 1000) / 1000).join(",");
    assert.ok(corners.has(expected));
  }
  visuals.dispose();
  assert.equal(visuals.root.children.length, 0);
});
