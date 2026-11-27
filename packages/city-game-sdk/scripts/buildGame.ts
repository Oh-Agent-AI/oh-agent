import { build, version as esbuildVersion } from "esbuild";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CodeGameBuildV2 } from "../src/protocol/build.ts";
import type { GameDiagnosticV1 } from "../src/protocol/diagnostics.ts";
import {
  validateCodeGameManifest,
  type CodeGameManifest,
} from "../src/protocol/manifestV2.ts";
import {
  canonicalJson,
  createCodeGameBuildRecord,
  loadCodeGameBuildArtifact,
} from "./buildArtifact.ts";

/**
 * P0 build service (prototype). It deliberately does three things only:
 *
 *   1. validate `game.manifest.json` with the same validator the host uses;
 *   2. bundle `entry` with a pinned toolchain and a trusted SDK alias;
 *   3. seal the normalized manifest, bundle, source map and declared assets in
 *      a digest-verified directory named by all build inputs.
 *
 * Type checking runs before bundling. The builder does not run `vite.config.ts`,
 * `postinstall` or any workspace script: the only executable input is the entry
 * graph. Test, preview and publish helpers load the sealed directory rather
 * than consulting later workspace files.
 */

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
  version: string;
  devDependencies: { typescript: string };
};
const SDK_NAME = "@oh-agent/city-game-sdk";
const DEFAULT_SDK_ENTRY = path.join(packageRoot, "src", "api", "index.ts");
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);

export type CodeGameBuildOptions = Readonly<{
  workspaceDir: string;
  outDir: string;
  /** When set, also publish a bounded build record for MCP status queries. */
  dataHome?: string;
  /** Overridable for tests; production points at the packaged SDK entry. */
  sdkApiEntry?: string;
  /** External workspace revision, or a deterministic workspace content digest. */
  sourceRevision?: string;
}>;

export type CodeGameBuildSuccess = Readonly<{
  ok: true;
  buildId: string;
  buildDir: string;
  bundlePath: string;
  manifest: CodeGameManifest;
  manifestDigest: string;
  bundleDigest: string;
  assetDigests: Readonly<Record<string, string>>;
  contentDigest: string;
  sourceRevision: string;
  sdkVersion: string;
  toolchainVersion: string;
  byteLength: number;
  warnings: readonly GameDiagnosticV1[];
}>;

export type CodeGameBuildFailure = Readonly<{
  ok: false;
  buildId: null;
  diagnostics: readonly GameDiagnosticV1[];
}>;

export type CodeGameBuildResult = CodeGameBuildSuccess | CodeGameBuildFailure;

type EsbuildMessage = Readonly<{
  text: string;
  location?: Readonly<{ file: string; line: number; column: number }> | null;
}>;

