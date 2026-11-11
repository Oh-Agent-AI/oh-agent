import test from "node:test";
import assert from "node:assert/strict";
import { createMountedMiniGamePlan, MountedMiniGameControllerV1 } from "../src/game/activity/mountedMiniGame";
import { createCreatorMiniGamePlan, CreatorMiniGameDrivingControllerV1 } from "../src/game/activity/creatorMiniGame";
import type { CityLayoutSdkViewV1 } from "../src/engine/sdk/cityLayoutAdapter";

const game = { schemaVersion: 1, id: "creator.collect-one", rulesVersion: 1, slots: { targets: { kind: "zone", min: 1, max: 2, requires: ["drive"] } }, rules: {
  counters: { found: { initial: 0, max: 1 } }, nodes: [
    { id: "collect", on: { type: "zone.entered", slot: "targets" }, actions: [{ op: "counter.add", counter: "found", amount: 1 }, { op: "run.finish", outcome: "success" }] },
  ],
} };
const view: CityLayoutSdkViewV1 = {
  layout: { schemaVersion: 1, id: "fixture", coordinateSystem: "city-local-m-v1", anchors: [
    { id: "spawn", kind: "spawn", capabilities: ["drive"], geometryRef: "g:spawn" },
    { id: "target", kind: "zone", capabilities: ["drive"], geometryRef: "g:target" },
    { id: "road-end", kind: "spawn", capabilities: ["drive"], geometryRef: "g:road-end" },
  ], links: [
    { id: "link-a", fromAnchorId: "spawn", toAnchorId: "target", capabilities: ["drive"] },
    { id: "link-b", fromAnchorId: "target", toAnchorId: "road-end", capabilities: ["drive"] },
  ] },
  geometry: new Map([
    ["g:spawn", { positionMeters: { x: 0, y: 0, z: 0 } }],
    ["g:target", { positionMeters: { x: 10, y: 0, z: 0 }, activationRadiusMeters: 1 }],
    ["g:road-end", { positionMeters: { x: 20, y: 0, z: 0 } }],
  ]), roadSegments: [{ id: "road-1", fromAnchorId: "spawn", toAnchorId: "road-end", checkpointAnchorId: "target", lengthMeters: 20 }], preferredStartMeters: { x: 0, z: 0 }, seed: 7, worldRevision: "r1",
};
const mount = { schemaVersion: 1 as const, mountId: "mounted-run", layout: { kind: "city-layout" as const, id: "fixture", version: "1", digest: "r1" }, game: { kind: "city-minigame" as const, id: "creator.collect-one", version: "1", digest: "local-test" }, entryAnchorId: "spawn", bindings: { targets: ["target"] }, parameterOverrides: {} };

test("loads a creator JSON mini-game and runs it through the shared fixed-step trigger host", () => {
  const plan = createMountedMiniGamePlan({ view, packageJson: JSON.stringify(game), mount, gameRef: mount.game, seed: 7 });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  let latest = null;
  const controller = new MountedMiniGameControllerV1(plan.value, snapshot => { latest = snapshot; });
  controller.fixedStep({ x: 8, y: 0, z: 0 });
  controller.fixedStep({ x: 10, y: 0, z: 0 });
  assert.equal(latest?.status, "success");
  assert.equal(latest?.state.counters.found, 1);
});

test("rejects executable packages and undeclared mount anchors before starting", () => {
  const executable = createMountedMiniGamePlan({ view, packageJson: JSON.stringify({ ...game, script: "return fetch('/secret')" }), mount, gameRef: mount.game, seed: 7 });
  assert.equal(executable.ok, false);
  const missingAnchor = createMountedMiniGamePlan({ view, packageJson: JSON.stringify(game), mount: { ...mount, bindings: { targets: ["missing"] } }, gameRef: mount.game, seed: 7 });
  assert.equal(missingAnchor.ok, false);
  if (!missingAnchor.ok) assert.ok(missingAnchor.diagnostics.some(item => item.code === "anchor_not_found"));
});

test("accepts a valid optional slot with no bound zones", () => {
  const optional = { ...game, slots: { targets: { kind: "zone", min: 0, max: 2, requires: ["drive"] } }, rules: { counters: {}, nodes: [] } };
  const result = createMountedMiniGamePlan({ view, packageJson: JSON.stringify(optional), mount: { ...mount, bindings: {} }, gameRef: mount.game, seed: 7 });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.zones.targets, []);
});

test("rejects a resolved package reference that does not match the mounted game digest", () => {
  const result = createMountedMiniGamePlan({ view, packageJson: JSON.stringify(game), mount, gameRef: { ...mount.game, digest: "sha256:wrong" }, seed: 7 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.diagnostics.some(item => item.code === "content_ref_mismatch"));
});

test("rejects drive anchors that exist but are disconnected from the mounted entry", () => {
  const disconnectedView: CityLayoutSdkViewV1 = {
    ...view,
    layout: { ...view.layout, anchors: [...view.layout.anchors, { id: "isolated-target", kind: "zone", capabilities: ["drive"], geometryRef: "g:isolated" }] },
    geometry: new Map([...view.geometry, ["g:isolated", { positionMeters: { x: 100, y: 0, z: 0 }, activationRadiusMeters: 1 }]]),
  };
  const result = createMountedMiniGamePlan({ view: disconnectedView, packageJson: JSON.stringify(game), mount: { ...mount, bindings: { targets: ["isolated-target"] } }, gameRef: mount.game, seed: 7 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.diagnostics.some(item => item.code === "anchor_unreachable" && item.path === "mount.bindings.targets" && item.objectId === "isolated-target"));
});

test("rejects game entries without trusted City geometry", () => {
  const incompleteView: CityLayoutSdkViewV1 = { ...view, geometry: new Map([...view.geometry].filter(([ref]) => ref !== "g:spawn")) };
  const result = createMountedMiniGamePlan({ view: incompleteView, packageJson: JSON.stringify(game), mount, gameRef: mount.game, seed: 7 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostics[0]?.code, "entry_geometry_unavailable");
});

test("runs a published drive mini-game through the City driving controller adapter", () => {
  const experience = { releaseId: "release-1", title: "One Target", game, mount };
  const plan = createCreatorMiniGamePlan(view, experience);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  let latest = null;
  const controller = new CreatorMiniGameDrivingControllerV1(plan.value, snapshot => { latest = snapshot; });
  controller.fixedStep({ x: 4, y: 0, z: 0 });
  controller.fixedStep({ x: 5, y: 0, z: 0 });
  assert.equal(latest?.status, "success");
  assert.equal(latest?.completed, 1);
  assert.equal(latest?.total, 1);
  controller.dispose();
});

test("City driving adapter refuses published games requiring walking or non-zone triggers", () => {
  const walkOnly = { ...game, slots: { targets: { kind: "zone", min: 1, max: 2, requires: ["walk"] } } };
  const result = createCreatorMiniGamePlan(view, { releaseId: "release-1", title: "Walk", game: walkOnly, mount });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostics[0]?.code, "creator_game_capability_unsupported");
});
