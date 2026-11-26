import test from "node:test";
import assert from "node:assert/strict";
// 对照语义权威:直接 import city-sdk 的 runtime.ts 源文件(经 mecha-ts-hook 解析),
// 不复制任何 runtime 语义 —— V2 评估器只与它对照,不替代它。
import { compileRules, createRun, runHeadless } from "../../agent-vitals-city-sdk/src/runtime";
import type { CityGameMountV1, CityLayoutV1, HeadlessTraceStepV1, MiniGamePackV1, PlayerRuleInputV1 } from "@oh-agent/city-sdk";
import { evaluateRuleAstV2, fromLegacyRuleGraphV1 } from "../src/protocol/ruleAstV2";
import type { ConditionV2, GameEffectV2, RuleEvalContextV2, RuleTraceStepV2, RuleV2 } from "../src/protocol/ruleAstV2";

/**
 * ADR-01 spike对照 fixture — 与 assets/creator/templates/checkpoint-race.json
 * 逐字相同(该模板与 flight-checkpoint 除 slot 名外结构一致)。内联嵌死是为了
 * 测试不依赖仓库根目录布局;模板变更时应同步此处并检查映射偏差。
 */
const racePack: MiniGamePackV1 = {
  schemaVersion: 1,
  id: "creator.checkpoint-race",
  rulesVersion: 1,
  slots: { points: { kind: "zone", min: 3, max: 8, requires: ["drive"] } },
  integerParameters: {
    gateTarget: { default: 3, min: 3, max: 8 },
    timeLimitTicks: { default: 2700, min: 60, max: 36000 },
  },
  rules: {
    counters: { next: { initial: 0, max: { parameter: "gateTarget" } } },
    nodes: [
      { id: "start-timer", on: { type: "run.started" }, actions: [{ op: "timer.start", timerId: "timeout", durationTicks: { parameter: "timeLimitTicks" } }] },
      { id: "advance", on: { type: "zone.entered", slot: "points" }, when: [{ op: "counter.eqEventIndex", counter: "next" }], actions: [{ op: "counter.add", counter: "next", amount: 1 }] },
      { id: "finish", on: { type: "zone.entered", slot: "points" }, when: [{ op: "counter.eq", counter: "next", value: { parameter: "gateTarget" } }], actions: [{ op: "run.finish", outcome: "success" }] },
      { id: "timeout", on: { type: "timer.expired", timerId: "timeout" }, actions: [{ op: "run.finish", outcome: "failure" }] },
    ],
  },
};

const layout: CityLayoutV1 = {
  schemaVersion: 1,
  id: "race-fixture",
  coordinateSystem: "city-local-m-v1",
  anchors: [
    { id: "race-spawn", kind: "spawn", capabilities: ["drive"], geometryRef: "g:spawn" },
    { id: "cp-1", kind: "zone", capabilities: ["drive"], geometryRef: "g:1" },
    { id: "cp-2", kind: "zone", capabilities: ["drive"], geometryRef: "g:2" },
    { id: "cp-3", kind: "zone", capabilities: ["drive"], geometryRef: "g:3" },
  ],
  links: [
    { id: "l-0", fromAnchorId: "race-spawn", toAnchorId: "cp-1", capabilities: ["drive"] },
    { id: "l-1", fromAnchorId: "cp-1", toAnchorId: "cp-2", capabilities: ["drive"] },
    { id: "l-2", fromAnchorId: "cp-2", toAnchorId: "cp-3", capabilities: ["drive"] },
  ],
};

const mount: CityGameMountV1 = {
  schemaVersion: 1,
  mountId: "race-mount-1",
  layout: { kind: "city-layout", id: layout.id, version: "1", digest: "fixture" },
  game: { kind: "city-minigame", id: racePack.id, version: "1", digest: "fixture" },
  entryAnchorId: "race-spawn",
  bindings: { points: ["cp-1", "cp-2", "cp-3"] },
  parameterOverrides: { timeLimitTicks: 2400 },
};

/** Same parameter layers, in runtime.ts resolution order (overrides → pack default). */
const evalContext: RuleEvalContextV2 = {
  counters: racePack.rules.counters,
  parameterOverrides: mount.parameterOverrides,
  packParameters: racePack.integerParameters!,
};

// --- 手写 V2 AST:checkpoint-race 四条规则的最小子集表达(ADR-01 样本) ---------

