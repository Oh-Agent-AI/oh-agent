import test from "node:test";
import assert from "node:assert/strict";
import { cityProjectionErrorCode, cityProjectionDelay, retryCityProjection } from "../src/data/projectionRetry.ts";

test("retries transient host and revision races using a fresh read", async () => {
  let count = 0; const attempts: string[] = [];
  const result = await retryCityProjection(async () => { count++; if (count === 1) throw "plugin_instance_mismatch"; if (count === 2) throw new Error("revision_changed"); return "ready"; },
    { delay: async () => {}, onAttempt: (n, code) => { if (code) attempts.push(`${n}:${code}`); } });
  assert.equal(result, "ready"); assert.equal(count, 3); assert.deepEqual(attempts, ["1:plugin_instance_mismatch", "2:revision_changed"]);
});

test("does not retry permission failures or expose arbitrary error text", async () => {
  let count = 0;
  await assert.rejects(retryCityProjection(async () => { count++; throw "permission_denied"; }, { delay: async () => {} }), /permission_denied/);
  assert.equal(count, 1);
  assert.equal(cityProjectionErrorCode(new Error("private /Users/example/log")), "typed_city_projection_unavailable");
});

test("retries are bounded and an abort interrupts the delay", async () => {
  let count = 0;
  await assert.rejects(retryCityProjection(async () => { count++; throw "revision_changed"; }, { delay: async () => {}, maxAttempts: 3 }), /revision_changed/);
  assert.equal(count, 3);
  const controller = new AbortController();
  const wait = cityProjectionDelay(5000, controller.signal); controller.abort();
  await assert.rejects(wait, /city_request_cancelled/);
});
