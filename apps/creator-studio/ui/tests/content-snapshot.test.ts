import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inspectInstalledWorld, supportsInstalledWorldGenerator } from "../src/contentSnapshot";
import { CITY_GENERATOR_VERSION } from "../../../agent-city/ui/src/engine/planPatch";
const fixture = JSON.parse(readFileSync(new URL("../../../../fixtures/city-content-v2/integrity-vector.json", import.meta.url), "utf8"));
const item = { packageId: fixture.manifest.packageId, version: fixture.manifest.version, contentDigest: fixture.manifest.contentDigest, fileCount: 3, byteLength: 100, installedAtMs: 0 };
test("snapshot checking rejects semantic errors and releases the snapshot", async () => {
  let closed = false;
  const request = async (method: string, payload: Record<string, unknown>): Promise<unknown> => {
    if (method.endsWith("open")) return { snapshotId: "snapshot-1", manifest: fixture.manifest };
    if (method.endsWith("close")) { closed = true; return { closed: true }; }
    return { contentDigest: item.contentDigest, offset: payload.offset, totalBytes: 2, complete: true, data: fixture.files[payload.path as string] };
  };
  await assert.rejects(inspectInstalledWorld(request, item), /content_asset_catalog_invalid/);
  assert.equal(closed, true);
});
test("snapshot checking rejects inconsistent chunks and releases the snapshot", async () => {
  let closed = false;
  const request = async (method: string): Promise<unknown> => {
    if (method.endsWith("open")) return { snapshotId: "snapshot-1", manifest: fixture.manifest };
    if (method.endsWith("close")) { closed = true; return {}; }
    return { contentDigest: "sha256:wrong", offset: 0, totalBytes: 2, complete: true, data: "e30=" };
  };
  await assert.rejects(inspectInstalledWorld(request, item), /content_snapshot_invalid/);
  assert.equal(closed, true);
});

test("snapshot checking accepts a valid world and releases the snapshot", async () => {
  const { createHash } = await import("node:crypto");
  const { canonicalJson } = await import("@agent-vitals/city-sdk");
  const hash = (value: Uint8Array | string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const files: Record<string, string> = {
    "assets/catalog.json": JSON.stringify({ schemaVersion: 1, entries: [] }),
    "scene/objects.json": JSON.stringify({ schemaVersion: 1, objects: [] }),
    "world/profile.json": JSON.stringify({ schemaVersion: 1, id: "desert", version: 1, biome: "arid", geography: { generator: "arid-dunes-v1", parameters: { dunes: { duneScale: 190, duneAmplitude: 11, orientationDeg: 18 } } }, visuals: { themeId: "desert" } }),
  };
  const manifest = structuredClone(fixture.manifest);
  manifest.files = Object.entries(files).map(([path, text]) => ({ path, mediaType: "application/json", byteLength: Buffer.byteLength(text), sha256: hash(text) }));
  const { contentDigest: _old, ...body } = manifest;
  manifest.contentDigest = hash(canonicalJson(body));
  const installed = { ...item, contentDigest: manifest.contentDigest };
  let closed = false;
  const world = await inspectInstalledWorld(async (method, payload) => {
    if (method.endsWith("open")) return { snapshotId: "snapshot-1", manifest };
    if (method.endsWith("close")) { closed = true; return {}; }
    const bytes = Buffer.from(files[payload.path as string]!);
    return { contentDigest: manifest.contentDigest, offset: 0, totalBytes: bytes.length, complete: true, data: bytes.toString("base64") };
  }, installed);
  assert.equal(world.profile.id, "desert");
  assert.equal(world.scene.objects.length, 0);
  assert.equal(world.patch, null);
  assert.equal(world.manifest.contentDigest, installed.contentDigest);
  assert.equal(world.files.size, 3);
  const compatible = { ...world.manifest, entry: { ...world.manifest.entry, generatorVersion: CITY_GENERATOR_VERSION } };
  assert.equal(supportsInstalledWorldGenerator(compatible), true);
  assert.equal(supportsInstalledWorldGenerator({ ...compatible, entry: { ...compatible.entry, generatorVersion: CITY_GENERATOR_VERSION + 1 } }), false);
  assert.equal(closed, true);
});
