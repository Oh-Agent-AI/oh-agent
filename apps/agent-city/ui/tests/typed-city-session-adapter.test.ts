import test from "node:test";
import assert from "node:assert/strict";
import type { TypedSessionCostV1, TypedSessionDetailV1, TypedSessionExcerptsV1,
  TypedSessionResponseV3, TypedSessionResponseV4, TypedSessionRowV3, TypedUsageSummaryV1,
  TypedSessionSourceStatusV1 } from "@agent-vitals/app-sdk";
import {
  assertCitySessionShadowParity,
  assertCitySourceStatusParity,
  assertCityActivityShadowParity,
  assertCityFindingShadowParity,
  assertCitySkillWorkflowShadowParity,
  assertCityModelUsageShadowParity,
  assertCityTimeCoverageShadowParity,
  assertCityUsageSummaryShadowParity,
  promoteCityTypedWindowValues,
  promoteCityTypedWorkflowValues,
  CITY_TYPED_SESSION_FIELDS,
  CITY_TYPED_STABLE_REF_FIELDS,
  readTypedCityStableRefs,
  readTypedCityActivityShadow,
  readTypedCityModelUsageShadow,
  readTypedCitySessionShadow,
  readTypedCityUsageSummaryShadow,
  readTypedCitySessionDetail,
  assertCitySessionDetailShadowParity,
  CITY_TYPED_SESSION_COST_FIELDS,
} from "../src/data/typedCitySessionAdapter.ts";

test("City asset source-status shadow maps generic lifecycle states and requires the legacy snapshot pin", () => {
  const toMs = 1_800_100_000_000;
  const windowDays = 30 as const;
  const typed: TypedSessionSourceStatusV1 = {
    schema: "session-source-status:v1", dataRevision: 7, windowDays,
    window: { fromMs: toMs - windowDays * 86_400_000, toMs },
    sources: [
      { stable_ref: `srp_${"a".repeat(32)}`, state: "active", has_usage_in_window: true },
      { stable_ref: `srp_${"b".repeat(32)}`, state: "active", has_usage_in_window: false },
      { stable_ref: `srp_${"c".repeat(32)}`, state: "deleted", has_usage_in_window: null },
      { stable_ref: `srp_${"d".repeat(32)}`, state: "missing", has_usage_in_window: null },
    ],
  };
  const legacy = ["present", "outside_window", "source_deleted", "orphaned"].map((state, index) => ({
    asset_ref: `ca_${String(index).repeat(32)}`, state,
  }));
  assert.deepEqual(assertCitySourceStatusParity(legacy, typed, { windowDays, toMs,
    fromMs: toMs - windowDays * 86_400_000, dataRevision: 7 }), { compared: 4, mismatches: 0 });
  assert.throws(() => assertCitySourceStatusParity(legacy, typed, { windowDays, toMs,
    fromMs: toMs - windowDays * 86_400_000, dataRevision: 8 }), /revision_changed/);
  assert.equal(assertCitySourceStatusParity([{ ...legacy[0]!, state: "orphaned" }], { ...typed, sources: [typed.sources[0]!] },
    { windowDays, toMs, fromMs: toMs - windowDays * 86_400_000, dataRevision: 7 }).mismatches, 1);
});

function stableRefPage(offset: number, rows: TypedSessionResponseV4["sessions"], total: number,
  revision = 7, toMs = 1_800_100_000_000): TypedSessionResponseV4 {
  return {
    schema: "harness-sessions:v4", dataRevision: revision, harnessId: null, windowDays: 30,
    window: { fromMs: toMs - 30 * 86_400_000, toMs }, fields: [...CITY_TYPED_STABLE_REF_FIELDS],
    pagination: { offset, limit: 500 },
    coverage: { total, returned: rows.length, truncated: total > offset + rows.length },
    sessions: rows,
  };
}

function row(index: number, windowOrder: number, title: string | null = `标题 ${index}`): TypedSessionRowV3 {
  return {
    id: `sr_${index.toString(16).padStart(32, "0")}`,
    harness_id: "codex",
    title,
    title_source: title ? "codex_thread_name" : null,
    window_order: windowOrder,
    window_first_event_at_ms: 1_800_000_000_000 + index * 1_000,
    window_last_event_at_ms: 1_800_000_000_500 + index * 1_000,
    lifetime_first_event_at_ms: 1_799_000_000_000 + index * 1_000,
    lifetime_last_event_at_ms: 1_800_000_000_500 + index * 1_000,
    event_count: 2,
    tokens: { input: 12, output: 8, total: 20, uncached_input: 10, cache_read: 1, cache_write: 1 },
    model_ids: ["openai/gpt-6.1-sol"],
    model_coverage: { unknown_model_usage_events: 0, legacy_usage_events: 0 },
  };
}

