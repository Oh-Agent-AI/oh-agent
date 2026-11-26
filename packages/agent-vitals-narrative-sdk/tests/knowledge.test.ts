import test from "node:test";
import assert from "node:assert/strict";
import {
  checkCausalDependency, KNOWLEDGE_CONTENT_MAX_BYTES_V1, markStaleSummaries, validateCharacterCanonV1,
  validateKnowledgeClaims,
  type CharacterCanonV1, type KnowledgeClaimV1, type NarrativeSummaryV1,
} from "../src/index";

// Knowledge/Belief、因果与摘要降级验收（S-5 第二部分，RFC §4.1/§4.2、V3-04/V3-06/V3-12）：
// - belief ≠ 世界事实；私人事件知识必须可溯源（V3-04）。
// - 新事件必须引用既有因果（§4.2 检查 2）。
// - 过期摘要只降级不覆盖（V3-06：State 优先）。
// - 失败绝不返回空成功（V3-12）；纯函数：输入不可变、输出确定性。

const CANON: CharacterCanonV1 = {
  storyId: "story-romance-1",
  characterId: "npc-mira",
  displayName: "Mira",
  version: 1,
};

// 已提交事件日志（Event Log = 历史凭证，§4.1）。
const COMMITTED = ["evt-night-market-news", "evt-rooftop-talk", "evt-mira-growth"];

const claim = (overrides: Partial<KnowledgeClaimV1> = {}): KnowledgeClaimV1 => ({
  claimId: "k-1",
  characterId: "npc-mira",
  subject: "city:night-market",
  content: "The night market opens this weekend.",
  visibility: "public",
  acquiredAtStoryRevision: 3,
  stale: false,
  ...overrides,
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function assertNoEmptySuccess(...results: unknown[]): void {
  for (const result of results) {
    assert.equal(typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === false, true);
    const diagnostics = (result as { diagnostics?: unknown[] }).diagnostics ?? [];
    assert.equal(diagnostics.length >= 1, true, "V3-12: a failed report must carry at least one diagnostic");
  }
}

test("legal claims pass: public common knowledge needs no source, private knowledge cites committed events", () => {
  const claims = [
    claim(),  // public 常识，无来源，合法。
    claim({
      claimId: "k-2",
      subject: "event:rooftop-talk",
      content: "I heard the player say they hate crowds at the rooftop talk.",
      visibility: "private",
      sourceEventId: "evt-rooftop-talk",
    }),
  ];
  const frozen = deepFreeze(structuredClone(claims)) as KnowledgeClaimV1[];
  const result = validateKnowledgeClaims(frozen, COMMITTED, CANON);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, frozen, "valid claims are returned by the same reference (runtime facts, no freeze)");
    assert.deepEqual(result.diagnostics, []);
  }
});

test("V3-04: a private claim with no sourceEventId is unverifiable (NPC cannot know private events without a source)", () => {
  const result = validateKnowledgeClaims(
    [claim({ claimId: "k-secret", subject: "event:rooftop-talk", content: "I know what was said on the rooftop.", visibility: "private" })],
    COMMITTED,
    CANON,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.diagnostics.map(d => `${d.path}:${d.code}`), ["claims[0].sourceEventId:knowledge_unverifiable"]);
    assert.equal(result.diagnostics[0]!.severity, "error");
    assert.equal(result.diagnostics[0]!.message.includes("V3-04"), true);
  }
});

test("V3-04: actor claims a date happened but the cited event is not committed -> validation rejects", () => {
  // Actor 声称已约会，但 Event Log 中没有对应已提交事件：Story State 不得因此改变，
  // 校验以 knowledge_source_missing 显式拒绝。
  const claimedDate = claim({
    claimId: "k-date",
    subject: "event:date-rooftop-bar",
    content: "We had a date at the rooftop bar last night.",
    visibility: "private",
    sourceEventId: "evt-date-rooftop-bar",
  });
  const missingSource = validateKnowledgeClaims([claimedDate], COMMITTED, CANON);
  assert.equal(missingSource.ok, false);
  if (!missingSource.ok) {
    assert.deepEqual(missingSource.diagnostics.map(d => `${d.path}:${d.code}`), ["claims[0].sourceEventId:knowledge_source_missing"]);
    assert.equal(missingSource.diagnostics[0]!.severity, "error");
  }
});

