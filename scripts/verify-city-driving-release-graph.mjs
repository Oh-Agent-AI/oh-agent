#!/usr/bin/env node
// ReleasedDrivingGraph 最小切片守卫：发布门（ready=false/无边界 hash 拒发）、green 子集只含
// passed、图与 key/租约绑定失效、发布不改动判定输入。
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { buildSync } = createRequire(path.join(repo, "apps/agent-city/ui/package.json"))("esbuild");
const load = (file) => {
  const source = buildSync({ entryPoints: [path.join(repo, "apps/agent-city/ui/src/game/driving/audit", file)], bundle: true,
    write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, console });
  return module.exports;
};
const { evaluateAuditRelease } = load("AuditReleasePolicy.ts");
const { publishDrivingGraph, bindDrivingGraph, RELEASED_DRIVING_GRAPH_VERSION } = load("ReleasedDrivingGraph.ts");

const key = { baseSnapshotHash: "s", vehicleConfigHash: "v", kernelBuildId: "k", surfaceVersion: 1, queryVersion: 1, snapshotCompilerVersion: 1,
  physicsVersion: 1, collisionVersion: 1, controllerVersion: 1, plannerVersion: 1, observerVersion: 1, manifestHash: "m",
  releasePolicyVersion: 1, releaseBoundaryHash: "b1" };
const units = [
  { id: "edge:a>b", kind: "directed-edge" }, { id: "edge:b>a", kind: "directed-edge" },
  { id: "turn:a", kind: "turn" }, { id: "spawn:0", kind: "spawn-access" },
  { id: "cut:x", kind: "directed-edge" },
];
const start = { x: 0, y: 0, z: 0, heading: 0, speed: 0, steering: 0, distance: 0, braking: false, reversing: false, pitch: 0, roll: 0, surfaceId: "pad" };
const manifest = { key, units, exclusions: [{ unitId: "cut:x", reason: "closed-by-decision" }],
  cases: [{ id: "c1", units: ["edge:a>b", "edge:b>a", "turn:a", "spawn:0"], start,
    gates: [{ id: "g1", x: 10, y: 0, z: 0, forwardX: 1, forwardZ: 0, halfWidth: 1.5, heightTolerance: 0.3, surfaceIds: ["pad"] }],
    corridor: { surfaceSequence: ["pad"], portalSequence: [], waypoints: [{ x: 0, z: 0 }, { x: 10, z: 0 }] },
    policy: { cruiseSpeed: 6, maxReverseSpeed: 2 }, maxTicks: 600, maxNoProgressTicks: 120 }] };
const pass = (unitId) => ({ key, unitId, topology: "passed", geometry: "passed", witness: null });
const statics = units.filter((u) => u.id !== "cut:x").map((u) => pass(u.id));
const run = { key, caseId: "c1", verdict: "passed", cause: "none", coveredUnits: ["edge:a>b", "edge:b>a", "turn:a", "spawn:0"], simulatedTicks: 40 };

// 1) 完整证据 → 发布成功；green 子集只含 passed，excluded 保留原因与 kind。
const ready = evaluateAuditRelease(manifest, statics, [run]);
assert.equal(ready.ready, true, "对照组必须 ready");
const published = publishDrivingGraph(manifest, ready);
assert.equal(published.ok, true);
assert.equal(published.graph.graphVersion, RELEASED_DRIVING_GRAPH_VERSION);
assert.equal(published.graph.releaseBoundaryHash, "b1");
assert.equal(published.graph.counts.passed, 4);
assert.equal(published.graph.counts.excluded, 1);
assert.equal(published.graph.counts.blocked, 0);
assert.ok(published.graph.units.every((u) => u.status === "passed" || u.status === "excluded"));
assert.equal(published.graph.units.find((u) => u.unitId === "cut:x").reason, "closed-by-decision");
assert.equal(published.graph.units.find((u) => u.unitId === "spawn:0").kind, "spawn-access");

// 2) ready=false（缺边界 hash）→ 拒发并携带结构化原因。
const openKey = { ...key, releaseBoundaryHash: null };
const openManifest = { ...manifest, key: openKey };
const openDecision = evaluateAuditRelease(openManifest, statics, [run]);
const refused = publishDrivingGraph(openManifest, openDecision);
assert.equal(refused.ok, false);
assert.equal(refused.reason, "final-boundary-replay-required");

// 3) ready=false（mandatory 未过）→ 拒发；缺口留在 pending，不混入图。
const partialDecision = evaluateAuditRelease(manifest, statics.filter((s) => s.unitId !== "spawn:0"), [run]);
const refusedPartial = publishDrivingGraph(manifest, partialDecision);
assert.equal(refusedPartial.ok, false, "证据不全绝不发布子图");
assert.ok(partialDecision.reasons.includes("mandatory-coverage-incomplete"));

// 4) 绑定租约：世界/key 失效 → isCurrent 翻 false；key 一致且租约活着 → true。
let live = true;
let currentKey = key;
const handle = bindDrivingGraph(published.graph, { isCurrent: () => live, currentKey: () => currentKey });
assert.equal(handle.isCurrent(), true);
live = false;
assert.equal(handle.isCurrent(), false, "租约失效");
live = true;
currentKey = { ...key, baseSnapshotHash: "s2" };
assert.equal(handle.isCurrent(), false, "世界身份变化");
currentKey = key;
assert.equal(handle.isCurrent(), true, "恢复同 key 后仍可用");

// 5) 发布不改动输入（判定只读）。
assert.equal(ready.units.length, 5);
assert.equal(manifest.units.length, 5);
assert.equal(manifest.exclusions.length, 1);
assert.equal(key.releaseBoundaryHash, "b1");

console.log("Released driving graph: publish gate (no-boundary/incomplete refuse), passed-only green set with exclusion reasons, lease+key staleness, read-only publish passed.");
