#!/usr/bin/env node
// RoadAuditView preserves the frozen mandatory denominator and gives blocked
// evidence a concrete map location; unrun units remain inconclusive.
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

const { buildRoadAuditViewRows } = await loadCity({ "game/RoadAuditView.ts": ["buildRoadAuditViewRows"] });
const units = [
  { id: "pass", kind: "directed-edge" },
  { id: "cut", kind: "directed-edge" },
  { id: "topology", kind: "turn" },
  { id: "unrun", kind: "turn" },
  { id: "excluded", kind: "structure-transition" },
];
const route = (id, path) => ({ id, path, units: [id] });
const plan = {
  units,
  exclusions: [{ unitId: "excluded", reason: "no-ground-landing" }],
  routes: [route("pass", [{ x: 0, z: 0 }, { x: 4, z: 0 }]), route("cut", [{ x: 2, z: 3 }, { x: 8, z: 3 }]),
    route("topology", [{ x: 10, z: 10 }, { x: 20, z: 10 }]), route("unrun", [{ x: -4, z: -2 }, { x: 4, z: -2 }])],
};
const base = (routeId, verdict, witness = null) => ({ routeId, verdict, witness, detail: routeId + "-detail", cause: verdict === "passed" ? "none" : "pilot-failed", run: null });
const rows = buildRoadAuditViewRows(plan, [
  base("pass", "passed"),
  base("cut", "blocked", { kind: "cut", a: { x: 4, z: 2 }, b: { x: 4, z: 8 }, station: 2, layerId: "ground", widest: 1, required: 3, limits: [] }),
  base("topology", "blocked", { kind: "topology", startRegion: "east", exitRegion: "west" }),
]);
assert.equal(rows.length, units.length, "every candidate and exclusion remains visible");
assert.deepEqual(rows.map((row) => [row.id, row.status]), [
  ["pass", "passed"], ["cut", "blocked"], ["topology", "blocked"], ["unrun", "inconclusive"], ["excluded", "excluded"],
]);
assert.deepEqual(rows.find((row) => row.id === "cut").location, { x: 4, z: 5 }, "cut witness locates the failing cross-section");
assert.deepEqual(rows.find((row) => row.id === "topology").location, { x: 15, z: 10 }, "topology-only failure locates on its planned route");
assert.equal(rows.find((row) => row.id === "unrun").reason, "not-run");
assert.equal(rows.find((row) => row.id === "excluded").reason, "no-ground-landing");
console.log("city road audit UI view guard passed");