const HANDWRITTEN_RULES: readonly RuleV2[] = [
  {
    schemaVersion: 2,
    id: "start-timer",
    version: "1",
    on: ["run.started"],
    when: { kind: "all", conditions: [] },
    effects: [{ op: "timer.start", timerId: "timeout", durationTicks: { parameter: "timeLimitTicks" } }],
    onFailure: "reject",
  },
  {
    schemaVersion: 2,
    id: "advance",
    version: "1",
    on: ["zone.entered"],
    when: {
      kind: "all",
      conditions: [
        { kind: "eq", left: { source: "event", path: "slot" }, right: { literal: "points" } },
        { kind: "counter.eqEventIndex", counter: "next" },
      ],
    } satisfies ConditionV2,
    effects: [{ op: "inc", counter: "next", amount: 1 } satisfies GameEffectV2],
    onFailure: "reject",
  },
  {
    schemaVersion: 2,
    id: "finish",
    version: "1",
    on: ["zone.entered"],
    when: {
      kind: "all",
      conditions: [
        { kind: "eq", left: { source: "event", path: "slot" }, right: { literal: "points" } },
        { kind: "counter.eq", counter: "next", value: { parameter: "gateTarget" } },
      ],
    } satisfies ConditionV2,
    effects: [{ op: "run.finish", outcome: "success" } satisfies GameEffectV2],
    onFailure: "reject",
  },
  {
    schemaVersion: 2,
    id: "timeout",
    version: "1",
    on: ["timer.expired"],
    when: {
      kind: "all",
      conditions: [
        { kind: "eq", left: { source: "event", path: "timerId" }, right: { literal: "timeout" } },
      ],
    } satisfies ConditionV2,
    effects: [{ op: "run.finish", outcome: "failure" } satisfies GameEffectV2],
    onFailure: "reject",
  },
];

// --- 轨迹:全过 / 超时 / 乱序门 ------------------------------------------------

const zoneInput = (tick: number, index: number): PlayerRuleInputV1 => ({ type: "zone.entered", tick, slot: "points", index });

const traceAllPass: RuleTraceStepV2[] = [
  { tick: 0 },
  { tick: 1, inputs: [zoneInput(1, 0)] },
  { tick: 2, inputs: [zoneInput(2, 1)] },
  { tick: 3, inputs: [zoneInput(3, 2)] },
];

const traceTimeout: RuleTraceStepV2[] = [
  { tick: 0 },
  { tick: 1, inputs: [zoneInput(1, 0)] },
  ...Array.from({ length: 2399 }, (_, offset): RuleTraceStepV2 => ({ tick: offset + 2 })),
];

const traceOutOfOrderGate: RuleTraceStepV2[] = [
  { tick: 0 },
  { tick: 1, inputs: [zoneInput(1, 1)] },
  { tick: 2, inputs: [zoneInput(2, 0)] },
  { tick: 3, inputs: [zoneInput(3, 2)] },
  { tick: 4, inputs: [zoneInput(4, 1)] },
  { tick: 5, inputs: [zoneInput(5, 2)] },
];

const asHeadlessTrace = (trace: RuleTraceStepV2[]): HeadlessTraceStepV1[] => trace.map(step => ({
  tick: step.tick,
  ...(step.inputs ? { inputs: step.inputs } : {}),
}));

const mapRules = (): readonly RuleV2[] => {
  const mapped = fromLegacyRuleGraphV1(racePack.rules);
  assert.equal(mapped.ok, true, mapped.ok ? "" : JSON.stringify(mapped.diagnostics));
  if (!mapped.ok) throw new Error("unreachable");
  return mapped.value;
};

const assertVerdictMatchesRuntime = (trace: RuleTraceStepV2[], label: string): void => {
  const evidence = runHeadless({ layout, game: racePack, mount, seed: 42, trace: asHeadlessTrace(trace) });
  assert.equal(evidence.ok, true, evidence.ok ? "" : JSON.stringify(evidence.diagnostics));
  if (!evidence.ok) return;
  const verdict = evaluateRuleAstV2(mapRules(), trace, evalContext);
  assert.equal(verdict.ok, true, verdict.ok ? "" : JSON.stringify(verdict.diagnostics));
  if (!verdict.ok) return;
  const finalState = evidence.value.finalState;
  assert.equal(verdict.value.outcome, finalState.outcome, `${label}: outcome`);
  assert.deepEqual(verdict.value.counters, finalState.counters, `${label}: counters`);
  assert.equal(verdict.value.tick, finalState.tick, `${label}: tick`);
  assert.deepEqual(verdict.value.hints, finalState.hints, `${label}: hints`);
};

// --- (a) 映射一致性 ------------------------------------------------------------

test("fromLegacyRuleGraphV1 maps the checkpoint-race graph exactly onto the handwritten V2 AST", () => {
  const mapped = mapRules();
  assert.deepEqual(mapped, HANDWRITTEN_RULES);
});

