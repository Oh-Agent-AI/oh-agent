import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CodeGameBuildV2 } from "../src/protocol/build.ts";
import { GameSdkError } from "../src/protocol/errors.ts";
import { deepFreeze } from "../src/protocol/freeze.ts";
import type { CodeGameAssetV2, CodeGameManifest } from "../src/protocol/manifestV2.ts";
import { validateCodeGameManifest } from "../src/protocol/manifestV2.ts";

const BUILD_ID = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export type ArtifactAssetInput = Readonly<{
  path: string;
  bytes: Uint8Array;
}>;

export type FrozenCodeGameAsset = Readonly<{
  id: string;
  path: string;
  type: CodeGameAssetV2["type"];
  digest: string;
  byteLength: number;
  bytes: Uint8Array;
  artifactPath: string;
}>;

export type LoadedCodeGameBuild = Readonly<{
  build: CodeGameBuildV2;
  manifest: CodeGameManifest;
  buildDir: string;
  bundlePath: string;
  bundle: Uint8Array;
  sourceMap: Uint8Array;
  manifestBytes: Uint8Array;
  buildRecordBytes: Uint8Array;
  assets: readonly FrozenCodeGameAsset[];
}>;

export type CodeGamePublishFile = Readonly<{
  relativePath: string;
  digest: string;
  bytes: Uint8Array;
}>;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON does not support non-finite numbers.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .sort()
      .map((key) => {
        if (record[key] === undefined) throw new Error("Canonical JSON does not support undefined fields.");
        return `${JSON.stringify(key)}:${canonicalJson(record[key])}`;
      });
    return `{${fields.join(",")}}`;
  }
  throw new Error("Canonical JSON supports JSON values only.");
}

export function digestArtifactBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function createCodeGameBuildRecord(input: Readonly<{
  manifest: CodeGameManifest;
  sourceRevision: string;
  sdkVersion: string;
  toolchainVersion: string;
  bundler: string;
  bundle: Uint8Array;
  sourceMap: Uint8Array;
  assets: readonly ArtifactAssetInput[];
}>): CodeGameBuildV2 {
  const manifestDigest = digestArtifactBytes(new TextEncoder().encode(canonicalJson(input.manifest)));
  const bundleDigest = digestArtifactBytes(input.bundle);
  const sourceMapDigest = digestArtifactBytes(input.sourceMap);
  const assetDigests = Object.fromEntries(
    [...input.assets]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((asset) => [asset.path, digestArtifactBytes(asset.bytes)]),
  );
  const contentDigest = digestArtifactBytes(
    new TextEncoder().encode(canonicalJson({ manifestDigest, bundleDigest, sourceMapDigest, assetDigests })),
  );
  const identity = {
    domain: "oh-agent-code-game-build-v2",
    gameId: input.manifest.gameId,
    gameVersion: input.manifest.version,
    manifestDigest,
    contentDigest,
    sourceRevision: input.sourceRevision,
    sdkVersion: input.sdkVersion,
    toolchainVersion: input.toolchainVersion,
  };
  const buildId = createHash("sha256").update(canonicalJson(identity)).digest("hex");
  return deepFreeze({
    schemaVersion: 2 as const,
    kind: "code-game-build" as const,
    buildId,
    gameId: input.manifest.gameId,
    gameVersion: input.manifest.version,
    manifestSchemaVersion: input.manifest.schemaVersion,
    sdk: { ...input.manifest.sdk },
    entry: input.manifest.entry,
    bundle: "game.js" as const,
    byteLength: input.bundle.byteLength,
    bundleDigest,
    sourceMapDigest,
    manifestDigest,
    assetDigests,
    contentDigest,
    sourceRevision: input.sourceRevision,
    sdkVersion: input.sdkVersion,
    toolchainVersion: input.toolchainVersion,
    bundler: input.bundler,
  });
}

export function loadCodeGameBuildById(buildsDir: string, buildId: string): LoadedCodeGameBuild {
  if (!BUILD_ID.test(buildId)) throw integrity("Build id must be 64 lower-case hexadecimal characters.");
  const loaded = loadCodeGameBuildArtifact(path.join(path.resolve(buildsDir), buildId));
  if (loaded.build.buildId !== buildId) throw integrity("Build directory and sealed build id disagree.");
  return loaded;
}

