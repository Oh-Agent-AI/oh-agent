import assert from "node:assert/strict";
import test from "node:test";
import { createTypedDataClient } from "../src/typed-data.ts";

const base = {
  schema: "harness-sessions:v1", dataRevision: 7, harnessId: "codex", windowDays: 30,
  pagination: { offset: 0, limit: 10 },
  coverage: { total: 2, returned: 1, truncated: true },
  sessions: [{ id: "sr_0123456789abcdef0123456789abcdef", tokens: { total: 42 } }],
};
const request = { harnessId: "codex", windowDays: 30, fields: ["session.id", "session.tokens.total"], limit: 10 };

test("typed client sends a bounded dataset request with host instance identity", async () => {
  let sent;
  const client = createTypedDataClient("instance-city", async value => {
    sent = value;
    return { version: 1, requestId: value.requestId, ok: true, result: structuredClone(base), error: null };
  });
  assert.deepEqual(await client.readSessions(request), base);
  assert.equal(sent.instanceId, "instance-city");
  assert.equal(sent.method, "typed-data.read");
  assert.deepEqual(sent.payload, { dataset: "harness-sessions", version: 1, fields: request.fields,
    query: { harnessId: "codex", windowDays: 30, offset: 0, limit: 10 } });
});

test("typed client rejects invalid requests, uncorrelated replies and extra fields", async () => {
  const client = createTypedDataClient("instance-city", async value => ({
    version: 1, requestId: value.requestId, ok: true, result: structuredClone(base), error: null,
  }));
  await assert.rejects(() => client.readSessions({ ...request, fields: ["session.sql"] }), /typed_data_request_invalid/);
  await assert.rejects(() => client.readSessions({ ...request, limit: 501 }), /typed_data_request_invalid/);
  const badCorrelation = createTypedDataClient("instance-city", async () => ({
    version: 1, requestId: "wrong", ok: true, result: structuredClone(base), error: null,
  }));
  await assert.rejects(() => badCorrelation.readSessions(request), /plugin_response_invalid/);
  const extra = createTypedDataClient("instance-city", async value => ({
    version: 1, requestId: value.requestId, ok: true,
    result: { ...structuredClone(base), sessions: [{ ...base.sessions[0], title: "private" }] }, error: null,
  }));
  await assert.rejects(() => extra.readSessions(request), /typed_data_response_invalid/);
});

test("session source status is bounded, revision-pinned and opaque-ref scoped", async () => {
  const references = ["srp_0123456789abcdef0123456789abcdef"];
  const input = { references, windowDays: 30, fields: ["source.stable_ref", "source.state", "source.has_usage_in_window"], toMs: 1_800_000_000_000, dataRevision: 8 };
  const result = { schema: "session-source-status:v1", dataRevision: 8, windowDays: 30,
    window: { fromMs: 1_797_408_000_000, toMs: input.toMs },
    sources: [{ stable_ref: references[0], state: "active", has_usage_in_window: true }] };
  let sent;
  const client = createTypedDataClient("instance-city", async request => {
    sent = request;
    return { version: 1, requestId: request.requestId, ok: true, result, error: null };
  });
  assert.deepEqual(await client.readSessionSourceStatus(input), result);
  assert.deepEqual(sent.payload, { dataset: "session-source-status", version: 1, fields: input.fields,
    query: { windowDays: 30, toMs: input.toMs, dataRevision: 8, references } });
  await assert.rejects(() => client.readSessionSourceStatus({ ...input, references: ["private-session-key"] }), /typed_data_request_invalid/);
  await assert.rejects(() => client.readSessionSourceStatus({ ...input, fields: ["source.state"] }), /typed_data_request_invalid/);
  const leak = createTypedDataClient("instance-city", async request => ({ version: 1, requestId: request.requestId, ok: true,
    result: { ...result, sources: [{ ...result.sources[0], private_session_key: "native-id" }] }, error: null }));
  await assert.rejects(() => leak.readSessionSourceStatus(input), /typed_data_response_invalid/);
});

