import test from "node:test";
import assert from "node:assert/strict";
import { createMiamiGameRuntimeRegistry } from "../src/game/runtime/miamiActivityHost.ts";
import type { MiamiActivityIdV1 } from "../src/game/runtime/miamiActivityHost.ts";
import { CITY_GAME_TYPE_CATALOG, gameTypeBlockReason, PLANNED_GAME_TYPE_IDS } from "../src/game/runtime/gameTypeCatalog.ts";
import { CREATOR_GAME_TYPES_V1 } from "@agent-vitals/city-sdk";

const ids: MiamiActivityIdV1[] = ["flight", "driving", "mecha", "cinema"];

function entries(calls: MiamiActivityIdV1[]) {
  return Object.fromEntries(ids.map(activity => [activity, async () => {
    calls.push(activity);
    return { ok: true as const, value: {
      telemetry: () => ({ status: "running" as const, tick: 1, counters: {}, metrics: {}, reason: null }),
      dispose: () => {},
    } };
  }])) as never;
}

test("app-side factory registers all four Miami adapters and delegates prepare", async () => {
  const calls: MiamiActivityIdV1[] = [];
  const registry = createMiamiGameRuntimeRegistry(entries(calls));
  assert.equal(registry.descriptors().length, 4);
  for (const activity of ids) {
    const runtime = registry.resolve(`miami.${activity}-v1`, 1);
    const prepared = await runtime.prepare({} as never);
    assert.equal(prepared.ok, true);
  }
  assert.deepEqual(calls, ["flight", "driving", "mecha", "cinema"]);
});

test("app catalog exposes the planned ornithopter descriptor but keeps it unregistrable", () => {
  assert.equal(CITY_GAME_TYPE_CATALOG.length, 5);
  assert.deepEqual(PLANNED_GAME_TYPE_IDS, ["creator.flight-ornithopter-v1"]);
  assert.match(gameTypeBlockReason("creator.flight-ornithopter-v1") ?? "", /planned template/);
  const registry = createMiamiGameRuntimeRegistry(entries([]));
  assert.throws(() => registry.resolve("creator.flight-ornithopter-v1", 1));
});

test("Creator capability gameTypes stays lockstep with the app catalog", () => {
  assert.deepEqual(CITY_GAME_TYPE_CATALOG.map(item => ({
    id: item.id, template: item.template, templateCatalog: item.templateCatalog, runtime: item.runtime,
  })), CREATOR_GAME_TYPES_V1.map(item => ({
    id: item.id, template: item.template, templateCatalog: item.templateCatalog, runtime: item.runtime,
  })));
});
