import type { PluginRequestV1, PluginResponseV1 } from "./plugin-rpc.js";

export type TypedSessionFieldV1 =
  | "session.id"
  | "session.harness_id"
  | "session.first_event_at_ms"
  | "session.last_event_at_ms"
  | "session.event_count"
  | "session.tokens.input"
  | "session.tokens.output"
  | "session.tokens.total";
export type TypedSessionWindowV1 = 7 | 30 | 90 | 366;
export type TypedSessionCostFieldV1 =
  | "cost.status" | "cost.reason" | "cost.has_unresolved" | "cost.complete" | "cost.cost_minor"
  | "cost.coverage" | "cost.pricing_versions" | "cost.reference_prices" | "cost.pricing_sources" | "cost.breakdown";
export type TypedSessionCostV1 = {
  schema: "session-cost:v1";
  dataRevision: number;
  windowDays: TypedSessionWindowV1;
  window: { fromMs: number; toMs: number };
  sessionRef: string;
  cost: {
    status?: "estimated" | "subscription" | "unpriced" | "unavailable";
    reason?: string;
    has_unresolved?: boolean;
    complete?: boolean;
    coverage?: { priced_tokens?: number; subscription_tokens?: number; unpriced_tokens?: number; legacy_tokens?: number };
    cost_minor?: { amount_minor: number; currency: string; basis: string } | null;
    pricing_versions?: string[];
    breakdown?: Array<{ currency: string; basis: string; amount_minor: number }>;
    pricing_sources?: string[];
    reference_prices?: Array<{ pricing_version: string; captured_at_ms: number }>;
  };
};
export type TypedSessionSourceStatusFieldV1 = "source.stable_ref" | "source.state" | "source.has_usage_in_window";
export type TypedSessionSourceStatusV1 = {
  schema: "session-source-status:v1";
  dataRevision: number;
  windowDays: TypedSessionWindowV1;
  window: { fromMs: number; toMs: number };
  sources: Array<{ stable_ref?: string; state?: "active" | "deleted" | "missing"; has_usage_in_window?: boolean | null }>;
};
export type TypedUsageSummaryFieldV1 =
  | "summary.session_count" | "summary.usage_event_count"
  | "summary.tokens.input" | "summary.tokens.output" | "summary.tokens.total"
  | "summary.tokens.uncached_input" | "summary.tokens.cache_read" | "summary.tokens.cache_write";
export type TypedUsageSummaryV1 = {
  schema: "usage-summary:v1";
  dataRevision: number;
  windowDays: TypedSessionWindowV1;
  window: { fromMs: number; toMs: number };
  summary: {
    session_count?: number;
    usage_event_count?: number;
    tokens?: { input?: number; output?: number; total?: number; uncached_input?: number; cache_read?: number; cache_write?: number };
  };
};
export type TypedActivitySummaryFieldV1 =
  | "activity.date" | "activity.session_count" | "activity.event_count" | "activity.tokens";
export type TypedActivitySummaryV1 = {
  schema: "activity-summary:v1";
  dataRevision: number;
  windowDays: TypedSessionWindowV1;
  window: { fromMs: number; toMs: number };
  timezone: string;
  days: Array<{
    date?: string;
    session_count?: number;
    event_count?: number;
    tokens?: number;
  }>;
};
export type TypedModelUsageFieldV1 =
  | "model.model_id" | "model.usage_event_count" | "model.legacy_usage_event_count"
  | "model.tokens.input" | "model.tokens.output" | "model.tokens.total"
  | "model.tokens.uncached_input" | "model.tokens.cache_read" | "model.tokens.cache_write"
  | "coverage.unknown_model_usage_events" | "coverage.legacy_usage_events" | "scope" | "pricing_independent";
export type TypedModelUsageV1 = {
  schema: "model-usage:v1";
  dataRevision: number;
  windowDays: TypedSessionWindowV1;
  window: { fromMs: number; toMs: number };
  models: Array<{
    model_id?: string | null;
    usage_event_count?: number;
    legacy_usage_event_count?: number;
    tokens?: { input?: number; output?: number; total?: number; uncached_input?: number; cache_read?: number; cache_write?: number };
  }>;
  coverage: { unknown_model_usage_events?: number; legacy_usage_events?: number };
  scope?: "window";
  pricingIndependent?: true;
};
export type TypedTimeCoverageFieldV1 =
  | "coverage.scope" | "coverage.unknown_time_only" | "coverage.mixed_time" | "coverage.excluded_no_usage";
export type TypedTimeCoverageV1 = {
  schema: "time-coverage:v1";
  dataRevision: number;
  coverage: {
    scope?: "all_non_deleted_sessions";
    unknown_time_only?: number;
    mixed_time?: number;
    excluded_no_usage?: number;
  };
};
export type TypedFindingSummaryFieldV1 =
  | "findings.current_backlog.harness_id" | "findings.current_backlog.severity" | "findings.current_backlog.count"
  | "findings.window_new.harness_id" | "findings.window_new.severity" | "findings.window_new.count"
  | "capabilities.harness_id" | "capabilities.available" | "capabilities.reason";
export type TypedFindingSummaryV1 = {
  schema: "finding-summary:v1";
  dataRevision: number;
  windowDays: TypedSessionWindowV1;
  window: { fromMs: number; toMs: number };
  current_backlog: Array<{ harness_id?: string; severity?: "critical" | "warning" | "info"; count?: number }>;
  window_new: Array<{ harness_id?: string; severity?: "critical" | "warning" | "info"; count?: number }>;
  capabilities: Array<{ harness_id?: string; available?: boolean; reason?: "findings_not_supported" | null }>;
};
export type TypedSkillUsageFieldV1 = "skill.harness_id" | "skill.label" | "skill.invocations" | "skill.sessions"
  | "skill.last_invoked_at_ms" | "skill.finished_events" | "skill.failed_events" | "skill.succeeded_events";
export type TypedSkillUsageV1 = {
  schema: "skill-usage-summary:v1"; dataRevision: number; windowDays: TypedSessionWindowV1;
  window: { fromMs: number; toMs: number };
  skills: Array<{ harness_id?: string; label?: string; invocations?: number; sessions?: number; last_invoked_at_ms?: number | null; finished_events?: number; failed_events?: number; succeeded_events?: number }>;
  truncated: boolean; coverage: "observed_workflow_events_only"; outcomeScope: "unpaired_finish_events"; inventoryIncluded: false;
};
export type TypedWorkflowActivityFieldV1 = "event.harness_id" | "event.event_type" | "event.count" | "event.sessions" | "event.last_event_at_ms" | "event.failed_events";
export type TypedWorkflowActivityV1 = {
  schema: "workflow-activity-summary:v1"; dataRevision: number; windowDays: TypedSessionWindowV1;
  window: { fromMs: number; toMs: number };
  events: Array<{ harness_id?: string; event_type?: string; count?: number; sessions?: number; last_event_at_ms?: number; failed_events?: number }>;
  truncated: boolean; coverage: "observed_workflow_events_only"; outcomeScope: "unpaired_events";
};
export type TypedCityLegacyExportSourceV1 = "registry.save_refs" | "registry.game_links"
  | "building.overrides" | "building.claims" | "building.squad_mailbox";
export type TypedCityLegacyExportRecordV1 = { source: TypedCityLegacyExportSourceV1; columns: string[]; values: Array<string | number | null> };
export type TypedCityLegacyExportPageV1 = {
  schema: "city-legacy-export:v1";
  consistency: "independent-sqlite-version-vector";
  sourceRevision: string;
  records: TypedCityLegacyExportRecordV1[];
  nextCursor: string | null;
};
export type TypedCityAssetCrosswalkV1 = {
  schema: "city-asset-crosswalk:v1";
  dataRevision: number;
  sourceRevision: string;
  pairs: Array<{ asset_ref: string; stable_ref: string }>;
  unresolved: string[];
};
export type TypedSessionExcerptV1 = {
  role: "user_first" | "user_turn";
  text: string;
  provenance: string;
  is_excerpt: true;
  scope: "session_lifetime";
  excerpt_at: null;
};
export type TypedSessionDetailV1 = {
  schema: "harness-session-detail:v1";
  dataRevision: number;
  windowDays: TypedSessionWindowV1;
  window: { fromMs: number; toMs: number };
  sessionRef: string;
  costDataset: "session-cost:v1";
  costAvailable: false;
  session: {
    id: string;
    harness: string;
    title: string | null;
    title_source: string | null;
    first_event_at: string;
    last_event_at: string;
    window_first_event_at: string;
    window_last_event_at: string;
    lifetime_first_event_at: string | null;
    lifetime_last_event_at: string | null;
    event_count: number;
    tokens: Record<string, number>;
    model_ids: string[];
    model_coverage: Record<string, unknown>;
  };
};
export type TypedSessionExcerptsV1 = {
  schema: "session-excerpts:v1";
  dataRevision: number;
  windowDays: TypedSessionWindowV1;
  window: { fromMs: number; toMs: number };
  sessionRef: string;
  excerptScope: "session_lifetime";
  excerpts: TypedSessionExcerptV1[];
  excerptAvailability: { available: boolean; reason: string | null };
};
export type TypedSessionRowV1 = {
  id?: string;
  harness_id?: string;
  first_event_at_ms?: number;
  last_event_at_ms?: number;
  event_count?: number;
  tokens?: { input?: number; output?: number; total?: number };
};
export type TypedSessionResponseV1 = {
  schema: "harness-sessions:v1";
  dataRevision: number;
  harnessId: string;
  windowDays: TypedSessionWindowV1;
  pagination: { offset: number; limit: number };
  coverage: { total: number; returned: number; truncated: boolean };
  sessions: TypedSessionRowV1[];
};
export type TypedSessionResponseV2 = Omit<TypedSessionResponseV1, "schema"> & {
  schema: "harness-sessions:v2";
  window: { fromMs: number; toMs: number };
};
export type TypedSessionFieldV3 = TypedSessionFieldV1
  | "session.title" | "session.title_source"
  | "session.window_first_event_at_ms" | "session.window_last_event_at_ms"
  | "session.window_order"
  | "session.lifetime_first_event_at_ms" | "session.lifetime_last_event_at_ms"
  | "session.tokens.uncached_input" | "session.tokens.cache_read" | "session.tokens.cache_write"
  | "session.model_ids" | "session.model_coverage";
export type TypedSessionFieldV4 = TypedSessionFieldV3 | "session.stable_ref";
export type TypedSessionFieldV5 = Exclude<TypedSessionFieldV4,
  "session.first_event_at_ms" | "session.last_event_at_ms"
  | "session.window_first_event_at_ms" | "session.window_last_event_at_ms" | "session.window_order">;
