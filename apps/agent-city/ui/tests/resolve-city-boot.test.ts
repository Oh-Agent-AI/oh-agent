import test from "node:test";
import assert from "node:assert/strict";
import { resolveCityBoot } from "../src/game/activity/resolveCityBoot.ts";

test("boot waits for host readiness and returns the authoritative city", async () => {
  let calls = 0;
  const city = { pending: true, runId: "desert" } as any;
  const result = await resolveCityBoot(async () => { if (++calls < 3) throw new Error("not-ready"); return city; }, async () => {}, () => false);
  assert.equal(calls, 3);
  assert.equal(result, city);
});

test("boot fails closed when the host remains unavailable", async () => {
  let calls = 0;
  await assert.rejects(resolveCityBoot(async () => { calls++; throw new Error("offline"); }, async () => {}, () => false, 2), /offline/);
  assert.equal(calls, 3);
});

test("unmounted boot ignores an in-flight response", async () => {
  let cancelled = false;
  const result = await resolveCityBoot(async () => { cancelled = true; return { pending: false }; }, async () => {}, () => cancelled);
  assert.equal(result, null);
});
