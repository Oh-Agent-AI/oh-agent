#!/usr/bin/env node
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { roadCandidateCrowding } = await loadCity({ "engine/planner/roadAdmission.ts": ["roadCandidateCrowding"] });
const road = (id, points, width = 12) => ({ id, from: `${points[0].x}:${points[0].z}`, to: `${points.at(-1).x}:${points.at(-1).z}`,
  kind: "arterial", width, points, bridge: false });
const host = road("short", [{ x: 0, z: 0 }, { x: 40, z: 0 }]);
const long = { a: { x: 0, z: 20 }, b: { x: 160, z: 20 }, arterial: true };
const before = JSON.stringify({ host, long });
assert.deepEqual(roadCandidateCrowding([host], [long]), { candidateIndex: 0, hostId: "short" },
  "a short host's midpoint can expose a conflict missed by the new road's midpoint");
assert.deepEqual(roadCandidateCrowding([{ ...host, width: 8 }], [long]), { candidateIndex: 0, hostId: "short" },
  "accepted 8-wide arterials cannot be ignored by a 12-only snapshot");
assert.equal(roadCandidateCrowding([host], [{ ...long, a: { x: 0, z: 30 }, b: { x: 160, z: 30 } }]), null);
assert.equal(roadCandidateCrowding([{ ...host, bridge: true }], [long]), null);
assert.equal(roadCandidateCrowding([host], [{ ...long, arterial: false }]), null);
assert.equal(roadCandidateCrowding([host], [{ a: { x: 40, z: 0 }, b: { x: 160, z: 20 }, arterial: true }]), null,
  "registered shared junctions retain the final predicate's exemption");
const bent = road("bent", [{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: 160, z: 100 }]);
assert.deepEqual(roadCandidateCrowding([bent], [{ a: { x: 0, z: 120 }, b: { x: 160, z: 120 }, arterial: true }]),
  { candidateIndex: 0, hostId: "bent" }, "all actual host segments participate");
assert.equal(JSON.stringify({ host, long }), before, "admission must not modify inputs or narrow roads");
assert.ok(roadCandidateCrowding([], [
  { a: { x: 0, z: 0 }, b: { x: 160, z: 0 }, arterial: true }, long,
]), "a batch cannot introduce mutually crowded arterials either");
const laterSplitHost = road("long-sloping", [{ x: -10.34, z: 399.83 }, { x: -5.12, z: 471.64 }]);
assert.ok(roadCandidateCrowding([laterSplitHost], [{ a: { x: 20.69, z: 406.52 }, b: { x: 15.31, z: 458.83 }, arterial: true }]),
  "a corridor conflict must be refused before a later junction split exposes it");
console.log("City road admission: shared final predicate, 8/12-wide and bent hosts, both-direction overlap, shared-node and bridge semantics, read-only passed.");
