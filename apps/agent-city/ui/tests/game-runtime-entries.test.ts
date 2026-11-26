import test from "node:test";
import assert from "node:assert/strict";
import { createMiamiActivityEntries } from "../src/game/runtime/miamiActivityEntries.ts";

function commands(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const activity = (id: string) => ({
    enter: () => { calls.push(`${id}:enter`); },
    exit: () => { calls.push(`${id}:exit`); },
    active: () => calls.includes(`${id}:enter`) && !calls.includes(`${id}:exit`),
    telemetry: () => ({ status: "running" as const, tick: 1, counters: {}, metrics: {}, reason: null }),
    ...(overrides[id] as object ?? {}),
  });
  return { calls, commands: { flight: activity("flight"), driving: activity("driving"), mecha: activity("mecha"), cinema: activity("cinema") } as never };
}

test("entry adapter delegates start, telemetry and one-shot dispose", async () => {
  const { calls, commands: c } = commands();
  const entries = createMiamiActivityEntries(c, { timeoutMs: 50, intervalMs: 1 });
  const entered = await entries.flight();
  assert.equal(entered.ok, true);
  assert.deepEqual(calls, ["flight:enter"]);
  if (!entered.ok) return;
  assert.equal(entered.value.telemetry().tick, 1);
  entered.value.dispose();
  entered.value.dispose();
  assert.deepEqual(calls, ["flight:enter", "flight:exit"]);
});

test("entry adapter rejects an already active activity and async start failure", async () => {
  const { commands: c } = commands({ flight: { active: () => true } });
  const entries = createMiamiActivityEntries(c, { timeoutMs: 50, intervalMs: 1 });
  const active = await entries.flight();
  assert.equal(active.ok, false);
  if (!active.ok) assert.equal(active.failure.code, "activity_already_active");

  const failing = commands({ driving: { enter: async () => { throw new Error("nope"); } } });
  const failed = await createMiamiActivityEntries(failing.commands, { timeoutMs: 50, intervalMs: 1 }).driving();
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.failure.code, "activity_entry_failed");
});

test("entry adapter times out instead of inventing a running activity", async () => {
  const { commands: c } = commands({ mecha: { active: () => false } });
  const entries = createMiamiActivityEntries(c, { timeoutMs: 10, intervalMs: 1 });
  const timedOut = await entries.mecha();
  assert.equal(timedOut.ok, false);
  if (!timedOut.ok) assert.equal(timedOut.failure.code, "activity_entry_timeout");
});
