#!/usr/bin/env node
// Road-neutral static scene capture: canonical ownership, revisions, budgets and cancellation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadCity } from "./city-kit/index.mjs";

const { CityStaticWorldPort } = await loadCity({ "engine/surface/cityStaticWorldPort.ts": ["CityStaticWorldPort"] });
const hash = async (bytes) => createHash("sha256").update(bytes).digest("hex");
function layout(height = (x, z) => x * 0.001 + z * 0.002) {
  return { seed: 7, scaleTier: 2, biome: "coastal", extent: 100, islandRadius: 80,
    roadEdges: [], highways: [], bridges: [], landmarks: [], culDeSacEnds: [],
    terrain: { height, slope: () => 0, buildable: () => true, coastRadius: () => 80,
      center: { x: 0, z: 0 }, radius: 80, hasRiver: false },
    seaMountains: [], decorMountains: [], extraMap: new Map([["b", 2], ["a", 1]]) };
}
const source = (cityLayout, solids = []) => ({ layout: cityLayout,
  rendered: { solids: [], isCurrent: () => true, verifyCurrent: () => true },
  solids, isCurrent: () => true, verifyCurrent: () => true });

// Static compilation only needs structure/layout descriptors; no ground-road compiler is present.
{
  let released = 0;
  const inputLayout = layout();
  const port = new CityStaticWorldPort(hash);
  const captured = await port.capture(source(inputLayout), () => { released++; });
  assert.equal(captured.status, "ready");
  const snapshot = captured.readWorld();
  assert.ok(snapshot);
  assert.notEqual(snapshot.layout, inputLayout, "layout is copied into the owned snapshot");
  assert.ok(Object.isFrozen(snapshot.layout) && Object.isFrozen(snapshot.layout.terrain));
  assert.throws(() => snapshot.layout.extraMap.set("c", 3), /immutable-city-layout/);
  inputLayout.extent = 500;
  assert.equal(snapshot.layout.extent, 100, "later source mutation cannot alter the captured layout");
  const initialRevision = captured.worldRevision;
  captured.release(); captured.release();
  assert.equal(released, 1, "release is idempotent");
  assert.equal(captured.readWorld(), null); assert.equal(captured.isLeaseCurrent(), false);

  const changedTerrain = await port.capture(source(layout((x, z) => x * 0.001 + z * 0.002 + 0.01)), () => {});
  assert.equal(changedTerrain.status, "ready");
  assert.notEqual(changedTerrain.worldRevision, initialRevision, "sampled terrain profile participates in static revision");
  changedTerrain.release();
  const reorderedMap = layout(); reorderedMap.extraMap = new Map([["a", 1], ["b", 2]]);
  const stable = await port.capture(source(reorderedMap), () => {});
  assert.equal(stable.status, "ready");
  assert.equal(stable.worldRevision, initialRevision, "map insertion order has stable canonical identity");
  stable.release();

  const diagnosticHeavy = layout();
  diagnosticHeavy.plannerDiagnostics = { probes: "x".repeat(8 * 1024 * 1024) };
  const withoutTransientDiagnostics = await port.capture(source(diagnosticHeavy), () => {});
  assert.equal(withoutTransientDiagnostics.status, "ready", "transient planner diagnostics do not consume the static metadata budget");
  assert.equal(withoutTransientDiagnostics.worldRevision, initialRevision, "non-static planner diagnostics do not change the world revision");
  assert.match(withoutTransientDiagnostics.worldRevision, /^city-static-v4:/, "the narrowed canonical contract gets a new revision version");
  withoutTransientDiagnostics.release();

  const renderHeavy = layout();
  renderHeavy.coastalConfig = { unusedRendererPayload: "x".repeat(9 * 1024 * 1024) };
  const collisionIdentityOnly = await port.capture(source(renderHeavy), () => {});
  assert.equal(collisionIdentityOnly.status, "ready", "large render/planner descriptors do not consume the static collision header budget");
  assert.equal(collisionIdentityOnly.worldRevision, initialRevision, "non-collision layout payload does not change the collision-world revision");
  collisionIdentityOnly.release();
}

// A delayed digest cancellation releases the one shared source freeze and cannot publish late.
{
  let resolveHash, hashStarted;
  const started = new Promise((resolve) => { hashStarted = resolve; });
  const port = new CityStaticWorldPort(() => new Promise((resolve) => { resolveHash = resolve; hashStarted(); }));
  const controller = new AbortController(); let released = 0;
  const pending = port.capture(source(layout()), () => { released++; }, controller.signal);
  await started; controller.abort(); resolveHash("a".repeat(64));
  assert.equal((await pending).status, "cancelled"); assert.equal(released, 1);
}

// Oversized static source is rejected before cloning/publishing partial geometry.
{
  let released = 0;
  const port = new CityStaticWorldPort(hash);
  const solids = Array.from({ length: 60_001 }, (_, i) => ({ id: `scene:${i}`, role: "fixture", kind: "box",
    center: { x: i, y: 0, z: 0 }, halfAxes: [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }] }));
  assert.equal((await port.capture(source(layout(), solids), () => { released++; })).status, "unavailable");
  assert.equal(released, 1);
}

console.log("city static world: road-neutral capture, stable terrain/layout revision, defensive ownership, cancellation and budget guards passed.");