export type TypedSessionRowV3 = {
  id?: string;
  harness_id?: string;
  title?: string | null;
  title_source?: "codex_thread_name" | "claude_ai_title" | "dsh_workspace_title" | "zcode_session_title" | null;
  window_first_event_at_ms?: number;
  window_last_event_at_ms?: number;
  window_order?: number;
  lifetime_first_event_at_ms?: number | null;
  lifetime_last_event_at_ms?: number | null;
  event_count?: number;
  tokens?: { input?: number; output?: number; total?: number; uncached_input?: number; cache_read?: number; cache_write?: number };
  model_ids?: string[];
  model_coverage?: { unknown_model_usage_events: number; legacy_usage_events: number };
};
export type TypedSessionResponseV3 = Omit<TypedSessionResponseV2, "schema" | "harnessId" | "sessions"> & {
  schema: "harness-sessions:v3";
  harnessId: null;
  sessions: TypedSessionRowV3[];
};
export type TypedSessionRowV4 = TypedSessionRowV3 & { stable_ref?: string };
export type TypedSessionResponseV4 = Omit<TypedSessionResponseV3, "schema" | "sessions"> & {
  schema: "harness-sessions:v4";
  sessions: TypedSessionRowV4[];
};
export type TypedSessionRowV5 = Omit<TypedSessionRowV4, "window_first_event_at_ms" | "window_last_event_at_ms" | "window_order">;
export type TypedSessionResponseV5 = {
  schema: "harness-sessions:v5";
  dataRevision: number;
  harnessId: null;
  pagination: { offset: number; limit: number };
  coverage: { total: number; returned: number; truncated: boolean };
  sessions: TypedSessionRowV5[];
};
export type TypedSessionIdentityV1 = {
  schema: "harness-session-identities:v1";
  dataRevision: number;
  pagination: { offset: number; limit: number };
  coverage: { total: number; returned: number; truncated: boolean };
  sessions: Array<{ id: string; stable_ref: string }>;
};

const FIELDS: readonly TypedSessionFieldV1[] = [
  "session.id", "session.harness_id", "session.first_event_at_ms", "session.last_event_at_ms",
  "session.event_count", "session.tokens.input", "session.tokens.output", "session.tokens.total",
];
const FIELDS_V3: readonly TypedSessionFieldV3[] = [
  ...FIELDS,
  "session.title", "session.title_source",
  "session.window_first_event_at_ms", "session.window_last_event_at_ms",
  "session.window_order",
  "session.lifetime_first_event_at_ms", "session.lifetime_last_event_at_ms",
  "session.tokens.uncached_input", "session.tokens.cache_read", "session.tokens.cache_write",
  "session.model_ids", "session.model_coverage",
];
const FIELDS_V4: readonly TypedSessionFieldV4[] = [...FIELDS_V3, "session.stable_ref"];
const FIELDS_V5: readonly TypedSessionFieldV5[] = FIELDS_V4.filter(field => !["session.first_event_at_ms", "session.last_event_at_ms", "session.window_first_event_at_ms",
  "session.window_last_event_at_ms", "session.window_order"].includes(field)) as TypedSessionFieldV5[];
const ID = /^[a-zA-Z0-9:_-]{1,128}$/;
const MODEL_ID = /^[a-zA-Z0-9_./:-]{1,256}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const safeCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

function expectedRowKeys(fields: readonly TypedSessionFieldV1[]): Set<string> {
  return new Set(fields.map(field => field.slice("session.".length).split(".")[0]!));
}

function parseRow(value: unknown, fields: readonly TypedSessionFieldV1[]): TypedSessionRowV1 {
  if (!isRecord(value)) throw new Error("typed_data_response_invalid");
  const allowed = expectedRowKeys(fields);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error("typed_data_response_invalid");
  const has = (field: TypedSessionFieldV1) => fields.includes(field);
  if ((has("session.id") && (typeof value.id !== "string" || !ID.test(value.id)))
      || (has("session.harness_id") && (typeof value.harness_id !== "string" || !ID.test(value.harness_id)))
      || (has("session.first_event_at_ms") && !safeCount(value.first_event_at_ms))
      || (has("session.last_event_at_ms") && !safeCount(value.last_event_at_ms))
      || (has("session.event_count") && !safeCount(value.event_count))) throw new Error("typed_data_response_invalid");
  if (allowed.has("tokens")) {
    const tokens = value.tokens;
    if (!isRecord(tokens)) throw new Error("typed_data_response_invalid");
    const tokenFields = fields.filter(field => field.startsWith("session.tokens.")).map(field => field.slice("session.tokens.".length));
    if (!exact(tokens, tokenFields) || tokenFields.some(field => !safeCount(tokens[field]))) throw new Error("typed_data_response_invalid");
  }
  return value as TypedSessionRowV1;
}

function parseResponse(value: unknown, fields: readonly TypedSessionFieldV1[], harnessId: string, windowDays: TypedSessionWindowV1, offset: number, limit: number): TypedSessionResponseV1 {
  if (!isRecord(value) || !exact(value, ["schema", "dataRevision", "harnessId", "windowDays", "pagination", "coverage", "sessions"])
      || value.schema !== "harness-sessions:v1" || !safeCount(value.dataRevision) || value.harnessId !== harnessId || value.windowDays !== windowDays
      || !isRecord(value.pagination) || !exact(value.pagination, ["offset", "limit"]) || value.pagination.offset !== offset || value.pagination.limit !== limit
      || !isRecord(value.coverage) || !exact(value.coverage, ["total", "returned", "truncated"])
      || !safeCount(value.coverage.total) || !safeCount(value.coverage.returned) || typeof value.coverage.truncated !== "boolean"
      || !Array.isArray(value.sessions) || value.sessions.length > limit || value.coverage.returned !== value.sessions.length
      || value.coverage.total < offset + value.coverage.returned || value.coverage.truncated !== (value.coverage.total > offset + value.coverage.returned)) {
    throw new Error("typed_data_response_invalid");
  }
  return { ...value, sessions: value.sessions.map(row => parseRow(row, fields)) } as TypedSessionResponseV1;
}

function parsePageV2(value: unknown, fields: readonly TypedSessionFieldV1[], harnessId: string, windowDays: TypedSessionWindowV1, offset: number, limit: number): TypedSessionResponseV2 {
  if (!isRecord(value) || !exact(value, ["schema", "dataRevision", "harnessId", "windowDays", "window", "pagination", "coverage", "sessions"])
      || value.schema !== "harness-sessions:v2" || !safeCount(value.dataRevision) || value.harnessId !== harnessId || value.windowDays !== windowDays
      || !isRecord(value.window) || !exact(value.window, ["fromMs", "toMs"]) || !safeCount(value.window.fromMs) || !safeCount(value.window.toMs)
      || value.window.toMs - value.window.fromMs !== windowDays * 86_400_000
      || !isRecord(value.pagination) || !exact(value.pagination, ["offset", "limit"]) || value.pagination.offset !== offset || value.pagination.limit !== limit
      || !isRecord(value.coverage) || !exact(value.coverage, ["total", "returned", "truncated"])
      || !safeCount(value.coverage.total) || !safeCount(value.coverage.returned) || typeof value.coverage.truncated !== "boolean"
      || !Array.isArray(value.sessions) || value.sessions.length > limit || value.coverage.returned !== value.sessions.length
      || value.coverage.truncated !== (value.coverage.total > offset + value.coverage.returned)) {
    throw new Error("typed_data_response_invalid");
  }
  return { ...value, sessions: value.sessions.map(row => parseRow(row, fields)) } as TypedSessionResponseV2;
}

function parseRowV3(value: unknown, fields: readonly TypedSessionFieldV3[]): TypedSessionRowV3 {
  if (!isRecord(value)) throw new Error("typed_data_response_invalid");
  const allowed = new Set(fields.map(field => field.slice("session.".length).split(".")[0]!));
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error("typed_data_response_invalid");
  if (fields.includes("session.id") && (typeof value.id !== "string" || !ID.test(value.id))) throw new Error("typed_data_response_invalid");
  if (fields.includes("session.harness_id") && (typeof value.harness_id !== "string" || !ID.test(value.harness_id))) throw new Error("typed_data_response_invalid");
  if (fields.includes("session.title") && value.title !== null && (typeof value.title !== "string" || Array.from(value.title).length > 256)) throw new Error("typed_data_response_invalid");
  if (fields.includes("session.title_source") && value.title_source !== null
      && !["codex_thread_name", "claude_ai_title", "dsh_workspace_title", "zcode_session_title"].includes(String(value.title_source))) throw new Error("typed_data_response_invalid");
  for (const field of ["session.window_first_event_at_ms", "session.window_last_event_at_ms", "session.window_order", "session.event_count"] as const) {
    if (fields.includes(field) && !safeCount(value[field.slice("session.".length)])) throw new Error("typed_data_response_invalid");
  }
  for (const field of ["session.lifetime_first_event_at_ms", "session.lifetime_last_event_at_ms"] as const) {
    if (fields.includes(field) && value[field.slice("session.".length)] !== null && !safeCount(value[field.slice("session.".length)])) throw new Error("typed_data_response_invalid");
  }
  const tokenFields = fields.filter(field => field.startsWith("session.tokens.")).map(field => field.slice("session.tokens.".length));
  if (tokenFields.length) {
    const tokens = value.tokens;
    if (!isRecord(tokens) || !exact(tokens, tokenFields) || tokenFields.some(field => !safeCount(tokens[field]))) throw new Error("typed_data_response_invalid");
  }
  if (fields.includes("session.model_ids") && (!Array.isArray(value.model_ids) || value.model_ids.length > 1024
      || value.model_ids.some(id => typeof id !== "string" || !MODEL_ID.test(id)) || new Set(value.model_ids).size !== value.model_ids.length)) throw new Error("typed_data_response_invalid");
  if (fields.includes("session.model_coverage") && (!isRecord(value.model_coverage)
      || !exact(value.model_coverage, ["unknown_model_usage_events", "legacy_usage_events"])
      || !safeCount(value.model_coverage.unknown_model_usage_events) || !safeCount(value.model_coverage.legacy_usage_events))) throw new Error("typed_data_response_invalid");
  return value as TypedSessionRowV3;
}

