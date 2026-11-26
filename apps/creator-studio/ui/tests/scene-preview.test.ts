import test from "node:test";
import assert from "node:assert/strict";
import { buildScenePreviewDraft, isSceneObjectPreviewOperations } from "../src/features/preview/scenePreview.ts";
import { composeProjectSceneView } from "../src/features/preview/projectSceneView.ts";

const collider = (id: string, x: number) => ({ id, kind: "collider", shape: "box", sizeMeters: { x: 4, y: 2, z: 3 },
  transform: { positionMeters: { x, y: 1, z: 2 }, rotationRadians: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } });

test("scene preview replays exact object operations on the saved revision", () => {
  const base = { schemaVersion: 1, objects: [collider("taxi-proxy", 2)] };
  const operations = [
    { op: "scene.object.upsert", object: collider("taxi-proxy", 8) },
    { op: "scene.object.upsert", object: collider("barrier", 12) },
    { op: "scene.object.remove", objectId: "barrier" },
  ];
  assert.equal(isSceneObjectPreviewOperations(operations), true);
  const preview = buildScenePreviewDraft(base, operations);
  assert.equal(preview?.objects.length, 1);
  assert.equal(preview?.objects[0]?.transform.positionMeters.x, 8);
  assert.equal(buildScenePreviewDraft(base, [{ op: "scene.object.remove", objectId: "missing" }]), null);
  assert.equal(buildScenePreviewDraft(base, [{ op: "mount.bind", mount: {} }]), null);
  assert.equal(buildScenePreviewDraft(base, [{ op: "scene.object.upsert", object: collider("bad", 1), extra: true }]), null);
});

test("saved project scene composes with world content without rebinding duplicate ids", () => {
  const emptyAssets = { schemaVersion: 1 as const, entries: [] };
  const base = { scene: { schemaVersion: 1 as const, objects: [collider("world-box", 1)] }, assets: emptyAssets, files: new Map() };
  const project = { scene: { schemaVersion: 1 as const, objects: [collider("project-box", 3)] }, assets: emptyAssets, files: new Map() };
  const combined = composeProjectSceneView(base, project);
  assert.deepEqual(combined?.scene.objects.map(object => object.id), ["world-box", "project-box"]);
  assert.equal(composeProjectSceneView(base, { ...project, scene: { schemaVersion: 1, objects: [collider("world-box", 9)] } }), null);
});