test("knowledge is scoped per character: claims from another character mismatch the canon", () => {
  const result = validateKnowledgeClaims(
    [claim({ claimId: "k-other", characterId: "npc-jun" })],
    COMMITTED,
    CANON,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.diagnostics.map(d => `${d.path}:${d.code}`), ["claims[0].characterId:knowledge_character_mismatch"]);
  }
});

test("claim shape diagnostics: content byte budget, visibility enum, revision and stale types", () => {
  assert.equal(KNOWLEDGE_CONTENT_MAX_BYTES_V1, 512);
  // 恰好 512 字节：通过；513 字节：超限。
  const exact = validateKnowledgeClaims([claim({ content: "a".repeat(512) })], COMMITTED, CANON);
  assert.equal(exact.ok, true);
  const tooLarge = validateKnowledgeClaims([claim({ content: "你".repeat(171) + "a" })], COMMITTED, CANON);  // 171*3+1 = 514 字节
  assert.equal(tooLarge.ok, false);
  if (!tooLarge.ok) {
    assert.deepEqual(
      tooLarge.diagnostics.filter(d => d.code === "knowledge_claim_content_too_large").map(d => d.path),
      ["claims[0].content"],
    );
  }

  const broken = validateKnowledgeClaims([
    claim({ visibility: "secret" as unknown as "public", acquiredAtStoryRevision: -1, stale: "no" as unknown as boolean }),
    claim({ claimId: "", subject: "", content: "", sourceEventId: "" } as KnowledgeClaimV1),
    42 as unknown as KnowledgeClaimV1,
  ], COMMITTED, CANON);
  assert.equal(broken.ok, false);
  if (!broken.ok) {
    assert.deepEqual(broken.diagnostics.map(d => `${d.path}:${d.code}`), [
      "claims[0].visibility:knowledge_claim_visibility_invalid",
      "claims[0].acquiredAtStoryRevision:knowledge_claim_revision_invalid",
      "claims[0].stale:knowledge_claim_stale_invalid",
      "claims[1].claimId:knowledge_claim_id_invalid",
      "claims[1].subject:knowledge_claim_subject_invalid",
      "claims[1].content:knowledge_claim_content_invalid",
      "claims[1].sourceEventId:knowledge_claim_source_invalid",
      "claims[2]:knowledge_claim_malformed",
    ]);
  }
});

test("a missing visibility field is diagnosed, never silently accepted (V3-12 guard)", () => {
  const noVisibility = { claimId: "k-v", characterId: "npc-mira", subject: "x", content: "y", acquiredAtStoryRevision: 0, stale: false };
  const result = validateKnowledgeClaims([noVisibility as unknown as KnowledgeClaimV1], COMMITTED, CANON);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.diagnostics.map(d => `${d.path}:${d.code}`), ["claims[0].visibility:knowledge_claim_visibility_invalid"]);
  }
});

test("invalid canon or committed event inputs fail loudly instead of masquerading as missing sources", () => {
  const badCanon = validateKnowledgeClaims([claim()], COMMITTED, { ...CANON, version: 0 });
  assert.equal(badCanon.ok, false);
  if (!badCanon.ok) {
    assert.deepEqual(badCanon.diagnostics.map(d => `${d.path}:${d.code}`), ["canon.version:canon_version_invalid"]);
  }

  const badCommitted = validateKnowledgeClaims([claim()], ["evt-1", 42 as unknown as string], CANON);
  assert.equal(badCommitted.ok, false);
  if (!badCommitted.ok) {
    assert.deepEqual(badCommitted.diagnostics.map(d => `${d.path}:${d.code}`), ["committedEventIds:knowledge_committed_events_invalid"]);
  }

  const notArray = validateKnowledgeClaims("nope" as unknown as KnowledgeClaimV1[], COMMITTED, CANON);
  assert.equal(notArray.ok, false);
  if (!notArray.ok) assert.equal(notArray.diagnostics[0]!.code, "knowledge_claims_invalid");
});

