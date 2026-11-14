import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(packageRoot, "bin", "oh-agent-sdk.mjs");

function run(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: packageRoot, encoding: "utf8" });
}

function makeGlb(document: Record<string, unknown>, binaryChunk = Buffer.from([0, 0, 0, 0])): Buffer {
  const json = Buffer.from(JSON.stringify(document), "utf8");
  const jsonLength = Math.ceil(json.byteLength / 4) * 4;
  const jsonChunk = Buffer.alloc(jsonLength, 0x20); json.copy(jsonChunk);
  const totalLength = 12 + 8 + jsonChunk.byteLength + 8 + binaryChunk.byteLength;
  const output = Buffer.alloc(totalLength);
  output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(totalLength, 8);
  output.writeUInt32LE(jsonChunk.byteLength, 12); output.writeUInt32LE(0x4e4f534a, 16); jsonChunk.copy(output, 20);
  const binaryHeader = 20 + jsonChunk.byteLength;
  output.writeUInt32LE(binaryChunk.byteLength, binaryHeader); output.writeUInt32LE(0x004e4942, binaryHeader + 4); binaryChunk.copy(output, binaryHeader + 8);
  return output;
}

test("CLI scaffold, stale ref repair, playtest, package and tamper verification", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "oh-agent-city-sdk-"));
  const project = path.join(tempRoot, "demo");
  const artifact = path.join(tempRoot, "demo.ohcity.json");
  try {
    assert.equal(run(["init", "city-minigame", project]).status, 0);
    assert.equal(run(["validate", project]).status, 0);

    const gamePath = path.join(project, "game.json");
    const game = JSON.parse(await readFile(gamePath, "utf8"));
    game.rules.counters.next.max = 3;
    await writeFile(gamePath, `${JSON.stringify(game, null, 2)}\n`);
    assert.notEqual(run(["validate", project]).status, 0);
    assert.equal(run(["sync-refs", project]).status, 0);
    assert.equal(run(["validate", project]).status, 0);
    assert.equal(run(["playtest", project, "--seed", "42"]).status, 0);
    assert.equal(run(["pack", project, "--out", artifact]).status, 0);
    assert.equal(run(["verify", artifact]).status, 0);

    const packageData = JSON.parse(await readFile(artifact, "utf8"));
    packageData.files["game.json"].id = "modified-after-pack";
    await writeFile(artifact, `${JSON.stringify(packageData, null, 2)}\n`);
    assert.notEqual(run(["verify", artifact]).status, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI creates and validates public City world profile projects", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "oh-agent-city-world-"));
  const project = path.join(tempRoot, "dunes");
  try {
    assert.equal(run(["init", "city-world", project, "--generator", "arid-dunes"]).status, 0);
    assert.equal(run(["validate-world", project]).status, 0);
    const worldPath = path.join(project, "world.json");
    const profile = JSON.parse(await readFile(worldPath, "utf8"));
    profile.geography.parameters.dunes.orientationDeg = 250;
    await writeFile(worldPath, `${JSON.stringify(profile, null, 2)}\n`);
    assert.notEqual(run(["validate-world", worldPath]).status, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("world development artifact exports reproducibly and detects tampering", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "oh-agent-world-pack-"));
  const project = path.join(tempRoot, "dunes"), first = path.join(tempRoot, "one.json"), second = path.join(tempRoot, "two.json");
  try {
    assert.equal(run(["init", "city-world", project, "--generator", "arid-dunes"]).status, 0);
    const patch = { version: 1, seed: 42, scaleTier: 2, generatorVersion: 6, updatedAt: 0,
      roadOps: [{ t: "add", from: { x: 0, z: 0 }, to: { x: 20, z: 0 }, width: 8 }], siteOps: [], buildingMoves: {}, suppressedContext: [] };
    await writeFile(path.join(project, "plan-patch.json"), JSON.stringify(patch));
    assert.notEqual(run(["pack-world", project, "--out", first, "--seed", "42"]).status, 0);
    const args = ["--seed", "42", "--generator-version", "6"];
    const packed = run(["pack-world", project, "--out", first, ...args]);
    assert.equal(packed.status, 0, packed.stderr); assert.equal(JSON.parse(packed.stdout).installable, false);
    assert.equal(run(["pack-world", project, "--out", second, ...args]).status, 0);
    assert.deepEqual(await readFile(first), await readFile(second));
    const verified = run(["verify-world", first]); assert.equal(verified.status, 0, verified.stderr);
    assert.ok(JSON.parse(verified.stdout).unchecked.includes("installation"));
    // 原始字节里的重复键必须与 Rust 宿主一致：JSON.parse 会折叠它，不能让 CLI 放行。
    const clean = await readFile(first);
    await writeFile(first, clean.toString().replace('"format":"oh-agent-city-content-v2"',
      '"format":"oh-agent-city-content-v2","format":"oh-agent-city-content-v2"'));
    assert.notEqual(run(["verify-world", first]).status, 0);
    await writeFile(first, clean);
    assert.equal(run(["verify-world", first]).status, 0, "restored artifact must verify again");
    assert.notEqual(run(["pack-world", project, "--out", first, ...args]).status, 0);
    const artifact = JSON.parse(await readFile(first, "utf8"));
    assert.deepEqual(JSON.parse(Buffer.from(artifact.files["world/plan-patch.json"], "base64").toString("utf8")), patch);
    assert.equal(artifact.manifest.entry.patch, "world/plan-patch.json");
    artifact.files["world/profile.json"] = Buffer.from("{}").toString("base64");
    await writeFile(first, JSON.stringify(artifact));
    assert.notEqual(run(["verify-world", first]).status, 0);
  } finally { await rm(tempRoot, { recursive: true, force: true }); }
});

test("world GLB import and export bind scene assets to the world package", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oh-agent-world-asset-"));
  const project = path.join(root, "world"), model = path.join(root, "gate.glb"), output = path.join(root, "world.json");
  try {
    assert.equal(run(["init", "city-world", project, "--generator", "arid-dunes"]).status, 0);
    const bytes = makeGlb({ asset: { version: "2.0" }, buffers: [{ byteLength: 12 }], bufferViews: [{ buffer: 0, byteLength: 12 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: "VEC3", min: [0, 0, 0], max: [1, 1, 1] }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }] }, Buffer.alloc(12));
    await writeFile(model, bytes);
    const imported = run(["asset", "import", project, model, "--asset-id", "gate"]);
    assert.equal(imported.status, 0, imported.stderr); const ref = JSON.parse(imported.stdout).assetRef;
    assert.equal(ref.package.kind, "city-world"); assert.equal(ref.package.digest, "self");
    await writeFile(path.join(project, "scene.json"), JSON.stringify({ schemaVersion: 1, objects: [{ id: "gate", kind: "model", asset: ref,
      transform: { positionMeters: { x: 0, y: 0, z: 0 }, rotationRadians: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }] }));
    const packed = run(["pack-world", project, "--out", output, "--seed", "42", "--generator-version", "6"]);
    assert.equal(packed.status, 0, packed.stderr); const verified = run(["verify-world", output]); assert.equal(verified.status, 0, verified.stderr);
    const artifact = JSON.parse(await readFile(output, "utf8"));
    const scene = JSON.parse(Buffer.from(artifact.files["scene/objects.json"], "base64").toString("utf8"));
    assert.deepEqual(scene.objects[0].asset.package, { digest: "self", id: artifact.manifest.packageId, kind: "city-world", version: artifact.manifest.version });
    assert.ok(artifact.files[`assets/${ref.digest.slice(7)}.glb`]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("asset inspect computes the digest of the exact bounded GLB bytes without claiming installation", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "oh-agent-city-glb-"));
  const modelPath = path.join(tempRoot, "fixture.glb");
  try {
    const bytes = makeGlb({
      asset: { version: "2.0" }, buffers: [{ byteLength: 12 }],
      bufferViews: [{ buffer: 0, byteLength: 12 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: "VEC3", min: [0, 0, 0], max: [1, 1, 1] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }],
    }, Buffer.alloc(12));
    await writeFile(modelPath, bytes);
    const inspected = run(["asset", "inspect", modelPath]);
    assert.equal(inspected.status, 0, inspected.stderr);
    const result = JSON.parse(inspected.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.asset.byteLength, bytes.byteLength);
    assert.equal(result.asset.sha256, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    assert.equal(result.trust, "unsigned-local-file");
    assert.equal(result.installable, false);
    assert.match(result.note, /does not create a package/);

    await writeFile(modelPath, Buffer.from("not a glb"));
    const rejected = run(["asset", "inspect", modelPath]);
    assert.notEqual(rejected.status, 0);
    assert.equal(JSON.parse(rejected.stdout).diagnostics[0].code, "model_size_invalid");
    await truncate(modelPath, 64 * 1024 * 1024 + 1);
    const oversized = run(["asset", "inspect", modelPath]);
    assert.notEqual(oversized.status, 0);
    assert.match(oversized.stderr, /64 MiB/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("asset import creates a content-addressed project inventory and verify detects tampering", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "oh-agent-city-asset-import-"));
  const project = path.join(tempRoot, "demo");
  const source = path.join(tempRoot, "model.glb");
  const artifact = path.join(tempRoot, "demo-with-assets.ohcity.json");
  try {
    assert.equal(run(["init", "city-minigame", project]).status, 0);
    const bytes = makeGlb({
      asset: { version: "2.0" }, buffers: [{ byteLength: 12 }],
      bufferViews: [{ buffer: 0, byteLength: 12 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: "VEC3", min: [0, 0, 0], max: [1, 1, 1] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }],
    }, Buffer.alloc(12));
    await writeFile(source, bytes);
    const imported = run(["asset", "import", project, source, "--asset-id", "small-tree"]);
    assert.equal(imported.status, 0, imported.stderr);
    const result = JSON.parse(imported.stdout);
    const expectedDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    assert.equal(result.asset.sha256, expectedDigest);
    assert.equal(result.asset.relativePath, `assets/${expectedDigest.slice("sha256:".length)}.glb`);
    assert.equal(result.installable, false);
    const catalogPath = path.join(project, "assets", "catalog.json");
    const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
    assert.equal(catalog.entries[0].assetId, "small-tree");
    assert.equal(run(["asset", "verify", project]).status, 0);
    const scene = {
      schemaVersion: 1,
      objects: [{ id: "tree-instance-1", kind: "model", asset: result.assetRef, transform: {
        positionMeters: { x: 0, y: 0, z: 0 }, rotationRadians: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
      } }],
    };
    await writeFile(path.join(project, "scene.json"), `${JSON.stringify(scene, null, 2)}\n`);
    assert.equal(run(["validate", project]).status, 0);
    const gamePath = path.join(project, "game.json");
    const game = JSON.parse(await readFile(gamePath, "utf8"));
    game.rules.counters.next.max = 3;
    await writeFile(gamePath, `${JSON.stringify(game, null, 2)}\n`);
    assert.notEqual(run(["validate", project]).status, 0);
    assert.equal(run(["sync-refs", project]).status, 0);
    assert.equal(run(["validate", project]).status, 0);

    const collision = run(["asset", "import", project, source, "--asset-id", "other-tree"]);
    assert.equal(collision.status, 0, collision.stderr);
    assert.equal(JSON.parse(await readFile(catalogPath, "utf8")).entries.length, 2);
    const packed = run(["pack", project, "--out", artifact]);
    assert.equal(packed.status, 0, packed.stderr);
    const packaged = JSON.parse(await readFile(artifact, "utf8"));
    const binaryFile = packaged.manifest.files.find((file: { mediaType: string }) => file.mediaType === "model/gltf-binary");
    assert.ok(binaryFile);
    assert.equal(binaryFile.sha256, expectedDigest);
    assert.equal(typeof packaged.files[binaryFile.path], "string");
    assert.equal(run(["verify", artifact]).status, 0);

    await writeFile(path.join(project, result.asset.relativePath), Buffer.from("tampered"));
    const verified = run(["asset", "verify", project]);
    assert.notEqual(verified.status, 0);
    assert.equal(JSON.parse(verified.stdout).diagnostics[0].code, "project_asset_verification_failed");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("asset import rejects an asset ID that is rebound to different bytes", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "oh-agent-city-asset-id-"));
  const project = path.join(tempRoot, "demo");
  const first = path.join(tempRoot, "first.glb");
  const second = path.join(tempRoot, "second.glb");
  try {
    assert.equal(run(["init", "city-minigame", project]).status, 0);
    await writeFile(first, makeGlb({ asset: { version: "2.0" }, buffers: [{ byteLength: 4 }] }));
    await writeFile(second, makeGlb({ asset: { version: "2.0", generator: "different" }, buffers: [{ byteLength: 4 }] }));
    assert.equal(run(["asset", "import", project, first, "--asset-id", "tree"]).status, 0);
    const rejected = run(["asset", "import", project, second, "--asset-id", "tree"]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /already refers to different bytes/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI scaffolds an App Game WebView project against the local App SDK without overwriting files", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "oh-agent-app-game-"));
  const project = path.join(tempRoot, "tap-challenge");
  try {
    const initialized = run(["init", "app-game", project]);
    assert.equal(initialized.status, 0, initialized.stderr);
    const packageJson = JSON.parse(await readFile(path.join(project, "package.json"), "utf8"));
    const sdkDependency = packageJson.dependencies["@agent-vitals/app-sdk"] as string;
    assert.match(sdkDependency, /^file:/);
    assert.equal(path.resolve(project, sdkDependency.slice("file:".length)), path.resolve(packageRoot, "../agent-vitals-app-sdk"));
    const source = await readFile(path.join(project, "src/main.ts"), "utf8");
    assert.match(source, /connectAppGame/);
    assert.match(source, /createAppHostClient/);
    assert.match(source, /suspend\(\)/);
    assert.match(source, /resume\(\)/);
    assert.match(source, /dispose\(\)/);
    assert.match((await readFile(path.join(project, "README.md"), "utf8")), /does not register the plugin/);
    const repeated = run(["init", "app-game", project]);
    assert.notEqual(repeated.status, 0);
    assert.match(repeated.stderr, /Refusing to overwrite/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI scaffolds an App Game project against an explicit local App SDK tarball", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "oh-agent-app-game-tarball-"));
  const project = path.join(tempRoot, "tap-challenge");
  const tarball = path.join(tempRoot, "agent-vitals-app-sdk-0.0.0.tgz");
  try {
    await writeFile(tarball, "test tarball placeholder");
    const initialized = run(["init", "app-game", project, "--app-sdk-tarball", tarball]);
    assert.equal(initialized.status, 0, initialized.stderr);
    const packageJson = JSON.parse(await readFile(path.join(project, "package.json"), "utf8"));
    assert.equal(packageJson.dependencies["@agent-vitals/app-sdk"], `file:${tarball}`);
    const result = JSON.parse(initialized.stdout);
    assert.equal(result.appSdkSource, "local-tarball");
    assert.equal(result.installable, false);
    const readme = await readFile(path.join(project, "README.md"), "utf8");
    assert.match(readme, /--app-sdk-tarball/);
    assert.match(readme, /private and not published/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