function parsePageV3(value: unknown, fields: readonly TypedSessionFieldV3[], windowDays: TypedSessionWindowV1, offset: number, limit: number): TypedSessionResponseV3 {
  if (!isRecord(value) || !exact(value, ["schema", "dataRevision", "harnessId", "windowDays", "window", "pagination", "coverage", "sessions"])
      || value.schema !== "harness-sessions:v3" || !safeCount(value.dataRevision) || value.harnessId !== null || value.windowDays !== windowDays
      || !isRecord(value.window) || !exact(value.window, ["fromMs", "toMs"]) || !safeCount(value.window.fromMs) || !safeCount(value.window.toMs)
      || value.window.toMs - value.window.fromMs !== windowDays * 86_400_000
      || !isRecord(value.pagination) || !exact(value.pagination, ["offset", "limit"]) || value.pagination.offset !== offset || value.pagination.limit !== limit
      || !isRecord(value.coverage) || !exact(value.coverage, ["total", "returned", "truncated"])
      || !safeCount(value.coverage.total) || !safeCount(value.coverage.returned) || typeof value.coverage.truncated !== "boolean"
      || !Array.isArray(value.sessions) || value.sessions.length > limit || value.coverage.returned !== value.sessions.length
      || value.coverage.total < offset + value.coverage.returned
      || value.coverage.truncated !== (value.coverage.total > offset + value.coverage.returned)) throw new Error("typed_data_response_invalid");
  return { ...value, sessions: value.sessions.map(row => parseRowV3(row, fields)) } as TypedSessionResponseV3;
}

function parsePageV4(value: unknown, fields: readonly TypedSessionFieldV4[], windowDays: TypedSessionWindowV1, offset: number, limit: number): TypedSessionResponseV4 {
  if (!isRecord(value) || !exact(value, ["schema", "dataRevision", "harnessId", "windowDays", "window", "pagination", "coverage", "sessions"])
      || value.schema !== "harness-sessions:v4" || !safeCount(value.dataRevision) || value.harnessId !== null || value.windowDays !== windowDays
      || !isRecord(value.window) || !exact(value.window, ["fromMs", "toMs"]) || !safeCount(value.window.fromMs) || !safeCount(value.window.toMs)
      || value.window.toMs - value.window.fromMs !== windowDays * 86_400_000
      || !isRecord(value.pagination) || !exact(value.pagination, ["offset", "limit"]) || value.pagination.offset !== offset || value.pagination.limit !== limit
      || !isRecord(value.coverage) || !exact(value.coverage, ["total", "returned", "truncated"])
      || !safeCount(value.coverage.total) || !safeCount(value.coverage.returned) || typeof value.coverage.truncated !== "boolean"
      || !Array.isArray(value.sessions) || value.sessions.length > limit || value.coverage.returned !== value.sessions.length
      || value.coverage.total < offset + value.coverage.returned
      || value.coverage.truncated !== (value.coverage.total > offset + value.coverage.returned)) throw new Error("typed_data_response_invalid");
  const fieldsV3 = fields.filter(field => field !== "session.stable_ref") as TypedSessionFieldV3[];
  return { ...value, sessions: value.sessions.map(row => {
    if (!isRecord(row)) throw new Error("typed_data_response_invalid");
    const parsed = parseRowV3(Object.fromEntries(Object.entries(row).filter(([key]) => key !== "stable_ref")), fieldsV3);
    if (Object.keys(row).some(key => !new Set([...fieldsV3.map(field => field.slice("session.".length).split(".")[0]!),
      ...(fields.includes("session.stable_ref") ? ["stable_ref"] : [])]).has(key))) throw new Error("typed_data_response_invalid");
    if (fields.includes("session.stable_ref") && (typeof row.stable_ref !== "string" || !/^srp_[a-f0-9]{32}$/.test(row.stable_ref))) {
      throw new Error("typed_data_response_invalid");
    }
    return row as unknown as TypedSessionRowV4;
  }) } as TypedSessionResponseV4;
}

function parsePageV5(value: unknown, fields: readonly TypedSessionFieldV5[], offset: number, limit: number): TypedSessionResponseV5 {
  if (!isRecord(value) || !exact(value, ["schema", "dataRevision", "harnessId", "pagination", "coverage", "sessions"])
      || value.schema !== "harness-sessions:v5" || !safeCount(value.dataRevision) || value.harnessId !== null
      || !isRecord(value.pagination) || !exact(value.pagination, ["offset", "limit"])
      || value.pagination.offset !== offset || value.pagination.limit !== limit
      || !isRecord(value.coverage) || !exact(value.coverage, ["total", "returned", "truncated"])
      || !safeCount(value.coverage.total) || !safeCount(value.coverage.returned) || typeof value.coverage.truncated !== "boolean"
      || !Array.isArray(value.sessions) || value.sessions.length > limit || value.coverage.returned !== value.sessions.length
      || value.coverage.total < offset + value.coverage.returned
      || value.coverage.truncated !== (value.coverage.total > offset + value.coverage.returned)) {
    throw new Error("typed_data_response_invalid");
  }
  const fieldsV3 = fields.filter(field => field !== "session.stable_ref") as TypedSessionFieldV3[];
  const allowedKeys = new Set([...fieldsV3.map(field => field.slice("session.".length).split(".")[0]!),
    ...(fields.includes("session.stable_ref") ? ["stable_ref"] : [])]);
  const sessions = value.sessions.map(row => {
    if (!isRecord(row) || Object.keys(row).some(key => !allowedKeys.has(key))) throw new Error("typed_data_response_invalid");
    parseRowV3(Object.fromEntries(Object.entries(row).filter(([key]) => key !== "stable_ref")), fieldsV3);
    if (fields.includes("session.stable_ref") && (typeof row.stable_ref !== "string" || !/^srp_[a-f0-9]{32}$/.test(row.stable_ref))) {
      throw new Error("typed_data_response_invalid");
    }
    return row as unknown as TypedSessionRowV5;
  });
  return { ...value, sessions } as TypedSessionResponseV5;
}

function parseSessionIdentityPage(value: unknown, offset: number, limit: number): TypedSessionIdentityV1 {
  if (!isRecord(value) || !exact(value, ["schema", "dataRevision", "pagination", "coverage", "sessions"])
      || value.schema !== "harness-session-identities:v1" || !safeCount(value.dataRevision)
      || !isRecord(value.pagination) || !exact(value.pagination, ["offset", "limit"])
      || value.pagination.offset !== offset || value.pagination.limit !== limit
      || !isRecord(value.coverage) || !exact(value.coverage, ["total", "returned", "truncated"])
      || !safeCount(value.coverage.total) || !safeCount(value.coverage.returned) || typeof value.coverage.truncated !== "boolean"
          || !Array.isArray(value.sessions) || value.sessions.length > limit
          || value.coverage.returned !== value.sessions.length
      || value.coverage.total < offset + value.coverage.returned
      || value.coverage.truncated !== (value.coverage.total > offset + value.coverage.returned)) {
    throw new Error("typed_data_response_invalid");
  }
  const seenIds = new Set<string>();
  const seenRefs = new Set<string>();
  const sessions = value.sessions.map((item) => {
    if (!isRecord(item) || !exact(item, ["id", "stable_ref"])
        || typeof item.id !== "string" || !/^sr_[a-f0-9]{32}$/i.test(item.id)
        || typeof item.stable_ref !== "string" || !/^srp_[a-f0-9]{32}$/.test(item.stable_ref)
        || seenIds.has(item.id) || seenRefs.has(item.stable_ref)) throw new Error("typed_data_response_invalid");
    seenIds.add(item.id);
    seenRefs.add(item.stable_ref);
    return { id: item.id, stable_ref: item.stable_ref };
  });
  return { ...value, sessions } as TypedSessionIdentityV1;
}

function parseUsageSummary(value: unknown, fields: readonly TypedUsageSummaryFieldV1[], windowDays: TypedSessionWindowV1): TypedUsageSummaryV1 {
  const summaryKeys = new Set(fields.map(field => field.slice("summary.".length).split(".")[0]!));
  const tokenFields = fields.filter(field => field.startsWith("summary.tokens.")).map(field => field.slice("summary.tokens.".length));
  if (!isRecord(value) || !exact(value, ["schema", "dataRevision", "windowDays", "window", "summary"])
      || value.schema !== "usage-summary:v1" || !safeCount(value.dataRevision) || value.windowDays !== windowDays
      || !isRecord(value.window) || !exact(value.window, ["fromMs", "toMs"])
      || !safeCount(value.window.fromMs) || !safeCount(value.window.toMs)
      || value.window.toMs - value.window.fromMs !== windowDays * 86_400_000
      || !isRecord(value.summary) || Object.keys(value.summary).some(key => !summaryKeys.has(key))) {
    throw new Error("typed_data_response_invalid");
  }
  const summaryValue = value.summary as Record<string, unknown>;
  for (const field of ["summary.session_count", "summary.usage_event_count"] as const) {
    if (fields.includes(field) && !safeCount(summaryValue[field.slice("summary.".length)])) throw new Error("typed_data_response_invalid");
  }
  if (tokenFields.length) {
    if (!isRecord(summaryValue.tokens) || !exact(summaryValue.tokens, tokenFields)
        || tokenFields.some(field => !safeCount((summaryValue.tokens as Record<string, unknown>)[field]))) throw new Error("typed_data_response_invalid");
  }
  return value as TypedUsageSummaryV1;
}

function parseActivitySummary(value: unknown, fields: readonly TypedActivitySummaryFieldV1[], windowDays: TypedSessionWindowV1): TypedActivitySummaryV1 {
  const allowed = new Set(fields.map(field => field.slice("activity.".length)));
  if (!isRecord(value) || !exact(value, ["schema", "dataRevision", "windowDays", "window", "timezone", "days"])
      || value.schema !== "activity-summary:v1" || !safeCount(value.dataRevision) || value.windowDays !== windowDays
      || !isRecord(value.window) || !exact(value.window, ["fromMs", "toMs"])
      || !safeCount(value.window.fromMs) || !safeCount(value.window.toMs)
      || value.window.toMs - value.window.fromMs !== windowDays * 86_400_000
      || typeof value.timezone !== "string" || value.timezone.length < 1 || value.timezone.length > 128
      || !Array.isArray(value.days) || value.days.length > 368) throw new Error("typed_data_response_invalid");
  const days = value.days.map(day => {
    if (!isRecord(day) || Object.keys(day).some(key => !allowed.has(key))) throw new Error("typed_data_response_invalid");
    if (fields.includes("activity.date") && (typeof day.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)
        || !Number.isFinite(Date.parse(`${day.date}T00:00:00Z`))
        || new Date(`${day.date}T00:00:00Z`).toISOString().slice(0, 10) !== day.date)) throw new Error("typed_data_response_invalid");
    for (const field of ["activity.session_count", "activity.event_count", "activity.tokens"] as const) {
      if (fields.includes(field) && !safeCount(day[field.slice("activity.".length)])) throw new Error("typed_data_response_invalid");
    }
    return day;
  });
  return { ...value, days } as TypedActivitySummaryV1;
}