test("semantic diagnostics are collected in deterministic input order (V3-12: failures carry diagnostics)", () => {
  const claims = [
    claim({ claimId: "k-a", visibility: "private" }),                                                   // unverifiable
    claim({ claimId: "k-b", sourceEventId: "evt-date-rooftop-bar", visibility: "private" }),             // source missing
    claim({ claimId: "k-c", characterId: "npc-jun" }),                                                   // character mismatch
    claim({ claimId: "k-d", visibility: "private", sourceEventId: "evt-rooftop-talk" }),                 // legal private claim
  ];
  const first = validateKnowledgeClaims(claims, COMMITTED, CANON);
  const second = validateKnowledgeClaims(claims, COMMITTED, CANON);
  assert.deepEqual(first, second);
  assert.equal(first.ok, false);
  if (!first.ok) {
    assert.deepEqual(first.diagnostics.map(d => `${d.path}:${d.code}`), [
      "claims[0].sourceEventId:knowledge_unverifiable",
      "claims[1].sourceEventId:knowledge_source_missing",
      "claims[2].characterId:knowledge_character_mismatch",
    ]);
    assert.equal(first.diagnostics.length >= 1, true);
  }
});

test("checkCausalDependency accepts satisfied dependencies and reports missing ones by index", () => {
  const satisfied = checkCausalDependency(["evt-mira-growth", "evt-rooftop-talk", "evt-mira-growth"], COMMITTED);
  assert.equal(satisfied.ok, true);
  if (satisfied.ok) {
    assert.deepEqual([...satisfied.value], ["evt-mira-growth", "evt-rooftop-talk"], "satisfied list is deduplicated and sorted");
    assert.deepEqual(satisfied.diagnostics, []);
  }

  const missing = checkCausalDependency(["evt-mira-growth", "evt-uncommitted-cause"], COMMITTED);
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.deepEqual(missing.diagnostics.map(d => `${d.path}:${d.code}`), ["newEventDependencies[1]:causal_dependency_missing"]);
    assert.equal(missing.diagnostics[0]!.severity, "error");
    assert.equal(missing.diagnostics[0]!.message.includes("evt-uncommitted-cause"), true);
  }

  const malformed = checkCausalDependency(["evt-rooftop-talk", ""], COMMITTED);
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.diagnostics[0]!.code, "causal_dependency_malformed");

  const badCommitted = checkCausalDependency(["evt-1"], "nope" as unknown as readonly string[]);
  assert.equal(badCommitted.ok, false);
  if (!badCommitted.ok) assert.equal(badCommitted.diagnostics[0]!.code, "causal_committed_events_invalid");

  const badDeps = checkCausalDependency("nope" as unknown as readonly string[], COMMITTED);
  assert.equal(badDeps.ok, false);
  if (!badDeps.ok) assert.equal(badDeps.diagnostics[0]!.code, "causal_dependencies_invalid");

  assertNoEmptySuccess(missing, malformed, badCommitted, badDeps);
});

test("markStaleSummaries downgrades summaries older than the current State revision (V3-06)", () => {
  const summaries = [
    { summaryId: "sum-old", revision: 2, stale: false },   // < 5 → stale
    { summaryId: "sum-current", revision: 5 },             // == 5 → 不 stale
    { summaryId: "sum-future", revision: 6 },              // > 5 → 不 stale（按规则字面）
    { summaryId: "sum-locked", revision: 5, stale: true }, // 已降级的摘要不"复活"
  ];
  const frozen = deepFreeze(structuredClone(summaries)) as NarrativeSummaryV1[];
  const result = markStaleSummaries(frozen, 5);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.map(s => `${s.summaryId}:${s.revision}:${s.stale}`), [
      "sum-old:2:true",
      "sum-current:5:false",
      "sum-future:6:false",
      "sum-locked:5:true",
    ]);
    // 输出是新数组、新对象；输入不被原地修改（State 优先，摘要只降级不覆盖）。
    assert.notEqual(result.value, frozen);
    for (const entry of frozen) assert.equal(Object.isFrozen(entry), true);
    assert.equal((frozen[0] as { stale?: unknown }).stale, false, "input must keep its original stale value");
    assert.equal("stale" in frozen[1]!, false, "input entries must not gain new keys");
  }
});

