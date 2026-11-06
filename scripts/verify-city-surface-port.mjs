#!/usr/bin/env node
// Host generation, frozen structure identity, ownership and concurrent capture regression checks.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadCity } from "./city-kit/index.mjs";
const { CitySurfacePort, canonicalCityWorldBytes, compileGroundRoadSurface } = await loadCity({
  "engine/surface/citySurfacePort.ts": ["CitySurfacePort", "canonicalCityWorldBytes"],
  "engine/surface/groundRoadCompiler.ts": ["compileGroundRoadSurface"],
});
const edge = (ax, bx, bridge = false) => ({ id: `${ax}/${bx}`, from: `${ax}:0`, to: `${bx}:0`,
  points: [{ x: ax, z: 0 }, { x: bx, z: 0 }], width: 5, kind: "local", bridge });
const layout = { extent: 400, terrain: { height: () => 2 }, roadEdges: [edge(-60, -20), edge(-20, 20, true), edge(20, 60)],
  highways: [], bridges: [], landmarks: [], culDeSacEnds: [] };
const source = { layout, ground: compileGroundRoadSurface(layout) };
const hash = async (bytes) => createHash("sha256").update(bytes).digest("hex");
let calls = 0;
const port = new CitySurfacePort(async (bytes) => { calls++; return hash(bytes); });
const [first, second] = await Promise.all([port.capture(source), port.capture(source)]);
assert.equal(first.status, "ready"); assert.equal(second, first); assert.equal(calls, 2, "same-source concurrency shares both hashes");
assert.equal(await port.capture(source), first);
const world = first.readWorld();
assert.equal(world.surface.revision, first.revision); assert.equal(world.revision, first.worldRevision);
assert.equal(world.obstacleCoverage, "structures-only");
assert.match(first.worldRevision, /^city-world-v2:sha256:[a-f0-9]{64}$/);
assert.equal(first.checkStructures({ requiredClearance: 1.3, maxSlopeRadians: 0.5 }).snapshotRevision, first.worldRevision);
assert.equal(first.checkLandings({maxStep:0.1,maxSlopeChange:0.3,aliasTolerance:0.1}).snapshotRevision,first.worldRevision);
assert.throws(()=>{world.landings[0].seam.a.x+=1;},TypeError);
const query=first.querySurface({x:0,z:0,layerId:"ground"});
assert.equal(query.status,"current"); assert.equal(query.worldRevision,first.worldRevision); assert.equal(query.result.status,"hit");
assert.ok(world.obstacles.some((o) => o.role === "bridge-pier"));
assert.ok(!("compilation" in first), "no mutable compiler or ground source escape hatch");
world.surface.patches[0].vertices[0] += 99;
assert.notEqual(first.readWorld().surface.patches[0].vertices[0], world.surface.patches[0].vertices[0]);
assert.throws(() => { world.obstacles[0].corners[0].x += 99; }, TypeError);
const before = await hash(canonicalCityWorldBytes(first.revision, world));
const reordered = { ...world, obstacles: [...world.obstacles].reverse(), landings: [...world.landings].reverse() };
assert.equal(await hash(canonicalCityWorldBytes(first.revision, reordered)), before);
const changed = structuredClone(world); changed.obstacles[0].corners[0].y += 1;
assert.notEqual(await hash(canonicalCityWorldBytes(first.revision, changed)), before, "pier/rail geometry changes world identity even with identical surface meshes");
const changedSeam=structuredClone(world);changedSeam.landings[0].seam.a.y+=0.1;
assert.notEqual(await hash(canonicalCityWorldBytes(first.revision,changedSeam)),before,"full seam geometry participates in world identity");
const invalid = structuredClone(world); invalid.obstacles[0].corners[0].y = NaN;
assert.throws(() => canonicalCityWorldBytes(first.revision, invalid), /invalid-world-obstacle/);

// Mountability changes the collision world even when every vertex stays fixed.
for (const obstacle of [world.obstacles.find((o) => o.shape === "box"),
  { id: "curb-policy", role: "island", shape: "prism", ring: [{x:0,z:0},{x:1,z:0},{x:1,z:1},{x:0,z:1}], yMin: 0, yMax: .22 }]) {
  assert.ok(obstacle);
  const bytes = (height) => canonicalCityWorldBytes(first.revision, { ...world, obstacles: [{ ...obstacle, mountableHeight: height }] });
  assert.notDeepEqual(bytes(0), bytes(.25), "box/prism mountability participates in identity");
  for (const height of [NaN, Infinity, -1]) assert.throws(() => bytes(height), /mountable-height/);
}

// A new rendered-source object invalidates earlier leases without requiring a manual clear.
const replaced = await port.capture({ layout, ground: compileGroundRoadSurface(layout) });
assert.equal(replaced.status, "ready"); assert.equal(replaced.worldRevision, first.worldRevision);
assert.equal(first.isCurrent(), false); assert.equal(first.read(), null); assert.equal(first.readWorld(), null);
assert.equal(first.checkStructures({ requiredClearance: 1.3, maxSlopeRadians: 0.5 }), null);
assert.equal(first.checkLandings({maxStep:0.1,maxSlopeChange:0.3,aliasTolerance:0.1}),null);
assert.equal(first.querySurface({x:0,z:0,layerId:"ground"}).status,"stale","old index cannot answer after source replacement");
assert.equal((await port.capture(null)).status, "unavailable"); assert.equal(replaced.readWorld(), null);
const beforeCancelledReplacement = await port.capture(source);
const alreadyAborted = new AbortController(); alreadyAborted.abort();
assert.equal((await port.capture({layout,ground:compileGroundRoadSurface(layout)},alreadyAborted.signal)).status,"cancelled");
assert.equal(beforeCancelledReplacement.readWorld(),null,"a cancelled request cannot keep the previous rendered source current");
const mismatch = { layout: { ...layout, extent: 500 }, ground: source.ground };
await assert.rejects(port.capture(mismatch), /ground-surface-layout-mismatch/);

