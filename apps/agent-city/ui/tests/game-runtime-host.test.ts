import test from "node:test";
import assert from "node:assert/strict";
import { createMiamiGameRuntimeRegistry } from "../src/game/runtime/miamiActivityHost.ts";
import type { MiamiActivityIdV1 } from "../src/game/runtime/miamiActivityHost.ts";

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
