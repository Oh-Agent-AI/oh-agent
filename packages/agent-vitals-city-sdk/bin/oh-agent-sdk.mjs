#!/usr/bin/env node
import { access, lstat, open, readFile, writeFile, mkdir, rename, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { canonicalJson, inspectGlbBytes, validateAssetRefs, validateCityContentPackage, validateCityLayout, validateCityProjectAssetCatalog, validateCityWorldProfile, validateMiniGamePack, validateMount, validatePackageManifest, validateSceneDraft, runHeadless } from "../dist/index.js";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const root = process.cwd();
const cliDirectory = path.dirname(fileURLToPath(import.meta.url));
const appSdkDirectory = path.resolve(cliDirectory, "../../agent-vitals-app-sdk");

function usage() {
  return [
    "oh-agent-sdk <command>",
    "",
    "Commands:",
    "  init app-game <directory> [--app-sdk-tarball <file>]  Create an App Game WebView starter",
    "  init city-minigame <directory>   Create a runnable City mini-game project",
    "  init city-world <directory> [--generator miami|arid-dunes]  Create a City world profile project",
    "  validate <directory>             Validate layout, game, mount, and optional scene assets",
    "  validate-world <file|directory>  Validate a public CityWorldProfileV1 JSON profile",
    "  asset inspect <file.glb>          Inspect a bounded local GLB and compute its SHA-256",
    "  asset import <project> <file.glb> --asset-id <id>  Copy a checked GLB into project assets",
    "  asset verify <project>            Recheck project asset bytes and catalog metadata",
    "  sync-refs <directory>            Refresh mount and scene asset refs after edits",
    "  playtest <directory> [--seed N]  Run trace.json as a deterministic headless playtest",
    "  pack <directory> --out <file>    Create an unsigned .ohcity.json development artifact",
    "  verify <file>                    Verify package structure and SHA-256 integrity",
  ].join("\n");
}

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function digest(value) {
  const bytes = typeof value === "string" ? value : canonicalJson(value);
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

function manifestDigestInput(manifest) {
  return { schemaVersion: manifest.schemaVersion, package: manifest.package, entry: manifest.entry, files: manifest.files };
}

function projectPath(directory) {
  if (!directory || directory.startsWith("-")) throw new Error("A project directory is required.");
  return path.resolve(root, directory);
}

async function readJson(project, file) {
  const filePath = path.join(project, file);
  const data = await readFile(filePath);
  if (data.byteLength > MAX_INPUT_BYTES) throw new Error(`${file} exceeds the ${MAX_INPUT_BYTES}-byte CLI input limit.`);
  try { return JSON.parse(data.toString("utf8")); }
  catch (error) { throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

const sample = {
  "layout.json": {
    schemaVersion: 1, id: "starter-city", coordinateSystem: "city-local-m-v1",
    anchors: [
      { id: "start", kind: "spawn", capabilities: ["drive"], geometryRef: "geo-start" },
      { id: "checkpoint-1", kind: "zone", capabilities: ["drive"], geometryRef: "geo-checkpoint-1" },
      { id: "checkpoint-2", kind: "zone", capabilities: ["drive"], geometryRef: "geo-checkpoint-2" },
    ],
  },
  "game.json": {
    schemaVersion: 1, id: "checkpoint-sprint", rulesVersion: 1,
    slots: { points: { kind: "zone", min: 2, max: 2, requires: ["drive"] } },
    rules: { counters: { next: { initial: 0, max: 2 } }, nodes: [
      { id: "advance", on: { type: "zone.entered", slot: "points" }, when: [{ op: "counter.eqEventIndex", counter: "next" }], actions: [{ op: "counter.add", counter: "next", amount: 1 }] },
      { id: "finish", on: { type: "zone.entered", slot: "points" }, when: [{ op: "counter.eq", counter: "next", value: 2 }], actions: [{ op: "run.finish", outcome: "success" }] },
    ] },
  },
  "mount.json": {
    schemaVersion: 1, mountId: "starter-mount",
    layout: { kind: "city-layout", id: "starter-city", version: "1", digest: "local-fixture" },
    game: { kind: "city-minigame", id: "checkpoint-sprint", version: "1", digest: "local-fixture" },
    entryAnchorId: "start", bindings: { points: ["checkpoint-1", "checkpoint-2"] }, parameterOverrides: {},
  },
  "trace.json": [
    { tick: 0 },
    { tick: 1, inputs: [{ type: "zone.entered", tick: 1, slot: "points", index: 0 }] },
    { tick: 2, inputs: [{ type: "zone.entered", tick: 2, slot: "points", index: 1 }] },
  ],
  "scene.json": { schemaVersion: 1, objects: [] },
};

async function init(kind, directory) {
  if (kind !== "city-minigame") throw new Error(`Unsupported template '${kind}'. Supported: city-minigame.`);
  const project = projectPath(directory);
  await mkdir(project, { recursive: true });
  const files = structuredClone(sample);
  files["mount.json"].layout.digest = digest(files["layout.json"]);
  files["mount.json"].game.digest = digest(files["game.json"]);
  for (const file of Object.keys(sample)) {
    try { await access(path.join(project, file)); throw new Error(`Refusing to overwrite ${path.join(project, file)}.`); }
    catch (error) { if (error instanceof Error && !("code" in error && error.code === "ENOENT")) throw error; }
  }
  for (const [file, value] of Object.entries(files)) {
    const filePath = path.join(project, file);
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  }
  output({ ok: true, projectDir: project, files: Object.keys(sample) });
}

async function initAppGame(directory, appSdkTarball) {
  const project = projectPath(directory);
  await mkdir(project, { recursive: true });
  let sdkSpecifier;
  if (appSdkTarball) {
    const tarballPath = path.resolve(root, appSdkTarball);
    await access(tarballPath);
    sdkSpecifier = `file:${tarballPath}`;
  } else {
    // Resolve macOS /tmp -> /private/tmp aliases before calculating the local
    // file dependency; npm materializes file: links from the physical path.
    const [physicalProject, physicalAppSdk] = await Promise.all([realpath(project), realpath(appSdkDirectory)]);
    const relativeSdkPath = path.relative(physicalProject, physicalAppSdk).split(path.sep).join("/");
    sdkSpecifier = `file:${relativeSdkPath.startsWith(".") ? relativeSdkPath : `./${relativeSdkPath}`}`;
  }
  const packageName = path.basename(project).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "oh-agent-app-game";
  const files = {
    "package.json": {
      name: packageName, private: true, type: "module",
      scripts: { dev: "vite --host 127.0.0.1", build: "vite build", typecheck: "tsc --noEmit" },
      dependencies: { "@agent-vitals/app-sdk": sdkSpecifier },
      devDependencies: { "typescript": "7.0.2", "vite": "6.4.5" },
    },
    "index.html": `<!doctype html>\n<html lang="en">\n  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${packageName}</title></head>\n  <body><main id="app" aria-live="polite"></main><script type="module" src="/src/main.ts"></script></body>\n</html>\n`,
    "tsconfig.json": JSON.stringify({ compilerOptions: {
      target: "ES2022", useDefineForClassFields: true, module: "ESNext", lib: ["ES2022", "DOM", "DOM.Iterable"],
      skipLibCheck: true, moduleResolution: "Bundler", allowImportingTsExtensions: true, verbatimModuleSyntax: true,
      moduleDetection: "force", noEmit: true, strict: true,
    }, include: ["src"] }, null, 2) + "\n",
    "vite.config.ts": `import { defineConfig } from "vite";\n\nexport default defineConfig({\n  server: { host: "127.0.0.1" },\n  build: { outDir: "dist", emptyOutDir: true },\n});\n`,
    "src/vite-env.d.ts": `/// <reference types="vite/client" />\n`,
    "src/main.ts": `import { connectAppGame, createAppHostClient } from "@agent-vitals/app-sdk";\nimport "./style.css";\n\nconst app = document.querySelector<HTMLElement>("#app")!;\nconst host = createAppHostClient();\nlet score = 0;\nlet suspended = false;\n\nfunction render() {\n  app.innerHTML = \`<section class="game-card"><p class="eyebrow">OH AGENT · APP GAME</p><h1>\${host.locale().startsWith("zh") ? "点击挑战" : "Tap Challenge"}</h1><p class="score">\${score}</p><button id="score-button" type="button" \${suspended ? "disabled" : ""}>\${host.locale().startsWith("zh") ? "得一分" : "Score a point"}</button><p class="hint">\${suspended ? "Game suspended by host" : "Built with @agent-vitals/app-sdk"}</p></section>\`;\n  app.querySelector<HTMLButtonElement>("#score-button")?.addEventListener("click", () => { score += 1; render(); });\n}\n\nvoid connectAppGame({\n  start() { render(); },\n  suspend() { suspended = true; render(); },\n  resume() { suspended = false; render(); },\n  dispose() { app.replaceChildren(); },\n}).catch((error: unknown) => {\n  app.textContent = error instanceof Error ? error.message : "app_game_start_failed";\n});\n`,
    "src/style.css": `:root { color-scheme: dark; font: 16px/1.5 system-ui, sans-serif; background: #10131a; color: #f5f7fb; }\n* { box-sizing: border-box; }\nbody { margin: 0; min-width: 320px; min-height: 100vh; display: grid; place-items: center; }\n.game-card { width: min(92vw, 480px); padding: 32px; border: 1px solid #343c4d; border-radius: 20px; background: #191e29; text-align: center; }\n.eyebrow, .hint { color: #aab4c5; font-size: 12px; letter-spacing: .12em; }\nh1 { margin: 8px 0; font-size: 28px; }\n.score { margin: 20px; font-size: 64px; font-variant-numeric: tabular-nums; }\nbutton { border: 0; border-radius: 999px; padding: 12px 24px; background: #83e1cf; color: #10131a; font: inherit; font-weight: 700; cursor: pointer; }\nbutton:disabled { opacity: .5; cursor: default; }\n`,
    "README.md": `# ${packageName}\n\nAn App Game WebView starter using @agent-vitals/app-sdk.\n\n## Start\n\nRun npm install, then npm run typecheck or npm run build. By default the generated dependency links the App SDK checkout that shipped with this CLI. For an isolated project, build a local SDK tarball with npm pack in packages/agent-vitals-app-sdk and run: oh-agent-sdk init app-game ./my-game --app-sdk-tarball /absolute/path/agent-vitals-app-sdk-0.0.0.tgz. Keep that tarball available while installing.\n\nThe game uses connectAppGame for startup/readiness, host suspend/resume and cleanup, and createAppHostClient for locale. Local state remains opt-in: add an exact namespaced key such as score:v1 to the official plugin descriptor before calling host.state.read/write.\n\nThis scaffold is source code for an official WebView plugin. Vite can build the UI, but it does not register the plugin, create a desktop package, grant state keys, or provide a standalone host preview. Official plugin registration and distribution remain controlled by the desktop host. The App SDK is private and not published; the tarball option supports local independent-consumer checks and controlled distribution only.\n`,
  };
  for (const file of Object.keys(files)) {
    try { await access(path.join(project, file)); throw new Error(`Refusing to overwrite ${path.join(project, file)}.`); }
    catch (error) { if (error instanceof Error && !("code" in error && error.code === "ENOENT")) throw error; }
  }
  for (const [file, value] of Object.entries(files)) {
    const filePath = path.join(project, file);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  }
  output({ ok: true, projectDir: project, files: Object.keys(files), appSdk: sdkSpecifier,
    appSdkSource: appSdkTarball ? "local-tarball" : "workspace-checkout", installable: false });
}

function worldTemplate(generator) {
  if (generator === "arid-dunes-v1") return {
    schemaVersion: 1, id: "arid-dunes", version: 1, biome: "arid",
    geography: { generator: "arid-dunes-v1", parameters: { dunes: { duneScale: 190, duneAmplitude: 11, orientationDeg: 18 } } },
    visuals: { themeId: "desert" },
  };
  if (generator === "coastal-islands-v1") return {
    schemaVersion: 1, id: "miami-islands", version: 1, biome: "tropical",
    geography: { generator: "coastal-islands-v1", parameters: { coastal: {
      profile: "miami-coastal", version: 3, biome: "tropical", preferredAzimuth: 0,
      azimuthTolerance: 1.2, segmentArc: 1.4835298641951802, wetSandWidth: 8,
      drySandWidth: 40, promenadeOffset: 62, boulevardOffset: 74, hotelOffset: 92,
      bandOuter: 108, maxCoastalSlope: 0.9, maxCoastalHeight: 6, riverMargin: 26,
      siteMargin: 14, minValidRatio: 0.6, bayHalfWidth: 0.22, bayShift: 0.33,
    } } }, visuals: { themeId: "miami" },
  };
  throw new Error(`Unsupported City generator '${generator}'.`);
}

async function initWorld(directory, generator) {
  const project = projectPath(directory);
  await mkdir(project, { recursive: true });
  const filePath = path.join(project, "world.json");
  try { await access(filePath); throw new Error(`Refusing to overwrite ${filePath}.`); }
  catch (error) { if (error instanceof Error && !("code" in error && error.code === "ENOENT")) throw error; }
  const profile = worldTemplate(generator);
  const validated = validateCityWorldProfile(profile);
  if (!validated.ok) throw new Error(validated.diagnostics[0]?.code ?? "world_profile_invalid");
  await writeFile(filePath, `${JSON.stringify(validated.value, null, 2)}\n`, { flag: "wx" });
  output({ ok: true, projectDir: project, generator, files: ["world.json"] });
}

async function loadProject(directory) {
  const project = projectPath(directory);
  const [layout, game, mount] = await Promise.all([
    readJson(project, "layout.json"), readJson(project, "game.json"), readJson(project, "mount.json"),
  ]);
  let scene = null;
  try { scene = await readJson(project, "scene.json"); }
  catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
  return { project, layout, game, mount, scene };
}

function packageAssetCatalog(projectCatalog, game) {
  const gameRef = { kind: "city-minigame", id: game.id, version: "1", digest: digest(game) };
  return { schemaVersion: 1, entries: projectCatalog.entries.filter(entry => entry.boundsMeters).map(entry => ({
    ref: { package: gameRef, assetId: entry.assetId, digest: entry.sha256 }, relativePath: entry.relativePath,
    byteLength: entry.byteLength, boundsMeters: entry.boundsMeters, unit: "meter",
  })) };
}

function validateProjectScene(scene, game, projectCatalog) {
  if (scene === null || scene === undefined) return { ok: true, diagnostics: [] };
  const result = validateSceneDraft(scene);
  if (!result.ok) return result;
  const refs = result.value.objects.filter(object => object.kind === "model").map(object => object.asset);
  if (refs.length === 0) return { ok: true, value: result.value, diagnostics: [] };
  const assets = validateAssetRefs({ refs, catalog: packageAssetCatalog(projectCatalog, game) });
  return assets.ok ? { ok: true, value: result.value, diagnostics: [] } : assets;
}

function validateProjectRefs(layout, game, mount) {
  const layoutResult = validateCityLayout(layout);
  if (!layoutResult.ok) return layoutResult;
  const gameResult = validateMiniGamePack(game);
  if (!gameResult.ok) return gameResult;
  const resolvedRefs = {
    layout: { kind: "city-layout", id: layoutResult.value.id, version: "1", digest: digest(layoutResult.value) },
    game: { kind: "city-minigame", id: gameResult.value.id, version: "1", digest: digest(gameResult.value) },
  };
  return validateMount({ layout: layoutResult.value, game: gameResult.value, mount, resolvedRefs });
}

async function validate(directory) {
  const { project, layout, game, mount, scene } = await loadProject(directory);
  const result = validateProjectRefs(layout, game, mount);
  const diagnostics = [...result.diagnostics];
  const gameResult = validateMiniGamePack(game);
  if (scene !== null && gameResult.ok) {
    const { catalogPath } = await projectAssetPaths(project);
    const catalog = await readProjectAssetCatalog(catalogPath);
    const sceneResult = validateProjectScene(scene, gameResult.value, catalog);
    if (!sceneResult.ok) diagnostics.push(...sceneResult.diagnostics);
  }
  const ok = diagnostics.length === 0;
  output({ ok, projectDir: project, diagnostics });
  if (!ok) process.exitCode = 1;
}

async function validateWorld(fileOrDirectory) {
  if (!fileOrDirectory || fileOrDirectory.startsWith("-")) throw new Error("A world profile JSON file or project directory is required.");
  const candidate = path.resolve(root, fileOrDirectory);
  const filePath = path.extname(candidate).toLowerCase() === ".json" ? candidate : path.join(candidate, "world.json");
  const data = await readFile(filePath);
  if (data.byteLength > MAX_INPUT_BYTES) throw new Error(`World profile exceeds the ${MAX_INPUT_BYTES}-byte CLI input limit.`);
  let value;
  try { value = JSON.parse(data.toString("utf8")); }
  catch (error) { throw new Error(`World profile is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const result = validateCityWorldProfile(value);
  output({ ok: result.ok, file: filePath, diagnostics: result.diagnostics });
  if (!result.ok) process.exitCode = 1;
}

async function readInspectedGlb(file) {
  if (!file || file.startsWith("-")) throw new Error("A GLB file path is required.");
  const filePath = path.resolve(root, file);
  const maxBytes = 64 * 1024 * 1024;
  const pathInfo = await lstat(filePath);
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) throw new Error("Model input must be a regular non-symlink file.");
  const handle = await open(filePath, "r");
  let bytes;
  try {
    const fileInfo = await handle.stat();
    if (!fileInfo.isFile() || fileInfo.dev !== pathInfo.dev || fileInfo.ino !== pathInfo.ino) throw new Error("Model input changed during open or is not a regular file.");
    if (fileInfo.size > maxBytes) throw new Error("Model input exceeds the 64 MiB GLB inspection limit.");
    const chunks = [];
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (total <= maxBytes) {
      const length = Math.min(buffer.byteLength, maxBytes + 1 - total);
      const { bytesRead } = await handle.read(buffer, 0, length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error("Model input exceeds the 64 MiB GLB inspection limit.");
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    if (total !== fileInfo.size) throw new Error("Model file size changed during inspection.");
    bytes = Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
  const inspection = inspectGlbBytes(bytes);
  const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return { filePath, bytes, inspection, sha256 };
}

async function inspectAsset(file) {
  const { filePath, inspection, sha256 } = await readInspectedGlb(file);
  if (!inspection.ok) {
    output({ ok: false, file: filePath, diagnostics: inspection.diagnostics });
    process.exitCode = 1;
    return;
  }
  output({ ok: true, file: filePath, asset: { ...inspection.value, sha256 }, trust: "unsigned-local-file", installable: false,
    note: "This is a local structural inspection only; it does not create a package, verify a publisher signature, or authorize installation." });
}

async function projectAssetPaths(directory) {
  const project = await realpath(projectPath(directory));
  const projectInfo = await lstat(project);
  if (!projectInfo.isDirectory()) throw new Error("Project path must resolve to a directory.");
  const assets = path.join(project, "assets");
  await mkdir(assets, { recursive: true });
  const assetsInfo = await lstat(assets);
  if (!assetsInfo.isDirectory() || assetsInfo.isSymbolicLink() || await realpath(assets) !== assets) {
    throw new Error("Project assets directory must be a real directory inside the project.");
  }
  return { project, assets, catalogPath: path.join(assets, "catalog.json") };
}

async function readProjectAssetCatalog(catalogPath) {
  let raw;
  try {
    const info = await lstat(catalogPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Project asset catalog must be a regular non-symlink file.");
    const bytes = await readFile(catalogPath);
    if (bytes.byteLength > MAX_INPUT_BYTES) throw new Error("Project asset catalog exceeds the 2 MiB CLI input limit.");
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { schemaVersion: 1, entries: [] };
    if (error instanceof SyntaxError) throw new Error(`Project asset catalog is not valid JSON: ${error.message}`);
    throw error;
  }
  const result = validateCityProjectAssetCatalog(raw);
  if (!result.ok) throw new Error(`Project asset catalog is invalid: ${result.diagnostics.map(item => item.code).join(", ")}`);
  return result.value;
}

async function writeProjectAssetCatalog(catalogPath, catalog) {
  try {
    const info = await lstat(catalogPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Project asset catalog must be a regular non-symlink file.");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  const temporary = path.join(path.dirname(catalogPath), `.catalog-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, catalogPath);
}

async function importAsset(directory, file, assetId) {
  if (!assetId || assetId.startsWith("-")) throw new Error("asset import requires --asset-id <id>.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(assetId)) throw new Error("Asset ID must be a stable identifier.");
  const { filePath, bytes, inspection, sha256 } = await readInspectedGlb(file);
  if (!inspection.ok) {
    output({ ok: false, file: filePath, diagnostics: inspection.diagnostics });
    process.exitCode = 1;
    return;
  }
  const { project, assets, catalogPath } = await projectAssetPaths(directory);
  const rawGame = await readJson(project, "game.json");
  const gameResult = validateMiniGamePack(rawGame);
  if (!gameResult.ok) throw new Error(`Project game is invalid: ${gameResult.diagnostics.map(item => item.code).join(", ")}`);
  const catalog = await readProjectAssetCatalog(catalogPath);
  const existingId = catalog.entries.find(entry => entry.assetId === assetId);
  if (existingId && existingId.sha256 !== sha256) throw new Error(`Asset ID '${assetId}' already refers to different bytes.`);
  const relativePath = `assets/${sha256.slice("sha256:".length)}.glb`;
  const assetPath = path.join(project, relativePath);
  try {
    const info = await lstat(assetPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Content-addressed project asset path must be a regular non-symlink file.");
    const existing = await readInspectedGlb(assetPath);
    if (!existing.inspection.ok || existing.bytes.byteLength !== bytes.byteLength || existing.sha256 !== sha256) {
      throw new Error("Existing content-addressed asset does not match its digest path.");
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") await writeFile(assetPath, bytes, { flag: "wx" });
    else throw error;
  }
  const entry = {
    assetId, relativePath, sha256, byteLength: bytes.byteLength, format: "glb-v2",
    ...(inspection.value.boundsMeters ? { boundsMeters: inspection.value.boundsMeters } : {}),
  };
  const entries = existingId ? catalog.entries.map(item => item.assetId === assetId ? entry : item) : [...catalog.entries, entry];
  const validated = validateCityProjectAssetCatalog({ schemaVersion: 1, entries });
  if (!validated.ok) throw new Error(`Imported asset metadata is invalid: ${validated.diagnostics.map(item => item.code).join(", ")}`);
  await writeProjectAssetCatalog(catalogPath, validated.value);
  const assetRef = { package: { kind: "city-minigame", id: gameResult.value.id, version: "1", digest: digest(gameResult.value) }, assetId, digest: sha256 };
  output({ ok: true, projectDir: project, asset: entry, assetRef, usableInScene: Boolean(entry.boundsMeters), trust: "unsigned-project-local-file", installable: false,
    note: entry.boundsMeters
      ? "The GLB is in the project inventory and the assetRef can be used in scene.json. pack includes it in an unsigned artifact; Creator/City runtime loading and installation are not implemented."
      : "The GLB is stored and packaged, but has no inspected bounds, so scene validation will not resolve it for placement." });
}

async function verifyProjectAssets(directory) {
  const { project, assets, catalogPath } = await projectAssetPaths(directory);
  const catalog = await readProjectAssetCatalog(catalogPath);
  const diagnostics = [];
  for (const entry of catalog.entries) {
    const assetPath = path.join(project, entry.relativePath);
    try {
      const info = await lstat(assetPath);
      if (!info.isFile() || info.isSymbolicLink() || path.dirname(assetPath) !== assets) throw new Error("Asset path must be a regular file directly inside the project assets directory.");
      if (info.size !== entry.byteLength || info.size > 64 * 1024 * 1024) throw new Error("Asset byte length does not match the catalog or exceeds the GLB limit.");
      const checked = await readInspectedGlb(assetPath);
      if (checked.sha256 !== entry.sha256) throw new Error("Asset SHA-256 does not match the project catalog.");
      if (!checked.inspection.ok) throw new Error(`GLB structure failed inspection: ${checked.inspection.diagnostics.map(item => item.code).join(", ")}`);
      if (entry.boundsMeters && JSON.stringify(checked.inspection.value.boundsMeters) !== JSON.stringify(entry.boundsMeters)) throw new Error("Inspected model bounds do not match the project catalog.");
    } catch (error) {
      diagnostics.push({ code: "project_asset_verification_failed", severity: "error", path: entry.relativePath, assetId: entry.assetId,
        message: error instanceof Error ? error.message : String(error) });
    }
  }
  output({ ok: diagnostics.length === 0, projectDir: project, verifiedCount: catalog.entries.length, diagnostics,
    trust: "unsigned-project-local-files", installable: false });
  if (diagnostics.length) process.exitCode = 1;
}

async function syncRefs(directory) {
  const { project, layout, game, mount, scene } = await loadProject(directory);
  const layoutResult = validateCityLayout(layout);
  const gameResult = validateMiniGamePack(game);
  if (!layoutResult.ok || !gameResult.ok) {
    const diagnostics = [...(!layoutResult.ok ? layoutResult.diagnostics : []), ...(!gameResult.ok ? gameResult.diagnostics : [])];
    output({ ok: false, diagnostics });
    process.exitCode = 1;
    return;
  }
  const currentMount = validateMount({ layout: layoutResult.value, game: gameResult.value, mount });
  if (!currentMount.ok) {
    output({ ok: false, diagnostics: currentMount.diagnostics });
    process.exitCode = 1;
    return;
  }
  const updated = {
    ...currentMount.value.mount,
    layout: { ...currentMount.value.mount.layout, digest: digest(layoutResult.value) },
    game: { ...currentMount.value.mount.game, digest: digest(gameResult.value) },
  };
  const result = validateProjectRefs(layoutResult.value, gameResult.value, updated);
  if (!result.ok) {
    output({ ok: false, diagnostics: result.diagnostics });
    process.exitCode = 1;
    return;
  }
  let updatedScene = scene;
  if (scene !== null) {
    const sceneResult = validateSceneDraft(scene);
    if (!sceneResult.ok) {
      output({ ok: false, diagnostics: sceneResult.diagnostics });
      process.exitCode = 1;
      return;
    }
    const currentGameDigest = digest(gameResult.value);
    updatedScene = { ...sceneResult.value, objects: sceneResult.value.objects.map(object => object.kind === "model"
      && object.asset.package.kind === "city-minigame" && object.asset.package.id === gameResult.value.id
      ? { ...object, asset: { ...object.asset, package: { ...object.asset.package, version: "1", digest: currentGameDigest } } }
      : object) };
    const { catalogPath } = await projectAssetPaths(project);
    const catalog = await readProjectAssetCatalog(catalogPath);
    const sceneValidation = validateProjectScene(updatedScene, gameResult.value, catalog);
    if (!sceneValidation.ok) {
      output({ ok: false, diagnostics: sceneValidation.diagnostics });
      process.exitCode = 1;
      return;
    }
  }
  const filePath = path.join(project, "mount.json");
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(updated, null, 2)}\n`, { flag: "wx" });
  await rename(tempPath, filePath);
  if (updatedScene !== null) {
    const scenePath = path.join(project, "scene.json");
    const sceneTempPath = `${scenePath}.${randomUUID()}.tmp`;
    await writeFile(sceneTempPath, `${JSON.stringify(updatedScene, null, 2)}\n`, { flag: "wx" });
    await rename(sceneTempPath, scenePath);
  }
  output({ ok: true, projectDir: project, updated: updatedScene === null ? ["mount.json"] : ["mount.json", "scene.json"], layoutDigest: updated.layout.digest, gameDigest: updated.game.digest });
}

async function playtest(directory, seed) {
  const { project, layout, game: rawGame, mount } = await loadProject(directory);
  const gameResult = validateMiniGamePack(rawGame);
  if (!gameResult.ok) {
    output({ ok: false, diagnostics: gameResult.diagnostics });
    process.exitCode = 1;
    return;
  }
  const mountResult = validateProjectRefs(layout, gameResult.value, mount);
  if (!mountResult.ok) {
    output({ ok: false, diagnostics: mountResult.diagnostics });
    process.exitCode = 1;
    return;
  }
  const trace = await readJson(project, "trace.json");
  const result = runHeadless({ layout, game: gameResult.value, mount, seed, trace, expected: { outcome: "success" } });
  output({ ok: result.ok && result.value.passed, projectDir: project, evidence: result.ok ? result.value : null, diagnostics: result.diagnostics });
  if (!result.ok || !result.value.passed) process.exitCode = 1;
}

async function pack(directory, outFile) {
  if (!outFile) throw new Error("pack requires --out <file>.");
  const { project, layout, game: rawGame, mount: rawMount, scene } = await loadProject(directory);
  const gameResult = validateMiniGamePack(rawGame);
  if (!gameResult.ok) {
    output({ ok: false, diagnostics: gameResult.diagnostics });
    process.exitCode = 1;
    return;
  }
  const files = {
    "layout.json": layout,
    "game.json": gameResult.value,
    "mount.json": {
      ...rawMount,
      layout: { ...rawMount.layout, digest: digest(layout) },
      game: { ...rawMount.game, digest: digest(gameResult.value) },
    },
  };
  if (scene !== null) files["scene.json"] = scene;
  const fileMediaTypes = new Map(Object.keys(files).map(filePath => [filePath, "application/json"]));
  const { project: physicalProject, catalogPath } = await projectAssetPaths(project);
  const assetCatalog = await readProjectAssetCatalog(catalogPath);
  const sceneResult = validateProjectScene(scene, gameResult.value, assetCatalog);
  if (!sceneResult.ok) {
    output({ ok: false, diagnostics: sceneResult.diagnostics });
    process.exitCode = 1;
    return;
  }
  if (assetCatalog.entries.length > 0) {
    files["assets/catalog.json"] = packageAssetCatalog(assetCatalog, gameResult.value);
    files["assets/project-catalog.json"] = assetCatalog;
    fileMediaTypes.set("assets/catalog.json", "application/json");
    fileMediaTypes.set("assets/project-catalog.json", "application/json");
    for (const entry of assetCatalog.entries) {
      const assetPath = path.join(physicalProject, entry.relativePath);
      const checked = await readInspectedGlb(assetPath);
      if (!checked.inspection.ok || checked.bytes.byteLength !== entry.byteLength || checked.sha256 !== entry.sha256) {
        throw new Error(`Project asset '${entry.assetId}' failed package verification.`);
      }
      files[entry.relativePath] = checked.bytes.toString("base64");
      fileMediaTypes.set(entry.relativePath, "model/gltf-binary");
    }
  }
  const resolved = validateProjectRefs(layout, gameResult.value, files["mount.json"]);
  if (!resolved.ok) {
    output({ ok: false, diagnostics: resolved.diagnostics });
    process.exitCode = 1;
    return;
  }
  const packageFiles = Object.keys(files).sort().map(filePath => {
    const mediaType = fileMediaTypes.get(filePath) ?? "application/json";
    if (mediaType === "model/gltf-binary") {
      const contents = Buffer.from(files[filePath], "base64");
      return { path: filePath, mediaType, byteLength: contents.byteLength, sha256: `sha256:${createHash("sha256").update(contents).digest("hex")}` };
    }
    const contents = canonicalJson(files[filePath]);
    return { path: filePath, mediaType, byteLength: Buffer.byteLength(contents), sha256: digest(contents) };
  });
  const manifest = {
    schemaVersion: 1,
    package: { kind: "city-minigame", id: gameResult.value.id, version: "0.1.0" },
    entry: { layout: "layout.json", game: "game.json", mount: "mount.json" },
    files: packageFiles,
    packageDigest: "",
    signature: null,
  };
  manifest.packageDigest = digest(manifestDigestInput(manifest));
  const manifestResult = validatePackageManifest(manifest);
  if (!manifestResult.ok) {
    output({ ok: false, diagnostics: manifestResult.diagnostics });
    process.exitCode = 1;
    return;
  }
  const artifact = { format: "oh-agent-city-package-v1", manifest: manifestResult.value, files };
  const artifactResult = validateCityContentPackage(artifact);
  if (!artifactResult.ok) {
    output({ ok: false, diagnostics: artifactResult.diagnostics });
    process.exitCode = 1;
    return;
  }
  const outputPath = path.resolve(root, outFile);
  await writeFile(outputPath, `${JSON.stringify(artifactResult.value, null, 2)}\n`, { flag: "wx" });
  output({ ok: true, projectDir: project, output: outputPath, packageDigest: manifest.packageDigest,
    trust: "unsigned-development-artifact", installable: false });
}

async function verify(packageFile) {
  if (!packageFile) throw new Error("verify requires a package file path.");
  const pathToPackage = path.resolve(root, packageFile);
  const data = await readFile(pathToPackage);
  if (data.byteLength > 140 * 1024 * 1024) throw new Error("Package exceeds the 140 MiB CLI verification limit.");
  let raw;
  try { raw = JSON.parse(data.toString("utf8")); }
  catch (error) { throw new Error(`Package is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const packageResult = validateCityContentPackage(raw);
  if (!packageResult.ok) {
    output({ ok: false, diagnostics: packageResult.diagnostics });
    process.exitCode = 1;
    return;
  }
  const { manifest, files } = packageResult.value;
  const diagnostics = [];
  for (const declaration of manifest.files) {
    if (declaration.mediaType === "model/gltf-binary") {
      const encoded = files[declaration.path];
      const contents = typeof encoded === "string" ? Buffer.from(encoded, "base64") : Buffer.alloc(0);
      const actualDigest = `sha256:${createHash("sha256").update(contents).digest("hex")}`;
      if (contents.byteLength !== declaration.byteLength || actualDigest !== declaration.sha256) {
        diagnostics.push({ code: "package_file_digest_mismatch", severity: "error", path: declaration.path, message: "Decoded binary length or SHA-256 digest does not match the manifest." });
      } else {
        const inspection = inspectGlbBytes(contents);
        if (!inspection.ok) diagnostics.push(...inspection.diagnostics.map(item => ({ ...item, path: declaration.path })));
      }
      continue;
    }
    let contents;
    try { contents = canonicalJson(files[declaration.path]); }
    catch (error) {
      diagnostics.push({ code: "package_file_invalid_json", severity: "error", path: declaration.path, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (Buffer.byteLength(contents) !== declaration.byteLength || digest(contents) !== declaration.sha256) {
      diagnostics.push({ code: "package_file_digest_mismatch", severity: "error", path: declaration.path, message: "Canonical JSON length or SHA-256 digest does not match the manifest." });
    }
  }
  if (digest(manifestDigestInput(manifest)) !== manifest.packageDigest) {
    diagnostics.push({ code: "package_digest_mismatch", severity: "error", path: "manifest.packageDigest", message: "Manifest digest does not match its canonical body." });
  }
  const layout = files[manifest.entry.layout];
  const game = files[manifest.entry.game];
  const mount = files[manifest.entry.mount];
  if (!game || typeof game !== "object" || game.id !== manifest.package.id) {
    diagnostics.push({ code: "package_game_identity_mismatch", severity: "error", path: "manifest.package.id", message: "Package identity must match the entry mini-game ID." });
  }
  const refs = validateProjectRefs(layout, game, mount);
  if (!refs.ok) diagnostics.push(...refs.diagnostics);
  if ((files["scene.json"] !== undefined || files["assets/project-catalog.json"] !== undefined) && game && typeof game === "object") {
    const catalogFile = files["assets/project-catalog.json"] ?? { schemaVersion: 1, entries: [] };
    const catalogResult = validateCityProjectAssetCatalog(catalogFile);
    if (!catalogResult.ok) diagnostics.push(...catalogResult.diagnostics);
    else {
      const expectedPackageCatalog = packageAssetCatalog(catalogResult.value, game);
      if (canonicalJson(files["assets/catalog.json"] ?? { schemaVersion: 1, entries: [] }) !== canonicalJson(expectedPackageCatalog)) {
        diagnostics.push({ code: "package_asset_catalog_mismatch", severity: "error", path: "assets/catalog.json", message: "Package asset catalog does not match the project asset inventory and game identity." });
      }
      const expectedBinaryPaths = [...new Set(catalogResult.value.entries.map(entry => entry.relativePath))].sort();
      const actualBinaryPaths = manifest.files.filter(file => file.mediaType === "model/gltf-binary").map(file => file.path).sort();
      if (canonicalJson(expectedBinaryPaths) !== canonicalJson(actualBinaryPaths)) {
        diagnostics.push({ code: "package_asset_file_set_mismatch", severity: "error", path: "manifest.files", message: "Binary package files do not match the project asset catalog." });
      }
      if (files["scene.json"] !== undefined) {
        const sceneResult = validateProjectScene(files["scene.json"], game, catalogResult.value);
        if (!sceneResult.ok) diagnostics.push(...sceneResult.diagnostics);
      }
    }
  }
  const ok = diagnostics.length === 0;
  output({ ok, packageDigest: manifest.packageDigest, trust: "unsigned-development-artifact", installable: false, diagnostics });
  if (!ok) process.exitCode = 1;
}

async function main(args) {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") { process.stdout.write(`${usage()}\n`); return; }
  if (command === "init") {
    if (rest[0] === "app-game") {
      const directory = rest[1];
      let appSdkTarball;
      for (let index = 2; index < rest.length; index += 1) {
        if (rest[index] === "--app-sdk-tarball" && rest[index + 1] && !rest[index + 1].startsWith("-")) appSdkTarball = rest[++index];
        else throw new Error(`Unknown or invalid app-game argument '${rest[index]}'.`);
      }
      return initAppGame(directory, appSdkTarball);
    }
    if (rest[0] === "city-world") {
      const directory = rest[1];
      let generator = "coastal-islands-v1";
      for (let index = 2; index < rest.length; index += 1) {
        if (rest[index] === "--generator" && rest[index + 1]) {
          const selection = rest[++index];
          generator = selection === "arid-dunes" ? "arid-dunes-v1" : selection === "miami" ? "coastal-islands-v1" : selection;
        } else throw new Error(`Unknown or invalid city-world argument '${rest[index]}'.`);
      }
      return initWorld(directory, generator);
    }
    return init(rest[0], rest[1]);
  }
  if (command === "validate") return validate(rest[0]);
  if (command === "validate-world") return validateWorld(rest[0]);
  if (command === "asset" && rest[0] === "inspect" && rest.length === 2) return inspectAsset(rest[1]);
  if (command === "asset" && rest[0] === "import") {
    const directory = rest[1];
    const file = rest[2];
    let assetId;
    for (let index = 3; index < rest.length; index += 1) {
      if (rest[index] === "--asset-id" && rest[index + 1] && !rest[index + 1].startsWith("-")) assetId = rest[++index];
      else throw new Error(`Unknown or invalid asset import argument '${rest[index]}'.`);
    }
    return importAsset(directory, file, assetId);
  }
  if (command === "asset" && rest[0] === "verify" && rest.length === 2) return verifyProjectAssets(rest[1]);
  if (command === "asset") throw new Error(`Unknown or invalid asset command.\n${usage()}`);
  if (command === "sync-refs") return syncRefs(rest[0]);
  if (command === "playtest") {
    const directory = rest[0];
    let seed = 1;
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === "--seed" && /^-?\d+$/.test(rest[index + 1] ?? "")) seed = Number(rest[++index]);
      else throw new Error(`Unknown or invalid playtest argument '${rest[index]}'.`);
    }
    if (!Number.isSafeInteger(seed)) throw new Error("--seed must be a safe integer.");
    return playtest(directory, seed);
  }
  if (command === "pack") {
    const directory = rest[0];
    let outFile;
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === "--out" && rest[index + 1]) outFile = rest[++index];
      else throw new Error(`Unknown or invalid pack argument '${rest[index]}'.`);
    }
    return pack(directory, outFile);
  }
  if (command === "verify") return verify(rest[0]);
  throw new Error(`Unknown command '${command}'.\n${usage()}`);
}

main(process.argv.slice(2)).catch(error => fail(error instanceof Error ? error.message : String(error)));
