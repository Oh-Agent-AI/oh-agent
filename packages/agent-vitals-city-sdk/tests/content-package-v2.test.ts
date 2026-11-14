import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson } from "../src/package";
import { validateContentPackageManifestV2, verifyContentPackageBytesV2, inspectContentPackageV2 } from "../src/contentPackageV2";

const sha = `sha256:${"a".repeat(64)}`;
const file = (path: string, mediaType = "application/json", byteLength = 10) => ({ path, mediaType, byteLength, sha256: sha });
const world = () => ({ formatVersion: 2, kind: "city-world", packageId: "example.desert", version: "1.0.0",
  sdkContractVersion: "1", minCityRuntimeVersion: "1.0.0", entry: { profile: "world/profile.json", scene: "scene/objects.json", assets: "assets/catalog.json", generatorVersion: 1, defaultSeed: 42 },
  files: [file("assets/catalog.json"), file("scene/objects.json"), file("world/profile.json")], contentDigest: sha });

test("v2 world manifest validates and is detached and frozen", () => {
  const input = world(); const result = validateContentPackageManifestV2(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  input.entry.defaultSeed = 7;
  assert.equal((result.value.entry as { defaultSeed: number }).defaultSeed, 42);
  assert.ok(Object.isFrozen(result.value.entry)); assert.ok(Object.isFrozen(result.value.files[0]));
});

test("v2 game entry is layout-independent and does not accept executable or undeclared data", () => {
  const value = { ...world(), kind: "city-minigame", entry: { game: "game.json", assets: "assets/catalog.json" },
    files: [file("assets/catalog.json"), file("game.json")] };
  assert.equal(validateContentPackageManifestV2(value).ok, true);
  assert.equal(validateContentPackageManifestV2({ ...value, entry: { ...value.entry, layout: "layout.json" } }).ok, false);
  assert.equal(validateContentPackageManifestV2({ ...value, files: [...value.files, file("run.js", "application/javascript")] }).ok, false);
  assert.equal(validateContentPackageManifestV2({ ...value, script: "run.js" }).ok, false);
});

test("v2 rejects traversal, case collisions, unsorted entries and size abuse", () => {
  const traversal = world(); traversal.files[0]!.path = "../catalog.json";
  assert.equal(validateContentPackageManifestV2(traversal).ok, false);
  const collision = world(); collision.files.push(file("world/Profile.json")); collision.files.sort((a,b) => a.path < b.path ? -1 : 1);
  assert.equal(validateContentPackageManifestV2(collision).ok, false);
  const unsorted = world(); unsorted.files.reverse(); assert.equal(validateContentPackageManifestV2(unsorted).ok, false);
  const oversized = world(); oversized.files[0]!.byteLength = 11 * 1024 * 1024; assert.equal(validateContentPackageManifestV2(oversized).ok, false);
  const missing = world(); missing.entry.scene = "scene/missing.json"; assert.equal(validateContentPackageManifestV2(missing).ok, false);
});

test("v2 verifies the canonical manifest and exact file bytes against a fixed SHA-256 vector", async () => {
  const vector = world();
  vector.files = vector.files.map(item => ({ ...item, byteLength: 2, sha256: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a" }));
  vector.contentDigest = "sha256:432a5a6173179521080db1ae9aa71a0d49e41d27681ed2b5ce0b62ba87383682";
  const bytes = () => new Map(vector.files.map(item => [item.path, new TextEncoder().encode("{}")]));
  assert.equal((await verifyContentPackageBytesV2(vector, bytes())).ok, true);
  const shared = JSON.parse(readFileSync(new URL("../../../fixtures/city-content-v2/integrity-vector.json", import.meta.url), "utf8"));
  const sharedFiles = new Map<string, Uint8Array>(Object.entries(shared.files).map(([name, data]) => [name, Buffer.from(data as string, "base64")]));
  assert.equal((await verifyContentPackageBytesV2(shared.manifest, sharedFiles)).ok, true);
  const changed = bytes(); changed.set("world/profile.json", new TextEncoder().encode("[]"));
  const badFile = await verifyContentPackageBytesV2(vector, changed);
  assert.equal(badFile.ok, false); if (!badFile.ok) assert.equal(badFile.diagnostics[0]?.code, "content_file_digest_mismatch");
  const wrongLength = bytes(); wrongLength.set("world/profile.json", new Uint8Array([1]));
  assert.equal((await verifyContentPackageBytesV2(vector, wrongLength)).ok, false);
  const extra = bytes(); extra.set("extra.json", new Uint8Array([1]));
  assert.equal((await verifyContentPackageBytesV2(vector, extra)).ok, false);
  const missing = bytes(); missing.delete("world/profile.json");
  assert.equal((await verifyContentPackageBytesV2(vector, missing)).ok, false);
  const altered = structuredClone(vector); altered.entry.defaultSeed++;
  const badManifest = await verifyContentPackageBytesV2(altered, bytes());
  assert.equal(badManifest.ok, false); if (!badManifest.ok) assert.equal(badManifest.diagnostics[0]?.code, "content_digest_mismatch");
});

test("world inspection validates semantic entries and rejects unresolved model references", async () => {
  const profile = { schemaVersion: 1, id: "desert", version: 1, biome: "arid", geography: { generator: "arid-dunes-v1", parameters: { dunes: { duneScale: 190, duneAmplitude: 11, orientationDeg: 18 } } }, visuals: { themeId: "desert" } };
  const encode = (x: unknown) => new TextEncoder().encode(JSON.stringify(x));
  const hash = (x: Uint8Array | string) => `sha256:${createHash("sha256").update(x).digest("hex")}`;
  const make = (scene: unknown, recipe: unknown = profile) => {
    const inputs = new Map([["assets/catalog.json", encode({ schemaVersion: 1, entries: [] })], ["scene/objects.json", encode(scene)], ["world/profile.json", encode(recipe)]]);
    const manifest = world(); manifest.files = [...inputs].map(([path, bytes]) => ({ path, mediaType: "application/json", byteLength: bytes.length, sha256: hash(bytes) }));
    const { contentDigest: _ignored, ...body } = manifest; manifest.contentDigest = hash(canonicalJson(body));
    return { manifest, inputs };
  };
  const valid = make({ schemaVersion: 1, objects: [] });
  const result = await inspectContentPackageV2(valid.manifest, valid.inputs);
  assert.equal(result.ok, true); if (result.ok) assert.ok(result.value.unchecked.includes("installation"));
  const badProfile = make({ schemaVersion: 1, objects: [] }, { ...profile, biome: "tropical" });
  const rejected = await inspectContentPackageV2(badProfile.manifest, badProfile.inputs);
  assert.equal(rejected.ok, false); if (!rejected.ok) assert.equal(rejected.diagnostics[0]?.code, "content_profile_invalid");
  const scene = { schemaVersion: 1, objects: [{ id: "gate", kind: "model", asset: { package: { kind: "city-layout", id: "layout", version: "1", digest: "digest" }, assetId: "gate", digest: sha }, transform: { positionMeters: { x: 0, y: 0, z: 0 }, rotationRadians: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }] };
  const missing = make(scene); const missingResult = await inspectContentPackageV2(missing.manifest, missing.inputs);
  assert.equal(missingResult.ok, false); if (!missingResult.ok) assert.equal(missingResult.diagnostics[0]?.code, "content_scene_asset_unresolved");
});

test("world inspection validates registered GLB bytes and their scene references", async () => {
  const gltf = { asset: { version: "2.0" }, buffers: [{ byteLength: 40 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 }, { buffer: 0, byteOffset: 36, byteLength: 4, target: 34963 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5121, count: 3, type: "SCALAR" }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], nodes: [{ mesh: 0 }] };
  const json = new TextEncoder().encode(JSON.stringify(gltf)); const padded = Math.ceil(json.length / 4) * 4;
  const glb = new Uint8Array(12 + 8 + padded + 8 + 40); const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, glb.length, true); view.setUint32(12, padded, true); view.setUint32(16, 0x4e4f534a, true);
  glb.fill(0x20, 20, 20 + padded); glb.set(json, 20); view.setUint32(20 + padded, 40, true); view.setUint32(24 + padded, 0x004e4942, true);
  const hash = (x: Uint8Array | string) => `sha256:${createHash("sha256").update(x).digest("hex")}`; const modelHash = hash(glb);
  const path = `assets/${modelHash.slice(7)}.glb`; const encode = (x: unknown) => new TextEncoder().encode(JSON.stringify(x));
  const catalog = { schemaVersion: 1, entries: [{ assetId: "gate", relativePath: path, sha256: modelHash, byteLength: glb.length, format: "glb-v2" }] };
  const scene = { schemaVersion: 1, objects: [{ id: "gate", kind: "model", asset: { package: { kind: "city-world", id: "example.desert", version: "1.0.0", digest: "self" }, assetId: "gate", digest: modelHash }, transform: { positionMeters: { x: 0, y: 0, z: 0 }, rotationRadians: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }] };
  const profile = { schemaVersion: 1, id: "desert", version: 1, biome: "arid", geography: { generator: "arid-dunes-v1", parameters: { dunes: { duneScale: 190, duneAmplitude: 11, orientationDeg: 18 } } }, visuals: { themeId: "desert" } };
  const files = new Map([[path, glb], ["assets/catalog.json", encode(catalog)], ["scene/objects.json", encode(scene)], ["world/profile.json", encode(profile)]]);
  const manifest = world(); manifest.files = [...files].sort(([a], [b]) => a < b ? -1 : 1).map(([name, bytes]) => ({ path: name, mediaType: name.endsWith(".glb") ? "model/gltf-binary" : "application/json", byteLength: bytes.length, sha256: hash(bytes) }));
  const { contentDigest: _ignored, ...body } = manifest; manifest.contentDigest = hash(canonicalJson(body));
  assert.equal((await inspectContentPackageV2(manifest, files)).ok, true);
  const foreign = structuredClone(scene); foreign.objects[0]!.asset.package.id = "other-world";
  const foreignFiles = new Map(files); foreignFiles.set("scene/objects.json", encode(foreign));
  const foreignManifest = structuredClone(manifest);
  const sceneFile = foreignManifest.files.find(item => item.path === "scene/objects.json")!;
  sceneFile.byteLength = foreignFiles.get("scene/objects.json")!.length; sceneFile.sha256 = hash(foreignFiles.get("scene/objects.json")!);
  const { contentDigest: _old, ...foreignBody } = foreignManifest; foreignManifest.contentDigest = hash(canonicalJson(foreignBody));
  const rejected = await inspectContentPackageV2(foreignManifest, foreignFiles);
  assert.equal(rejected.ok, false); if (!rejected.ok) assert.equal(rejected.diagnostics[0]?.code, "content_scene_asset_scope_invalid");
  files.delete(path); const missing = await inspectContentPackageV2(manifest, files);
  assert.equal(missing.ok, false);
});