test("markStaleSummaries rejects malformed summaries and invalid state revisions with diagnostics", () => {
  const badRevision = markStaleSummaries([], -1);
  assert.equal(badRevision.ok, false);
  if (!badRevision.ok) assert.deepEqual(badRevision.diagnostics.map(d => `${d.path}:${d.code}`), ["currentStateRevision:summary_state_revision_invalid"]);
  const fractional = markStaleSummaries([], 1.5);
  assert.equal(fractional.ok, false);
  if (!fractional.ok) assert.equal(fractional.diagnostics[0]!.code, "summary_state_revision_invalid");

  const malformed = markStaleSummaries([
    42 as unknown as NarrativeSummaryV1,
    { summaryId: "", revision: 1 } as NarrativeSummaryV1,
    { summaryId: "sum-x", revision: "3" } as unknown as NarrativeSummaryV1,
  ] as NarrativeSummaryV1[], 3);
  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    assert.deepEqual(malformed.diagnostics.map(d => `${d.path}:${d.code}`), [
      "summaries[0]:summary_malformed",
      "summaries[1].summaryId:summary_id_invalid",
      "summaries[2].revision:summary_revision_invalid",
    ]);
  }

  const notArray = markStaleSummaries("nope" as unknown as NarrativeSummaryV1[], 3);
  assert.equal(notArray.ok, false);
  if (!notArray.ok) assert.equal(notArray.diagnostics[0]!.code, "summaries_invalid");

  assertNoEmptySuccess(badRevision, fractional, malformed, notArray);
});

test("algorithms are pure: deep-frozen inputs produce identical results across runs", () => {
  const claims = deepFreeze(structuredClone([
    claim({ claimId: "k-a", visibility: "private", sourceEventId: "evt-rooftop-talk" }),
  ])) as KnowledgeClaimV1[];
  const canonFrozen = deepFreeze(structuredClone(CANON)) as CharacterCanonV1;
  const claimsResult = validateKnowledgeClaims(claims, deepFreeze([...COMMITTED] as string[]), canonFrozen);
  const claimsAgain = validateKnowledgeClaims(claims, deepFreeze([...COMMITTED] as string[]), canonFrozen);
  assert.deepEqual(claimsResult, claimsAgain);
  assert.equal(claimsResult.ok, true);

  const causal = checkCausalDependency(deepFreeze(["evt-mira-growth"]) as string[], deepFreeze([...COMMITTED] as string[]));
  const causalAgain = checkCausalDependency(deepFreeze(["evt-mira-growth"]) as string[], deepFreeze([...COMMITTED] as string[]));
  assert.deepEqual(causal, causalAgain);
  assert.equal(causal.ok, true);

  const stale = markStaleSummaries(deepFreeze([{ summaryId: "s", revision: 1 }]) as NarrativeSummaryV1[], 2);
  const staleAgain = markStaleSummaries(deepFreeze([{ summaryId: "s", revision: 1 }]) as NarrativeSummaryV1[], 2);
  assert.deepEqual(stale, staleAgain);
  assert.equal(stale.ok, true);
});

test("canon used by validateKnowledgeClaims is validated through the shared canon contract", () => {
  const canonResult = validateCharacterCanonV1({ ...CANON, growthEdges: [{ from: "a", to: "b", requireEvent: "evt-mira-growth" }] }, { knownEventIds: COMMITTED });
  assert.equal(canonResult.ok, true);
  const claims = [claim({ claimId: "k-growth", subject: "self:mood", content: "I feel more trusting lately.", visibility: "private", sourceEventId: "evt-mira-growth" })];
  const result = validateKnowledgeClaims(claims, COMMITTED, canonResult.ok ? canonResult.value : CANON);
  assert.equal(result.ok, true);
});
