import test from "node:test";
import assert from "node:assert/strict";
import { validateSceneDraft } from "../src/validate";

const transform = {
  positionMeters: { x: 0, y: 0, z: 0 },
  rotationRadians: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
};
const asset = {
  package: { kind: "city-minigame", id: "sprint", version: "1", digest: `sha256:${"a".repeat(64)}` },
  assetId: "tree", digest: `sha256:${"b".repeat(64)}`,
};

test("validates and freezes model and anchor scene objects", () => {
  const result = validateSceneDraft({ schemaVersion: 1, objects: [
    { id: "tree-instance", kind: "model", asset, transform },
    { id: "start", kind: "anchor", anchor: { id: "start", kind: "spawn", capabilities: ["drive"], geometryRef: "road-start" }, transform },
  ] });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.objects.length, 2);
    assert.equal(Object.isFrozen(result.value.objects[0]), true);
  }
});

test("validates bounded explicit static box colliders without inferring them from models", () => {
  const result = validateSceneDraft({ schemaVersion: 1, objects: [
    { id: "obstacle", kind: "collider", shape: "box", sizeMeters: { x: 4, y: 2, z: 3 }, transform },
    { id: "tree-instance", kind: "model", asset, transform },
  ] });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.objects[0]?.kind, "collider");
    assert.equal(Object.isFrozen(result.value.objects[0]), true);
    assert.equal(result.value.objects[1]?.kind, "model");
  }
  const oversized = validateSceneDraft({ schemaVersion: 1, objects: [
    { id: "obstacle", kind: "collider", shape: "box", sizeMeters: { x: 100.1, y: 2, z: 3 }, transform },
  ] });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.diagnostics[0]?.code, "scene_collider_invalid");
});

test("rejects duplicate IDs, malformed transforms and mismatched anchor identity", () => {
  const duplicate = validateSceneDraft({ schemaVersion: 1, objects: [
    { id: "same", kind: "model", asset, transform },
    { id: "same", kind: "model", asset, transform },
  ] });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.ok(duplicate.diagnostics.some(item => item.code === "scene_object_duplicate_id"));

  const badTransform = validateSceneDraft({ schemaVersion: 1, objects: [
    { id: "tree-instance", kind: "model", asset, transform: { ...transform, scale: { x: 0, y: 1, z: 1 } } },
  ] });
  assert.equal(badTransform.ok, false);

  const mismatch = validateSceneDraft({ schemaVersion: 1, objects: [
    { id: "entry", kind: "anchor", anchor: { id: "other", kind: "spawn", capabilities: ["drive"], geometryRef: "road-start" }, transform },
  ] });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.diagnostics[0]?.code, "scene_anchor_id_mismatch");
});
