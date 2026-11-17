import test from "node:test";
import assert from "node:assert/strict";
import { completionThresholdOverrides, validateMount } from "../src/validate";
import type { CityGameMountV1, CityLayoutV1, MiniGamePackV1 } from "../src/types";

// 检查点耦合修复（2026-11-17）：完成阈值参数化后，绑定 5 个门却让 gateTarget 停在默认 3，
// 会让第 4/5 门永远无效。validateMount 负责在绑定期拦住这种静默截断——
// 显式 override 必须等于绑定数；没有 override 时 pack 默认值必须等于绑定数。
// 这里同时钉住两件事：检查真的会执行（此前的 rules.graph 形状假设让它成了死代码），
// 以及它只对带 run.finish 的守卫生效。

function makeLayout(gates: number): CityLayoutV1 {
  const ids = ["spawn", ...Array.from({ length: gates }, (_, index) => `cp-${index}`)];
  return {
    schemaVersion: 1,
    id: "gate-target-layout",
    coordinateSystem: "city-local-m-v1",
    anchors: ids.map((id, index) => ({
      id,
      kind: index === 0 ? "spawn" : "zone",
      capabilities: ["drive"],
      geometryRef: `g-${index}`,
    })),
    links: ids.slice(1).map((id, index) => ({
      id: `link-${index}`,
      fromAnchorId: ids[index],
      toAnchorId: id,
      capabilities: ["drive"],
    })),
  } as CityLayoutV1;
}

function makePack(): MiniGamePackV1 {
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
        { id: "advance", on: { type: "zone.entered", slot: "points" }, when: [{ op: "counter.eqEventIndex", counter: "next" }], actions: [{ op: "counter.add", counter: "next", amount: 1 }] },
        { id: "finish", on: { type: "zone.entered", slot: "points" }, when: [{ op: "counter.eq", counter: "next", value: { parameter: "gateTarget" } }], actions: [{ op: "run.finish", outcome: "success" }] },
      ],
    },
  };
}

function makeMount(gates: number, parameterOverrides: Record<string, number>): CityGameMountV1 {
  return {
    schemaVersion: 1,
    mountId: "gate-target-mount",
    layout: { kind: "city-layout", id: "gate-target-layout", version: "1", digest: "layout-digest" },
    game: { kind: "city-minigame", id: "creator.checkpoint-race", version: "1", digest: "game-digest" },
    entryAnchorId: "spawn",
    bindings: { points: Array.from({ length: gates }, (_, index) => `cp-${index}`) },
    parameterOverrides,
  };
}

function diagnosticsFor(gates: number, overrides: Record<string, number>) {
  const result = validateMount({ layout: makeLayout(gates), game: makePack(), mount: makeMount(gates, overrides) });
  return result.ok ? [] : result.diagnostics.map(item => item.code);
}

test("a bound count that matches the explicit gateTarget is accepted", () => {
  assert.deepEqual(diagnosticsFor(5, { gateTarget: 5 }), []);
  assert.deepEqual(diagnosticsFor(3, {}), []);
});

test("an explicit gateTarget that differs from the bound count is rejected", () => {
  assert.deepEqual(diagnosticsFor(5, { gateTarget: 3 }), ["parameter_binding_mismatch"]);
  assert.deepEqual(diagnosticsFor(4, { gateTarget: 5 }), ["parameter_binding_mismatch"]);
});

test("a silent default below the bound count is rejected instead of truncating the run", () => {
  // 5 个门、不写 override → gateTarget 用默认 3 → 旧行为是过 3 门就结束。
  assert.deepEqual(diagnosticsFor(5, {}), ["parameter_binding_mismatch"]);
  assert.deepEqual(diagnosticsFor(4, { timeLimitTicks: 2400 }), ["parameter_binding_mismatch"]);
});

test("the check only applies to completion guards", () => {
  const pack = makePack();
  // 去掉 run.finish 后，参数守卫不再是完成阈值——同样的 5 门 / 默认 3 不应再报错。
  const withoutFinish: MiniGamePackV1 = {
    ...pack,
    rules: { ...pack.rules, nodes: pack.rules.nodes.filter(node => node.id !== "finish") },
  };
  const result = validateMount({ layout: makeLayout(5), game: withoutFinish, mount: makeMount(5, {}) });
  assert.equal(result.ok, true);
  assert.deepEqual((result.ok ? [] : result.diagnostics).map(item => item.code), []);
});

test("binding N anchors yields an explicit completion-threshold override", () => {
  assert.deepEqual(
    completionThresholdOverrides(makePack(), { points: ["cp-0", "cp-1", "cp-2", "cp-3", "cp-4"] }),
    { gateTarget: 5 },
  );
  assert.deepEqual(
    completionThresholdOverrides(makePack(), { points: ["cp-0", "cp-1", "cp-2"] }),
    { gateTarget: 3 },
  );
});

test("a pack without completion guards yields no overrides", () => {
  const pack = makePack();
  const withoutFinish: MiniGamePackV1 = {
    ...pack,
    rules: { ...pack.rules, nodes: pack.rules.nodes.filter(node => node.id !== "finish") },
  };
  assert.deepEqual(completionThresholdOverrides(withoutFinish, { points: ["cp-0", "cp-1", "cp-2"] }), {});
});

test("the produced overrides make a 5-gate mount valid", () => {
  const bindings = { points: ["cp-0", "cp-1", "cp-2", "cp-3", "cp-4"] };
  const overrides = completionThresholdOverrides(makePack(), bindings);
  const mount = { ...makeMount(5, {}), bindings, parameterOverrides: overrides };
  const result = validateMount({ layout: makeLayout(5), game: makePack(), mount });
  assert.equal(result.ok, true);
});
