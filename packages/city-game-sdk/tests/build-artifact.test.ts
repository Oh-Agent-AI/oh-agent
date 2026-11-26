import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildCodeGame, type CodeGameBuildSuccess } from "../scripts/buildGame.ts";
import {
  createCodeGamePublishPayload,
  digestArtifactBytes,
  loadCodeGameBuildArtifact,
  loadCodeGameBuildById,
  readCodeGameBuildAsset,
} from "../scripts/buildArtifact.ts";
import { createInstalledGameFromCodeBuild } from "../src/protocol/installedGame";
import { compileWorldFixtureV1 } from "@oh-agent/city-sdk/testing";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const templateDir = path.join(repoRoot, "games", "hello-city");

function fixture(t: { after(callback: () => void): void }): { workspace: string; outDir: string } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "code-game-artifact-workspace-"));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-game-artifact-builds-"));
  fs.cpSync(templateDir, workspace, { recursive: true });
  t.after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });
  return { workspace, outDir };
}

async function built(workspace: string, outDir: string): Promise<CodeGameBuildSuccess> {
  const result = await buildCodeGame({ workspaceDir: workspace, outDir });
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.diagnostics));
  if (!result.ok) throw new Error("unreachable");
  return result;
}

function writeV2Manifest(workspace: string, entryExport = "default"): void {
  const manifestPath = path.join(workspace, "game.manifest.json");
  const v1 = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        ...v1,
        schemaVersion: 2,
        sdk: { name: "@oh-agent/city-game-sdk", apiMajor: 2 },
        citySdk: { name: "@oh-agent/city-sdk", schemaMajor: 2 },
        world: { requiredCapabilities: ["world.snapshot", "roads.graph"], binding: "capability-based" },
        render: { compatibleProfiles: [] },
        presentation: { supported: ["exclusive", "overlay"], default: "exclusive" },
        entries: [
          { id: "default", export: entryExport, presentation: ["exclusive"] },
          { id: "briefing", export: "default", presentation: ["overlay"] },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

function expectIntegrity(error: unknown): boolean {
  assert.equal((error as { code?: string }).code, "game_package_integrity_failed");
  return true;
}

test("a build seals deterministic artifacts and indexes the manifest display name", async (t) => {
  const { workspace, outDir } = fixture(t);
  const first = await built(workspace, outDir);
  const second = await buildCodeGame({ workspaceDir: workspace, outDir, dataHome: workspace });
  assert.equal(second.ok, true);
  if (!second.ok) throw new Error("could not index built package");
  const index = JSON.parse(fs.readFileSync(path.join(workspace, "state", "creator", "code-games", "index.json"), "utf8"));
  assert.equal(index[0].displayName, first.manifest.displayName);
  assert.equal(second.buildId, first.buildId);
  const loaded = loadCodeGameBuildById(outDir, first.buildId);
  assert.equal(loaded.build.manifestDigest, first.manifestDigest);
  assert.equal(loaded.build.bundleDigest, digestArtifactBytes(loaded.bundle));
  assert.equal(loaded.build.sourceMapDigest, digestArtifactBytes(loaded.sourceMap));
  assert.equal(loaded.assets.length, 1);
  assert.equal(readCodeGameBuildAsset(loaded, "cube").digest, first.assetDigests["assets/cube.glb"]);
  assert.equal(fs.existsSync(path.join(first.buildDir, "manifest.json")), true);
  assert.equal(fs.existsSync(path.join(first.buildDir, "assets", "cube.glb")), true);

  const publish = createCodeGamePublishPayload(loaded);
  assert.deepEqual(publish.map((file) => file.relativePath).sort(), [
    "assets/cube.glb",
    "build.json",
    "game.js",
    "game.js.map",
    "manifest.json",
  ]);
  for (const file of publish) assert.equal(file.digest, digestArtifactBytes(file.bytes));

  const installed = createInstalledGameFromCodeBuild("installation-1", loaded.build, loaded.manifest);
  assert.equal(installed.kind, "code");
  assert.equal(installed.buildId, first.buildId);
  assert.equal(installed.contentDigest, first.contentDigest);
  assert.deepEqual(installed.entries, [{ id: "default", presentations: ["exclusive"] }]);
});

test("old BuildIds and publish bytes ignore workspace edits and deletion; new content gets a new id", async (t) => {
  const { workspace, outDir } = fixture(t);
  const first = await built(workspace, outDir);
  const sealedAsset = readCodeGameBuildAsset(loadCodeGameBuildById(outDir, first.buildId), "cube").bytes.slice();
  const manifestPath = path.join(workspace, "game.manifest.json");
  const workspaceManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { displayName: string };
  workspaceManifest.displayName = "Changed after build";
  fs.writeFileSync(manifestPath, JSON.stringify(workspaceManifest));
  fs.writeFileSync(path.join(workspace, "assets", "cube.glb"), "changed workspace asset");
  fs.appendFileSync(path.join(workspace, "src", "index.ts"), "\n// changed workspace source\n");

  const old = loadCodeGameBuildById(outDir, first.buildId);
  assert.equal(old.manifest.displayName, "Hello City");
  assert.deepEqual(readCodeGameBuildAsset(old, "cube").bytes, sealedAsset);
  const publish = createCodeGamePublishPayload(old);
  assert.deepEqual(publish.find((file) => file.relativePath === "assets/cube.glb")?.bytes, sealedAsset);

  const second = await built(workspace, outDir);
  assert.notEqual(second.buildId, first.buildId);
  fs.rmSync(workspace, { recursive: true, force: true });
  assert.equal(loadCodeGameBuildById(outDir, first.buildId).build.buildId, first.buildId);

  const preview = spawnSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--import",
      path.join(repoRoot, "scripts", "mecha-ts-register.mjs"),
      path.join(packageRoot, "scripts", "previewGame.ts"),
      "--build",
      first.buildId,
      "--builds-dir",
      outDir,
      "--ticks",
      "400",
    ],
    { encoding: "utf8" },
  );
  assert.equal(preview.status, 0, preview.stderr);
  const output = JSON.parse(preview.stdout) as {
    ok: boolean;
    buildId?: string;
    telemetry?: { outcome?: string; reason?: string; tick?: number };
  };
  assert.equal(output.ok, true, preview.stdout);
  assert.equal(output.buildId, first.buildId);
  assert.equal(output.telemetry?.outcome, "success");
  assert.equal(output.telemetry?.reason, "route_complete");
  assert.equal(output.telemetry?.tick, 120);
});

