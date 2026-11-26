import test from "node:test";
import assert from "node:assert/strict";
import { loadWorldSceneModels, loadWorldScenePreview } from "../src/game/activity/creatorSceneModels";
import { PreviewEntityRegistry } from "../src/engine/previewEntityRegistry";

test("world model loader rejects missing model bytes rather than silently dropping objects", async () => {
  const scene = { schemaVersion: 1 as const, objects: [{ id: "gate", kind: "model" as const, asset: { package: { kind: "city-world" as const, id: "desert", version: "1", digest: "self" }, assetId: "gate", digest: `sha256:${"a".repeat(64)}` }, transform: { positionMeters: { x: 0, y: 0, z: 0 }, rotationRadians: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }] };
  const catalog = { schemaVersion: 1 as const, entries: [{ assetId: "gate", relativePath: "assets/gate.glb", sha256: scene.objects[0]!.asset.digest, byteLength: 4, format: "glb-v2" as const }] };
  await assert.rejects(loadWorldSceneModels(scene, catalog, new Map()), /creator_scene_asset_ref_invalid/);
  await assert.rejects(loadWorldSceneModels(scene, catalog, new Map([["assets/gate.glb", new Uint8Array(4)]])), /creator_scene_asset_ref_invalid/);
});

test("world model loader mounts a valid model and rejects modified bytes", async () => {
  const { createHash } = await import("node:crypto");
  const document = { asset: { version: "2.0" }, buffers: [{ byteLength: 12 }], bufferViews: [{ buffer: 0, byteLength: 12 }], accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: "VEC3", min: [0, 0, 0], max: [0, 0, 0] }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 };
  const json = Buffer.from(JSON.stringify(document));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20); json.copy(padded);
  const bytes = Buffer.alloc(12 + 8 + padded.length + 8 + 12);
  bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(padded.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); padded.copy(bytes, 20);
  bytes.writeUInt32LE(12, 20 + padded.length); bytes.writeUInt32LE(0x004e4942, 24 + padded.length);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const scene = { schemaVersion: 1 as const, objects: [{ id: "gate", kind: "model" as const, asset: { package: { kind: "city-world" as const, id: "desert", version: "1", digest: "self" }, assetId: "gate", digest }, transform: { positionMeters: { x: 1, y: 2, z: 3 }, rotationRadians: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }] };
  const catalog = { schemaVersion: 1 as const, entries: [{ assetId: "gate", relativePath: "assets/gate.glb", sha256: digest, byteLength: bytes.length, format: "glb-v2" as const }] };
  const loaded = await loadWorldSceneModels(scene, catalog, new Map([["assets/gate.glb", bytes]]));
  assert.equal(loaded.group.children.length, 1);
  loaded.dispose();
  assert.equal(loaded.group.children.length, 0);
  const modified = Buffer.from(bytes); modified[modified.length - 1] = 1;
  await assert.rejects(loadWorldSceneModels(scene, catalog, new Map([["assets/gate.glb", modified]])), /creator_scene_asset_ref_invalid/);
});


test("authoring preview renders exact collider and anchor objects as pickable entities", async () => {
  const transform = { positionMeters: { x: 4, y: 2, z: 6 }, rotationRadians: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
  const scene = { schemaVersion: 1 as const, objects: [
    { id: "taxi-collider", kind: "collider" as const, shape: "box" as const, sizeMeters: { x: 4, y: 2, z: 3 }, transform },
    { id: "spawn-a", kind: "anchor" as const, anchor: { id: "spawn-a", kind: "spawn" as const, capabilities: ["drive" as const], geometryRef: "road:a" }, transform },
  ] };
  const loaded = await loadWorldScenePreview(scene, { schemaVersion: 1, entries: [] }, new Map());
  assert.equal(loaded.group.children.length, 2);
  const registry = new PreviewEntityRegistry();
  registry.register(loaded.group);
  assert.equal(registry.metadataFor(registry.get("taxi-collider")!)?.kind, "scene-collider");
  assert.equal(registry.metadataFor(registry.get("spawn-a")!)?.kind, "scene-anchor");
  registry.unregister(loaded.group);
  loaded.dispose();
  assert.equal(loaded.group.children.length, 0);
});