function parseModelUsage(value: unknown, fields: readonly TypedModelUsageFieldV1[], windowDays: TypedSessionWindowV1): TypedModelUsageV1 {
  const modelFields = fields.filter(field => field.startsWith("model."));
  const modelKeys = new Set(modelFields.map(field => field.slice("model.".length).split(".")[0]!));
  const tokenFields = modelFields.filter(field => field.startsWith("model.tokens.")).map(field => field.slice("model.tokens.".length));
  const coverageFields = fields.filter(field => field.startsWith("coverage.")).map(field => field.slice("coverage.".length));
  if (!isRecord(value) || value.schema !== "model-usage:v1" || !safeCount(value.dataRevision)
      || value.windowDays !== windowDays || !isRecord(value.window) || !exact(value.window, ["fromMs", "toMs"])
      || !safeCount(value.window.fromMs) || !safeCount(value.window.toMs)
      || value.window.toMs - value.window.fromMs !== windowDays * 86_400_000
      || !Array.isArray(value.models) || value.models.length > 500 || !isRecord(value.coverage)
      || Object.keys(value.coverage).some(key => !coverageFields.includes(key))) throw new Error("typed_data_response_invalid");
  const modelRows = value.models.map(model => {
    if (!isRecord(model) || Object.keys(model).some(key => !modelKeys.has(key))) throw new Error("typed_data_response_invalid");
    if (modelKeys.has("model_id") && model.model_id !== null
        && (typeof model.model_id !== "string" || !MODEL_ID.test(model.model_id))) throw new Error("typed_data_response_invalid");
    for (const field of ["model.usage_event_count", "model.legacy_usage_event_count"] as const) {
      if (fields.includes(field) && !safeCount(model[field.slice("model.".length)])) throw new Error("typed_data_response_invalid");
    }
    if (tokenFields.length && (!isRecord(model.tokens) || !exact(model.tokens, tokenFields)
        || tokenFields.some(field => !safeCount((model.tokens as Record<string, unknown>)[field])))) throw new Error("typed_data_response_invalid");
    return model;
  });
  for (const field of ["coverage.unknown_model_usage_events", "coverage.legacy_usage_events"] as const) {
    if (fields.includes(field) && !safeCount(value.coverage[field.slice("coverage.".length)])) throw new Error("typed_data_response_invalid");
  }
  const expectedKeys = ["schema", "dataRevision", "windowDays", "window", "models", "coverage"];
  if (fields.includes("scope")) expectedKeys.push("scope");
  if (fields.includes("pricing_independent")) expectedKeys.push("pricingIndependent");
  if (!exact(value, expectedKeys) || (fields.includes("scope") && value.scope !== "window")
      || (fields.includes("pricing_independent") && value.pricingIndependent !== true)) throw new Error("typed_data_response_invalid");
  return { ...value, models: modelRows } as TypedModelUsageV1;
}

function parseTimeCoverage(value: unknown, fields: readonly TypedTimeCoverageFieldV1[]): TypedTimeCoverageV1 {
  if (!isRecord(value) || !exact(value, ["schema", "dataRevision", "coverage"])
      || value.schema !== "time-coverage:v1" || !safeCount(value.dataRevision) || !isRecord(value.coverage)) {
    throw new Error("typed_data_response_invalid");
  }
  const allowed = fields.map(field => field.slice("coverage.".length));
  if (Object.keys(value.coverage).some(key => !allowed.includes(key))) throw new Error("typed_data_response_invalid");
  if (fields.includes("coverage.scope") && value.coverage.scope !== "all_non_deleted_sessions") throw new Error("typed_data_response_invalid");
  for (const field of ["coverage.unknown_time_only", "coverage.mixed_time", "coverage.excluded_no_usage"] as const) {
    if (fields.includes(field) && !safeCount(value.coverage[field.slice("coverage.".length)])) throw new Error("typed_data_response_invalid");
  }
  return value as TypedTimeCoverageV1;
}

function parseFindingSummary(value: unknown, fields: readonly TypedFindingSummaryFieldV1[], windowDays: TypedSessionWindowV1): TypedFindingSummaryV1 {
  if (!isRecord(value) || !exact(value, ["schema", "dataRevision", "windowDays", "window", "current_backlog", "window_new", "capabilities"])
      || value.schema !== "finding-summary:v1" || !safeCount(value.dataRevision) || value.windowDays !== windowDays
      || !isRecord(value.window) || !exact(value.window, ["fromMs", "toMs"])
      || !safeCount(value.window.fromMs) || !safeCount(value.window.toMs)
      || value.window.toMs - value.window.fromMs !== windowDays * 86_400_000
      || !Array.isArray(value.current_backlog) || !Array.isArray(value.window_new) || !Array.isArray(value.capabilities)
      || value.current_backlog.length > 500 || value.window_new.length > 500 || value.capabilities.length > 500) {
    throw new Error("typed_data_response_invalid");
  }
  const parseCounts = (rows: unknown[], scope: "current_backlog" | "window_new") => rows.map(row => {
    const selectedFields = fields.filter(field => field.startsWith(`findings.${scope}.`));
    const allowed = selectedFields.map(field => field.slice(`findings.${scope}.`.length));
    if (!isRecord(row) || Object.keys(row).some(key => !allowed.includes(key))) throw new Error("typed_data_response_invalid");
    if (selectedFields.includes(`findings.${scope}.harness_id`) && (typeof row.harness_id !== "string" || !ID.test(row.harness_id))) throw new Error("typed_data_response_invalid");
    if (selectedFields.includes(`findings.${scope}.severity`) && !["critical", "warning", "info"].includes(String(row.severity))) throw new Error("typed_data_response_invalid");
    if (selectedFields.includes(`findings.${scope}.count`) && !safeCount(row.count)) throw new Error("typed_data_response_invalid");
    return row;
  });
  const capabilityFields = fields.filter(field => field.startsWith("capabilities.")).map(field => field.slice("capabilities.".length));
  const capabilities = value.capabilities.map(row => {
    if (!isRecord(row) || Object.keys(row).some(key => !capabilityFields.includes(key))) throw new Error("typed_data_response_invalid");
    if (fields.includes("capabilities.harness_id") && (typeof row.harness_id !== "string" || !ID.test(row.harness_id))) throw new Error("typed_data_response_invalid");
    if (fields.includes("capabilities.available") && typeof row.available !== "boolean") throw new Error("typed_data_response_invalid");
    if (fields.includes("capabilities.reason") && row.reason !== null && row.reason !== "findings_not_supported") throw new Error("typed_data_response_invalid");
    return row;
  });
  return { ...value, current_backlog: parseCounts(value.current_backlog, "current_backlog"),
    window_new: parseCounts(value.window_new, "window_new"), capabilities } as TypedFindingSummaryV1;
}

function parseSkillOrWorkflow(value: unknown, fields: readonly (TypedSkillUsageFieldV1 | TypedWorkflowActivityFieldV1)[], days: TypedSessionWindowV1, skills: boolean): TypedSkillUsageV1 | TypedWorkflowActivityV1 {
  const schema = skills ? "skill-usage-summary:v1" : "workflow-activity-summary:v1";
  const collection = skills ? "skills" : "events";
  const expected = skills ? ["schema", "dataRevision", "windowDays", "window", "skills", "truncated", "coverage", "outcomeScope", "inventoryIncluded"]
    : ["schema", "dataRevision", "windowDays", "window", "events", "truncated", "coverage", "outcomeScope"];
  if (!isRecord(value) || !exact(value, expected) || value.schema !== schema || !safeCount(value.dataRevision) || value.windowDays !== days
      || !isRecord(value.window) || !exact(value.window, ["fromMs", "toMs"]) || !safeCount(value.window.fromMs) || !safeCount(value.window.toMs)
      || value.window.toMs - value.window.fromMs !== days * 86_400_000 || typeof value.truncated !== "boolean"
      || value.coverage !== "observed_workflow_events_only" || value.outcomeScope !== (skills ? "unpaired_finish_events" : "unpaired_events")
      || (skills && value.inventoryIncluded !== false) || !Array.isArray(value[collection]) || value[collection].length > 500) throw new Error("typed_data_response_invalid");
  const rows = (value[collection] as unknown[]).map(row => {
    const allowed = fields.filter(field => field.startsWith(skills ? "skill." : "event.")).map(field => field.split(".")[1]!);
    if (!isRecord(row) || Object.keys(row).some(key => !allowed.includes(key))) throw new Error("typed_data_response_invalid");
    const idKey = skills ? "harness_id" : "harness_id";
    if (allowed.includes(idKey) && (typeof row[idKey] !== "string" || !ID.test(row[idKey] as string))) throw new Error("typed_data_response_invalid");
    if (skills && allowed.includes("label") && (typeof row.label !== "string" || Array.from(row.label).length > 120)) throw new Error("typed_data_response_invalid");
    for (const key of ["invocations", "sessions", "finished_events", "failed_events", "succeeded_events", "count", "last_event_at_ms"])
      if (allowed.includes(key) && !safeCount(row[key])) throw new Error("typed_data_response_invalid");
    if (skills && allowed.includes("last_invoked_at_ms") && row.last_invoked_at_ms !== null && !safeCount(row.last_invoked_at_ms)) throw new Error("typed_data_response_invalid");
    if (!skills && allowed.includes("event_type") && !["task_started", "task_finished", "skill_invoked", "skill_finished", "tool_invoked", "tool_finished", "model_switched", "approval_denied"].includes(String(row.event_type))) throw new Error("typed_data_response_invalid");
    return row;
  });
  return { ...value, [collection]: rows } as unknown as TypedSkillUsageV1 | TypedWorkflowActivityV1;
}

function parseSessionDetail(value: unknown, expectedSessionRef: string, days: TypedSessionWindowV1, expectedRevision?: number): TypedSessionDetailV1 {
  if (!isRecord(value) || !exact(value, ["schema", "dataRevision", "windowDays", "window", "sessionRef", "session", "costDataset", "costAvailable"])
      || value.schema !== "harness-session-detail:v1" || !safeCount(value.dataRevision) || (expectedRevision !== undefined && value.dataRevision !== expectedRevision)
      || value.windowDays !== days || !isRecord(value.window)
      || !exact(value.window, ["fromMs", "toMs"]) || !safeCount(value.window.fromMs) || !safeCount(value.window.toMs)
      || value.window.toMs - value.window.fromMs !== days * 86_400_000
      || value.sessionRef !== expectedSessionRef
      || value.costDataset !== "session-cost:v1" || value.costAvailable !== false || !isRecord(value.session)) {
    throw new Error("typed_data_response_invalid");
  }
  const row = value.session;
  const keys = ["id", "harness", "title", "title_source", "first_event_at", "last_event_at",
    "window_first_event_at", "window_last_event_at", "lifetime_first_event_at", "lifetime_last_event_at", "event_count",
    "tokens", "model_ids", "model_coverage"];
  if (!exact(row, keys) || typeof row.id !== "string" || !/^sr_[a-f0-9]{32}$/i.test(row.id)
      || typeof row.harness !== "string" || !ID.test(row.harness)
      || (row.title !== null && (typeof row.title !== "string" || Array.from(row.title).length > 256))
      || (row.title_source !== null && (typeof row.title_source !== "string" || row.title_source.length > 100))
      || ![row.first_event_at, row.last_event_at, row.window_first_event_at, row.window_last_event_at].every(item => typeof item === "string" && Number.isFinite(Date.parse(item)))
      || (row.lifetime_first_event_at !== null && (typeof row.lifetime_first_event_at !== "string" || !Number.isFinite(Date.parse(row.lifetime_first_event_at))))
      || (row.lifetime_last_event_at !== null && (typeof row.lifetime_last_event_at !== "string" || !Number.isFinite(Date.parse(row.lifetime_last_event_at))))
      || !safeCount(row.event_count)
      || !isRecord(row.tokens) || !exact(row.tokens, ["input", "output", "total", "uncached_input", "cache_read", "cache_write"])
      || Object.values(row.tokens).some(item => !safeCount(item)) || !Array.isArray(row.model_ids)
      || row.model_ids.some(item => typeof item !== "string" || !MODEL_ID.test(item))
      || !isRecord(row.model_coverage) || !exact(row.model_coverage, ["unknown_model_usage_events", "legacy_usage_events"])
      || !safeCount(row.model_coverage.unknown_model_usage_events) || !safeCount(row.model_coverage.legacy_usage_events)) throw new Error("typed_data_response_invalid");
  if (row.id !== value.sessionRef) throw new Error("typed_data_response_invalid");
  return value as unknown as TypedSessionDetailV1;
}