test("typed client continues a v2 page with the pinned time window and revision", async () => {
  let sent;
  const page = {
    schema: "harness-sessions:v2", dataRevision: 7, harnessId: "codex", windowDays: 30,
    window: { fromMs: 1_700_000_000_000, toMs: 1_702_592_000_000 },
    pagination: { offset: 500, limit: 500 },
    coverage: { total: 620, returned: 120, truncated: false },
    sessions: Array.from({ length: 120 }, (_, index) => ({ id: `sr_${String(index).padStart(32, "0")}` })),
  };
  const client = createTypedDataClient("instance-city", async value => {
    sent = value;
    return { version: 1, requestId: value.requestId, ok: true, result: structuredClone(page), error: null };
  });
  const pageRequest = { ...request, fields: ["session.id"], offset: 500, limit: 500,
    toMs: page.window.toMs, dataRevision: page.dataRevision };
  const result = await client.readSessionsPage(pageRequest);
  assert.equal(result.sessions.length, 120);
  assert.deepEqual(sent.payload, { dataset: "harness-sessions", version: 2, fields: pageRequest.fields,
    query: { harnessId: "codex", windowDays: 30, offset: 500, limit: 500,
      toMs: page.window.toMs, dataRevision: page.dataRevision } });
  await assert.rejects(() => client.readSessionsPage({ ...request, offset: 3_501, limit: 500 }), /typed_data_request_invalid/);
  await assert.rejects(() => client.readSessionsPage({ ...request, offset: 500, limit: 100 }), /typed_data_request_invalid/);
  const invalid = createTypedDataClient("instance-city", async value => ({
    version: 1, requestId: value.requestId, ok: true,
    result: { ...structuredClone(page), window: { ...page.window, toMs: -1 } }, error: null,
  }));
  await assert.rejects(() => invalid.readSessionsPage({ ...pageRequest, toMs: page.window.toMs, dataRevision: 7 }), /typed_data_response_invalid/);
});

test("typed client reads generic v3 session layout pages with explicit approved fields", async () => {
  let sent;
  const page = {
    schema: "harness-sessions:v3", dataRevision: 11, harnessId: null, windowDays: 30,
    window: { fromMs: 1_700_000_000_000, toMs: 1_702_592_000_000 },
    pagination: { offset: 0, limit: 100 },
    coverage: { total: 1, returned: 1, truncated: false },
    sessions: [{ id: "sr_0123456789abcdef0123456789abcdef", harness_id: "codex", title: "😀".repeat(200),
      title_source: "codex_thread_name", window_first_event_at_ms: 1_701_000_000_000,
      window_last_event_at_ms: 1_701_100_000_000, window_order: 1, event_count: 2,
      tokens: { input: 12, total: 20 }, model_ids: ["gpt-5.6-sol"],
      model_coverage: { unknown_model_usage_events: 0, legacy_usage_events: 0 } }],
  };
  const client = createTypedDataClient("instance-city", async value => {
    sent = value;
    return { version: 1, requestId: value.requestId, ok: true, result: structuredClone(page), error: null };
  });
  const input = { windowDays: 30, fields: ["session.id", "session.harness_id", "session.title", "session.title_source",
    "session.window_first_event_at_ms", "session.window_last_event_at_ms", "session.window_order", "session.event_count", "session.tokens.input",
    "session.tokens.total", "session.model_ids", "session.model_coverage"] };
  const result = await client.readSessionsLayoutPage(input);
  assert.equal(Array.from(result.sessions[0].title).length, 200);
  assert.equal(result.sessions[0].window_order, 1);
  assert.deepEqual(sent.payload, { dataset: "harness-sessions", version: 3, fields: input.fields,
    query: { windowDays: 30, offset: 0, limit: 100, toMs: null, dataRevision: null } });
  const invalid = createTypedDataClient("instance-city", async value => ({
    version: 1, requestId: value.requestId, ok: true,
    result: { ...structuredClone(page), sessions: [{ ...page.sessions[0], title_source: "unknown" }] }, error: null,
  }));
  await assert.rejects(() => invalid.readSessionsLayoutPage(input), /typed_data_response_invalid/);
  const noTitle = createTypedDataClient("instance-city", async value => ({
    version: 1, requestId: value.requestId, ok: true,
    result: { ...structuredClone(page), sessions: [{ ...page.sessions[0], title: null, title_source: null }] }, error: null,
  }));
  assert.equal((await noTitle.readSessionsLayoutPage(input)).sessions[0].title, null);
});

