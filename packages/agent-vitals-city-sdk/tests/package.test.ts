import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, validateCityContentPackage, validatePackageManifest } from "../src/package";

const manifest = {
  schemaVersion: 1,
  package: { kind: "city-minigame", id: "sprint", version: "0.1.0" },
  entry: { layout: "layout.json", game: "game.json", mount: "mount.json" },
  files: [
    { path: "game.json", mediaType: "application/json", byteLength: 1, sha256: `sha256:${"a".repeat(64)}` },
    { path: "layout.json", mediaType: "application/json", byteLength: 1, sha256: `sha256:${"b".repeat(64)}` },
    { path: "mount.json", mediaType: "application/json", byteLength: 1, sha256: `sha256:${"c".repeat(64)}` },
  ],
  packageDigest: `sha256:${"d".repeat(64)}`,
  signature: null,
};

test("canonical JSON sorts object keys and preserves array order", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 }, list: ["b", "a"] }), '{"a":{"b":3,"y":2},"list":["b","a"],"z":1}');
  assert.throws(() => canonicalJson({ value: Number.POSITIVE_INFINITY }), /non-finite/);
  const sparse = new Array(1);
  assert.throws(() => canonicalJson(sparse), /missing/);
  const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
  assert.throws(() => canonicalJson(accessor), /data property/);
});

test("manifest validates sorted safe paths and rejects traversal", () => {
  assert.equal(validatePackageManifest(manifest).ok, true);
  const traversal = structuredClone(manifest);
  traversal.files[0].path = "../escape.json";
  assert.equal(validatePackageManifest(traversal).ok, false);
  const unsorted = structuredClone(manifest);
  unsorted.files.reverse();
  assert.equal(validatePackageManifest(unsorted).ok, false);
});

test("content package requires its file map to match the manifest exactly", () => {
  const valid = validateCityContentPackage({ format: "oh-agent-city-package-v1", manifest, files: {
    "game.json": {}, "layout.json": {}, "mount.json": {},
  } });
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(Object.isFrozen(valid.value.files["game.json"]), true);
  const extra = validateCityContentPackage({ format: "oh-agent-city-package-v1", manifest, files: {
    "game.json": {}, "layout.json": {}, "mount.json": {}, "run.js": "executable",
  } });
  assert.equal(extra.ok, false);
});

test("content package accepts bounded base64 GLB entries and rejects malformed binary payloads", () => {
  const binaryManifest = structuredClone(manifest);
  binaryManifest.files.push({ path: "z-assets/model.glb", mediaType: "model/gltf-binary", byteLength: 20, sha256: `sha256:${"e".repeat(64)}` });
  binaryManifest.files.sort((a, b) => a.path.localeCompare(b.path));
  const binary = "AAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const valid = validateCityContentPackage({ format: "oh-agent-city-package-v1", manifest: binaryManifest, files: {
    "game.json": {}, "layout.json": {}, "mount.json": {}, "z-assets/model.glb": binary,
  } });
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(valid.value.manifest.files.at(-1)?.mediaType, "model/gltf-binary");

  const malformed = validateCityContentPackage({ format: "oh-agent-city-package-v1", manifest: binaryManifest, files: {
    "game.json": {}, "layout.json": {}, "mount.json": {}, "z-assets/model.glb": "not-base64!!!!",
  } });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.diagnostics[0]?.code, "package_binary_encoding_invalid");
});