// One cancelled caller must not cancel the shared capture for another caller.
let release;
const shared = new CitySurfacePort((bytes) => release ? hash(bytes) : new Promise((resolve) => { release = async () => resolve(await hash(bytes)); }));
const controller = new AbortController();
const cancelled = shared.capture(source, controller.signal); const survivor = shared.capture(source);
controller.abort(); await release();
assert.equal((await cancelled).status, "cancelled"); assert.equal((await survivor).status, "ready");

// A city change during the SECOND (structural metadata) hash must also discard publication.
let releaseWorld, startedWorld;
const worldStarted = new Promise((resolve) => { startedWorld = resolve; }); let phases = 0;
const racing = new CitySurfacePort((bytes) => ++phases === 1 ? hash(bytes) : new Promise((resolve) => {
  releaseWorld = async () => resolve(await hash(bytes)); startedWorld();
}));
const pending = racing.capture(source); await worldStarted; racing.invalidate(); await releaseWorld();
assert.equal((await pending).status, "stale");
// Remote scene proxy integration must retain the local same-generation guarantees.
let scene = [{ id: "scene:building:0", role: "building", kind: "box", center: { x: 0, y: 5, z: 0 },
  halfAxes: [{ x: 1,y: 0,z: 0 }, { x: 0,y: 5,z: 0 }, { x: 0,y: 0,z: 1 }] }];
const scenePort = new CitySurfacePort(hash), sceneSource = { ...source, solids: () => scene };
const sceneCapture = await scenePort.capture(sceneSource); assert.equal(sceneCapture.status, "ready");
assert.equal(sceneCapture.readWorld().sceneSolids.length, 1);
assert.throws(() => { sceneCapture.readWorld().sceneSolids[0].center.y = 8; }, TypeError);
const originalScene = scene; scene = structuredClone(scene); scene[0].center.y += 1;
assert.equal(sceneCapture.isCurrent(), false, "displayed scene proxy changes invalidate the frozen world");
scene = originalScene; assert.equal(sceneCapture.isCurrent(), false, "restoring scene geometry cannot revive an old handle");
const budgetProxy = { ...scene[0], mountableHeight: .25 };
assert.notDeepEqual(canonicalCityWorldBytes(first.revision, world, undefined, [budgetProxy]),
  canonicalCityWorldBytes(first.revision, world, undefined, [{ ...budgetProxy, mountableHeight: 0 }]), "scene proxy policy participates in identity");
scene = [budgetProxy];
const policyPort = new CitySurfacePort(hash), policyCapture = await policyPort.capture({ ...source, solids: () => scene });
assert.equal(policyCapture.status, "ready");
scene = [{ ...budgetProxy, mountableHeight: .26 }];
assert.equal(policyCapture.isCurrent(), false, "policy-only source mutation invalidates a lease");
scene = originalScene;
scenePort.invalidate(); const restoredScene = await scenePort.capture(sceneSource);
assert.equal(restoredScene.worldRevision, sceneCapture.worldRevision, "unchanged scene geometry keeps content identity across generations");
scenePort.invalidate(); scene = structuredClone(scene); scene[0].center.y += 1;
const movedScene = await scenePort.capture(sceneSource);
assert.notEqual(movedScene.worldRevision, restoredScene.worldRevision, "scene proxies participate in world content identity");
// Frozen host leases expose a cheap revision check instead of re-collecting and
// serializing the full scene proxy list on every runtime frame.
let leaseCurrent = true, proxyReads = 0, leaseChecks = 0, renderedChecks = 0;
const frozenPort = new CitySurfacePort(hash);
const frozenCapture = await frozenPort.capture({ ...source,
  solids: () => { proxyReads++; return scene; }, solidsCurrent: () => { leaseChecks++; return leaseCurrent; },
  verifySolidsCurrent: () => { proxyReads++; return leaseCurrent; },
  rendered: { solids: [], isCurrent: () => { renderedChecks++; return leaseCurrent; } },
});
assert.equal(frozenCapture.status, "ready");
const proxyReadsAtPublish = proxyReads;
const leaseChecksAtPublish = leaseChecks, renderedChecksAtPublish = renderedChecks;
for (let i = 0; i < 100; i++) assert.equal(frozenCapture.isLeaseCurrent(), true);
assert.equal(proxyReads, proxyReadsAtPublish, "per-frame freshness must not recollect scene solids");
assert.equal(leaseChecks - leaseChecksAtPublish, 100);
assert.equal(renderedChecks - renderedChecksAtPublish, 100, "fast checks only invoke the lease callbacks");
assert.equal(frozenCapture.verifyCurrent(), true);
assert.equal(proxyReads, proxyReadsAtPublish + 1, "deep verification still rechecks the source");
leaseCurrent = false;
assert.equal(frozenCapture.isCurrent(), false, "ending the freeze lease invalidates immediately");
console.log("Surface port: owned surface/structural metadata, world content identity, concurrent capture sharing, per-caller cancellation, source replacement and invalidation during either hash passed.");
