import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { canonicalJson } from "@oh-agent/city-sdk";
import { buildCitySourceExport, buildProjectSourceExport } from "../src/projectSourceExport.ts";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
const sdkCli = path.resolve("../../../packages/agent-vitals-city-sdk/bin/oh-agent-sdk.mjs");
const run = (...args: string[]) => spawnSync(process.execPath, [sdkCli, ...args], { encoding: "utf8" });
const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const city = { schemaVersion: 1, cityId: "city-desert", revision: 2, name: "desert", seed: 42,
  profile: { schemaVersion: 1, id: "arid-dunes", version: 1, biome: "arid", geography: { generator: "arid-dunes-v1", parameters: { dunes: { duneScale: 190, duneAmplitude: 11, orientationDeg: 18 } } }, visuals: { themeId: "desert" } } };

test("exports an independent City without a game and validates its world", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "creator-city-source-"));
  try {
    const source = buildCitySourceExport(city, 6);
    assert.equal(JSON.stringify(source.files).includes(city.cityId), false);
    assert.equal(Object.keys(source.files).some(name => name.startsWith("games/")), false);
    for (const [name, contents] of Object.entries(source.files)) { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, contents); }
    const checked = run("validate-world", path.join(root, "world"));
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    const bundle = path.join(root, "world-package.json");
    const packed = run("pack-world", path.join(root, "world"), "--out", bundle, "--seed", "42", "--generator-version", "6");
    assert.equal(packed.status, 0, packed.stderr || packed.stdout);
    const verified = run("verify-world", bundle);
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);
    assert.throws(() => buildCitySourceExport({ ...city, planPatch: { version: 1, seed: 42, generatorVersion: 6, scaleTier: 1, updatedAt: 0, roadOps: [], siteOps: [], buildingMoves: {}, suppressedContext: ["unknown-context"] } }, 6), /patch_context_unresolved/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("exports an independent City and game as SDK-valid source files, without private identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "creator-source-projection-"));
  try {
    const gameDir = path.join(root, "fixture");
    assert.equal(run("init", "city-minigame", gameDir).status, 0);
    const game = JSON.parse(await readFile(path.join(gameDir, "game.json"), "utf8"));
    const layout = JSON.parse(await readFile(path.join(gameDir, "layout.json"), "utf8"));
    const mount = JSON.parse(await readFile(path.join(gameDir, "mount.json"), "utf8"));
    mount.layout.digest = "world-revision"; mount.game.digest = digest(game);
    const project = { cityId: city.cityId, cityRevision: city.revision, cityLayout: { schemaVersion: 1, worldRevision: "world-revision", seed: city.seed, layout }, game, mounts: [mount], scene: { schemaVersion: 1, objects: [] }, assets: { schemaVersion: 1, entries: [] } };
    const result = await buildProjectSourceExport(project, city, 6);
    assert.deepEqual(result.assetDigests, []);
    assert.equal(JSON.stringify(result.files).includes(city.cityId), false);
    assert.match(result.files["README.md"], /World seed: 42\. Generator version: 6/);
    const output = path.join(root, "export");
    for (const [name, text] of Object.entries(result.files)) { const file = path.join(output, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); }
    assert.equal(run("validate-world", path.join(output, "world")).status, 0);
    const checked = run("validate", path.join(output, "games/game"));
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    assert.equal(run("pack-world", path.join(output, "world"), "--out", path.join(root, "world.json"), "--seed", "42", "--generator-version", "6").status, 0);
    await assert.rejects(buildProjectSourceExport({ ...project, cityId: "city-other" }, city, 6), /city_scope_mismatch/);
    const unbound = await buildProjectSourceExport({ ...project, mounts: [] }, city, 6);
    assert.equal(unbound.files["games/game/mount.json"], undefined);
    assert.match(unbound.files["README.md"], /game has no mount/);
    await assert.rejects(buildProjectSourceExport({ ...project, mounts: [mount, mount] }, city, 6), /single_mount_required/);
    await assert.rejects(buildProjectSourceExport({ ...project, cityPatch: { version: 1, seed: 42, generatorVersion: 6, scaleTier: 1, updatedAt: 0, roadOps: [], siteOps: [], buildingMoves: { private: {} }, suppressedContext: [] } }, city, 6), /patch_not_portable/);
    await assert.rejects(buildProjectSourceExport({ ...project, cityPatch: { version: 1, seed: 42, generatorVersion: 6, scaleTier: 1, updatedAt: 0, roadOps: [], siteOps: [], buildingMoves: {}, suppressedContext: ["unknown-context"] } }, city, 6), /patch_context_unresolved/);
    const assetDigest = `sha256:${"a".repeat(64)}`;
    const asset = { assetId: "gate", relativePath: `assets/${"a".repeat(64)}.glb`, sha256: assetDigest, byteLength: 64, format: "glb-v2", boundsMeters: { x: 1, y: 2, z: 1 } };
    const transform = { positionMeters: { x: 0, y: 0, z: 0 }, rotationRadians: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
    const assetRef = { package: { kind: "city-layout", id: layout.id, version: "1", digest: "world-revision" }, assetId: "gate", digest: assetDigest };
    const withAsset = { ...project, assets: { schemaVersion: 1, entries: [asset] }, assetRefs: [assetRef], scene: { schemaVersion: 1, objects: [{ id: "gate-instance", kind: "model", asset: assetRef, transform }] } };
    const assetResult = await buildProjectSourceExport(withAsset, city, 6);
    assert.deepEqual(assetResult.assetDigests, [assetDigest]);
    const scene = JSON.parse(assetResult.files["games/game/scene.json"]);
    assert.deepEqual(scene.objects[0].asset.package, { kind: "city-minigame", id: game.id, version: "1", digest: digest(game) });
    await assert.rejects(buildProjectSourceExport({ ...withAsset, assetRefs: [] }, city, 6), /asset_reference_invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