function page(offset: number, rows: TypedSessionRowV3[], total: number, revision = 7, toMs = 1_800_100_000_000): TypedSessionResponseV3 {
  return {
    schema: "harness-sessions:v3", dataRevision: revision, harnessId: null, windowDays: 30,
    window: { fromMs: toMs - 30 * 86_400_000, toMs },
    pagination: { offset, limit: 500 },
    coverage: { total, returned: rows.length, truncated: total > offset + rows.length },
    sessions: rows,
  };
}

const detailRef = `sr_${"b".repeat(32)}`;
const detailToMs = 1_800_100_000_000;
const detailPin = { sessionRef: detailRef, windowDays: 30 as const, toMs: detailToMs, dataRevision: 7 };
function typedDetail(revision = detailPin.dataRevision): TypedSessionDetailV1 {
  return {
    schema: "harness-session-detail:v1", dataRevision: revision, windowDays: detailPin.windowDays,
    window: { fromMs: detailToMs - 30 * 86_400_000, toMs: detailToMs }, sessionRef: detailRef,
    costDataset: "session-cost:v1", costAvailable: false,
    session: { id: detailRef, harness: "codex", title: "Test session", title_source: "codex_thread_name",
      first_event_at: new Date(detailToMs - 120_000).toISOString(), last_event_at: new Date(detailToMs - 60_000).toISOString(),
      window_first_event_at: new Date(detailToMs - 120_000).toISOString(), window_last_event_at: new Date(detailToMs - 60_000).toISOString(),
      lifetime_first_event_at: new Date(detailToMs - 300_000).toISOString(), lifetime_last_event_at: new Date(detailToMs - 60_000).toISOString(),
      event_count: 2, tokens: { input: 12, output: 8, total: 20, uncached_input: 10, cache_read: 1, cache_write: 1 },
      model_ids: ["openai/gpt-6.1-sol"], model_coverage: { unknown_model_usage_events: 0, legacy_usage_events: 0 } },
  };
}
function typedExcerpts(revision = detailPin.dataRevision): TypedSessionExcerptsV1 {
  return { schema: "session-excerpts:v1", dataRevision: revision, windowDays: detailPin.windowDays,
    window: { fromMs: detailToMs - 30 * 86_400_000, toMs: detailToMs }, sessionRef: detailRef, excerptScope: "session_lifetime",
    excerpts: [{ role: "user_first", text: "scrubbed first task", provenance: "scrubbed", is_excerpt: true,
      scope: "session_lifetime", excerpt_at: null }], excerptAvailability: { available: true, reason: null } };
}
function typedCost(revision = detailPin.dataRevision): TypedSessionCostV1 {
  return { schema: "session-cost:v1", dataRevision: revision, windowDays: detailPin.windowDays,
    window: { fromMs: detailToMs - 30 * 86_400_000, toMs: detailToMs }, sessionRef: detailRef,
    cost: { status: "unavailable", reason: "multiple_currency_basis_groups", has_unresolved: true, complete: true,
      cost_minor: null, coverage: { priced_tokens: 20, subscription_tokens: 0, unpriced_tokens: 0, legacy_tokens: 0 },
      pricing_versions: ["usd-v1", "eur-v1"], reference_prices: [{ pricing_version: "usd-v1", captured_at_ms: detailToMs - 1000 }],
      pricing_sources: ["official-catalog", "reference-catalog"], breakdown: [
        { currency: "USD", basis: "input_output", amount_minor: 4 },
        { currency: "EUR", basis: "cache_read", amount_minor: 2 },
      ] } };
}

test("typed City adapter reads all bounded pages, pins revision/window and preserves City layout order", async () => {
  const requests: Array<{ offset: number; toMs?: number; dataRevision?: number; fields: readonly string[] }> = [];
  const result = await readTypedCitySessionShadow(async (request) => {
    requests.push(request);
    if (request.offset === 0) return page(0, [row(1, 2), row(2, 1, null)], 2);
    return page(request.offset, [], 2);
  }, 30);

  assert.equal(requests.length, 1, "complete page set stops when coverage is complete");
  assert.deepEqual(requests[0]?.fields, CITY_TYPED_SESSION_FIELDS);
  assert.equal(result.dataRevision, 7);
  assert.deepEqual(result.sessions.map((session) => session.window_order), [1, 2]);
  assert.equal(result.sessions[0]?.title_state, "unavailable");
  assert.equal(result.sessions[0]?.title_source, undefined);
  assert.equal(result.sessions[1]?.title, "标题 1");
  assert.equal(result.sessions[1]?.first_event_at, "2027-01-15T08:00:01Z");
  assert.deepEqual(result.sessions[1]?.tokens, { input: 12, output: 8, total: 20, uncached_input: 10, cache_read: 1, cache_write: 1 });
});

