import test from "node:test";
import assert from "node:assert/strict";
import {
  CANON_BACKSTORY_MAX_BYTES_V1, validateCharacterCanonV1,
  type CharacterCanonGrowthEdgeV1, type CharacterCanonV1,
} from "../src/index";

// Character Canon 契约验收（S-5 第二部分，RFC OH_AGENT_CITY_SDK_V3_INTEGRATION §4.1/§2、V3-12）：
// version ≥ 1、id 形状、backstory ≤ 2 KiB、growthEdge 形状/自环/重复/引用存在性（环 + 可选已知事件集）、
// 不可变资产（通过即深度冻结）、失败绝不返回空成功、确定性。

const growthEdge = (from: string, to: string, requireEvent: string): CharacterCanonGrowthEdgeV1 => ({ from, to, requireEvent });

const canon = (overrides: Partial<CharacterCanonV1> = {}): CharacterCanonV1 => ({
  storyId: "story-romance-1",
  characterId: "npc-mira",
  displayName: "Mira",
  version: 1,
  ...overrides,
});

const ACYCLIC = canon({
  backstory: "Bartender at the pier. Values honesty.",
  growthEdges: [growthEdge("wary", "curious", "evt-meet-1"), growthEdge("curious", "trusting", "evt-trust-1")],
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

test("minimal canon passes, returns the same reference, and is deep frozen as an immutable asset", () => {
  const input = canon();
  const result = validateCharacterCanonV1(input);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, input, "validated canon must be returned by the same reference");
    assert.deepEqual(result.diagnostics, []);
    assert.equal(Object.isFrozen(result.value), true);
    // 没有 growthEdges 时轨迹缺省表示性格不可变，无需冻结子结构。
  }
  // 冻结幂等：重复校验同一 canon 安全。
  const again = validateCharacterCanonV1(input);
  assert.equal(again.ok, true);
});

test("full canon with backstory and acyclic growth edges passes and freezes nested structures", () => {
  const result = validateCharacterCanonV1(ACYCLIC);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(Object.isFrozen(result.value.growthEdges), true);
    for (const edge of result.value.growthEdges ?? []) assert.equal(Object.isFrozen(edge), true);
  }
});

test("backstory limit is 2 KiB of UTF-8 bytes, not code points", () => {
  assert.equal(CANON_BACKSTORY_MAX_BYTES_V1, 2048);
  // 恰好 2048 字节：通过。
  const exact = validateCharacterCanonV1(canon({ backstory: "a".repeat(2048) }));
  assert.equal(exact.ok, true);
  // 多字节字符：682 个"你"= 2046 字节，通过；683 个 = 2049 字节，超限。
  const multibyteOk = validateCharacterCanonV1(canon({ backstory: "你".repeat(682) }));
  assert.equal(multibyteOk.ok, true);
  const tooLarge = validateCharacterCanonV1(canon({ backstory: "你".repeat(683) }));
  assert.equal(tooLarge.ok, false);
  if (!tooLarge.ok) {
    assert.deepEqual(
      tooLarge.diagnostics.filter(d => d.code === "canon_backstory_too_large").map(d => d.path),
      ["backstory"],
    );
  }
  assert.equal(validateCharacterCanonV1(canon({ backstory: "b".repeat(2049) })).ok, false);
  assert.equal(validateCharacterCanonV1(canon({ backstory: 42 as unknown as string })).ok, false);
});

test("version must be an integer >= 1 and ids must be non-empty strings", () => {
  for (const badVersion of [0, -1, 1.5, "1", undefined]) {
    const result = validateCharacterCanonV1(canon({ version: badVersion as number }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(
        result.diagnostics.filter(d => d.code === "canon_version_invalid").map(d => d.path),
        ["version"],
      );
    }
  }
  const broken = validateCharacterCanonV1(canon({ storyId: "", characterId: "", displayName: "" }));
  assert.equal(broken.ok, false);
  if (!broken.ok) {
    assert.deepEqual(broken.diagnostics.map(d => `${d.path}:${d.code}`), [
      "storyId:canon_story_id_invalid",
      "characterId:canon_character_id_invalid",
      "displayName:canon_display_name_invalid",
    ]);
  }
});

test("growth edge entries must be well-formed objects with non-empty fields", () => {
  const result = validateCharacterCanonV1(canon({
    growthEdges: [
      42 as unknown as CharacterCanonGrowthEdgeV1,
      { from: "", to: "curious", requireEvent: "evt-1" } as CharacterCanonGrowthEdgeV1,
      { from: "wary", to: "", requireEvent: "evt-1" } as CharacterCanonGrowthEdgeV1,
      { from: "wary", to: "curious", requireEvent: "" } as CharacterCanonGrowthEdgeV1,
    ],
  }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.diagnostics.map(d => `${d.path}:${d.code}`), [
      "growthEdges[0]:canon_growth_edge_malformed",
      "growthEdges[1].from:canon_growth_edge_from_invalid",
      "growthEdges[2].to:canon_growth_edge_to_invalid",
      "growthEdges[3].requireEvent:canon_growth_edge_event_invalid",
    ]);
  }
});

test("self loops and duplicate transitions are rejected; self loops are not double-reported as cycles", () => {
  const selfLoop = validateCharacterCanonV1(canon({ growthEdges: [growthEdge("wary", "wary", "evt-1")] }));
  assert.equal(selfLoop.ok, false);
  if (!selfLoop.ok) {
    assert.deepEqual(selfLoop.diagnostics.map(d => `${d.path}:${d.code}`), ["growthEdges[0]:canon_growth_edge_self_loop"]);
  }

  const duplicate = validateCharacterCanonV1(canon({
    growthEdges: [growthEdge("wary", "curious", "evt-1"), growthEdge("wary", "curious", "evt-2")],
  }));
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) {
    assert.deepEqual(duplicate.diagnostics.map(d => `${d.path}:${d.code}`), ["growthEdges[1]:canon_growth_edge_duplicate"]);
  }
});