function parseSessionExcerpts(value: unknown, expectedSessionRef: string, days: TypedSessionWindowV1): TypedSessionExcerptsV1 {
  if (!isRecord(value) || !exact(value, ["schema", "dataRevision", "windowDays", "window", "sessionRef", "excerpts", "excerptScope", "excerptAvailability"])
      || value.schema !== "session-excerpts:v1" || !safeCount(value.dataRevision) || value.windowDays !== days
      || !isRecord(value.window) || !exact(value.window, ["fromMs", "toMs"]) || !safeCount(value.window.fromMs) || !safeCount(value.window.toMs)
      || value.window.toMs - value.window.fromMs !== days * 86_400_000
      || value.sessionRef !== expectedSessionRef || value.excerptScope !== "session_lifetime"
      || !Array.isArray(value.excerpts) || value.excerpts.length > 2 || !isRecord(value.excerptAvailability)
      || !exact(value.excerptAvailability, ["available", "reason"]) || typeof value.excerptAvailability.available !== "boolean"
      || (value.excerptAvailability.reason !== null && typeof value.excerptAvailability.reason !== "string")) throw new Error("typed_data_response_invalid");
  const excerpts = value.excerpts.map(item => {
    if (!isRecord(item) || !exact(item, ["role", "text", "provenance", "is_excerpt", "scope", "excerpt_at"])
        || !["user_first", "user_turn"].includes(String(item.role)) || typeof item.text !== "string" || Array.from(item.text).length > 512
        || typeof item.provenance !== "string" || item.provenance.length > 64 || item.is_excerpt !== true
        || item.scope !== "session_lifetime" || item.excerpt_at !== null) throw new Error("typed_data_response_invalid");
    return item;
  });
  if (value.excerptAvailability.available !== (excerpts.length > 0)) throw new Error("typed_data_response_invalid");
  return { ...value, excerpts } as unknown as TypedSessionExcerptsV1;
}

const SESSION_COST_FIELDS: readonly TypedSessionCostFieldV1[] = [
  "cost.status", "cost.reason", "cost.has_unresolved", "cost.complete", "cost.cost_minor", "cost.coverage",
  "cost.pricing_versions", "cost.reference_prices", "cost.pricing_sources", "cost.breakdown",
];

function parseSessionCost(value: unknown, fields: readonly TypedSessionCostFieldV1[], sessionRef: string,
  days: TypedSessionWindowV1, expectedRevision?: number): TypedSessionCostV1 {
  const required = ["schema", "dataRevision", "windowDays", "window", "sessionRef", "cost"];
  if (!isRecord(value) || !exact(value, required) || value.schema !== "session-cost:v1" || !safeCount(value.dataRevision)
      || (expectedRevision !== undefined && value.dataRevision !== expectedRevision) || value.windowDays !== days
      || value.sessionRef !== sessionRef || !isRecord(value.window) || !exact(value.window, ["fromMs", "toMs"])
      || !safeCount(value.window.fromMs) || !safeCount(value.window.toMs) || value.window.toMs - value.window.fromMs !== days * 86_400_000
      || !isRecord(value.cost)) throw new Error("typed_data_response_invalid");
  const cost = value.cost;
  const allowed = fields.map(field => field.slice("cost.".length));
  if (Object.keys(cost).some(key => !allowed.includes(key))) throw new Error("typed_data_response_invalid");
  if (allowed.includes("status") && !["estimated", "subscription", "unpriced", "unavailable"].includes(String(cost.status))) throw new Error("typed_data_response_invalid");
  if (allowed.includes("reason") && (typeof cost.reason !== "string" || cost.reason.length > 160)) throw new Error("typed_data_response_invalid");
  if (allowed.includes("has_unresolved") && typeof cost.has_unresolved !== "boolean") throw new Error("typed_data_response_invalid");
  if (allowed.includes("complete") && typeof cost.complete !== "boolean") throw new Error("typed_data_response_invalid");
  if (allowed.includes("cost_minor") && cost.cost_minor !== null) {
    if (!isRecord(cost.cost_minor) || !exact(cost.cost_minor, ["amount_minor", "currency", "basis"])
        || !safeCount(cost.cost_minor.amount_minor) || typeof cost.cost_minor.currency !== "string" || !/^[A-Z]{3}$/.test(cost.cost_minor.currency)
        || typeof cost.cost_minor.basis !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(cost.cost_minor.basis)) throw new Error("typed_data_response_invalid");
  }
  if (allowed.includes("coverage")) {
    const coverageFields = ["priced_tokens", "subscription_tokens", "unpriced_tokens", "legacy_tokens"];
    if (!isRecord(cost.coverage) || !exact(cost.coverage, coverageFields)
        || Object.values(cost.coverage).some(item => !safeCount(item))) throw new Error("typed_data_response_invalid");
  }
  if (allowed.includes("pricing_versions") && (!Array.isArray(cost.pricing_versions) || cost.pricing_versions.length > 64
      || cost.pricing_versions.some(item => typeof item !== "string" || item.length < 1 || item.length > 100))) throw new Error("typed_data_response_invalid");
  if (allowed.includes("pricing_sources") && (!Array.isArray(cost.pricing_sources) || cost.pricing_sources.length > 64
      || cost.pricing_sources.some(item => typeof item !== "string" || item.length < 1 || item.length > 100))) throw new Error("typed_data_response_invalid");
  if (allowed.includes("reference_prices") && (!Array.isArray(cost.reference_prices) || cost.reference_prices.length > 64
      || cost.reference_prices.some(item => !isRecord(item) || !exact(item, ["pricing_version", "captured_at_ms"])
        || typeof item.pricing_version !== "string" || item.pricing_version.length < 1 || item.pricing_version.length > 100
        || !safeCount(item.captured_at_ms)))) throw new Error("typed_data_response_invalid");
  if (allowed.includes("breakdown") && (!Array.isArray(cost.breakdown) || cost.breakdown.length > 256
      || cost.breakdown.some(item => !isRecord(item) || !exact(item, ["amount_minor", "currency", "basis"])
        || !safeCount(item.amount_minor) || typeof item.currency !== "string" || !/^[A-Z]{3}$/.test(item.currency)
        || typeof item.basis !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(item.basis)))) throw new Error("typed_data_response_invalid");
  return value as unknown as TypedSessionCostV1;
}

function parseSessionSourceStatus(value: unknown, fields: readonly TypedSessionSourceStatusFieldV1[], references: readonly string[],
  days: TypedSessionWindowV1, expectedRevision?: number): TypedSessionSourceStatusV1 {
  if (!fields.includes("source.stable_ref")) throw new Error("typed_data_response_invalid");
  if (!isRecord(value) || !exact(value, ["schema", "dataRevision", "windowDays", "window", "sources"])
      || value.schema !== "session-source-status:v1" || !safeCount(value.dataRevision)
      || (expectedRevision !== undefined && value.dataRevision !== expectedRevision) || value.windowDays !== days
      || !isRecord(value.window) || !exact(value.window, ["fromMs", "toMs"]) || !safeCount(value.window.fromMs)
      || !safeCount(value.window.toMs) || value.window.toMs - value.window.fromMs !== days * 86_400_000
      || !Array.isArray(value.sources) || value.sources.length !== references.length) throw new Error("typed_data_response_invalid");
  const allowed = fields.map(field => field.slice("source.".length));
  const sources = value.sources.map((item, index) => {
    if (!isRecord(item) || Object.keys(item).some(key => !allowed.includes(key))
        || item.stable_ref !== references[index] && allowed.includes("stable_ref")) throw new Error("typed_data_response_invalid");
    if (allowed.includes("stable_ref") && (typeof item.stable_ref !== "string" || !/^srp_[a-f0-9]{32}$/i.test(item.stable_ref))) throw new Error("typed_data_response_invalid");
    if (allowed.includes("state") && !["active", "deleted", "missing"].includes(String(item.state))) throw new Error("typed_data_response_invalid");
    if (allowed.includes("has_usage_in_window") && item.has_usage_in_window !== null && typeof item.has_usage_in_window !== "boolean") throw new Error("typed_data_response_invalid");
    return item;
  });
  return { ...value, sources } as unknown as TypedSessionSourceStatusV1;
}

function parseCityLegacyExportPage(value: unknown, limit: number, requestedSource?: TypedCityLegacyExportSourceV1): TypedCityLegacyExportPageV1 {
  const sources: readonly TypedCityLegacyExportSourceV1[] = ["registry.save_refs", "registry.game_links",
    "building.overrides", "building.claims", "building.squad_mailbox"];
  const columns: Record<TypedCityLegacyExportSourceV1, readonly string[]> = {
    "registry.save_refs": ["save_id", "asset_ref"],
    "registry.game_links": ["id", "revision", "document"],
    "building.overrides": ["asset_ref", "revision", "kit_version", "model_json", "updated_at_ms"],
    "building.claims": ["session_id", "asset_ref", "agent_id", "agent_name", "expires_at", "updated_at"],
    "building.squad_mailbox": ["document"],
  };
  const cursorPattern = /^v1:[a-f0-9]{64}\.[a-f0-9]{64}:\d{1,3}:\d{1,16}$/;
  if (!isRecord(value) || !exact(value, ["schema", "consistency", "sourceRevision", "records", "nextCursor"])
      || value.schema !== "city-legacy-export:v1"
      || value.consistency !== "independent-sqlite-version-vector"
      || typeof value.sourceRevision !== "string" || !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(value.sourceRevision)
      || !Array.isArray(value.records) || value.records.length > limit
      || (value.nextCursor !== null && (typeof value.nextCursor !== "string" || value.nextCursor.length > 180 || !cursorPattern.test(value.nextCursor)))) {
    throw new Error("typed_data_response_invalid");
  }
  for (const record of value.records) {
    if (!isRecord(record) || !exact(record, ["source", "columns", "values"])
        || typeof record.source !== "string" || !sources.includes(record.source as TypedCityLegacyExportSourceV1)
        || !Array.isArray(record.values) || !Array.isArray(record.columns)) throw new Error("typed_data_response_invalid");
    const source = record.source as TypedCityLegacyExportSourceV1;
    if ((requestedSource !== undefined && source !== requestedSource)
        || record.values.length !== columns[source].length || JSON.stringify(record.columns) !== JSON.stringify(columns[source])
        || record.values.some(item => item !== null && typeof item !== "string" && typeof item !== "number")
        || (source === "building.overrides"
          && (typeof record.values[0] !== "string" || !/^ca_[a-fA-F0-9]{32}$/.test(record.values[0])))) {
      throw new Error("typed_data_response_invalid");
    }
  }
  return value as unknown as TypedCityLegacyExportPageV1;
}

