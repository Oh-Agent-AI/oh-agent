import test from "node:test";
import assert from "node:assert/strict";
import { compileRules, createRun } from "../src/runtime";
import type { MiniGamePackV1 } from "../src/types";

// 检查点耦合修复（2026-11-17）：完成阈值 gateTarget 参数化。
// 旧模板把 finish 的 `counter.eq` 与 counter.max 都硬编码为 3——绑 5 个门时第 3 门就结束，
// 后两个门永远无效（实测为静默截断，不是抛错）。这里钉住「第 gateTarget 门才完成」与
// 「counter 预算跟随 gateTarget」两条语义。

function pack(gateTarget: number): MiniGamePackV1 {
  return {
    schemaVersion: 1,
    id: "creator.checkpoint-race",
    rulesVersion: 1,
    slots: { points: { kind: "zone", min: 3, max: 8, requires: ["drive"] } },
    integerParameters: {
      timeLimitTicks: { min: 60, max: 36000, default: 2700 },
      gateTarget: { min: 3, max: 8, default: 3 },
    },
    rules: {
      counters: { next: { initial: 0, max: { parameter: "gateTarget" } } },
      nodes: [
        { id: "start-timer", on: { type: "run.started" }, actions: [{ op: "timer.start", timerId: "timeout", durationTicks: { parameter: "timeLimitTicks" } }] },
        { id: "advance", on: { type: "zone.entered", slot: "points" }, when: [{ op: "counter.eqEventIndex", counter: "next" }], actions: [{ op: "counter.add", counter: "next", amount: 1 }] },
        { id: "finish", on: { type: "zone.entered", slot: "points" }, when: [{ op: "counter.eq", counter: "next", value: { parameter: "gateTarget" } }], actions: [{ op: "run.finish", outcome: "success" }] },
      ],
    },
  };
}

/** 逐门进入，返回每一次 step 后的 outcome（`null` 表示还没结束）。 */
function runGates(gateTarget: number, gateCount: number): Array<string | null> {
  const compiled = compileRules(pack(gateTarget));
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error("pack must compile");
  const run = createRun({
    rules: compiled.value,
    mount: {
      bindings: { points: Array.from({ length: gateCount }, (_, index) => `cp-${index}`) },
      parameterOverrides: { gateTarget },
    },
    seed: 7,
  });
  const outcomes: Array<string | null> = [];
  for (let gate = 0; gate < gateCount; gate += 1) {
    const result = run.step(gate, [{ type: "zone.entered", tick: gate, slot: "points", index: gate }]);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error(result.diagnostics.map(item => item.message).join("; "));
    outcomes.push(result.value.state.outcome);
  }
  return outcomes;
}

test("parameterized finish: success exactly at the gateTarget-th gate", () => {
  // 3 门 / 阈值 3：第 3 门（index 2）结束，之前都不结束。
  assert.deepEqual(runGates(3, 3), [null, null, "success"]);
  // 5 门 / 阈值 5：第 5 门（index 4）结束——旧模板的 counter.max=3 会在这里越界。
  assert.deepEqual(runGates(5, 5), [null, null, null, null, "success"]);
});

test("a gateTarget beyond the bound gates never finishes", () => {
  assert.deepEqual(runGates(5, 4), [null, null, null, null]);
});

test("replay determinism: identical inputs produce identical outcome sequences", () => {
  assert.deepEqual(runGates(5, 5), runGates(5, 5));
  assert.deepEqual(runGates(4, 4), runGates(4, 4));
});
