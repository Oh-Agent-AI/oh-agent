import test from "node:test";
import assert from "node:assert/strict";
import { createMiamiGameRuntimeRegistry } from "../src/game/runtime/miamiActivityHost.ts";
import type { MiamiActivityIdV1 } from "../src/game/runtime/miamiActivityHost.ts";
import { CITY_GAME_TYPE_CATALOG, gameTypeBlockReason, PLANNED_GAME_TYPE_IDS, PROTOTYPE_GAME_TYPE_IDS } from "../src/game/runtime/gameTypeCatalog.ts";
import { CREATOR_GAME_TYPES_V1 } from "@oh-agent/city-sdk";

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

test("app-side factory registers the four Miami adapters plus the flight prototype", async () => {
  const calls: MiamiActivityIdV1[] = [];
  const registry = createMiamiGameRuntimeRegistry(entries(calls));
  assert.equal(registry.descriptors().length, 5);
  for (const activity of ids) {
    const runtime = registry.resolve(`miami.${activity}-v1`, 1);
    const prepared = await runtime.prepare({} as never);
    assert.equal(prepared.ok, true);
  }
  const prototype = registry.resolve("creator.flight-ornithopter-prototype-v1", 1);
  assert.equal(prototype.type, "miami.flight");
  const preparedPrototype = await prototype.prepare();
  assert.equal(preparedPrototype.ok, true);
  assert.deepEqual(calls, ["flight", "driving", "mecha", "cinema", "flight"]);
});

test("app catalog exposes the flight prototype and keeps the real ornithopter unregistrable", () => {
  assert.equal(CITY_GAME_TYPE_CATALOG.length, 6);
  assert.deepEqual(PLANNED_GAME_TYPE_IDS, ["creator.flight-ornithopter-v1"]);
  assert.deepEqual(PROTOTYPE_GAME_TYPE_IDS, ["creator.flight-ornithopter-prototype-v1"]);
  assert.match(gameTypeBlockReason("creator.flight-ornithopter-v1") ?? "", /planned template/);
  assert.equal(gameTypeBlockReason("creator.flight-ornithopter-prototype-v1"), null);
  const registry = createMiamiGameRuntimeRegistry(entries([]));
  assert.equal(registry.resolve("creator.flight-ornithopter-prototype-v1", 1).type, "miami.flight");
  assert.throws(() => registry.resolve("creator.flight-ornithopter-v1", 1));
});

test("Creator capability gameTypes stays lockstep with the app catalog", () => {
  assert.deepEqual(CITY_GAME_TYPE_CATALOG.map(item => ({
    id: item.id, template: item.template, templateCatalog: item.templateCatalog, runtime: item.runtime,
  })), CREATOR_GAME_TYPES_V1.map(item => ({
    id: item.id, template: item.template, templateCatalog: item.templateCatalog, runtime: item.runtime,
  })));
});