test("missing or tampered sealed files fail closed with package integrity diagnostics", async (t) => {
  const { workspace, outDir } = fixture(t);
  const result = await built(workspace, outDir);
  const files = ["manifest.json", "game.js", "game.js.map", "assets/cube.glb", "build.json"];
  for (const relativePath of files) {
    const file = path.join(result.buildDir, ...relativePath.split("/"));
    const original = fs.readFileSync(file);
    try {
      fs.appendFileSync(file, relativePath === "build.json" ? " " : "tampered");
      assert.throws(() => loadCodeGameBuildArtifact(result.buildDir), expectIntegrity, relativePath);
    } finally {
      fs.writeFileSync(file, original);
    }
    assert.equal(loadCodeGameBuildArtifact(result.buildDir).build.buildId, result.buildId);
  }
  const missing = path.join(result.buildDir, "assets", "cube.glb");
  const original = fs.readFileSync(missing);
  fs.rmSync(missing);
  assert.throws(() => loadCodeGameBuildArtifact(result.buildDir), expectIntegrity);
  fs.writeFileSync(missing, original);

  const assetsDir = path.join(result.buildDir, "assets");
  const sealedAssets = path.join(result.buildDir, "sealed-assets");
  fs.renameSync(assetsDir, sealedAssets);
  try {
    fs.symlinkSync(path.join(workspace, "assets"), assetsDir, "dir");
    assert.throws(() => loadCodeGameBuildArtifact(result.buildDir), expectIntegrity);
  } finally {
    fs.rmSync(assetsDir, { force: true });
    fs.renameSync(sealedAssets, assetsDir);
  }
});

test("V2 builds preserve registered entries and reject exports missing from the bundle", async (t) => {
  const { workspace, outDir } = fixture(t);
  writeV2Manifest(workspace);
  const result = await built(workspace, outDir);
  const loaded = loadCodeGameBuildById(outDir, result.buildId);
  assert.equal(loaded.manifest.schemaVersion, 2);
  const installed = createInstalledGameFromCodeBuild("installation-v2", loaded.build, loaded.manifest);
  assert.deepEqual(installed.entries, [
    { id: "default", presentations: ["exclusive"] },
    { id: "briefing", presentations: ["overlay"] },
  ]);

  writeV2Manifest(workspace, "notExported");
  const invalid = await buildCodeGame({ workspaceDir: workspace, outDir });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.ok ? "" : invalid.diagnostics[0]?.code, "game_entry_invalid");
});


test("V1 and V2 headless runs bind the real Snapshot identity", async (t) => {
  const { workspace, outDir } = fixture(t);
  const snapshot = compileWorldFixtureV1();
  const snapshotPath = path.join(outDir, "city.json");
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));
  const snapshotArgs = ["--snapshot", snapshotPath, "--snapshot-digest", snapshot.header.snapshotDigest];
  const runPreview = (buildId: string) => {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-transform-types",
        "--import",
        path.join(repoRoot, "scripts", "mecha-ts-register.mjs"),
        path.join(packageRoot, "scripts", "previewGame.ts"),
        "--build",
        buildId,
        "--builds-dir",
        outDir,
        ...snapshotArgs,
        "--ticks",
        "400",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as {
      ok: boolean;
      telemetry?: {
        cityId?: string;
        cityRevision?: number;
        snapshotDigest?: string;
        outcome?: string;
        reason?: string;
      };
    };
    assert.equal(output.ok, true, result.stdout);
    assert.equal(output.telemetry?.cityId, "city-fixture");
    assert.equal(output.telemetry?.cityRevision, 7);
    assert.equal(output.telemetry?.snapshotDigest, snapshot.header.snapshotDigest);
    return output;
  };

  const v1 = await built(workspace, outDir);
  const v1Output = runPreview(v1.buildId);
  assert.equal(v1Output.telemetry?.outcome, "success");
  assert.equal(v1Output.telemetry?.reason, "route_complete");

  writeV2Manifest(workspace);
  fs.writeFileSync(
    path.join(workspace, "src", "index.ts"),
    `import { defineGameV2 } from "@oh-agent/city-game-sdk";
export default defineGameV2({
  id: "community.hello-city",
  setup(ctx) {
    ctx.onStart(async () => {
      const cityId = ctx.world.header().cityId;
      ctx.ui.setHud({ cityId });
      ctx.finish("success", cityId);
    });
  },
});
`,
  );
  const v2 = await built(workspace, outDir);
  const v2Output = runPreview(v2.buildId);
  assert.equal(v2Output.telemetry?.outcome, "success");
  assert.equal(v2Output.telemetry?.reason, "city-fixture");
});