function parseCityAssetCrosswalk(value: unknown, requested: readonly string[], dataRevision: number,
  sourceRevision: string): TypedCityAssetCrosswalkV1 {
  if (!isRecord(value) || !exact(value, ["schema", "dataRevision", "sourceRevision", "pairs", "unresolved"])
      || value.schema !== "city-asset-crosswalk:v1" || value.dataRevision !== dataRevision
      || value.sourceRevision !== sourceRevision || !Array.isArray(value.pairs) || !Array.isArray(value.unresolved)
      || value.pairs.length + value.unresolved.length !== requested.length) throw new Error("typed_data_response_invalid");
  const requestedSet = new Set(requested);
  const seen = new Set<string>();
  const pairs = value.pairs.map((pair) => {
    if (!isRecord(pair) || !exact(pair, ["asset_ref", "stable_ref"])
        || typeof pair.asset_ref !== "string" || !requestedSet.has(pair.asset_ref)
        || !/^ca_[0-9a-f]{32}$/.test(pair.asset_ref) || seen.has(pair.asset_ref)
        || typeof pair.stable_ref !== "string" || !/^srp_[a-f0-9]{32}$/.test(pair.stable_ref)) {
      throw new Error("typed_data_response_invalid");
    }
    seen.add(pair.asset_ref);
    return { asset_ref: pair.asset_ref, stable_ref: pair.stable_ref };
  });
  const unresolved = value.unresolved.map((reference) => {
    if (typeof reference !== "string" || !requestedSet.has(reference) || !/^ca_[0-9a-f]{32}$/.test(reference)
        || seen.has(reference)) throw new Error("typed_data_response_invalid");
    seen.add(reference);
    return reference;
  });
  if (seen.size !== requested.length || !safeCount(value.dataRevision)
      || typeof value.sourceRevision !== "string" || !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(value.sourceRevision)) {
    throw new Error("typed_data_response_invalid");
  }
  return { schema: "city-asset-crosswalk:v1", dataRevision, sourceRevision, pairs, unresolved };
}

/**
 * Generic, descriptor-scoped access to a bounded typed dataset. The host
 * supplies instance identity and transport; callers never receive SQL access.
 */