test("typed City adapter continues pages with identical fixed time and data revision", async () => {
  const requests: Array<{ offset: number; toMs?: number; dataRevision?: number }> = [];
  const result = await readTypedCitySessionShadow(async (request) => {
    requests.push(request);
    if (request.offset === 0) return page(0, Array.from({ length: 500 }, (_, i) => row(i + 1, i + 1)), 501);
    return page(500, [row(501, 501)], 501);
  }, 30);
  assert.deepEqual(requests.map(({ offset, toMs, dataRevision }) => ({ offset, toMs, dataRevision })), [
    { offset: 0, toMs: undefined, dataRevision: undefined },
    { offset: 500, toMs: 1_800_100_000_000, dataRevision: 7 },
  ]);
  assert.equal(result.sessions.length, 501);
  assert.equal(result.sessions.at(-1)?.id, row(501, 501).id);
});

test("typed City first page can be pinned to the current City snapshot", async () => {
  const requests: Array<{ offset: number; toMs?: number; dataRevision?: number }> = [];
  const pinned = { toMs: 1_800_100_000_000, dataRevision: 7 };
  await readTypedCitySessionShadow(async request => {
    requests.push(request);
    return page(0, [], 0, pinned.dataRevision, pinned.toMs);
  }, 30, pinned);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.offset, 0);
  assert.equal(requests[0]?.toMs, pinned.toMs);
  assert.equal(requests[0]?.dataRevision, pinned.dataRevision);
});

test("typed City stable refs are read in bounded pages pinned to the City revision", async () => {
  const requests: Array<{ offset: number; toMs?: number; dataRevision?: number; fields: readonly string[] }> = [];
  const pin = { toMs: 1_800_100_000_000, dataRevision: 7 };
  const rows = [
    { id: `sr_${"1".repeat(32)}`, stable_ref: `srp_${"a".repeat(32)}` },
    { id: `sr_${"2".repeat(32)}`, stable_ref: `srp_${"b".repeat(32)}` },
  ];
  const result = await readTypedCityStableRefs(async (request) => {
    requests.push(request);
    return stableRefPage(request.offset, request.offset === 0 ? rows : [], 2);
  }, 30, pin);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.fields, CITY_TYPED_STABLE_REF_FIELDS);
  assert.equal(requests[0]?.toMs, pin.toMs);
  assert.equal(requests[0]?.dataRevision, pin.dataRevision);
  assert.deepEqual([...result.bySessionId], rows.map(({ id, stable_ref }) => [id, stable_ref]));
});

test("typed City stable refs reject duplicate, malformed and changed-snapshot mappings", async () => {
  const pin = { toMs: 1_800_100_000_000, dataRevision: 7 };
  await assert.rejects(() => readTypedCityStableRefs(async () => stableRefPage(0, [
    { id: `sr_${"1".repeat(32)}`, stable_ref: `srp_${"a".repeat(32)}` },
    { id: `sr_${"2".repeat(32)}`, stable_ref: `srp_${"a".repeat(32)}` },
  ], 2), 30, pin), /typed_city_stable_ref_invalid/);
  await assert.rejects(() => readTypedCityStableRefs(async () => stableRefPage(0, [
    { id: `sr_${"1".repeat(32)}`, stable_ref: "native-session-id" },
  ], 1), 30, pin), /typed_city_stable_ref_invalid/);
  await assert.rejects(() => readTypedCityStableRefs(async () => stableRefPage(0, [], 0, 8), 30, pin), /revision_changed/);
});

test("typed City adapter discards pages that changed revision/window or contain duplicate identities", async () => {
  let count = 0;
  await assert.rejects(() => readTypedCitySessionShadow(async (request) => {
    count++;
    return request.offset === 0 ? page(0, Array.from({ length: 500 }, (_, i) => row(i + 1, i + 1)), 501)
      : page(500, [row(501, 501)], 501, 8);
  }, 30), /revision_changed/);

  await assert.rejects(() => readTypedCitySessionShadow(async (request) => {
    return request.offset === 0 ? page(0, Array.from({ length: 500 }, (_, i) => row(i + 1, i + 1)), 501)
      : page(500, [row(500, 500)], 501);
  }, 30), /typed_city_page_duplicate/);
  assert.equal(count, 2);
});

