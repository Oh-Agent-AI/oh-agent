import test from "node:test";
import assert from "node:assert/strict";
import { STOP_LANDED_GUARD_MS, STOP_TIMEOUT_MS, stopTransition } from "../src/features/agent/useStopPhase.ts";

test("stop phase machine: request → pending, ack → landed, guard → idle", () => {
  const requested = stopTransition({ phase: "idle", at: null }, { type: "request", now: 1_000 });
  assert.equal(requested.phase, "pending");
  assert.equal(requested.at, 1_000);
  // pending 中重复点击不改变状态（双击防护）。
  assert.equal(stopTransition(requested, { type: "request", now: 1_100 }).phase, "pending");
  const landed = stopTransition(requested, { type: "ack", now: 1_200 });
  assert.equal(landed.phase, "landed");
  assert.equal(landed.at, 1_200);
  // landed 后 500ms 防抖内不回到 idle。
  assert.equal(stopTransition(landed, { type: "guard-elapsed", now: 1_200 + STOP_LANDED_GUARD_MS - 1 }).phase, "landed");
  assert.equal(stopTransition(landed, { type: "guard-elapsed", now: 1_200 + STOP_LANDED_GUARD_MS }).phase, "idle");
});

test("stop phase machine: 10s without ack re-enables the button for retry", () => {
  const requested = stopTransition({ phase: "idle", at: null }, { type: "request", now: 0 });
  assert.equal(stopTransition(requested, { type: "timeout", now: STOP_TIMEOUT_MS - 1 }).phase, "pending");
  assert.equal(stopTransition(requested, { type: "timeout", now: STOP_TIMEOUT_MS }).phase, "timedOut");
  // timedOut 可再次 request；ack 迟到不再把 timedOut 拉回 landed。
  const retried = stopTransition({ phase: "timedOut", at: null }, { type: "request", now: 20_000 });
  assert.equal(retried.phase, "pending");
  assert.equal(stopTransition({ phase: "timedOut", at: null }, { type: "ack", now: 20_000 }).phase, "timedOut");
  // timeout 与 ack 竞态：ack 先落则 timeout 不覆盖 landed。
  assert.equal(stopTransition(requested, { type: "ack", now: 3_000 }).phase, "landed");
});

test("stop timeouts use the documented budgets", () => {
  assert.equal(STOP_TIMEOUT_MS, 10_000);
  assert.equal(STOP_LANDED_GUARD_MS, 500);
});