test("the mapped V2 draft is deeply frozen and keeps legacy rule order", () => {
  const mapped = mapRules();
  assert.deepEqual(mapped.map(rule => rule.id), ["start-timer", "advance", "finish", "timeout"]);
  assert.equal(Object.isFrozen(mapped), true);
  const advance = mapped.find(rule => rule.id === "advance");
  if (!advance || advance.when.kind !== "all") throw new Error("unexpected advance mapping");
  assert.equal(Object.isFrozen(advance), true);
  assert.equal(Object.isFrozen(advance.when), true);
  assert.equal(Object.isFrozen(advance.when.conditions), true);
  const advanceRouting = advance.when.conditions[0];
  if (!advanceRouting || advanceRouting.kind !== "eq") throw new Error("unexpected routing condition");
  assert.equal(Object.isFrozen(advanceRouting), true);
  assert.equal(Object.isFrozen(advance.effects), true);
  // 参数引用也是新对象,不是 legacy 输入的别名
  const finish = mapped.find(rule => rule.id === "finish");
  if (!finish || finish.when.kind !== "all") throw new Error("unexpected finish mapping");
  const finishGuard = finish.when.conditions[1];
  if (!finishGuard || finishGuard.kind !== "counter.eq") throw new Error("unexpected finish guard");
  assert.equal(Object.isFrozen(finishGuard.value), true);
  if (typeof finishGuard.value !== "object") throw new Error("finish guard must reference the gateTarget parameter");
  assert.equal(finishGuard.value.parameter, "gateTarget");
});

test("a malformed legacy graph yields diagnostics instead of throwing", () => {
  assert.equal(fromLegacyRuleGraphV1(null).ok, false);
  assert.equal(fromLegacyRuleGraphV1({ counters: {}, nodes: "not-an-array" }).ok, false);
  const missingId = fromLegacyRuleGraphV1({ counters: {}, nodes: [{ on: { type: "run.started" }, actions: [] }] });
  assert.equal(missingId.ok, false);
  if (!missingId.ok) assert.ok(missingId.diagnostics.every(item => item.severity === "error"));
});

// --- (b) headless 对照:同一轨迹,同 outcome/counters/tick ----------------------

test("trace all-pass: V2 evaluator and runtime.ts agree on outcome, counters and tick", () => {
  assertVerdictMatchesRuntime(traceAllPass, "all-pass");
});

test("trace timeout: V2 evaluator and runtime.ts agree on the timer.expired failure", () => {
  assertVerdictMatchesRuntime(traceTimeout, "timeout");
});

test("trace out-of-order gate: skipped wrong-order checkpoints then a legal finish", () => {
  assertVerdictMatchesRuntime(traceOutOfOrderGate, "out-of-order");
});

test("createRun's step-by-step emitted stream matches the V2 evaluator event-for-event", () => {
  const compiled = compileRules(racePack);
  assert.equal(compiled.ok, true, compiled.ok ? "" : JSON.stringify(compiled.diagnostics));
  if (!compiled.ok) return;
  const run = createRun({ rules: compiled.value, mount, seed: 42 });
  const emitted: unknown[] = [];
  for (const step of traceAllPass) {
    const stepped = run.step(step.tick, step.inputs ?? []);
    assert.equal(stepped.ok, true, stepped.ok ? "" : JSON.stringify(stepped.diagnostics));
    if (!stepped.ok) return;
    emitted.push(...stepped.value.emitted);
  }
  const verdict = evaluateRuleAstV2(mapRules(), traceAllPass, evalContext);
  assert.equal(verdict.ok, true);
  if (!verdict.ok) return;
  // run.started + 3× zone.entered,事件派生顺序与 runtime.ts 一致
  assert.deepEqual(verdict.value.emitted, emitted);
  assert.deepEqual(verdict.value.counters, run.snapshot().counters);
  assert.equal(verdict.value.outcome, "success");
});