test("growth trajectory must be acyclic; cycle states are reported deterministically", () => {
  const cyclic = validateCharacterCanonV1(canon({
    growthEdges: [growthEdge("c", "a", "evt-3"), growthEdge("a", "b", "evt-1"), growthEdge("b", "c", "evt-2")],
  }));
  assert.equal(cyclic.ok, false);
  if (!cyclic.ok) {
    assert.deepEqual(cyclic.diagnostics.map(d => `${d.path}:${d.code}`), ["growthEdges:canon_growth_edge_cycle"]);
    assert.equal(cyclic.diagnostics[0]!.message.includes("a, b, c"), true, "cycle states must be listed in sorted order");
  }
  // 环下游状态同样不可解析，一并报告；无环轨迹通过。
  const downstream = validateCharacterCanonV1(canon({
    growthEdges: [growthEdge("a", "b", "evt-1"), growthEdge("b", "a", "evt-2"), growthEdge("b", "z", "evt-3")],
  }));
  assert.equal(downstream.ok, false);
  if (!downstream.ok) {
    assert.equal(downstream.diagnostics.some(d => d.code === "canon_growth_edge_cycle" && d.message.includes("a, b, z")), true);
  }
});

test("growth edge requireEvent references are checked against the optional known event set", () => {
  const known = new Set(["evt-meet-1", "evt-trust-1"]);
  const ok = validateCharacterCanonV1(ACYCLIC, { knownEventIds: known });
  assert.equal(ok.ok, true);

  const missing = validateCharacterCanonV1(ACYCLIC, { knownEventIds: ["evt-meet-1"] });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.deepEqual(
      missing.diagnostics.filter(d => d.code === "canon_growth_edge_event_missing").map(d => d.path),
      ["growthEdges[1].requireEvent"],
    );
    assert.equal(missing.diagnostics[0]!.message.includes("evt-trust-1"), true);
  }

  // 不提供 context 时不做事件引用校验（引用存在性由宿主按可用证据决定）。
  assert.equal(validateCharacterCanonV1(ACYCLIC).ok, true);

  const badContext = validateCharacterCanonV1(ACYCLIC, { knownEventIds: ["evt-meet-1", 42 as unknown as string] });
  assert.equal(badContext.ok, false);
  if (!badContext.ok) {
    assert.deepEqual(badContext.diagnostics.map(d => `${d.path}:${d.code}`), ["context.knownEventIds:canon_context_events_invalid"]);
  }
  const badShape = validateCharacterCanonV1(ACYCLIC, { knownEventIds: "evt-meet-1" as unknown as readonly string[] });
  assert.equal(badShape.ok, false);
  if (!badShape.ok) assert.equal(badShape.diagnostics[0]!.code, "canon_context_events_invalid");
});

test("malformed containers produce structured failures, never empty successes", () => {
  const malformed = validateCharacterCanonV1(42 as unknown as CharacterCanonV1);
  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    assert.deepEqual(malformed.diagnostics.map(d => `${d.path}:${d.code}`), ["$:canon_malformed"]);
    assert.equal(malformed.diagnostics.length >= 1, true);
  }
  const badEdges = validateCharacterCanonV1(canon({ growthEdges: "nope" as unknown as readonly CharacterCanonGrowthEdgeV1[] }));
  assert.equal(badEdges.ok, false);
  if (!badEdges.ok) assert.equal(badEdges.diagnostics[0]!.code, "canon_growth_edges_invalid");
});

test("failing canon validation never touches the input; passing validation is deterministic", () => {
  const failing = canon({ growthEdges: [growthEdge("a", "b", "evt-1"), growthEdge("b", "a", "evt-2")] });
  const failingResult = validateCharacterCanonV1(failing);
  assert.equal(failingResult.ok, false);
  assert.equal(Object.isFrozen(failing), false, "failing validation must not freeze or mutate the input");

  const passing = deepFreeze(structuredClone(ACYCLIC)) as CharacterCanonV1;
  const first = validateCharacterCanonV1(passing);
  const second = validateCharacterCanonV1(passing);
  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
});