test("typed client reads v4 stable source refs only when explicitly requested", async () => {
  let sent;
  const page = {
    schema: "harness-sessions:v4", dataRevision: 12, harnessId: null, windowDays: 30,
    window: { fromMs: 1_700_000_000_000, toMs: 1_702_592_000_000 },
    pagination: { offset: 0, limit: 100 }, coverage: { total: 1, returned: 1, truncated: false },
    sessions: [{ id: "sr_0123456789abcdef0123456789abcdef", stable_ref: "srp_0123456789abcdef0123456789abcdef" }],
  };
  const client = createTypedDataClient("instance-city", async value => {
    sent = value;
    return { version: 1, requestId: value.requestId, ok: true, result: structuredClone(page), error: null };
  });
  const input = { windowDays: 30, fields: ["session.id", "session.stable_ref"] };
  const result = await client.readSessionsLayoutPageV4(input);
  assert.equal(result.sessions[0].stable_ref, page.sessions[0].stable_ref);
  assert.deepEqual(sent.payload, { dataset: "harness-sessions", version: 4, fields: input.fields,
    query: { windowDays: 30, offset: 0, limit: 100, toMs: null, dataRevision: null } });

  const noRef = createTypedDataClient("instance-city", async value => ({
    version: 1, requestId: value.requestId, ok: true,
    result: { ...structuredClone(page), sessions: [{ id: page.sessions[0].id }] }, error: null,
  }));
  assert.equal((await noRef.readSessionsLayoutPageV4({ windowDays: 30, fields: ["session.id"] })).sessions[0].stable_ref, undefined);

  const malformed = createTypedDataClient("instance-city", async value => ({
    version: 1, requestId: value.requestId, ok: true,
    result: { ...structuredClone(page), sessions: [{ ...page.sessions[0], stable_ref: "native-session-id" }] }, error: null,
  }));
  await assert.rejects(() => malformed.readSessionsLayoutPageV4(input), /typed_data_response_invalid/);
  await assert.rejects(() => client.readSessionsLayoutPageV4({ windowDays: 30, fields: ["session.id", "session.stable_ref", "session.stable_ref"] }), /typed_data_request_invalid/);
});

test("typed client reads a pinned, application-neutral usage summary", async () => {
  let sent;
  const summary = {
    schema: "usage-summary:v1", dataRevision: 19, windowDays: 30,
    window: { fromMs: 1_700_000_000_000, toMs: 1_702_592_000_000 },
    summary: { session_count: 12, usage_event_count: 45, tokens: { total: 90 } },
  };
  const client = createTypedDataClient("instance-city", async value => {
    sent = value;
    return { version: 1, requestId: value.requestId, ok: true, result: structuredClone(summary), error: null };
  });
  const input = { windowDays: 30, fields: ["summary.session_count", "summary.usage_event_count", "summary.tokens.total"] };
  assert.deepEqual(await client.readUsageSummary(input), summary);
  assert.deepEqual(sent.payload, { dataset: "usage-summary", version: 1, fields: input.fields,
    query: { windowDays: 30, toMs: null, dataRevision: null } });
  assert.deepEqual(await client.readUsageSummary({ ...input, toMs: summary.window.toMs, dataRevision: summary.dataRevision }), summary);
  await assert.rejects(() => client.readUsageSummary({ ...input, toMs: summary.window.toMs }), /typed_data_request_invalid/);
  await assert.rejects(() => client.readUsageSummary({ ...input, fields: ["summary.raw_sql"] }), /typed_data_request_invalid/);
  const extra = createTypedDataClient("instance-city", async value => ({
    version: 1, requestId: value.requestId, ok: true,
    result: { ...structuredClone(summary), summary: { ...summary.summary, harness_id: "codex" } }, error: null,
  }));
  await assert.rejects(() => extra.readUsageSummary(input), /typed_data_response_invalid/);
});

test("typed client reads bounded timezone-aware daily activity buckets", async () => {
  let sent;
  const activity = {
    schema: "activity-summary:v1", dataRevision: 23, windowDays: 7,
    window: { fromMs: 1_700_000_000_000, toMs: 1_700_604_800_000 },
    timezone: "America/New_York", days: [{ date: "2026-03-08", session_count: 2, event_count: 5, tokens: 90 }],
  };
  const client = createTypedDataClient("instance-city", async value => {
    sent = value;
    return { version: 1, requestId: value.requestId, ok: true, result: structuredClone(activity), error: null };
  });
  const input = { windowDays: 7, timezone: "America/New_York", fields: [
    "activity.date", "activity.session_count", "activity.event_count", "activity.tokens",
  ] };
  assert.deepEqual(await client.readActivitySummary(input), activity);
  assert.deepEqual(sent.payload, { dataset: "activity-summary", version: 1, fields: input.fields,
    query: { windowDays: 7, timezone: input.timezone, toMs: null, dataRevision: null } });
  await assert.rejects(() => client.readActivitySummary({ ...input, toMs: activity.window.toMs }), /typed_data_request_invalid/);
  await assert.rejects(() => client.readActivitySummary({ ...input, timezone: "x".repeat(129) }), /typed_data_request_invalid/);
  const badDate = createTypedDataClient("instance-city", async value => ({
    version: 1, requestId: value.requestId, ok: true,
    result: { ...structuredClone(activity), days: [{ ...activity.days[0], date: "2026-99-99" }] }, error: null,
  }));
  await assert.rejects(() => badDate.readActivitySummary(input), /typed_data_response_invalid/);
});

