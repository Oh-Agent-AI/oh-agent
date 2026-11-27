import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { GameDefinitionV1 } from "../src/api/defineGame.ts";
import type { GameDefinitionV2 } from "../src/api/v2.ts";
import { validateCityWorldSnapshot } from "@oh-agent/city-sdk";
import { compileWorldFixtureV1 } from "@oh-agent/city-sdk/testing";
import { createSnapshotWorldAPIV2 } from "../src/host/snapshotWorld.ts";
import { createV1WorldFromV2 } from "../src/host/codeGameHostV2.ts";
import { createCodeGameHostV1 } from "../src/host/codeGameHost.ts";
import { createGameTestWorld } from "../src/testing/index.ts";
import { createCodeGameHostV2 } from "../src/host/codeGameHostV2.ts";
import { createGameAccessV1, type HostGrantV1 } from "../src/protocol/access.ts";
import {
  loadCodeGameBuildArtifact,
  loadCodeGameBuildById,
  type LoadedCodeGameBuild,
} from "./buildArtifact.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const buildId = argument("build");
const buildsDir = argument("builds-dir");
const buildDir = argument("build-dir");
const legacyBundlePath = argument("bundle");
const legacyManifestPath = argument("manifest");
const snapshotPath = argument("snapshot");
const expectedSnapshotDigest = argument("snapshot-digest");
const seed = Number(argument("seed") ?? 7);
const ticks = Number(argument("ticks") ?? 600);
const sealedRequest = Boolean(buildId && buildsDir) || Boolean(buildDir);
const legacyRequest = Boolean(legacyBundlePath && legacyManifestPath);
const incompleteRequest = Boolean(buildId && !buildsDir) || Boolean(buildsDir && !buildId) ||
  Boolean(legacyBundlePath && !legacyManifestPath) || Boolean(legacyManifestPath && !legacyBundlePath) ||
  Boolean(snapshotPath && !expectedSnapshotDigest) || Boolean(expectedSnapshotDigest && !snapshotPath);

/** Defense in depth (PR04): mirrors the MCP `creator_code_test` cap, so a
 * direct invocation cannot request an unbounded run either. */
const MAX_TICKS = 3_600;
/** Wall-clock deadline for the run loops (PR04). A bundle whose step() never
 * returns would otherwise hang this process forever; the deadline sits below
 * the MCP runner's own test budget (60 s) so the structured reason usually
 * wins the race against the host-side kill. Normal bounded runs never reach it. */
const RUN_DEADLINE_MS = 50_000;
const deadlineMs = Date.now() + RUN_DEADLINE_MS;

function assertWithinDeadline(tick: number): void {
  if (Date.now() >= deadlineMs) {
    throw Object.assign(
      new Error(`The headless run exceeded its ${RUN_DEADLINE_MS} ms wall-clock deadline at tick ${tick}.`),
      { code: "game_execution_timeout" },
    );
  }
}

if (Number.isSafeInteger(ticks) && ticks > MAX_TICKS) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "game_argument_invalid", message: `\`ticks\` must be at most ${MAX_TICKS}; the headless runner has no unbounded mode` } })}\n`);
  process.exit(0);
}

if (incompleteRequest || (!sealedRequest && !legacyRequest) || !Number.isSafeInteger(seed) || !Number.isSafeInteger(ticks) || ticks <= 0) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "invalid_argument", message: "use --build <id> --builds-dir <dir> (or --build-dir <dir>), with positive seed/ticks; --snapshot also requires --snapshot-digest" } })}\n`);
  process.exit(0);
}