test("typed City session shadow projection matches current city:v3 display semantics", async () => {
  const candidate = await readTypedCitySessionShadow(async () => page(0, [row(1, 1)], 1), 30);
  const legacyRow = {
    id: candidate.sessions[0]!.id,
    harness: "codex",
    title: "标题 1",
    title_source: "codex_thread_name",
    layout_order: 1,
    window_first_event_at: "2027-01-15T08:00:01Z",
    window_last_event_at: "2027-01-15T08:00:01.500Z",
    lifetime_first_event_at: "2027-01-03T18:13:21Z",
    lifetime_last_event_at: "2027-01-15T08:00:01.500Z",
    usage_event_count: 2,
    tokens: { input: 12, output: 8, total: 20, uncached_input: 10, cache_read: 1, cache_write: 1 },
    model_ids: ["openai/gpt-6.1-sol"],
    model_coverage: { unknown_model_usage_events: 0, legacy_usage_events: 0, scope: "window", pricing_independent: true },
  };
  assertCitySessionShadowParity([legacyRow], candidate.sessions);
  assert.throws(() => assertCitySessionShadowParity([{ ...legacyRow, title: "另一个标题" }], candidate.sessions), /typed_city_parity_row_0/);
});

test("detail, lifetime excerpts and cost use separate reads pinned to the same snapshot", async () => {
  const calls: Array<{ dataset: string; sessionRef: string; toMs: number; dataRevision: number; fields?: readonly string[] }> = [];
  const detailData = await readTypedCitySessionDetail({
    detail: async input => { calls.push({ dataset: "detail", ...input }); return typedDetail(); },
    excerpts: async input => { calls.push({ dataset: "excerpts", ...input }); return typedExcerpts(); },
    cost: async input => { calls.push({ dataset: "cost", ...input }); return typedCost(); },
  }, detailPin);
  assert.deepEqual(calls.map(({ dataset, sessionRef, toMs, dataRevision }) => ({ dataset, sessionRef, toMs, dataRevision })), [
    { dataset: "detail", sessionRef: detailRef, toMs: detailToMs, dataRevision: 7 },
    { dataset: "excerpts", sessionRef: detailRef, toMs: detailToMs, dataRevision: 7 },
    { dataset: "cost", sessionRef: detailRef, toMs: detailToMs, dataRevision: 7 },
  ]);
  assert.deepEqual(calls[2]?.fields, CITY_TYPED_SESSION_COST_FIELDS);
  assert.equal(detailData.excerpts.excerptScope, "session_lifetime");
  assert.equal(detailData.excerpts.excerptAvailability.available, true);
  assert.equal(detailData.cost.cost.breakdown?.length, 2);
  assert.equal(detailData.cost.cost.cost_minor, null, "separate currencies/bases must not be collapsed into a total");

  const cityDetail = {
    ...typedDetail().session,
    asset_ref: `ca_${"c".repeat(32)}`,
    layout_order: 4,
    usage_event_count: 2,
    title_state: "available",
    task_excerpts: detailData.excerpts.excerpts,
    excerpt_scope: "session_lifetime",
    excerpt_availability: { state: "ready", reason: null },
    cost: detailData.cost.cost,
  };
  assertCitySessionDetailShadowParity(cityDetail, detailData, {
    windowDays: detailPin.windowDays, toMs: detailPin.toMs, dataRevision: detailPin.dataRevision,
  });
});

test("detail fails closed when its separate excerpt grant is denied", async () => {
  const requested: string[] = [];
  await assert.rejects(() => readTypedCitySessionDetail({
    detail: async input => { requested.push(`detail:${input.sessionRef}`); return typedDetail(); },
    excerpts: async input => { requested.push(`excerpts:${input.sessionRef}`); throw new Error("typed_data_denied"); },
    cost: async input => { requested.push(`cost:${input.sessionRef}`); return typedCost(); },
  }, detailPin), /typed_data_denied/);
  assert.deepEqual(requested.sort(), [`cost:${detailRef}`, `detail:${detailRef}`, `excerpts:${detailRef}`].sort());
});

test("detail rejects raw session-key fields and mismatched revision envelopes", async () => {
  const raw = typedDetail() as unknown as { session: Record<string, unknown> };
  raw.session.session_key = "native-session-key";
  await assert.rejects(() => readTypedCitySessionDetail({
    detail: async () => raw as unknown as TypedSessionDetailV1,
    excerpts: async () => typedExcerpts(),
    cost: async () => typedCost(),
  }, detailPin), /typed_city_detail_shape_invalid/);

  await assert.rejects(() => readTypedCitySessionDetail({
    detail: async () => typedDetail(8),
    excerpts: async () => typedExcerpts(),
    cost: async () => typedCost(),
  }, detailPin), /typed_city_detail_revision_changed/);
});