test("typed client reads full-window model usage without mixing pricing into model totals", async () => {
  let sent;
  const usage = {
    schema: "model-usage:v1", dataRevision: 24, windowDays: 30,
    window: { fromMs: 1_700_000_000_000, toMs: 1_702_592_000_000 },
    models: [{ model_id: null, usage_event_count: 2, legacy_usage_event_count: 1,
      tokens: { input: 10, output: 5, total: 15, uncached_input: 8, cache_read: 1, cache_write: 1 } }],
    coverage: { unknown_model_usage_events: 2, legacy_usage_events: 1 }, scope: "window", pricingIndependent: true,
  };
  const client = createTypedDataClient("instance-city", async value => {
    sent = value;
    return { version: 1, requestId: value.requestId, ok: true, result: structuredClone(usage), error: null };
  });
  const input = { windowDays: 30, fields: ["model.model_id", "model.usage_event_count", "model.legacy_usage_event_count",
    "model.tokens.input", "model.tokens.output", "model.tokens.total", "model.tokens.uncached_input", "model.tokens.cache_read",
    "model.tokens.cache_write", "coverage.unknown_model_usage_events", "coverage.legacy_usage_events", "scope", "pricing_independent"] };
  assert.deepEqual(await client.readModelUsage(input), usage);
  assert.deepEqual(sent.payload, { dataset: "model-usage", version: 1, fields: input.fields,
    query: { windowDays: 30, toMs: null, dataRevision: null } });
  await assert.rejects(() => client.readModelUsage({ ...input, fields: ["model.raw_sql"] }), /typed_data_request_invalid/);
  const withPrice = createTypedDataClient("instance-city", async value => ({
    version: 1, requestId: value.requestId, ok: true,
    result: { ...structuredClone(usage), price: 1.2 }, error: null,
  }));
  await assert.rejects(() => withPrice.readModelUsage(input), /typed_data_response_invalid/);
});

test("typed client preserves lifetime time-coverage denominator semantics", async () => {
  let sent;
  const coverage = { schema: "time-coverage:v1", dataRevision: 25, coverage: {
    scope: "all_non_deleted_sessions", unknown_time_only: 3, mixed_time: 1, excluded_no_usage: 2,
  } };
  const client = createTypedDataClient("instance-city", async value => {
    sent = value;
    return { version: 1, requestId: value.requestId, ok: true, result: structuredClone(coverage), error: null };
  });
  const input = { fields: ["coverage.scope", "coverage.unknown_time_only", "coverage.mixed_time", "coverage.excluded_no_usage"] };
  assert.deepEqual(await client.readTimeCoverage(input), coverage);
  assert.deepEqual(sent.payload, { dataset: "time-coverage", version: 1, fields: input.fields, query: { dataRevision: null } });
  await assert.rejects(() => client.readTimeCoverage({ ...input, fields: ["coverage.native_ids"] }), /typed_data_request_invalid/);
});

