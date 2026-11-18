import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { GameDefinitionV1 } from "../src/api/defineGame.ts";
import { createGameTestWorld } from "../src/testing/index.ts";

/**
 * Headless acceptance for a built Code Game. The MCP `creator_code_test` tool
 * runs exactly this script, with the same production host the City uses, so an
 * Agent's automated feedback is not a second implementation.
 *
 * Output is one JSON document on stdout. Failure to launch is `{ok:false,error}`;
 * a game that simply has not finished in the tick budget is a successful run
 * with `telemetry.status = "running"` — the caller decides what that means.
 */

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const bundlePath = argument("bundle");
const manifestPath = argument("manifest");
const seed = Number(argument("seed") ?? 7);
const ticks = Number(argument("ticks") ?? 600);

if (!bundlePath || !manifestPath || !Number.isSafeInteger(seed) || !Number.isSafeInteger(ticks) || ticks <= 0) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "invalid_argument", message: "bundle, manifest, seed and ticks are required" } })}\n`);
  process.exit(0);
}

try {
  const module = (await import(pathToFileURL(path.resolve(bundlePath)).href)) as { default?: unknown };
  if (typeof module.default !== "object" || module.default === null || typeof (module.default as GameDefinitionV1).setup !== "function") {
    throw Object.assign(new Error("The bundle does not export default defineGame()."), { code: "game_entry_invalid" });
  }
  const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8")) as unknown;
  const world = createGameTestWorld();
  const run = await world.launch(module.default as GameDefinitionV1, { seed, manifest });
  run.advanceTicks(ticks);
  const telemetry = run.telemetry();
  run.dispose();
  run.assertNoLeakedEntities();
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      telemetry: {
        status: telemetry.status,
        outcome: telemetry.outcome,
        reason: telemetry.reason,
        tick: telemetry.tick,
        entities: telemetry.entities,
        hud: telemetry.hud,
        counters: telemetry.counters,
      },
    })}\n`,
  );
} catch (error) {
  const code = (error as { code?: unknown }).code;
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      error: {
        code: typeof code === "string" ? code : "game_runtime_fault",
        message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      },
    })}\n`,
  );
}