test("typed City usage summary shadow pins the session window and authority revision", async () => {
  const requests: Array<{ windowDays: number; toMs?: number; dataRevision?: number }> = [];
  const summary: TypedUsageSummaryV1 = {
    schema: "usage-summary:v1", dataRevision: 7, windowDays: 30,
    window: { fromMs: 1_797_508_000_000, toMs: 1_800_100_000_000 },
    summary: { session_count: 1, usage_event_count: 2,
      tokens: { input: 12, output: 8, total: 20, uncached_input: 10, cache_read: 1, cache_write: 1 } },
  };
  const result = await readTypedCityUsageSummaryShadow(async (request) => {
    requests.push(request);
    return summary;
  }, 30, summary.window.toMs, summary.dataRevision);
  assert.deepEqual(requests, [{
    windowDays: 30,
    fields: ["summary.session_count", "summary.usage_event_count", "summary.tokens.input", "summary.tokens.output",
      "summary.tokens.total", "summary.tokens.uncached_input", "summary.tokens.cache_read", "summary.tokens.cache_write"],
    toMs: summary.window.toMs,
    dataRevision: summary.dataRevision,
  }]);
  assertCityUsageSummaryShadowParity({ session_count: 1, usage_event_count: 2,
    tokens: { input: 12, output: 8, total: 20, uncached_input: 10, cache_read: 1, cache_write: 1 } }, result);
  assert.throws(() => assertCityUsageSummaryShadowParity({ session_count: 2 }, result), /typed_city_parity_summary/);
});

test("typed City usage summary shadow rejects a changed window or revision", async () => {
  const summary: TypedUsageSummaryV1 = {
    schema: "usage-summary:v1", dataRevision: 8, windowDays: 30,
    window: { fromMs: 1, toMs: 2 }, summary: {},
  };
  await assert.rejects(() => readTypedCityUsageSummaryShadow(async () => summary, 30, 2, 7), /revision_changed/);
  await assert.rejects(() => readTypedCityUsageSummaryShadow(async () => summary, 30, 3, 8), /revision_changed/);
});

test("typed City activity shadow preserves timezone day buckets and pins revision/window", async () => {
  const activity = {
    schema: "activity-summary:v1" as const, dataRevision: 7, windowDays: 7 as const,
    window: { fromMs: 1_800_000_000_000 - 7 * 86_400_000, toMs: 1_800_000_000_000 },
    timezone: "America/New_York",
    days: [{ date: "2027-01-08", session_count: 2, event_count: 5, tokens: 90 }],
  };
  const requests: Array<{ timezone: string; toMs?: number; dataRevision?: number }> = [];
  const result = await readTypedCityActivityShadow(async request => {
    requests.push(request);
    return activity;
  }, 7, activity.timezone, activity.window.toMs, activity.dataRevision);
  assert.equal(requests[0]?.timezone, activity.timezone);
  assert.equal(requests[0]?.toMs, activity.window.toMs);
  assert.equal(requests[0]?.dataRevision, activity.dataRevision);
  assertCityActivityShadowParity({ timezone: activity.timezone, days: activity.days.map(day => ({ ...day })) }, result);
  assert.throws(() => assertCityActivityShadowParity({ timezone: "UTC", days: activity.days }, result), /typed_city_parity_activity/);
});

test("typed City model usage shadow checks full-window model and coverage parity", async () => {
  const modelUsage = {
    schema: "model-usage:v1" as const, dataRevision: 7, windowDays: 30 as const,
    window: { fromMs: 1_800_000_000_000 - 30 * 86_400_000, toMs: 1_800_000_000_000 },
    models: [{ model_id: "openai/gpt-6.1-sol", usage_event_count: 3, legacy_usage_event_count: 1,
      tokens: { input: 12, output: 8, total: 20, uncached_input: 10, cache_read: 1, cache_write: 1 } }],
    coverage: { unknown_model_usage_events: 2, legacy_usage_events: 1 }, scope: "window" as const, pricingIndependent: true as const,
  };
  const result = await readTypedCityModelUsageShadow(async request => {
    assert.equal(request.toMs, modelUsage.window.toMs);
    assert.equal(request.dataRevision, modelUsage.dataRevision);
    return modelUsage;
  }, 30, modelUsage.window.toMs, modelUsage.dataRevision);
  assertCityModelUsageShadowParity({ model_ids: ["openai/gpt-6.1-sol"], unknown_model_usage_events: 2, legacy_usage_events: 1 }, result);
  assert.throws(() => assertCityModelUsageShadowParity({ model_ids: [], unknown_model_usage_events: 2, legacy_usage_events: 1 }, result), /typed_city_parity_models/);
});

test("typed City time coverage shadow retains its lifetime denominator", () => {
  const typedCoverage = { schema: "time-coverage:v1" as const, dataRevision: 7, coverage: {
    scope: "all_non_deleted_sessions" as const, unknown_time_only: 2, mixed_time: 1, excluded_no_usage: 4,
  } };
  assertCityTimeCoverageShadowParity({ ...typedCoverage.coverage }, typedCoverage);
  assert.throws(() => assertCityTimeCoverageShadowParity({ ...typedCoverage.coverage, excluded_no_usage: 0 }, typedCoverage), /typed_city_parity_time_coverage/);
});