export function createTypedDataClient(
  instanceId: string,
  send: (request: PluginRequestV1) => Promise<PluginResponseV1>,
) {
  let sequence = 0;
  return {
    async readCityLegacyStorePage(input: { cursor?: string | null; limit?: number; source?: TypedCityLegacyExportSourceV1 }) {
      const limit = input?.limit ?? 100;
      const cursor = input?.cursor ?? null;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500
          || (input.source !== undefined && !["registry.save_refs", "registry.game_links",
            "building.overrides", "building.claims", "building.squad_mailbox"].includes(input.source))
          || (cursor !== null && (typeof cursor !== "string" || cursor.length > 180
            || !/^v1:[a-f0-9]{64}\.[a-f0-9]{64}:\d{1,3}:\d{1,16}$/.test(cursor)))) throw new Error("typed_data_request_invalid");
      const requestId = `typed-data-${++sequence}`;
      const response = await send({ version: 1, instanceId, requestId, method: "typed-data.read", payload: {
        dataset: "city-legacy-store", version: 1, cursor, limit, ...(input.source === undefined ? {} : { source: input.source }),
      } });
      if (response.version !== 1 || response.requestId !== requestId) throw new Error("plugin_response_invalid");
      if (!response.ok || !response.result) throw new Error(response.error?.code ?? "plugin_request_failed");
      return parseCityLegacyExportPage(response.result, limit, input.source);
    },
    async readCityAssetCrosswalk(input: { assetRefs: readonly string[]; sourceRevision: string; dataRevision: number }) {
      if (!input || !Array.isArray(input.assetRefs) || input.assetRefs.length === 0 || input.assetRefs.length > 4_000
          || input.assetRefs.some((reference) => typeof reference !== "string" || !/^ca_[0-9a-f]{32}$/.test(reference))
          || new Set(input.assetRefs).size !== input.assetRefs.length
          || !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(input.sourceRevision) || !safeCount(input.dataRevision)) {
        throw new Error("typed_data_request_invalid");
      }
      const requestId = `typed-data-${++sequence}`;
      const response = await send({ version: 1, instanceId, requestId, method: "typed-data.read", payload: {
        dataset: "city-asset-crosswalk", version: 1, assetRefs: [...input.assetRefs],
        sourceRevision: input.sourceRevision, dataRevision: input.dataRevision,
      } });
      if (response.version !== 1 || response.requestId !== requestId) throw new Error("plugin_response_invalid");
      if (!response.ok || !response.result) throw new Error(response.error?.code ?? "plugin_request_failed");
      return parseCityAssetCrosswalk(response.result, input.assetRefs, input.dataRevision, input.sourceRevision);
    },
    async readSessions(input: { harnessId: string; windowDays: TypedSessionWindowV1; fields: readonly TypedSessionFieldV1[]; offset?: number; limit?: number }) {
      if (!input || !ID.test(input.harnessId) || ![7, 30, 90, 366].includes(input.windowDays)
          || !Array.isArray(input.fields) || input.fields.length === 0 || input.fields.length > FIELDS.length
          || input.fields.some(field => !FIELDS.includes(field)) || new Set(input.fields).size !== input.fields.length) {
        throw new Error("typed_data_request_invalid");
      }
      const limit = input.limit ?? 100;
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0 || offset > 500) throw new Error("typed_data_request_invalid");
      const requestId = `typed-data-${++sequence}`;
      const response = await send({ version: 1, instanceId, requestId, method: "typed-data.read", payload: {
        dataset: "harness-sessions", version: 1, fields: [...input.fields],
        query: { harnessId: input.harnessId, windowDays: input.windowDays, offset, limit },
      } });
      if (response.version !== 1 || response.requestId !== requestId) throw new Error("plugin_response_invalid");
      if (!response.ok || !response.result) throw new Error(response.error?.code ?? "plugin_request_failed");
      return parseResponse(response.result, input.fields, input.harnessId, input.windowDays, offset, limit);
    },
    async readSessionsPage(input: { harnessId: string; windowDays: TypedSessionWindowV1; fields: readonly TypedSessionFieldV1[]; offset?: number; limit?: number; toMs?: number; dataRevision?: number }) {
      if (!input || !ID.test(input.harnessId) || ![7, 30, 90, 366].includes(input.windowDays)
          || !Array.isArray(input.fields) || input.fields.length === 0 || input.fields.length > FIELDS.length
          || input.fields.some(field => !FIELDS.includes(field)) || new Set(input.fields).size !== input.fields.length) {
        throw new Error("typed_data_request_invalid");
      }
      const limit = input.limit ?? 100;
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0 || offset + limit > 4_000
          || (input.toMs !== undefined && !safeCount(input.toMs))
          || (input.dataRevision !== undefined && !safeCount(input.dataRevision))
          || ((input.toMs === undefined) !== (input.dataRevision === undefined))
          || (offset > 0 && (input.toMs === undefined || input.dataRevision === undefined))) throw new Error("typed_data_request_invalid");
      const requestId = `typed-data-${++sequence}`;
      const response = await send({ version: 1, instanceId, requestId, method: "typed-data.read", payload: {
        dataset: "harness-sessions", version: 2, fields: [...input.fields],
        query: { harnessId: input.harnessId, windowDays: input.windowDays, offset, limit,
          toMs: input.toMs ?? null, dataRevision: input.dataRevision ?? null },
      } });
      if (response.version !== 1 || response.requestId !== requestId) throw new Error("plugin_response_invalid");
      if (!response.ok || !response.result) throw new Error(response.error?.code ?? "plugin_request_failed");
      return parsePageV2(response.result, input.fields, input.harnessId, input.windowDays, offset, limit);
    },
    async readSessionsLayoutPage(input: { windowDays: TypedSessionWindowV1; fields: readonly TypedSessionFieldV3[]; offset?: number; limit?: number; toMs?: number; dataRevision?: number }) {
      if (!input || ![7, 30, 90, 366].includes(input.windowDays)
          || !Array.isArray(input.fields) || input.fields.length === 0 || input.fields.length > FIELDS_V3.length
          || input.fields.some(field => !FIELDS_V3.includes(field)) || new Set(input.fields).size !== input.fields.length) throw new Error("typed_data_request_invalid");
      const limit = input.limit ?? 100;
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0 || offset + limit > 4_000
          || (input.toMs !== undefined && !safeCount(input.toMs)) || (input.dataRevision !== undefined && !safeCount(input.dataRevision))
          || ((input.toMs === undefined) !== (input.dataRevision === undefined))
          || (offset > 0 && (input.toMs === undefined || input.dataRevision === undefined))) throw new Error("typed_data_request_invalid");
      const requestId = `typed-data-${++sequence}`;
      const response = await send({ version: 1, instanceId, requestId, method: "typed-data.read", payload: {
        dataset: "harness-sessions", version: 3, fields: [...input.fields],
        query: { windowDays: input.windowDays, offset, limit, toMs: input.toMs ?? null, dataRevision: input.dataRevision ?? null },
      } });
      if (response.version !== 1 || response.requestId !== requestId) throw new Error("plugin_response_invalid");
      if (!response.ok || !response.result) throw new Error(response.error?.code ?? "plugin_request_failed");
      return parsePageV3(response.result, input.fields, input.windowDays, offset, limit);
    },
    async readSessionsLayoutPageV4(input: { windowDays: TypedSessionWindowV1; fields: readonly TypedSessionFieldV4[]; offset?: number; limit?: number; toMs?: number; dataRevision?: number }) {
      if (!input || ![7, 30, 90, 366].includes(input.windowDays)
          || !Array.isArray(input.fields) || input.fields.length === 0 || input.fields.length > FIELDS_V4.length
          || input.fields.some(field => !FIELDS_V4.includes(field)) || new Set(input.fields).size !== input.fields.length) throw new Error("typed_data_request_invalid");
      const limit = input.limit ?? 100;
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0 || offset + limit > 4_000
          || (input.toMs !== undefined && !safeCount(input.toMs)) || (input.dataRevision !== undefined && !safeCount(input.dataRevision))
          || ((input.toMs === undefined) !== (input.dataRevision === undefined))
          || (offset > 0 && (input.toMs === undefined || input.dataRevision === undefined))) throw new Error("typed_data_request_invalid");
      const requestId = `typed-data-${++sequence}`;
      const response = await send({ version: 1, instanceId, requestId, method: "typed-data.read", payload: {
        dataset: "harness-sessions", version: 4, fields: [...input.fields],
        query: { windowDays: input.windowDays, offset, limit, toMs: input.toMs ?? null, dataRevision: input.dataRevision ?? null },
      } });
      if (response.version !== 1 || response.requestId !== requestId) throw new Error("plugin_response_invalid");
      if (!response.ok || !response.result) throw new Error(response.error?.code ?? "plugin_request_failed");
      return parsePageV4(response.result, input.fields, input.windowDays, offset, limit);
    },
    async readLifetimeSessionsPage(input: { fields: readonly TypedSessionFieldV5[]; offset?: number; limit?: number; dataRevision?: number }) {
      if (!input || !Array.isArray(input.fields) || input.fields.length === 0 || input.fields.length > FIELDS_V5.length
          || input.fields.some(field => !FIELDS_V5.includes(field)) || new Set(input.fields).size !== input.fields.length) {
        throw new Error("typed_data_request_invalid");
      }
      const limit = input.limit ?? 100;
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0 || offset + limit > 100_000
          || (input.dataRevision !== undefined && !safeCount(input.dataRevision))
          || (offset > 0 && input.dataRevision === undefined)) throw new Error("typed_data_request_invalid");
      const requestId = `typed-data-${++sequence}`;
      const response = await send({ version: 1, instanceId, requestId, method: "typed-data.read", payload: {
        dataset: "harness-sessions", version: 5, fields: [...input.fields],
        query: { offset, limit, dataRevision: input.dataRevision ?? null },
      } });
      if (response.version !== 1 || response.requestId !== requestId) throw new Error("plugin_response_invalid");
      if (!response.ok || !response.result) throw new Error(response.error?.code ?? "plugin_request_failed");
      return parsePageV5(response.result, input.fields, offset, limit);
    },
    async readSessionIdentityPage(input: { offset?: number; limit?: number; dataRevision?: number }) {
      const limit = input?.limit ?? 500;
      const offset = input?.offset ?? 0;
      if (!input || !Number.isSafeInteger(limit) || limit < 1 || limit > 500
          || !Number.isSafeInteger(offset) || offset < 0 || offset + limit > 100_000
          || (input.dataRevision !== undefined && !safeCount(input.dataRevision))
          || (offset > 0 && input.dataRevision === undefined)) throw new Error("typed_data_request_invalid");
      const requestId = `typed-data-${++sequence}`;
      const response = await send({ version: 1, instanceId, requestId, method: "typed-data.read", payload: {
        dataset: "harness-session-identities", version: 1,
        fields: ["session.id", "session.stable_ref"],
        query: { offset, limit, dataRevision: input.dataRevision ?? null },
      } });
      if (response.version !== 1 || response.requestId !== requestId) throw new Error("plugin_response_invalid");
      if (!response.ok || !response.result) throw new Error(response.error?.code ?? "plugin_request_failed");
      return parseSessionIdentityPage(response.result, offset, limit);
    },
    async readUsageSummary(input: { windowDays: TypedSessionWindowV1; fields: readonly TypedUsageSummaryFieldV1[]; toMs?: number; dataRevision?: number }) {
      if (!input || ![7, 30, 90, 366].includes(input.windowDays)
          || !Array.isArray(input.fields) || input.fields.length === 0 || input.fields.length > 8
          || input.fields.some(field => !["summary.session_count", "summary.usage_event_count", "summary.tokens.input", "summary.tokens.output",
            "summary.tokens.total", "summary.tokens.uncached_input", "summary.tokens.cache_read", "summary.tokens.cache_write"].includes(field))
          || new Set(input.fields).size !== input.fields.length
          || (input.toMs !== undefined && !safeCount(input.toMs)) || (input.dataRevision !== undefined && !safeCount(input.dataRevision))
          || ((input.toMs === undefined) !== (input.dataRevision === undefined))) throw new Error("typed_data_request_invalid");
      const requestId = `typed-data-${++sequence}`;
      const response = await send({ version: 1, instanceId, requestId, method: "typed-data.read", payload: {
        dataset: "usage-summary", version: 1, fields: [...input.fields],
        query: { windowDays: input.windowDays, toMs: input.toMs ?? null, dataRevision: input.dataRevision ?? null },
      } });
      if (response.version !== 1 || response.requestId !== requestId) throw new Error("plugin_response_invalid");
      if (!response.ok || !response.result) throw new Error(response.error?.code ?? "plugin_request_failed");
      return parseUsageSummary(response.result, input.fields, input.windowDays);
    },
    async readActivitySummary(input: { windowDays: TypedSessionWindowV1; timezone: string; fields: readonly TypedActivitySummaryFieldV1[]; toMs?: number; dataRevision?: number }) {
      if (!input || ![7, 30, 90, 366].includes(input.windowDays) || typeof input.timezone !== "string"
          || input.timezone.length < 1 || input.timezone.length > 128
          || !Array.isArray(input.fields) || input.fields.length === 0 || input.fields.length > 4
          || input.fields.some(field => !["activity.date", "activity.session_count", "activity.event_count", "activity.tokens"].includes(field))
          || new Set(input.fields).size !== input.fields.length
          || (input.toMs !== undefined && !safeCount(input.toMs)) || (input.dataRevision !== undefined && !safeCount(input.dataRevision))
          || ((input.toMs === undefined) !== (input.dataRevision === undefined))) throw new Error("typed_data_request_invalid");
      const requestId = `typed-data-${++sequence}`;
      const response = await send({ version: 1, instanceId, requestId, method: "typed-data.read", payload: {
        dataset: "activity-summary", version: 1, fields: [...input.fields],
        query: { windowDays: input.windowDays, timezone: input.timezone, toMs: input.toMs ?? null, dataRevision: input.dataRevision ?? null },
      } });
      if (response.version !== 1 || response.requestId !== requestId) throw new Error("plugin_response_invalid");
      if (!response.ok || !response.result) throw new Error(response.error?.code ?? "plugin_request_failed");
      return parseActivitySummary(response.result, input.fields, input.windowDays);
    },
    async readModelUsage(input: { windowDays: TypedSessionWindowV1; fields: readonly TypedModelUsageFieldV1[]; toMs?: number; dataRevision?: number }) {
      const allowed: TypedModelUsageFieldV1[] = ["model.model_id", "model.usage_event_count", "model.legacy_usage_event_count",
        "model.tokens.input", "model.tokens.output", "model.tokens.total", "model.tokens.uncached_input", "model.tokens.cache_read",
        "model.tokens.cache_write", "coverage.unknown_model_usage_events", "coverage.legacy_usage_events", "scope", "pricing_independent"];
      if (!input || ![7, 30, 90, 366].includes(input.windowDays) || !Array.isArray(input.fields)
          || input.fields.length === 0 || input.fields.length > allowed.length
          || input.fields.some(field => !allowed.includes(field)) || new Set(input.fields).size !== input.fields.length
          || (input.toMs !== undefined && !safeCount(input.toMs)) || (input.dataRevision !== undefined && !safeCount(input.dataRevision))
          || ((input.toMs === undefined) !== (input.dataRevision === undefined))) throw new Error("typed_data_request_invalid");
      const requestId = `typed-data-${++sequence}`;
      const response = await send({ version: 1, instanceId, requestId, method: "typed-data.read", payload: {
        dataset: "model-usage", version: 1, fields: [...input.fields],
        query: { windowDays: input.windowDays, toMs: input.toMs ?? null, dataRevision: input.dataRevision ?? null },
      } });
      if (response.version !== 1 || response.requestId !== requestId) throw new Error("plugin_response_invalid");
      if (!response.ok || !response.result) throw new Error(response.error?.code ?? "plugin_request_failed");
      return parseModelUsage(response.result, input.fields, input.windowDays);
    },
    async readTimeCoverage(input: { fields: readonly TypedTimeCoverageFieldV1[]; dataRevision?: number }) {
      const allowed: TypedTimeCoverageFieldV1[] = ["coverage.scope", "coverage.unknown_time_only", "coverage.mixed_time", "coverage.excluded_no_usage"];
      if (!input || !Array.isArray(input.fields) || input.fields.length === 0 || input.fields.length > allowed.length
          || input.fields.some(field => !allowed.includes(field)) || new Set(input.fields).size !== input.fields.length
          || (input.dataRevision !== undefined && !safeCount(input.dataRevision))) throw new Error("typed_data_request_invalid");
      const requestId = `typed-data-${++sequence}`;
      const response = await send({ version: 1, instanceId, requestId, method: "typed-data.read", payload: {
        dataset: "time-coverage", version: 1, fields: [...input.fields],
        query: { dataRevision: input.dataRevision ?? null },
      } });
      if (response.version !== 1 || response.requestId !== requestId) throw new Error("plugin_response_invalid");
      if (!response.ok || !response.result) throw new Error(response.error?.code ?? "plugin_request_failed");
      return parseTimeCoverage(response.result, input.fields);
    },
    async readFindingSummary(input: { windowDays: TypedSessionWindowV1; fields: readonly TypedFindingSummaryFieldV1[]; toMs?: number; dataRevision?: number }) {
      const allowed: TypedFindingSummaryFieldV1[] = ["findings.current_backlog.harness_id", "findings.current_backlog.severity",
        "findings.current_backlog.count", "findings.window_new.harness_id", "findings.window_new.severity", "findings.window_new.count",
        "capabilities.harness_id", "capabilities.available", "capabilities.reason"];
      if (!input || ![7, 30, 90, 366].includes(input.windowDays) || !Array.isArray(input.fields)
          || input.fields.length === 0 || input.fields.length > allowed.length
          || input.fields.some(field => !allowed.includes(field)) || new Set(input.fields).size !== input.fields.length
          || (input.toMs !== undefined && !safeCount(input.toMs)) || (input.dataRevision !== undefined && !safeCount(input.dataRevision))
          || ((input.toMs === undefined) !== (input.dataRevision === undefined))) throw new Error("typed_data_request_invalid");
      const requestId = `typed-data-${++sequence}`;
      const response = await send({ version: 1, instanceId, requestId, method: "typed-data.read", payload: {
        dataset: "finding-summary", version: 1, fields: [...input.fields],
        query: { windowDays: input.windowDays, toMs: input.toMs ?? null, dataRevision: input.dataRevision ?? null },
      } });
      if (response.version !== 1 || response.requestId !== requestId) throw new Error("plugin_response_invalid");
      if (!response.ok || !response.result) throw new Error(response.error?.code ?? "plugin_request_failed");
      return parseFindingSummary(response.result, input.fields, input.windowDays);
    },
    async readSkillUsage(input: { windowDays: TypedSessionWindowV1; fields: readonly TypedSkillUsageFieldV1[]; toMs?: number; dataRevision?: number }) {
      const allowed: TypedSkillUsageFieldV1[] = ["skill.harness_id", "skill.label", "skill.invocations", "skill.sessions", "skill.last_invoked_at_ms", "skill.finished_events", "skill.failed_events", "skill.succeeded_events"];
      if (!input || ![7, 30, 90, 366].includes(input.windowDays) || !Array.isArray(input.fields) || input.fields.length === 0
          || input.fields.length > allowed.length || input.fields.some(field => !allowed.includes(field)) || new Set(input.fields).size !== input.fields.length
          || (input.toMs !== undefined && !safeCount(input.toMs)) || (input.dataRevision !== undefined && !safeCount(input.dataRevision))
          || ((input.toMs === undefined) !== (input.dataRevision === undefined))) throw new Error("typed_data_request_invalid");
      const requestId = `typed-data-${++sequence}`;
      const response = await send({ version: 1, instanceId, requestId, method: "typed-data.read", payload: { dataset: "skill-usage-summary", version: 1,
        fields: [...input.fields], query: { windowDays: input.windowDays, toMs: input.toMs ?? null, dataRevision: input.dataRevision ?? null } } });
      if (response.version !== 1 || response.requestId !== requestId) throw new Error("plugin_response_invalid");
      if (!response.ok || !response.result) throw new Error(response.error?.code ?? "plugin_request_failed");
      return parseSkillOrWorkflow(response.result, input.fields, input.windowDays, true) as TypedSkillUsageV1;
    },
    async readWorkflowActivity(input: { windowDays: TypedSessionWindowV1; fields: readonly TypedWorkflowActivityFieldV1[]; toMs?: number; dataRevision?: number }) {
      const allowed: TypedWorkflowActivityFieldV1[] = ["event.harness_id", "event.event_type", "event.count", "event.sessions", "event.last_event_at_ms", "event.failed_events"];
      if (!input || ![7, 30, 90, 366].includes(input.windowDays) || !Array.isArray(input.fields) || input.fields.length === 0
          || input.fields.length > allowed.length || input.fields.some(field => !allowed.includes(field)) || new Set(input.fields).size !== input.fields.length
          || (input.toMs !== undefined && !safeCount(input.toMs)) || (input.dataRevision !== undefined && !safeCount(input.dataRevision))
          || ((input.toMs === undefined) !== (input.dataRevision === undefined))) throw new Error("typed_data_request_invalid");
      const requestId = `typed-data-${++sequence}`;
      const response = await send({ version: 1, instanceId, requestId, method: "typed-data.read", payload: { dataset: "workflow-activity-summary", version: 1,
        fields: [...input.fields], query: { windowDays: input.windowDays, toMs: input.toMs ?? null, dataRevision: input.dataRevision ?? null } } });
      if (response.version !== 1 || response.requestId !== requestId) throw new Error("plugin_response_invalid");
      if (!response.ok || !response.result) throw new Error(response.error?.code ?? "plugin_request_failed");
      return parseSkillOrWorkflow(response.result, input.fields, input.windowDays, false) as TypedWorkflowActivityV1;
    },
    async readSessionDetail(input: { sessionRef: string; windowDays: TypedSessionWindowV1; toMs?: number; dataRevision?: number }) {
      if (!input || typeof input.sessionRef !== "string" || !/^sr_[a-f0-9]{32}$/i.test(input.sessionRef)
          || ![7, 30, 90, 366].includes(input.windowDays)
          || (input.toMs !== undefined && !safeCount(input.toMs)) || (input.dataRevision !== undefined && !safeCount(input.dataRevision))
          || ((input.toMs === undefined) !== (input.dataRevision === undefined))) throw new Error("typed_data_request_invalid");
      const requestId = `typed-data-${++sequence}`;
      const response = await send({ version: 1, instanceId, requestId, method: "typed-data.read", payload: {
        dataset: "harness-session-detail", version: 1,
        fields: ["session.id", "session.harness_id", "session.title", "session.title_source", "session.first_event_at", "session.last_event_at",
          "session.window_first_event_at", "session.window_last_event_at", "session.lifetime_first_event_at", "session.lifetime_last_event_at",
          "session.event_count", "session.tokens.input", "session.tokens.output", "session.tokens.total", "session.tokens.uncached_input",
          "session.tokens.cache_read", "session.tokens.cache_write", "session.model_ids", "session.model_coverage"],
        query: { sessionRef: input.sessionRef, windowDays: input.windowDays, toMs: input.toMs ?? null, dataRevision: input.dataRevision ?? null },
      } });
      if (response.version !== 1 || response.requestId !== requestId) throw new Error("plugin_response_invalid");
      if (!response.ok || !response.result) throw new Error(response.error?.code ?? "plugin_request_failed");
      const detail = parseSessionDetail(response.result, input.sessionRef, input.windowDays, input.dataRevision);
      if (detail.session.id !== input.sessionRef || (input.dataRevision !== undefined && detail.dataRevision !== input.dataRevision)
          || (input.toMs !== undefined && detail.window.toMs !== input.toMs)) throw new Error("typed_data_response_invalid");
      return detail;
    },
    async readSessionExcerpts(input: { sessionRef: string; windowDays: TypedSessionWindowV1; toMs?: number; dataRevision?: number }) {
      if (!input || typeof input.sessionRef !== "string" || !/^sr_[a-f0-9]{32}$/i.test(input.sessionRef)
          || ![7, 30, 90, 366].includes(input.windowDays)
          || (input.toMs !== undefined && !safeCount(input.toMs)) || (input.dataRevision !== undefined && !safeCount(input.dataRevision))
          || ((input.toMs === undefined) !== (input.dataRevision === undefined))) throw new Error("typed_data_request_invalid");
      const requestId = `typed-data-${++sequence}`;
      const response = await send({ version: 1, instanceId, requestId, method: "typed-data.read", payload: {
        dataset: "session-excerpts", version: 1, fields: ["excerpt.role", "excerpt.text", "excerpt.provenance", "excerpt.is_excerpt", "excerpt.scope", "excerpt.excerpt_at"],
        query: { sessionRef: input.sessionRef, windowDays: input.windowDays, toMs: input.toMs ?? null, dataRevision: input.dataRevision ?? null },
      } });
      if (response.version !== 1 || response.requestId !== requestId) throw new Error("plugin_response_invalid");
      if (!response.ok || !response.result) throw new Error(response.error?.code ?? "plugin_request_failed");
      const parsed = parseSessionExcerpts(response.result, input.sessionRef, input.windowDays);
      if ((input.dataRevision !== undefined && parsed.dataRevision !== input.dataRevision)
          || (input.toMs !== undefined && parsed.window.toMs !== input.toMs)) throw new Error("typed_data_response_invalid");
      return parsed;
    },
    async readSessionCost(input: { sessionRef: string; windowDays: TypedSessionWindowV1; fields: readonly TypedSessionCostFieldV1[]; toMs?: number; dataRevision?: number }) {
      if (!input || typeof input.sessionRef !== "string" || !/^sr_[a-f0-9]{32}$/i.test(input.sessionRef)
          || ![7, 30, 90, 366].includes(input.windowDays) || !Array.isArray(input.fields) || input.fields.length === 0
          || input.fields.length > SESSION_COST_FIELDS.length || input.fields.some(field => !SESSION_COST_FIELDS.includes(field))
          || new Set(input.fields).size !== input.fields.length || (input.toMs !== undefined && !safeCount(input.toMs))
          || (input.dataRevision !== undefined && !safeCount(input.dataRevision))
          || ((input.toMs === undefined) !== (input.dataRevision === undefined))) throw new Error("typed_data_request_invalid");
      const requestId = `typed-data-${++sequence}`;
      const response = await send({ version: 1, instanceId, requestId, method: "typed-data.read", payload: {
        dataset: "session-cost", version: 1, fields: [...input.fields],
        query: { sessionRef: input.sessionRef, windowDays: input.windowDays, toMs: input.toMs ?? null, dataRevision: input.dataRevision ?? null },
      } });
      if (response.version !== 1 || response.requestId !== requestId) throw new Error("plugin_response_invalid");
      if (!response.ok || !response.result) throw new Error(response.error?.code ?? "plugin_request_failed");
      return parseSessionCost(response.result, input.fields, input.sessionRef, input.windowDays, input.dataRevision);
    },
    async readSessionSourceStatus(input: { references: readonly string[]; windowDays: TypedSessionWindowV1; fields: readonly TypedSessionSourceStatusFieldV1[]; toMs?: number; dataRevision?: number }) {
      const allowed: readonly TypedSessionSourceStatusFieldV1[] = ["source.stable_ref", "source.state", "source.has_usage_in_window"];
      if (!input || ![7, 30, 90, 366].includes(input.windowDays) || !Array.isArray(input.references) || input.references.length > 200
          || input.references.some(reference => typeof reference !== "string" || !/^srp_[a-f0-9]{32}$/i.test(reference))
          || new Set(input.references).size !== input.references.length || !Array.isArray(input.fields) || input.fields.length === 0
          || input.fields.length > allowed.length || input.fields.some(field => !allowed.includes(field)) || new Set(input.fields).size !== input.fields.length
          || !input.fields.includes("source.stable_ref")
          || (input.toMs !== undefined && !safeCount(input.toMs)) || (input.dataRevision !== undefined && !safeCount(input.dataRevision))
          || ((input.toMs === undefined) !== (input.dataRevision === undefined))) throw new Error("typed_data_request_invalid");
      const requestId = `typed-data-${++sequence}`;
      const response = await send({ version: 1, instanceId, requestId, method: "typed-data.read", payload: {
        dataset: "session-source-status", version: 1, fields: [...input.fields],
        query: { windowDays: input.windowDays, toMs: input.toMs ?? null, dataRevision: input.dataRevision ?? null, references: [...input.references] },
      } });
      if (response.version !== 1 || response.requestId !== requestId) throw new Error("plugin_response_invalid");
      if (!response.ok || !response.result) throw new Error(response.error?.code ?? "plugin_request_failed");
      return parseSessionSourceStatus(response.result, input.fields, input.references, input.windowDays, input.dataRevision);
    },
  };
}