test("typed client preserves finding denominators and capability availability without issue detail", async () => {
  let sent;
  const findings = {
    schema: "finding-summary:v1", dataRevision: 26, windowDays: 30,
    window: { fromMs: 1_700_000_000_000, toMs: 1_702_592_000_000 },
    current_backlog: [{ harness_id: "codex", severity: "warning", count: 1 }],
    window_new: [{ harness_id: "codex", severity: "critical", count: 1 }],
    capabilities: [{ harness_id: "codex", available: true, reason: null },
      { harness_id: "harness:other", available: false, reason: "findings_not_supported" }],
  };
  const client = createTypedDataClient("instance-city", async value => {
    sent = value;
    return { version: 1, requestId: value.requestId, ok: true, result: structuredClone(findings), error: null };
  });
  const input = { windowDays: 30, fields: ["findings.current_backlog.harness_id", "findings.current_backlog.severity", "findings.current_backlog.count",
    "findings.window_new.harness_id", "findings.window_new.severity", "findings.window_new.count",
    "capabilities.harness_id", "capabilities.available", "capabilities.reason"] };
  assert.deepEqual(await client.readFindingSummary(input), findings);
  assert.deepEqual(sent.payload, { dataset: "finding-summary", version: 1, fields: input.fields,
    query: { windowDays: 30, toMs: null, dataRevision: null } });
  const leaking = createTypedDataClient("instance-city", async value => ({
    version: 1, requestId: value.requestId, ok: true,
    result: { ...structuredClone(findings), current_backlog: [{ ...findings.current_backlog[0], issue_id: "private" }] }, error: null,
  }));
  await assert.rejects(() => leaking.readFindingSummary(input), /typed_data_response_invalid/);
});

test("typed client reads bounded skill observations without exposing inventory semantics", async () => {
  let sent;
  const data = { schema: "skill-usage-summary:v1", dataRevision: 27, windowDays: 30,
    window: { fromMs: 1_700_000_000_000, toMs: 1_702_592_000_000 },
    skills: [{ harness_id: "codex", label: "code-review", invocations: 2, sessions: 1, last_invoked_at_ms: 1_702_500_000_000,
      finished_events: 1, failed_events: 0, succeeded_events: 1 }], truncated: false,
    coverage: "observed_workflow_events_only", outcomeScope: "unpaired_finish_events", inventoryIncluded: false };
  const client = createTypedDataClient("instance-city", async value => { sent = value; return { version: 1, requestId: value.requestId, ok: true, result: structuredClone(data), error: null }; });
  const fields = ["skill.harness_id", "skill.label", "skill.invocations", "skill.sessions", "skill.last_invoked_at_ms", "skill.finished_events", "skill.failed_events", "skill.succeeded_events"];
  assert.deepEqual(await client.readSkillUsage({ windowDays: 30, fields }), data);
  assert.equal(sent.payload.dataset, "skill-usage-summary");
  const bad = createTypedDataClient("instance-city", async value => ({ version: 1, requestId: value.requestId, ok: true,
    result: { ...structuredClone(data), skills: [{ ...data.skills[0], raw_capability_id: "/private/path" }] }, error: null }));
  await assert.rejects(() => bad.readSkillUsage({ windowDays: 30, fields }), /typed_data_response_invalid/);
});

test("typed client reads fixed workflow event families with unpaired outcome scope", async () => {
  let sent;
  const data = { schema: "workflow-activity-summary:v1", dataRevision: 28, windowDays: 7,
    window: { fromMs: 1_700_000_000_000, toMs: 1_700_604_800_000 },
    events: [{ harness_id: "codex", event_type: "tool_finished", count: 3, sessions: 2, last_event_at_ms: 1_700_500_000_000, failed_events: 1 }],
    truncated: false, coverage: "observed_workflow_events_only", outcomeScope: "unpaired_events" };
  const client = createTypedDataClient("instance-city", async value => { sent = value; return { version: 1, requestId: value.requestId, ok: true, result: structuredClone(data), error: null }; });
  const fields = ["event.harness_id", "event.event_type", "event.count", "event.sessions", "event.last_event_at_ms", "event.failed_events"];
  assert.deepEqual(await client.readWorkflowActivity({ windowDays: 7, fields }), data);
  assert.equal(sent.payload.dataset, "workflow-activity-summary");
  const bad = createTypedDataClient("instance-city", async value => ({ version: 1, requestId: value.requestId, ok: true,
    result: { ...structuredClone(data), events: [{ ...data.events[0], event_type: "unknown_private_event" }] }, error: null }));
  await assert.rejects(() => bad.readWorkflowActivity({ windowDays: 7, fields }), /typed_data_response_invalid/);
});