test("typed City findings shadow combines private issue categories and preserves capability states", () => {
  const typedFindings = {
    schema: "finding-summary:v1" as const, dataRevision: 7, windowDays: 30 as const,
    window: { fromMs: 1_800_000_000_000 - 30 * 86_400_000, toMs: 1_800_000_000_000 },
    current_backlog: [{ harness_id: "codex", severity: "warning" as const, count: 3 }],
    window_new: [{ harness_id: "codex", severity: "critical" as const, count: 2 }],
    capabilities: [{ harness_id: "codex", available: true, reason: null },
      { harness_id: "harness:other", available: false, reason: "findings_not_supported" as const }],
  };
  assertCityFindingShadowParity({
    current_backlog: [
      { harness: "codex", severity: "warning", category: "internal-a", count: 1 },
      { harness: "codex", severity: "warning", category: "internal-b", count: 2 },
    ],
    window_new: [{ harness: "codex", severity: "critical", category: "internal-c", count: 2 }],
    capabilities: [
      { id: "codex", findings: { available: true, reason: null } },
      { id: "harness:other", findings: { available: false, reason: "findings_not_supported" } },
    ],
  }, typedFindings);
  assert.throws(() => assertCityFindingShadowParity({ current_backlog: [], window_new: [], capabilities: [] }, typedFindings), /typed_city_parity_findings/);
});

test("typed City skills and workflow shadow compare only redacted aggregate fields", () => {
  const typedSkills = { schema: "skill-usage-summary:v1" as const, dataRevision: 7, windowDays: 30 as const,
    window: { fromMs: 1_800_000_000_000 - 30 * 86_400_000, toMs: 1_800_000_000_000 },
    skills: [{ harness_id: "codex", label: "review", invocations: 4, sessions: 2, last_invoked_at_ms: 1_799_999_000_000,
      finished_events: 3, failed_events: 1, succeeded_events: 2 }], truncated: false,
    coverage: "observed_workflow_events_only" as const, outcomeScope: "unpaired_finish_events" as const, inventoryIncluded: false as const };
  const typedWorkflow = { schema: "workflow-activity-summary:v1" as const, dataRevision: 7, windowDays: 30 as const,
    window: typedSkills.window, events: [{ harness_id: "codex", event_type: "tool_finished", count: 3, sessions: 2,
      last_event_at_ms: 1_799_999_000_000, failed_events: 1 }], truncated: false,
    coverage: "observed_workflow_events_only" as const, outcomeScope: "unpaired_events" as const };
  assertCitySkillWorkflowShadowParity({ data: { skills: [{ harness: "codex", skill: "review", invocations: 4, sessions: 2,
    last_invoked_at_ms: 1_799_999_000_000, finished_events: 3, failed_events: 1, succeeded_events: 2, internal: "drop" }] } },
  { data: { events: [{ harness: "codex", event_type: "tool_finished", events: 3, sessions: 2, last_event_at_ms: 1_799_999_000_000, failed_events: 1 }] } },
  typedSkills, typedWorkflow);
  assert.throws(() => assertCitySkillWorkflowShadowParity({ data: { skills: [] } },
    { data: { events: [] } }, typedSkills, typedWorkflow), /typed_city_parity_skills/);
});