export async function buildCodeGame(options: CodeGameBuildOptions): Promise<CodeGameBuildResult> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const outDir = path.resolve(options.outDir);

  const manifest = readManifest(workspaceDir);
  if (!manifest.ok) return { ok: false, buildId: null, diagnostics: manifest.diagnostics };

  const entryPath = path.resolve(workspaceDir, manifest.value.entry);
  if (!isInside(workspaceDir, entryPath) || !fs.existsSync(entryPath)) {
    return failure("game_entry_invalid", `Entry "${manifest.value.entry}" does not exist inside the workspace.`);
  }

  const assets = [];
  for (const asset of manifest.value.assets) {
    const assetPath = path.resolve(workspaceDir, asset.path);
    if (!isInside(workspaceDir, assetPath) || !fs.existsSync(assetPath) || !fs.lstatSync(assetPath).isFile()) {
      return failure("game_asset_invalid", `Declared asset "${asset.path}" is missing from the workspace.`);
    }
    assets.push({ path: asset.path, bytes: fs.readFileSync(assetPath) });
  }

  const typecheckDiagnostics = typecheckWorkspace(workspaceDir, options.sdkApiEntry ?? DEFAULT_SDK_ENTRY);
  if (typecheckDiagnostics.length > 0) {
    return { ok: false, buildId: null, diagnostics: typecheckDiagnostics };
  }

  const sourceRevision = options.sourceRevision ?? `sha256:${digestWorkspace(workspaceDir, manifest.value)}`;
  const bundler = `esbuild@${esbuildVersion}`;
  const toolchainVersion = [
    bundler,
    `typescript@${packageJson.devDependencies.typescript}`,
    "target=es2022",
    "format=esm",
    "platform=browser",
  ].join(";");
  fs.mkdirSync(outDir, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(outDir, ".code-game-"));
  const stagingBundle = path.join(stagingDir, "game.js");

  try {
    let output: Awaited<ReturnType<typeof build>>;
    try {
      output = await build({
        absWorkingDir: workspaceDir,
        entryPoints: [manifest.value.entry],
        outfile: stagingBundle,
        bundle: true,
        format: "esm",
        platform: "browser",
        target: ["es2022"],
        sourcemap: true,
        metafile: true,
        logLevel: "silent",
        alias: { [SDK_NAME]: options.sdkApiEntry ?? DEFAULT_SDK_ENTRY },
        define: { "process.env.NODE_ENV": '"production"' },
      });
    } catch (error) {
      const messages = (error as { errors?: readonly EsbuildMessage[] }).errors ?? [];
      return {
        ok: false,
        buildId: null,
        diagnostics:
          messages.length > 0
            ? messages.map((message) => fromEsbuildMessage(message, workspaceDir))
            : [diagnostic("game_build_failed", "esbuild failed without a structured error.")],
      };
    }

    if (manifest.value.schemaVersion === 2) {
      const bundleOutput = Object.values(output.metafile.outputs).find((candidate) => candidate.entryPoint !== undefined);
      const exported = new Set(bundleOutput?.exports ?? []);
      const missing = manifest.value.entries.filter((entry) => !exported.has(entry.export));
      if (missing.length > 0) {
        return failure(
          "game_entry_invalid",
          `Registered entry export${missing.length === 1 ? "" : "s"} ${missing.map((entry) => `"${entry.export}"`).join(", ")} not found in the bundle.`,
        );
      }
    }

    const bundle = fs.readFileSync(stagingBundle);
    if (bundle.byteLength === 0) return failure("game_build_failed", "esbuild produced an empty bundle.");
    const sourceMapPath = path.join(stagingDir, "game.js.map");
    const sourceMap = options.sourceRevision?.startsWith("workspace:") || options.sourceRevision?.startsWith("candidate:")
      ? normalizeWorkspaceSourceMap(sourceMapPath, workspaceDir)
      : fs.readFileSync(sourceMapPath);
    if (!sourceMap) return failure("game_build_failed", "Build sources must come from the workspace or City SDK.");
    fs.writeFileSync(sourceMapPath, sourceMap);
    const buildRecord = createCodeGameBuildRecord({
      manifest: manifest.value,
      sourceRevision,
      sdkVersion: packageJson.version,
      toolchainVersion,
      bundler,
      bundle,
      sourceMap,
      assets,
    });
    fs.writeFileSync(path.join(stagingDir, "manifest.json"), `${canonicalJson(manifest.value)}\n`);
    fs.writeFileSync(path.join(stagingDir, "build.json"), `${JSON.stringify(buildRecord, null, 2)}\n`);
    for (const asset of assets) {
      const destination = path.join(stagingDir, ...asset.path.split("/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, asset.bytes);
    }

    const buildDir = path.join(outDir, buildRecord.buildId);
    if (fs.existsSync(buildDir)) {
      loadCodeGameBuildArtifact(buildDir);
    } else {
      fs.renameSync(stagingDir, buildDir);
    }
    const bundlePath = path.join(buildDir, "game.js");
    const warnings = (output.warnings ?? []).map((message) => fromEsbuildMessage(message, workspaceDir, "warning"));
    if (options.dataHome) writeBuildRecord(options.dataHome, { ...buildRecord, createdAtMs: Date.now() }, manifest.value.displayName);

    return {
      ok: true,
      buildId: buildRecord.buildId,
      buildDir,
      bundlePath,
      manifest: manifest.value,
      manifestDigest: buildRecord.manifestDigest,
      bundleDigest: buildRecord.bundleDigest,
      assetDigests: buildRecord.assetDigests,
      contentDigest: buildRecord.contentDigest,
      sourceRevision: buildRecord.sourceRevision,
      sdkVersion: buildRecord.sdkVersion,
      toolchainVersion: buildRecord.toolchainVersion,
      byteLength: buildRecord.byteLength,
      warnings: Object.freeze(warnings),
    };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

/** MCP reads this registry; it is a status index, not a build authority. The
 * bundle identity is always the content digest, never this file. */
function writeBuildRecord(
  dataHome: string,
  record: CodeGameBuildV2 & Readonly<{ createdAtMs: number }>,
  displayName: string,
): void {
  const root = path.join(dataHome, "state", "creator", "code-games");
  const builds = path.join(root, "builds");
  fs.mkdirSync(builds, { recursive: true });
  writeAtomic(path.join(builds, `${record.buildId}.json`), `${JSON.stringify(record, null, 2)}\n`);
  const indexPath = path.join(root, "index.json");
  let index: unknown[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    if (Array.isArray(parsed)) index = parsed;
  } catch {
    index = [];
  }
  const next = [{ ...record, displayName }, ...index.filter((item) => (item as { buildId?: unknown })?.buildId !== record.buildId)].slice(0, 50);
  writeAtomic(indexPath, `${JSON.stringify(next, null, 2)}\n`);
}

function writeAtomic(file: string, content: string): void {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}

/**
 * Type checking is a separate authority from bundling: esbuild strips types, so
 * a bundle can succeed while `const hp: number = "many"` ships. The Agent's
 * repair loop depends on these diagnostics (stage "typecheck"), and a missing
 * compiler fails closed rather than silently skipping the gate.
 */
/** Keep temporary snapshot paths out of artifacts and their content identity. */
function normalizeWorkspaceSourceMap(mapPath: string, workspaceDir: string): Buffer | null {
  const map = JSON.parse(fs.readFileSync(mapPath, "utf8")) as { sources: string[] };
  const roots = [
    { path: workspaceDir, prefix: "workspace" },
    { path: packageRoot, prefix: "city-game-sdk" },
    { path: path.resolve(packageRoot, "../agent-vitals-city-sdk"), prefix: "city-sdk" },
  ].map(root => ({ ...root, path: fs.realpathSync(root.path) }));
  const sources: string[] = [];
  for (const source of map.sources) {
    const absolute = fs.realpathSync(path.resolve(path.dirname(mapPath), source));
    const root = roots.find(candidate => isInside(candidate.path, absolute));
    if (!root) return null;
    sources.push(`${root.prefix}/${path.relative(root.path, absolute).split(path.sep).join("/")}`);
  }
  return Buffer.from(JSON.stringify({ ...map, sources }));
}

function typecheckWorkspace(workspaceDir: string, sdkApiEntry: string): readonly GameDiagnosticV1[] {
  const tsc = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc");
  if (!fs.existsSync(tsc)) {
    return [diagnostic("game_build_failed", "TypeScript is unavailable; the build cannot type-check the workspace.")];
  }
  const configPath = path.join(workspaceDir, ".code-game-tsconfig.json");
  const relativeSdk = path.relative(workspaceDir, sdkApiEntry).split(path.sep).join("/");
  const config = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
      allowImportingTsExtensions: true,
      paths: {
        "@oh-agent/city-game-sdk": [relativeSdk.startsWith(".") ? relativeSdk : `./${relativeSdk}`],
        "@oh-agent/city-sdk": [path.join(packageRoot, "../agent-vitals-city-sdk/src/index.ts")],
        "@oh-agent/city-sdk/contracts": [path.join(packageRoot, "../agent-vitals-city-sdk/src/contracts.ts")],
        "@oh-agent/city-sdk/testing": [path.join(packageRoot, "../agent-vitals-city-sdk/src/testing.ts")],
      },
    },
    include: ["src/**/*.ts"],
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  try {
    const result = spawnSync(process.execPath, [tsc, "-p", configPath, "--pretty", "false"], {
      cwd: workspaceDir,
      encoding: "utf8",
    });
    if (result.status === 0) return [];
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const diagnostics: GameDiagnosticV1[] = [];
    for (const line of output.split(/\r?\n/)) {
      const withLocation = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/.exec(line.trim());
      if (withLocation) {
        const file = path.resolve(workspaceDir, withLocation[1]);
        const relativePath = isInside(workspaceDir, file) ? path.relative(workspaceDir, file) : undefined;
        diagnostics.push(
          Object.freeze({
            code: "game_typecheck_failed" as const,
            severity: "error" as const,
            stage: "typecheck" as const,
            message: `${withLocation[4]}: ${withLocation[5]}`,
            ...(relativePath !== undefined ? { relativePath } : {}),
            line: Number(withLocation[2]),
            column: Number(withLocation[3]),
          }),
        );
      } else if (/^error TS\d+:/.test(line.trim())) {
        diagnostics.push(
          Object.freeze({
            code: "game_typecheck_failed" as const,
            severity: "error" as const,
            stage: "typecheck" as const,
            message: line.trim(),
          }),
        );
      }
    }
    if (diagnostics.length > 0) return Object.freeze(diagnostics);
    return [diagnostic("game_build_failed", "TypeScript exited non-zero without parseable diagnostics.")];
  } finally {
    fs.rmSync(configPath, { force: true });
  }
}

function readManifest(
  workspaceDir: string,
): { ok: true; value: CodeGameManifest } | { ok: false; diagnostics: readonly GameDiagnosticV1[] } {
  const manifestPath = path.join(workspaceDir, "game.manifest.json");
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      diagnostics: [diagnostic("game_manifest_invalid", `Cannot read game.manifest.json: ${(error as Error).message}`)],
    };
  }
  const parsed = validateCodeGameManifest(raw);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
  return { ok: true, value: parsed.value };
}

