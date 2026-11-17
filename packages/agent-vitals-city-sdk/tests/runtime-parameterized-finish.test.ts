import test from "node:test";
import assert from "node:assert/strict";
import { compileRules, createRun } from "../src/runtime";
import type { MiniGamePackV1 } from "../src/types";

// 检查点耦合修复（2026-11-17）：完成阈值 gateTarget 参数化——绑定数与阈值一致时
// 在第 gateTarget 个门完成；不一致组合由 validateMount 的绑定数一致性检查拦截。

const anchors = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `cp-${i}`, kind: "zone", capabilities: ["drive"], geometryRef: `g:${i}` }));

function buildPack(gateTarget: number, gateCount: number): MiniGamePackV1 {
  return {
    schemaVersion: 1, id: "checkpoint-race", rulesVersion: 1,
    slots: { points: { kind: "zone", min: 2, max: 8, requires: ["drive"] } },
    integerParameters: { gateTarget: { min: 3, max: 8, default: 3 } },
    rules: {
      counters: { next: { initial: 0, max: { parameter: "gateTarget" } } },
      nodes: [
        { id: "advance", on: { type: "zone.entered", slot: "points" }, when: [{ op: "counter.eqEventIndex", counter: "next" }], actions: [{ op: "counter.add", counter: "next", amount: 1 }] },
        { id: "finish", on: { type: "zone.entered", slot: "points" }, when: [{ op: "counter.eq", counter: "next", value: { parameter: "gateTarget" } }], actions: [{ op: "run.finish", outcome: "success" }] },
      ],
    },
  } as unknown as MiniGamePackV1;
}

function runRace(gateTarget: number, gateCount: number): string[] {
  const pack = buildPack(gateTarget, gateCount);
  const compiled = compileRules(pack);
  if (!compiled.ok) throw new Error(compiled.diagnostics.map(d => d.message).join("; "));
  const bindings = { points: anchors(gateCount).map(a => a.id) };
  const run = createRun({ rules: compiled.value, mount: { bindings, parameterOverrides: { gateTarget } }, seed: 7 });
  const outcomes: string[] = [];
  let tick = 1;
  for (let gateIndex = 0; gateIndex < gateCount; gateIndex += 1) {
    const result = run.step(tick++, [{ type: "zone.entered", tick, slot: "points", index: gateIndex }]);
    if (!result.ok) throw new Error(result.diagnostics.map(d => d.message).join("; "));
    for (const event of result.emitted) if (event.type === "run.finish") outcomes.push(`${event.outcome}@gate${gateIndex}`);
  }
  return outcomes;
}

test("parameterized finish: success exactly at the gateTarget-th gate", () => {
  assert.deepEqual(runRace(3, 3), ["success@gate2"]);
  assert.deepEqual(runRace(5, 5), ["success@gate4"]);
});

test("replay determinism: identical inputs produce identical outcome sequences", () => {
  assert.deepEqual(runRace(5, 5), runRace(5, 5));
});