test("default City typed aggregates promote only after same revision and window parity", async () => {
  const toMs = 1_800_100_000_000;
  const fromMs = toMs - 30 * 86_400_000;
  const window = { fromMs, toMs };
  const pin = { schema: "usage-summary:v1" as const, dataRevision: 7, windowDays: 30 as const, window };
  const summary = { ...pin, summary: { session_count: 1, usage_event_count: 2,
    tokens: { input: 12, output: 8, total: 20, uncached_input: 10, cache_read: 1, cache_write: 1 } } };
  const activity = { schema: "activity-summary:v1" as const, dataRevision: 7, windowDays: 30 as const, window,
    timezone: "UTC", days: [{ date: "2027-01-15", session_count: 1, event_count: 2, tokens: 20 }] };
  const models = { schema: "model-usage:v1" as const, dataRevision: 7, windowDays: 30 as const, window,
    models: [{ model_id: "openai/gpt-6.1-sol", usage_event_count: 2, legacy_usage_event_count: 0,
      tokens: { input: 12, output: 8, total: 20, uncached_input: 10, cache_read: 1, cache_write: 1 } }],
    coverage: { unknown_model_usage_events: 0, legacy_usage_events: 0 }, scope: "window" as const, pricingIndependent: true as const };
  const timeCoverage = { schema: "time-coverage:v1" as const, dataRevision: 7, coverage: {
    scope: "all_non_deleted_sessions" as const, unknown_time_only: 2, mixed_time: 1, excluded_no_usage: 4,
  } };
  const findings = { schema: "finding-summary:v1" as const, dataRevision: 7, windowDays: 30 as const, window,
    current_backlog: [{ harness_id: "codex", severity: "warning" as const, count: 3 }],
    window_new: [{ harness_id: "codex", severity: "critical" as const, count: 2 }],
    capabilities: [{ harness_id: "codex", available: true, reason: null }] };
  const legacy = {
    overview: { session_count: 1, usage_event_count: 2, tokens: summary.summary.tokens,
      models: { model_ids: ["openai/gpt-6.1-sol"], unknown_model_usage_events: 0, legacy_usage_events: 0 },
      time_classification: timeCoverage.coverage },
    activity: { timezone: "UTC", days: activity.days },
    findings: { current_backlog: [{ harness: "codex", severity: "warning", count: 3 }],
      window_new: [{ harness: "codex", severity: "critical", count: 2 }],
      capabilities: [{ id: "codex", findings: { available: true, reason: null } }] },
  };
  const requests: unknown[] = [];
  const result = await promoteCityTypedWindowValues({
    readers: {
      summary: async (...args) => { requests.push(["summary", ...args]); return summary; },
      activity: async (...args) => { requests.push(["activity", ...args]); return activity; },
      models: async (...args) => { requests.push(["models", ...args]); return models; },
      timeCoverage: async (...args) => { requests.push(["timeCoverage", ...args]); return timeCoverage; },
      findings: async (...args) => { requests.push(["findings", ...args]); return findings; },
    },
    legacy, windowDays: 30, timezone: "UTC", window, dataRevision: 7,
  });
  const requestByName = Object.fromEntries(requests.map((request) => {
    const [name, ...args] = request as unknown[];
    return [name, args];
  }));
  assert.deepEqual(Object.keys(requestByName).sort(), ["activity", "findings", "models", "summary", "timeCoverage"]);
  assert.deepEqual(requestByName.summary, [30, toMs, 7]);
  assert.deepEqual(requestByName.activity, [30, "UTC", toMs, 7]);
  assert.deepEqual(requestByName.models, [30, toMs, 7]);
  assert.deepEqual(requestByName.findings, [30, toMs, 7]);
  assert.deepEqual(requestByName.timeCoverage, [7]);
  assert.deepEqual(Object.keys(result.statuses).sort(), ["activity", "findings", "models", "summary", "timeCoverage"]);
  assert.ok(Object.values(result.statuses).every((status) => status.status === "matched"));
  assert.deepEqual(result.values.summary, summary.summary);
  assert.equal(result.values.activity?.days[0]?.tokens, 20);
  assert.equal(result.values.models?.models[0]?.model_id, "openai/gpt-6.1-sol");
  assert.deepEqual(result.values.timeCoverage, timeCoverage.coverage);
  assert.equal(result.values.findings?.current_backlog[0]?.count, 3);
});

test("default City typed aggregates fall back independently on denial, mismatch, and stale window", async () => {
  const toMs = 1_800_100_000_000;
  const fromMs = toMs - 30 * 86_400_000;
  const window = { fromMs, toMs };
  const summary = { schema: "usage-summary:v1" as const, dataRevision: 7, windowDays: 30 as const, window,
    summary: { session_count: 1, usage_event_count: 2, tokens: { input: 12, output: 8, total: 20, uncached_input: 10, cache_read: 1, cache_write: 1 } } };
  const activity = { schema: "activity-summary:v1" as const, dataRevision: 7, windowDays: 30 as const, window, timezone: "UTC",
    days: [{ date: "2027-01-15", session_count: 1, event_count: 2, tokens: 20 }] };
  const models = { schema: "model-usage:v1" as const, dataRevision: 7, windowDays: 30 as const, window,
    models: [{ model_id: "model-a" }], coverage: { unknown_model_usage_events: 0, legacy_usage_events: 0 }, scope: "window" as const, pricingIndependent: true as const };
  const timeCoverage = { schema: "time-coverage:v1" as const, dataRevision: 7, coverage: { scope: "all_non_deleted_sessions" as const,
    unknown_time_only: 2, mixed_time: 1, excluded_no_usage: 4 } };
  const findings = { schema: "finding-summary:v1" as const, dataRevision: 7, windowDays: 30 as const, window,
    current_backlog: [{ harness_id: "codex", severity: "warning" as const, count: 3 }], window_new: [],
    capabilities: [{ harness_id: "codex", available: true, reason: null }] };
  const result = await promoteCityTypedWindowValues({
    readers: {
      summary: async () => { throw new Error("typed_data_denied"); },
      activity: async () => ({ ...activity, days: [{ ...activity.days[0]!, tokens: 999 }] }),
      models: async () => models,
      timeCoverage: async () => ({ ...timeCoverage, dataRevision: 8 }),
      findings: async () => ({ ...findings, window: { ...window, toMs: toMs - 1 } }),
    },
    legacy: { overview: { session_count: 1, usage_event_count: 2, tokens: summary.summary.tokens,
      models: { model_ids: ["model-a"], unknown_model_usage_events: 0, legacy_usage_events: 0 },
      time_classification: timeCoverage.coverage },
      activity: { timezone: "UTC", days: activity.days },
      findings: { current_backlog: [{ harness: "codex", severity: "warning", count: 3 }], window_new: [],
        capabilities: [{ id: "codex", findings: { available: true, reason: null } }] } },
    windowDays: 30, timezone: "UTC", window, dataRevision: 7,
  });
  assert.deepEqual(Object.fromEntries(Object.entries(result.statuses).map(([key, status]) => [key, status.status])), {
    summary: "fallback", activity: "fallback", models: "matched", timeCoverage: "fallback", findings: "fallback",
  });
  assert.equal(result.values.summary, undefined);
  assert.equal(result.values.activity, undefined);
  assert.equal(result.values.models?.models[0]?.model_id, "model-a");
  assert.equal(result.values.timeCoverage, undefined);
  assert.equal(result.values.findings, undefined);
});