try {
  const artifact: LoadedCodeGameBuild | null = buildDir
    ? loadCodeGameBuildArtifact(buildDir)
    : buildId && buildsDir
      ? loadCodeGameBuildById(buildsDir, buildId)
      : null;
  const bundlePath = artifact?.bundlePath ?? (legacyBundlePath as string);
  const manifest = artifact?.manifest ??
    JSON.parse(fs.readFileSync(path.resolve(legacyManifestPath as string), "utf8")) as unknown;
  const module = (await import(pathToFileURL(path.resolve(bundlePath)).href)) as { default?: unknown };
  if (typeof module.default !== "object" || module.default === null || typeof (module.default as GameDefinitionV1).setup !== "function") {
    throw Object.assign(new Error("The bundle does not export default defineGame()."), { code: "game_entry_invalid" });
  }

  const snapshot = snapshotPath ? readSnapshot(snapshotPath, expectedSnapshotDigest as string) : null;
  const worldV2 = snapshot ? createSnapshotWorldAPIV2(snapshot) : null;
  const buildIdentity = artifact?.build.buildId ?? "legacy-build";
  const runId = `run-${buildIdentity.slice(0, 16)}-${seed}`;
  const evidenceId = `evidence-${runId}`;
  const worldIdentity = snapshot ? {
    cityId: snapshot.header.cityId,
    cityRevision: snapshot.header.cityRevision,
    worldRevision: snapshot.header.revisions.worldRevision,
    snapshotDigest: snapshot.header.snapshotDigest,
    interactionRevision: snapshot.header.revisions.interactionRevision,
  } : {
    cityId: "test-city",
    worldRevision: "world-1",
  };

  if (manifest.schemaVersion === 2) {
    const world = worldV2 ?? createSnapshotWorldAPIV2(compileWorldFixtureV1());
    const grant: HostGrantV1 = Object.freeze({
      installationId: `installation-${buildIdentity}`,
      runId,
      grantedPermissions: manifest.permissions,
      status: "active",
    });
    const access = createGameAccessV1(manifest, world.header().capabilities, grant);
    const host = createCodeGameHostV2(manifest, {
      world,
      seed,
      runId,
      access,
      grant,
    });
    await host.prepare(module.default as GameDefinitionV2);
    await host.start();
    for (let index = 0; index < ticks && host.status === "running"; index += 1) {
      assertWithinDeadline(index);
      host.step();
    }
    const telemetry = host.telemetry();
    await host.stop();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      buildId: buildIdentity,
      runId,
      evidenceId,
      telemetry: {
        ...worldIdentity,
        status: telemetry.status,
        outcome: telemetry.outcome,
        reason: telemetry.reason,
        tick: telemetry.tick,
        entities: telemetry.entities,
        hud: telemetry.hud,
        counters: telemetry.counters,
      },
    })}\n`);
  } else if (manifest.schemaVersion === 1) {
    const worldSource = worldV2 ? createV1WorldFromV2(worldV2) : createGameTestWorld().source;
    const host = createCodeGameHostV1(manifest, { world: worldSource, seed, runId });
    await host.prepare(module.default as GameDefinitionV1);
    host.start();
    for (let index = 0; index < ticks; index += 1) {
      assertWithinDeadline(index);
      host.step();
    }
    const telemetry = host.telemetry();
    host.dispose();
    if (host.entityCount !== 0) throw new Error("The run leaked entities after disposal.");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      buildId: buildIdentity,
      runId,
      evidenceId,
      telemetry: {
        ...worldIdentity,
        status: telemetry.status,
        outcome: telemetry.outcome,
        reason: telemetry.reason,
        tick: telemetry.tick,
        entities: telemetry.entities,
        hud: telemetry.hud,
        counters: telemetry.counters,
      },
    })}\n`);
  } else {
    throw Object.assign(new Error("The headless host does not support this manifest schema."), { code: "game_manifest_unsupported" });
  }
} catch (error) {
  const code = (error as { code?: unknown }).code;
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: {
      code: typeof code === "string" ? code : "game_runtime_fault",
      message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    },
  })}\n`);
}

function readSnapshot(file: string, expectedDigest: string) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as unknown;
  const parsed = validateCityWorldSnapshot(raw);
  if (!parsed.ok) throw Object.assign(new Error(parsed.diagnostics[0]?.message ?? "Invalid City snapshot."), { code: "game_asset_invalid" });
  if (parsed.value.header.snapshotDigest !== expectedDigest) {
    throw Object.assign(new Error("The City snapshot digest does not match the requested world identity."), { code: "game_package_integrity_failed" });
  }
  return parsed.value;
}
