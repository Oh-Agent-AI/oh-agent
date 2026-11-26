import test from "node:test";
import assert from "node:assert/strict";
import { validateGameTypeDescriptorV1 } from "../src/gameTypes.ts";

const descriptor = {
  schemaVersion: 1,
  id: "creator.flight-ornithopter-v1",
  version: 1,
  label: "扑翼飞行",
  templateCatalog: "planned",
  template: "ornithopter-flight",
  runtime: { id: "city-flight-ornithopter", contractVersion: 1 },
  slots: {
    launch: { kind: "spawn", min: 1, max: 1, requires: ["fly"] },
    gates: { kind: "route", min: 3, max: 12, requires: ["fly"], role: "gate" },
  },
  parameters: {
    flapPower: { min: 1, max: 10, default: 6 },
    timeLimit: { min: 30, max: 600, default: 120, unit: "seconds" },
  },
  assetRoles: { vehicle: { kind: "model-glb", required: true, maxBytes: 64 * 1024 * 1024, nodeRoles: ["wing.left", "wing.right"] } },
  hud: "flight-hud",
};

test("accepts a bounded data-only game type descriptor and freezes it", () => {
  const result = validateGameTypeDescriptorV1(descriptor);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.id, "creator.flight-ornithopter-v1");
  assert.deepEqual(result.value.slots.gates.requires, ["fly"]);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.slots.gates), true);
});

test("rejects executable or unbounded game type claims", () => {
  assert.equal(validateGameTypeDescriptorV1({ ...descriptor, code: "run()" }).ok, false);
  assert.equal(validateGameTypeDescriptorV1({ ...descriptor, templateCatalog: "other" }).ok, false);
  assert.equal(validateGameTypeDescriptorV1({ ...descriptor, runtime: { id: "x" } }).ok, false);
  assert.equal(validateGameTypeDescriptorV1({ ...descriptor, slots: { gates: { kind: "route", min: 3, max: 3, requires: ["teleport"] } } }).ok, false);
  assert.equal(validateGameTypeDescriptorV1({ ...descriptor, parameters: { flapPower: { min: 10, max: 1, default: 6 } } }).ok, false);
  assert.equal(validateGameTypeDescriptorV1({ ...descriptor, assetRoles: { vehicle: { kind: "model-glb", required: true, maxBytes: 1 } } }).ok, false);
});

test("accepts an asset role with nodeRoles and no maxBytes", () => {
  const result = validateGameTypeDescriptorV1({ ...descriptor, assetRoles: {
    vehicle: { kind: "model-glb", required: true, nodeRoles: ["wing.left", "wing.right"] },
  } });
  assert.equal(result.ok, true, JSON.stringify(result));
});