test("default City typed aggregate promotion does not fall back after abort", async () => {
  const controller = new AbortController();
  const toMs = 1_800_100_000_000;
  const window = { fromMs: toMs - 30 * 86_400_000, toMs };
  const cancelled = async () => { controller.abort(); return { schema: "usage-summary:v1", dataRevision: 7, windowDays: 30,
    window, summary: {} } as never; };
  await assert.rejects(() => promoteCityTypedWindowValues({
    readers: { summary: cancelled, activity: async () => { throw new Error("should-not-promote"); },
      models: async () => { throw new Error("should-not-promote"); }, timeCoverage: async () => { throw new Error("should-not-promote"); },
      findings: async () => { throw new Error("should-not-promote"); } },
    legacy: { overview: {}, activity: {}, findings: {} }, windowDays: 30, timezone: "UTC", window, dataRevision: 7,
    signal: controller.signal,
  }), /city_request_cancelled/);
});

test("default City skills and workflow promotion retains v3 module shape and rejects a changed snapshot", () => {
  const toMs = 1_800_100_000_000;
  const window = { fromMs: toMs - 30 * 86_400_000, toMs };
  const skills = { schema: "skill-usage-summary:v1" as const, dataRevision: 7, windowDays: 30 as const, window,
    skills: [{ harness_id: "codex", label: "review", invocations: 4, sessions: 2, last_invoked_at_ms: 1_799_999_000_000,
      finished_events: 3, failed_events: 1, succeeded_events: 2 }], truncated: false,
    coverage: "observed_workflow_events_only" as const, outcomeScope: "unpaired_finish_events" as const, inventoryIncluded: false as const };
  const workflow = { schema: "workflow-activity-summary:v1" as const, dataRevision: 7, windowDays: 30 as const, window,
    events: [{ harness_id: "codex", event_type: "tool_finished", count: 3, sessions: 2,
      last_event_at_ms: 1_799_999_000_000, failed_events: 1 }], truncated: false,
    coverage: "observed_workflow_events_only" as const, outcomeScope: "unpaired_events" as const };
  const promoted = promoteCityTypedWorkflowValues({
    legacySkills: { state: "ready", supported: true, data: { skills: [{ harness: "codex", skill: "review", invocations: 4,
      sessions: 2, last_invoked_at_ms: 1_799_999_000_000, finished_events: 3, failed_events: 1, succeeded_events: 2 }], inventory_included: false } },
    legacyWorkflow: { state: "ready", supported: true, data: { events: [{ harness: "codex", event_type: "tool_finished", events: 3,
      sessions: 2, last_event_at_ms: 1_799_999_000_000, failed_events: 1 }], outcome_scope: "unpaired_events" } },
    skills, workflow, windowDays: 30, window, dataRevision: 7,
  });
  assert.equal((promoted.skills.skills as Array<Record<string, unknown>>)[0]?.skill, "review");
  assert.equal((promoted.workflow.events as Array<Record<string, unknown>>)[0]?.events, 3);
  assert.equal(promoted.skills.inventory_included, false);
  assert.throws(() => promoteCityTypedWorkflowValues({
    legacySkills: { data: { skills: [] } }, legacyWorkflow: { data: { events: [] } },
    skills: { ...skills, dataRevision: 8 }, workflow, windowDays: 30, window, dataRevision: 7,
  }), /typed_city_parity_window/);
});
