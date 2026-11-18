import { build, version as esbuildVersion } from "esbuild";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GameDiagnosticV1 } from "../src/protocol/diagnostics.ts";
import { validateCodeGameManifestV1, type CodeGameManifestV1 } from "../src/protocol/manifest.ts";

/**
 * P0 build service (prototype). It deliberately does three things only:
 *
 *   1. validate `game.manifest.json` with the same validator the host uses;
 *   2. bundle `entry` with a pinned toolchain and a trusted SDK alias;
 *   3. name the output by a content digest, so a `buildId` can never point at
 *      two different source trees.
 *
 * It does **not** typecheck (that is a separate `tsc --noEmit` step in the
 * Studio build job) and it does not run `vite.config.ts`, `postinstall` or any
 * workspace script: the only executable input is the entry graph. Vite remains
 * the Studio/City bundler; this service exists so the vertical slice can
 * produce a real ESM bundle with a reproducible identity before that pipeline
 * is wired into Rust.
 */

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
  version: string;
};
const SDK_NAME = "@oh-agent/city-game-sdk";
const DEFAULT_SDK_ENTRY = path.join(packageRoot, "src", "api", "index.ts");
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);

export type CodeGameBuildOptions = Readonly<{
  workspaceDir: string;
  outDir: string;
  /** Overridable for tests; production points at the packaged SDK entry. */
  sdkApiEntry?: string;
}>;

export type CodeGameBuildSuccess = Readonly<{
  ok: true;
  buildId: string;
  buildDir: string;
  bundlePath: string;
  manifest: CodeGameManifestV1;
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

  const missingAssets = manifest.value.assets.filter((asset) => !fs.existsSync(path.join(workspaceDir, asset.path)));
  if (missingAssets.length > 0) {
    return {
      ok: false,
      buildId: null,
      diagnostics: missingAssets.map((asset) =>
        diagnostic("game_asset_invalid", `Declared asset "${asset.path}" is missing from the workspace.`),
      ),
    };
  }

  const buildId = digestWorkspace(workspaceDir, manifest.value);
  const buildDir = path.join(outDir, buildId);
  const bundlePath = path.join(buildDir, "game.js");
  fs.mkdirSync(buildDir, { recursive: true });

  let output: Awaited<ReturnType<typeof build>>;
  try {
    output = await build({
      absWorkingDir: workspaceDir,
      entryPoints: [manifest.value.entry],
      outfile: bundlePath,
      bundle: true,
      format: "esm",
      platform: "browser",
      target: ["es2022"],
      sourcemap: true,
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

  const stat = fs.statSync(bundlePath);
  if (stat.size === 0) return failure("game_build_failed", "esbuild produced an empty bundle.");

  const warnings = (output.warnings ?? []).map((message) => fromEsbuildMessage(message, workspaceDir, "warning"));
  fs.writeFileSync(
    path.join(buildDir, "build.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: "code-game",
        buildId,
        gameId: manifest.value.gameId,
        gameVersion: manifest.value.version,
        sdk: manifest.value.sdk,
        entry: manifest.value.entry,
        bundle: "game.js",
        byteLength: stat.size,
        sdkVersion: packageJson.version,
        bundler: `esbuild@${esbuildVersion}`,
      },
      null,
      2,
    )}\n`,
  );

  return {
    ok: true,
    buildId,
    buildDir,
    bundlePath,
    manifest: manifest.value,
    byteLength: stat.size,
    warnings: Object.freeze(warnings),
  };
}

function readManifest(
  workspaceDir: string,
): { ok: true; value: CodeGameManifestV1 } | { ok: false; diagnostics: readonly GameDiagnosticV1[] } {
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
  const parsed = validateCodeGameManifestV1(raw);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
  return { ok: true, value: parsed.value };
}

/** Content identity: every file that can change the bundle, sorted by relative
 * path, plus the toolchain versions. No timestamps, so a rebuild is identical. */
function digestWorkspace(workspaceDir: string, manifest: CodeGameManifestV1): string {
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
  if (!workspaceDir || !outDir) {
    throw new Error("Usage: buildGame.ts --workspace <game dir> --out <builds dir>");
  }
  const result = await buildCodeGame({ workspaceDir, outDir });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