test("typed session detail uses scoped reference and fixed revision without returning excerpts or cost", async () => {
  let sent;
  const sessionRef = "sr_0123456789abcdef0123456789abcdef";
  const toMs = 1_800_000_000_000;
  const detail = { schema: "harness-session-detail:v1", dataRevision: 30, windowDays: 30,
    window: { fromMs: toMs - 30 * 86_400_000, toMs }, sessionRef,
    costDataset: "session-cost:v1", costAvailable: false,
    session: { id: sessionRef, harness: "codex", title: "Safe title", title_source: "codex_thread_name",
      first_event_at: "2026-01-01T00:00:00Z", last_event_at: "2026-01-01T00:00:01Z",
      window_first_event_at: "2026-01-01T00:00:00Z", window_last_event_at: "2026-01-01T00:00:01Z",
      lifetime_first_event_at: "2025-12-01T00:00:00Z", lifetime_last_event_at: "2026-01-01T00:00:01Z",
      event_count: 2,
      tokens: { input: 10, output: 5, total: 15, uncached_input: 8, cache_read: 1, cache_write: 1 },
      model_ids: ["openai/gpt-6.1-sol"], model_coverage: { unknown_model_usage_events: 0, legacy_usage_events: 0 } } };
  const client = createTypedDataClient("city-instance", async request => {
    sent = request;
    return { version: 1, requestId: request.requestId, ok: true, result: structuredClone(detail), error: null };
  });
  assert.deepEqual(await client.readSessionDetail({ sessionRef, windowDays: 30, toMs, dataRevision: 30 }), detail);
  assert.equal(sent.payload.dataset, "harness-session-detail");
  assert.equal(sent.payload.query.sessionRef, sessionRef);
  assert.equal(sent.payload.query.dataRevision, 30);
  assert.equal(sent.payload.includeExcerpts, undefined, "excerpt authorization remains separate");
  const leaked = createTypedDataClient("city-instance", async request => ({ version: 1, requestId: request.requestId, ok: true,
    result: { ...structuredClone(detail), session: { ...detail.session, session_key: "private" } }, error: null }));
  await assert.rejects(() => leaked.readSessionDetail({ sessionRef, windowDays: 30, toMs, dataRevision: 30 }), /typed_data_response_invalid/);
  const wrongWindow = createTypedDataClient("city-instance", async request => ({ version: 1, requestId: request.requestId, ok: true,
    result: { ...structuredClone(detail), window: { ...detail.window, toMs: toMs - 1 } }, error: null }));
  await assert.rejects(() => wrongWindow.readSessionDetail({ sessionRef, windowDays: 30, toMs, dataRevision: 30 }), /typed_data_response_invalid/);
});

test("typed session excerpts require their own dataset and lifetime-scope contract", async () => {
  let sent;
  const sessionRef = "sr_0123456789abcdef0123456789abcdef";
  const toMs = 1_800_000_000_000;
  const excerpts = { schema: "session-excerpts:v1", dataRevision: 30, windowDays: 30,
    window: { fromMs: toMs - 30 * 86_400_000, toMs }, sessionRef, excerptScope: "session_lifetime",
    excerpts: [{ role: "user_first", text: "Review this project", provenance: "scrubbed", is_excerpt: true,
      scope: "session_lifetime", excerpt_at: null }], excerptAvailability: { available: true, reason: null } };
  const client = createTypedDataClient("city-instance", async request => { sent = request; return { version: 1, requestId: request.requestId, ok: true, result: structuredClone(excerpts), error: null }; });
  assert.deepEqual(await client.readSessionExcerpts({ sessionRef, windowDays: 30, toMs, dataRevision: 30 }), excerpts);
  assert.equal(sent.payload.dataset, "session-excerpts");
  assert.equal(sent.payload.query.sessionRef, sessionRef);
  const leaking = createTypedDataClient("city-instance", async request => ({ version: 1, requestId: request.requestId, ok: true,
    result: { ...structuredClone(excerpts), excerpts: [{ ...excerpts.excerpts[0], native_event_id: "private" }] }, error: null }));
  await assert.rejects(() => leaking.readSessionExcerpts({ sessionRef, windowDays: 30, toMs, dataRevision: 30 }), /typed_data_response_invalid/);
});