test("hud.hint truncation and retention mirror runtime.ts for the certified effect", () => {
  // 34 hints across 3 nodes (≤16 actions each) to exercise the 32-hint
  // retention cap. Note: compile-time validation rejects hud.hint text longer
  // than 160 chars, so runtime.ts's slice(0,160) is defense-in-depth for
  // legacy data — worth an ADR-01 note, not worth a divergence here.
  const hintActions = (offset: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({ op: "hud.hint" as const, text: `hint-${offset + i}` }));
  const hintPack = { ...racePack, rules: {
    counters: {},
    nodes: [
      { id: "hints-1", on: { type: "run.started" as const }, actions: hintActions(1, 16) },
      { id: "hints-2", on: { type: "run.started" as const }, actions: hintActions(17, 16) },
      { id: "hints-3", on: { type: "run.started" as const }, actions: hintActions(33, 2) },
    ],
  } };
  const mapped = fromLegacyRuleGraphV1(hintPack.rules);
  assert.equal(mapped.ok, true, mapped.ok ? "" : JSON.stringify(mapped.diagnostics));
  if (!mapped.ok) return;
  const verdict = evaluateRuleAstV2(mapped.value, [{ tick: 0 }], { counters: {} });
  assert.equal(verdict.ok, true);
  if (!verdict.ok) return;
  const compiled = compileRules(hintPack);
  assert.equal(compiled.ok, true, compiled.ok ? "" : JSON.stringify(compiled.diagnostics));
  if (!compiled.ok) return;
  const run = createRun({ rules: compiled.value, mount, seed: 0 });
  assert.equal(run.step(0).ok, true);
  assert.deepEqual(verdict.value.hints, run.snapshot().hints);
  assert.deepEqual(verdict.value.hints, Array.from({ length: 32 }, (_, i) => `hint-${i + 3}`));
});

// --- (c) 不识别 op:诊断非空,不产出假 verdict(V3-12) ---------------------------

const cloneGraph = (): { counters: Record<string, { initial: number; max: number | { parameter: string } }>; nodes: unknown[] } =>
  structuredClone(racePack.rules) as { counters: Record<string, { initial: number; max: number | { parameter: string } }>; nodes: unknown[] };

const assertUnsupportedDiagnostic = (result: ReturnType<typeof fromLegacyRuleGraphV1>, expectedObjectId: string): void => {
  assert.equal(result.ok, false, "unrecognized ops must not produce a mapped ruleset");
  if (result.ok) return;
  assert.ok(result.diagnostics.length > 0, "diagnostics must be non-empty");
  assert.ok(
    result.diagnostics.some(item => item.code === "legacy_rule_operation_unsupported" && item.objectId === expectedObjectId),
    JSON.stringify(result.diagnostics),
  );
};

test("an unrecognized legacy action op is diagnosed and the mapping fails closed", () => {
  const graph = cloneGraph();
  (graph.nodes[0] as { actions: unknown[] }).actions.push({ op: "host.call", method: "readFile" });
  assertUnsupportedDiagnostic(fromLegacyRuleGraphV1(graph), "start-timer");
});

test("an unrecognized legacy guard op is diagnosed and the mapping fails closed", () => {
  const graph = cloneGraph();
  (graph.nodes[1] as { when?: unknown[] }).when?.push({ op: "counter.gte", counter: "next", value: 1 });
  assertUnsupportedDiagnostic(fromLegacyRuleGraphV1(graph), "advance");
});

test("an unrecognized legacy event type is diagnosed and the mapping fails closed", () => {
  const graph = cloneGraph();
  (graph.nodes[1] as { on: { type: string; slot?: string } }).on = { type: "npc.met", slot: "points" };
  assertUnsupportedDiagnostic(fromLegacyRuleGraphV1(graph), "advance");
});

test("whitelist effects outside the certified subset refuse to produce a verdict", () => {
  const withSet: RuleV2[] = [{
    ...HANDWRITTEN_RULES[1]!,
    when: { kind: "all", conditions: [] },
    effects: [{ op: "set", target: "next", value: 1 }],
  }];
  const verdict = evaluateRuleAstV2(withSet, traceAllPass, evalContext);
  assert.equal(verdict.ok, false, "set is whitelisted but not certified — no verdict may be produced");
  if (verdict.ok) return;
  assert.ok(verdict.diagnostics.some(item => item.code === "v2_ast_unsupported_node" && item.message.includes('"set"')));
});

test("City Guard conditions (at-place / has-item) are kept out of the game verdict", () => {
  const withAtPlace: RuleV2[] = [{
    ...HANDWRITTEN_RULES[2]!,
    when: { kind: "at-place", actor: "player", anchor: "cp-1" } satisfies ConditionV2,
  }];
  const verdict = evaluateRuleAstV2(withAtPlace, traceAllPass, evalContext);
  assert.equal(verdict.ok, false);
  if (verdict.ok) return;
  assert.ok(verdict.diagnostics.some(item => item.code === "v2_ast_unsupported_node" && item.message.includes('"at-place"')));

  const withHasItem: RuleV2[] = [{
    ...HANDWRITTEN_RULES[0]!,
    when: { kind: "has-item", item: "race-pass" } satisfies ConditionV2,
  }];
  const refused = evaluateRuleAstV2(withHasItem, traceAllPass, evalContext);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.ok(refused.diagnostics.some(item => item.message.includes('"has-item"')));
});