/** Content identity: every file that can change the bundle, sorted by relative
 * path, plus the toolchain versions. No timestamps, so a rebuild is identical. */
function digestWorkspace(workspaceDir: string, manifest: CodeGameManifest): string {
  const files: string[] = [];
  collectFiles(workspaceDir, files);
  files.sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  for (const file of files) {
    const relative = path.relative(workspaceDir, file).split(path.sep).join("/");
    hash.update(relative);
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  hash.update(`sdk:${packageJson.version}\0esbuild:${esbuildVersion}\0game:${manifest.gameId}`);
  return hash.digest("hex");
}

function collectFiles(directory: string, out: string[]): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function fromEsbuildMessage(
  message: EsbuildMessage,
  workspaceDir: string,
  severity: "error" | "warning" = "error",
): GameDiagnosticV1 {
  const location = message.location ?? null;
  const file = location?.file ? path.resolve(workspaceDir, location.file) : null;
  const relativePath = file && isInside(workspaceDir, file) ? path.relative(workspaceDir, file) : undefined;
  const code = /Could not resolve/.test(message.text) ? "game_dependency_denied" : "game_build_failed";
  return Object.freeze({
    code,
    severity,
    stage: "build" as const,
    message: message.text,
    ...(relativePath !== undefined ? { relativePath } : {}),
    ...(location ? { line: location.line, column: location.column } : {}),
  });
}

function diagnostic(code: GameDiagnosticV1["code"], message: string): GameDiagnosticV1 {
  return Object.freeze({ code, severity: "error" as const, stage: "build" as const, message });
}

function failure(code: GameDiagnosticV1["code"], message: string): CodeGameBuildFailure {
  return { ok: false, buildId: null, diagnostics: [diagnostic(code, message)] };
}

async function main(argv: readonly string[]): Promise<void> {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${item} expects a value.`);
    args.set(item.slice(2), value);
    index += 1;
  }
  const workspaceDir = args.get("workspace");
  const outDir = args.get("out");
  const dataHome = args.get("data-home") ?? process.env.AGENT_VITALS_HOME;
  if (!workspaceDir || !outDir) {
    throw new Error("Usage: buildGame.ts --workspace <game dir> --out <builds dir>");
  }
  const workspaceId = args.get("workspace-id");
  // PR09 候选隔离层：candidate 构建密封 `candidate:<candidateId>:<digest>`，
  // 与 workspace 形态互斥；source map 与 workspace 路径同规则归一化。
  const candidateId = args.get("candidate-id");
  const revision = args.get("source-revision");
  const ids = [workspaceId, candidateId].filter((id) => id !== undefined);
  if (
    (ids.length > 1) ||
    (revision === undefined ? ids.length > 0 : ids.length !== 1) ||
    (workspaceId !== undefined && !/^gws-[a-f0-9]{16}$/.test(workspaceId)) ||
    (candidateId !== undefined && !/^candidate-[a-f0-9]{16}$/.test(candidateId)) ||
    (revision !== undefined && !/^[a-f0-9]{64}$/.test(revision))
  ) {
    throw new Error("Workspace builds require a valid workspace or candidate ID and source revision.");
  }
  const sourceRevision =
    workspaceId !== undefined ? `workspace:${workspaceId}:${revision}`
    : candidateId !== undefined ? `candidate:${candidateId}:${revision}`
    : undefined;
  const result = await buildCodeGame({
    workspaceDir,
    outDir,
    ...(dataHome ? { dataHome } : {}),
    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