test("typed session cost preserves currency and basis breakdowns with honest coverage", async () => {
  let sent;
  const sessionRef = "sr_0123456789abcdef0123456789abcdef";
  const fields = ["cost.status", "cost.reason", "cost.has_unresolved", "cost.complete", "cost.cost_minor", "cost.coverage",
    "cost.pricing_versions", "cost.reference_prices", "cost.pricing_sources", "cost.breakdown"];
  const cost = { schema: "session-cost:v1", dataRevision: 30, windowDays: 30,
    window: { fromMs: 1_797_408_000_000, toMs: 1_800_000_000_000 }, sessionRef,
    cost: { status: "estimated", reason: "mixed-currency-and-basis", has_unresolved: true, complete: false, cost_minor: null,
      coverage: { priced_tokens: 70, subscription_tokens: 0, unpriced_tokens: 30, legacy_tokens: 0 }, pricing_versions: ["2026-11"],
      reference_prices: [{ pricing_version: "2026-11", captured_at_ms: 1_799_000_000_000 }],
      pricing_sources: ["official-card", "current-card-reference"],
      breakdown: [{ amount_minor: 120, currency: "USD", basis: "metered_estimate" },
        { amount_minor: 80, currency: "CNY", basis: "official" }, { amount_minor: 40, currency: "USD", basis: "subscription" }] } };
  const client = createTypedDataClient("city-instance", async request => {
    sent = request;
    return { version: 1, requestId: request.requestId, ok: true, result: structuredClone(cost), error: null };
  });
  const input = { sessionRef, windowDays: 30, fields, toMs: cost.window.toMs, dataRevision: 30 };
  const result = await client.readSessionCost(input);
  assert.deepEqual(result.cost.breakdown, cost.cost.breakdown, "different currencies and bases remain separate rows");
  assert.equal(result.cost.cost_minor, null, "a misleading flattened total is not synthesized");
  assert.equal(result.cost.has_unresolved, true);
  assert.equal(result.cost.complete, false);
  assert.deepEqual(sent.payload, { dataset: "session-cost", version: 1, fields,
    query: { sessionRef, windowDays: 30, toMs: cost.window.toMs, dataRevision: 30 } });

  await assert.rejects(() => client.readSessionCost({ ...input, fields: ["cost.native_id"] }), /typed_data_request_invalid/);
  const invalidCurrency = createTypedDataClient("city-instance", async request => ({ version: 1, requestId: request.requestId, ok: true,
    result: { ...structuredClone(cost), cost: { ...cost.cost, breakdown: [{ ...cost.cost.breakdown[0], currency: "USD+CNY" }] } }, error: null }));
  await assert.rejects(() => invalidCurrency.readSessionCost(input), /typed_data_response_invalid/);
  const wrongRevision = createTypedDataClient("city-instance", async request => ({ version: 1, requestId: request.requestId, ok: true,
    result: { ...structuredClone(cost), dataRevision: 29 }, error: null }));
  await assert.rejects(() => wrongRevision.readSessionCost(input), /typed_data_response_invalid/);
});

test("City legacy export client pins bounded pages and rejects malformed source records", async () => {
  let sent;
  const page = { schema: "city-legacy-export:v1", consistency: "independent-sqlite-version-vector", sourceRevision: `${"a".repeat(64)}.${"b".repeat(64)}`,
    records: [{ source: "registry.save_refs", columns: ["save_id", "asset_ref"],
      values: ["city-primary", "ca_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] }],
    nextCursor: `v1:${"a".repeat(64)}.${"b".repeat(64)}:0:1` };
  const client = createTypedDataClient("city-instance", async request => {
    sent = request;
    return { version: 1, requestId: request.requestId, ok: true, result: structuredClone(page), error: null };
  });
  assert.deepEqual(await client.readCityLegacyStorePage({ limit: 1 }), page);
  assert.deepEqual(sent.payload, { dataset: "city-legacy-store", version: 1, cursor: null, limit: 1 });
  assert.equal(sent.method, "typed-data.read");
  await assert.rejects(() => client.readCityLegacyStorePage({ cursor: "../private", limit: 1 }), /typed_data_request_invalid/);
  await assert.rejects(() => client.readCityLegacyStorePage({ limit: 501 }), /typed_data_request_invalid/);
  const wrongColumns = createTypedDataClient("city-instance", async request => ({ version: 1, requestId: request.requestId,
    ok: true, result: { ...structuredClone(page), records: [{ ...page.records[0], columns: ["secret", "key_hash", "state"] }] }, error: null }));
  await assert.rejects(() => wrongColumns.readCityLegacyStorePage({ limit: 1 }), /typed_data_response_invalid/);
  const extraField = createTypedDataClient("city-instance", async request => ({ version: 1, requestId: request.requestId,
    ok: true, result: { ...structuredClone(page), hidden: true }, error: null }));
  await assert.rejects(() => extraField.readCityLegacyStorePage({ limit: 1 }), /typed_data_response_invalid/);
});