export function loadCodeGameBuildArtifact(buildDirInput: string): LoadedCodeGameBuild {
  const buildDir = path.resolve(buildDirInput);
  const manifestBytes = readSealedFile(buildDir, "manifest.json");
  const buildRecordBytes = readSealedFile(buildDir, "build.json");
  let rawManifest: unknown;
  let rawBuild: unknown;
  try {
    rawManifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    rawBuild = JSON.parse(new TextDecoder().decode(buildRecordBytes));
  } catch {
    throw integrity("Sealed manifest.json or build.json is not valid JSON.");
  }
  const parsedManifest = validateCodeGameManifest(rawManifest);
  if (!parsedManifest.ok) throw integrity("Sealed manifest does not satisfy its declared schema.");
  const manifest = parsedManifest.value;
  if (new TextDecoder().decode(manifestBytes) !== `${canonicalJson(manifest)}\n`) {
    throw integrity("Sealed manifest is not the canonical frozen manifest bytes.");
  }
  const recorded = parseBuildRecord(rawBuild);
  if (new TextDecoder().decode(buildRecordBytes) !== `${JSON.stringify(recorded, null, 2)}\n`) {
    throw integrity("Sealed build record is not the canonical frozen record bytes.");
  }
  const bundle = readSealedFile(buildDir, "game.js");
  const sourceMap = readSealedFile(buildDir, "game.js.map");
  const assets = manifest.assets.map((asset) => {
    const bytes = readSealedFile(buildDir, asset.path);
    return { path: asset.path, bytes };
  });
  const expected = createCodeGameBuildRecord({
    manifest,
    sourceRevision: recorded.sourceRevision,
    sdkVersion: recorded.sdkVersion,
    toolchainVersion: recorded.toolchainVersion,
    bundler: recorded.bundler,
    bundle,
    sourceMap,
    assets,
  });
  if (canonicalJson(expected) !== canonicalJson(rawBuild)) {
    throw integrity("Sealed build record, manifest, bundle or asset digest does not match.");
  }

  const frozenAssets = manifest.assets.map((asset, index) => {
    const input = assets[index];
    if (!input) throw integrity(`Sealed asset "${asset.id}" is missing.`);
    return Object.freeze({
      id: asset.id,
      path: asset.path,
      type: asset.type,
      digest: expected.assetDigests[asset.path] as string,
      byteLength: input.bytes.byteLength,
      bytes: input.bytes,
      artifactPath: path.join(buildDir, ...asset.path.split("/")),
    });
  });
  return Object.freeze({
    build: expected,
    manifest,
    buildDir,
    bundlePath: path.join(buildDir, "game.js"),
    bundle,
    sourceMap,
    manifestBytes,
    buildRecordBytes,
    assets: Object.freeze(frozenAssets),
  });
}

export function readCodeGameBuildAsset(loaded: LoadedCodeGameBuild, assetId: string): FrozenCodeGameAsset {
  const asset = loaded.assets.find((candidate) => candidate.id === assetId);
  if (!asset) throw new GameSdkError("game_asset_invalid", `Build has no sealed asset "${assetId}".`, "test");
  return asset;
}

/** Publish consumes the same verified bytes as test and preview. No workspace
 * path is accepted here, so a later workspace edit cannot leak into a release. */
export function createCodeGamePublishPayload(loaded: LoadedCodeGameBuild): readonly CodeGamePublishFile[] {
  const files: CodeGamePublishFile[] = [
    publishFile("manifest.json", loaded.manifestBytes),
    publishFile("game.js", loaded.bundle),
    publishFile("game.js.map", loaded.sourceMap),
    ...loaded.assets.map((asset) => publishFile(asset.path, asset.bytes)),
    publishFile("build.json", loaded.buildRecordBytes),
  ];
  return Object.freeze(files);
}

function publishFile(relativePath: string, bytes: Uint8Array): CodeGamePublishFile {
  return Object.freeze({ relativePath, digest: digestArtifactBytes(bytes), bytes });
}

function parseBuildRecord(value: unknown): CodeGameBuildV2 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw integrity("Sealed build record must be an object.");
  }
  const record = value as Record<string, unknown>;
  const strings = [
    "buildId",
    "gameId",
    "gameVersion",
    "entry",
    "bundleDigest",
    "sourceMapDigest",
    "manifestDigest",
    "contentDigest",
    "sourceRevision",
    "sdkVersion",
    "toolchainVersion",
    "bundler",
  ];
  for (const key of strings) {
    if (typeof record[key] !== "string" || (record[key] as string).length === 0) {
      throw integrity(`Sealed build record field "${key}" is invalid.`);
    }
  }
  if (
    record.schemaVersion !== 2 ||
    record.kind !== "code-game-build" ||
    (record.manifestSchemaVersion !== 1 && record.manifestSchemaVersion !== 2) ||
    record.bundle !== "game.js" ||
    !BUILD_ID.test(record.buildId as string) ||
    typeof record.byteLength !== "number" ||
    !Number.isSafeInteger(record.byteLength) ||
    record.byteLength < 1
  ) {
    throw integrity("Sealed build record identity is invalid.");
  }
  for (const key of ["bundleDigest", "sourceMapDigest", "manifestDigest", "contentDigest"]) {
    if (!DIGEST.test(record[key] as string)) throw integrity(`Sealed build digest "${key}" is invalid.`);
  }
  if (typeof record.sdk !== "object" || record.sdk === null || Array.isArray(record.sdk)) {
    throw integrity("Sealed SDK identity is invalid.");
  }
  const sdk = record.sdk as Record<string, unknown>;
  if (typeof sdk.name !== "string" || typeof sdk.apiMajor !== "number" || !Number.isSafeInteger(sdk.apiMajor)) {
    throw integrity("Sealed SDK identity is invalid.");
  }
  if (typeof record.assetDigests !== "object" || record.assetDigests === null || Array.isArray(record.assetDigests)) {
    throw integrity("Sealed asset digest map is invalid.");
  }
  for (const digest of Object.values(record.assetDigests)) {
    if (typeof digest !== "string" || !DIGEST.test(digest)) throw integrity("Sealed asset digest is invalid.");
  }
  return value as CodeGameBuildV2;
}

function readSealedFile(buildDir: string, relativePath: string): Uint8Array {
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw integrity("Sealed artifact contains an unsafe relative path.");
  }
  try {
    let current = buildDir;
    for (const segment of segments.slice(0, -1)) {
      current = path.join(current, segment);
      if (!fs.lstatSync(current).isDirectory()) throw new Error("not a regular directory");
    }
    const file = path.join(buildDir, ...segments);
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error("not a regular file");
    return fs.readFileSync(file);
  } catch {
    throw integrity(`Sealed artifact file "${relativePath}" is missing or unreadable.`);
  }
}

function integrity(message: string): GameSdkError {
  return new GameSdkError("game_package_integrity_failed", message, "test");
}
