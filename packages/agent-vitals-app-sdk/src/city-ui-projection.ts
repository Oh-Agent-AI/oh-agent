/** Official same-host City MVP contract. Not the legacy paginated app-local schema. */
import type { HarnessPublicIdentityV1 } from "./harness-data.js";
export type CityUiProjectionV2 = {
  protocol: "city:v2";
  harnesses: HarnessPublicIdentityV1[];
  source?: "local" | "fixture";
  data_revision?: number;
  generated_at: string | null;
  window: { days: 7 | 30 | 90 | 366; label: string; from: string; to: string };
  sessions: Array<{
    id: string;
    harness: string;
    /** 会话标题（V32，City 楼名）：codex thread_name / claude ai-title /
     *  dsh workspace title 的已脱敏、已截断投影；null = 无标题证据（UI 走
     *  fallback 命名）。本地 app 投影专用，不进 MCP/export 面。 */
    title?: string | null;
    /** Controlled source token, open to registered Harness extractors; missing evidence is null. */
    title_source?: string | null;
    asset_ref?: string;
    window_first_event_at?: string;
    window_last_event_at?: string;
    lifetime_first_event_at?: string | null;
    lifetime_last_event_at?: string | null;
    excerpt_scope?: string;
    first_event_at: string;
    last_event_at: string;
    tokens: { input: number; uncached_input?: number; cache_read?: number; cache_write?: number; output: number; total: number };
    model_ids?: string[];
    /** Metered estimate only; null means unavailable/unpriced/subscription. */
    cost_minor?: { amount_minor: number; currency: string; basis: string; pricing_versions?: string[]; pricing_source?: string; evidence_basis?: string; has_unresolved?: boolean } | null;
    cost_breakdown?: Array<{ amount_minor: number; currency: string; basis: string }>;
    cost_complete?: boolean;
    cost_reference_prices?: Array<{ pricing_version: string; captured_at_ms: number }>;
    cost_status?: { state: "estimated" | "subscription" | "unpriced" | "unavailable"; reason: string; has_unresolved: boolean };
    event_count?: number;
    task_excerpts?: Array<{ role: "user_first" | "user_turn"; text: string; provenance: "verbatim" | "truncated" | "scrubbed"; is_excerpt: true }>;
  }>;
  v3_context?: CitySnapshotV3;
  summary?: { session_count: number; usage_event_count: number; tokens: { input: number; output: number; total: number; uncached_input?: number; cache_read?: number; cache_write?: number } };
  model_coverage?: { unknown_model_usage_events: number; legacy_usage_events: number };
  models?: string[];
  activity?: { timezone?: string; days: Array<{ date: string; session_count: number; event_count: number; tokens: number }>; busiest_day: { date: string; session_count: number; event_count: number; tokens: number } | null };
  findings: Array<{ harness: string; severity: "critical" | "warning" | "info"; count: number }>;
  coverage: { total: number; returned: number; truncated: boolean; unknown_time: number; findings_state?: "unavailable" | "partial"; time_classification?: { scope: string; unknown_time_only: number; mixed_time: number; excluded_no_usage: number } };
  status: "ready" | "empty" | "stale" | "unavailable";
};

export type CityWindowV3 = { days: 7 | 30 | 90 | 366; from_ms: number; to_ms: number; from: string; to: string; timezone: string; calendar_mode: "rolling"; boundary: "half_open" };
export type CitySnapshotV3 = { data_revision: number; snapshot: string; context: string; query_semantics: "city-window-v3.1"; window: CityWindowV3 };
export type CitySessionV3 = CityUiProjectionV2["sessions"][number] & {
  asset_ref: string; layout_order: number; usage_event_count: number; title_state: "available" | "unavailable";
  window_first_event_at: string; window_last_event_at: string; lifetime_first_event_at: string | null; lifetime_last_event_at: string | null;
};
export type CityModuleV3 = { state: "ready" | "empty" | "unsupported" | "unavailable" | "stale"; supported: boolean; reason?: string; data?: Record<string, unknown>; freshness?: { read_at: string; source_state: "unknown"; reason: string } };
export type CityProjectionV3 = CitySnapshotV3 & {
  protocol: "city:v3"; source: "local"; generated_at: string;
  harnesses?: HarnessPublicIdentityV1[];
  page?: { sessions: CitySessionV3[]; next_cursor: string | null; coverage: { matched: number; returned: number; offset: number; has_more: boolean; render_budget: number; selection: string; order: string } };
  modules?: Record<"overview" | "activity" | "findings" | "skills" | "workflow", CityModuleV3>;
  detail?: CitySessionV3 & { cost: { cost_minor: CityUiProjectionV2["sessions"][number]["cost_minor"]; status: "estimated" | "subscription" | "unpriced" | "unavailable"; reason: string; has_unresolved: boolean; complete: boolean; reference_prices?: Array<{ pricing_version: string; captured_at_ms: number }>; breakdown: Array<{ amount_minor: number; currency: string; basis: string }> }; excerpt_scope?: "session_lifetime_not_window" };
  module?: "findings" | "skills" | "workflow";
  result?: CityModuleV3 | Record<string, unknown>;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("city_projection_invalid");
  return value as Record<string, unknown>;
}
function integer(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("city_numeric_invalid");
}
function safeTree(value: unknown, depth = 0): void {
  if (depth > 20) throw new Error("city_projection_invalid");
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("city_numeric_invalid");
  if (Array.isArray(value)) { if (value.length > 32000) throw new Error("city_projection_invalid"); for (const item of value) safeTree(item, depth + 1); }
  else if (value && typeof value === "object") for (const item of Object.values(value)) safeTree(item, depth + 1);
}
function sessions(value: unknown, cap: number): void {
  if (!Array.isArray(value) || value.length > cap) throw new Error("city_sessions_invalid");
  for (const raw of value) {
    const row = object(raw), tokens = object(row.tokens);
    if (typeof row.id !== "string" || typeof row.harness !== "string" || typeof row.first_event_at !== "string" || typeof row.last_event_at !== "string") throw new Error("city_session_invalid");
    for (const key of ["input", "output", "total"]) integer(tokens[key]);
    if ((tokens.input as number) + (tokens.output as number) !== tokens.total) throw new Error("city_tokens_invalid");
    if (["uncached_input", "cache_read", "cache_write"].some((key) => tokens[key] !== undefined)) {
      for (const key of ["uncached_input", "cache_read", "cache_write"]) integer(tokens[key]);
      if ((tokens.uncached_input as number)+(tokens.cache_read as number)+(tokens.cache_write as number)!==tokens.input) throw new Error("city_tokens_invalid");
    }
    if (!Number.isFinite(Date.parse(row.first_event_at as string)) || !Number.isFinite(Date.parse(row.last_event_at as string))
      || Date.parse(row.first_event_at as string)>Date.parse(row.last_event_at as string)) throw new Error("city_time_invalid");
    if (row.title != null && (typeof row.title !== "string" || Array.from(row.title).length > 256)) throw new Error("city_title_invalid");
    if (row.title_source != null && (typeof row.title_source !== "string" || !/^[a-zA-Z0-9_:.-]{1,100}$/.test(row.title_source))) throw new Error("city_title_source_invalid");
    if (row.model_ids !== undefined && (!Array.isArray(row.model_ids) || row.model_ids.some((id) => typeof id !== "string"))) throw new Error("city_models_invalid");
  }
}
export function validateCityProjectionV2(value: unknown): CityUiProjectionV2 {
  const root = object(value); safeTree(root);
  if (root.protocol !== "city:v2" || !Array.isArray(root.harnesses) || !Array.isArray(root.findings)) throw new Error("city_projection_invalid");
  sessions(root.sessions, 4000);
  const coverage = object(root.coverage); integer(coverage.total); integer(coverage.returned);
  if (coverage.returned !== (root.sessions as unknown[]).length || (coverage.total as number) < (coverage.returned as number)) throw new Error("city_coverage_invalid");
  return value as CityUiProjectionV2;
}
export function validateCityProjectionV3(value: unknown): CityProjectionV3 {
  const root = object(value); safeTree(root);
  if (root.protocol !== "city:v3" || root.source !== "local" || root.query_semantics !== "city-window-v3.1") throw new Error("city_projection_invalid");
  integer(root.data_revision);
  for (const key of ["snapshot", "context"]) if (typeof root[key] !== "string" || !/^sr_[0-9a-f]{32}$/.test(root[key] as string)) throw new Error("city_snapshot_invalid");
  const window = object(root.window);
  if (window.boundary !== "half_open" || window.calendar_mode !== "rolling" || typeof window.timezone !== "string" || ![7,30,90,366].includes(window.days as number)) throw new Error("city_window_invalid");
  if (typeof window.from_ms !== "number" || typeof window.to_ms !== "number" || window.to_ms - window.from_ms !== (window.days as number)*86400000) throw new Error("city_window_invalid");
  if (root.page) {
    const page = object(root.page); sessions(page.sessions, 500); const coverage=object(page.coverage);
    integer(coverage.matched); integer(coverage.returned); integer(coverage.offset);
    if (coverage.returned !== (page.sessions as unknown[]).length || (coverage.offset as number)+(coverage.returned as number)>(coverage.matched as number)) throw new Error("city_coverage_invalid");
    for (const item of page.sessions as unknown[]) {
      const row=object(item); integer(row.layout_order);
      if (typeof row.asset_ref !== "string" || !/^ca_[0-9a-f]{32}$/.test(row.asset_ref)) throw new Error("city_asset_invalid");
    }
  }
  if (root.modules) for (const value of Object.values(object(root.modules))) {
    const module=object(value);
    if (!["ready","empty","unsupported","unavailable","stale"].includes(module.state as string) || typeof module.supported !== "boolean") throw new Error("city_module_invalid");
    if (module.state === "unsupported" && module.supported !== false) throw new Error("city_module_invalid");
  }
  if (root.detail) {
    sessions([root.detail], 1);
    const cost=object(object(root.detail).cost);
    if (!["estimated","subscription","unpriced","unavailable"].includes(cost.status as string) || typeof cost.reason !== "string"
      || typeof cost.has_unresolved !== "boolean" || typeof cost.complete !== "boolean" || !Array.isArray(cost.breakdown) || cost.breakdown.length>100) throw new Error("city_cost_invalid");
    if (cost.reference_prices !== undefined) {
      if (!Array.isArray(cost.reference_prices) || cost.reference_prices.length < 1 || cost.reference_prices.length > 16) throw new Error("city_cost_invalid");
      for (const item of cost.reference_prices) {
        const ref = object(item); integer(ref.captured_at_ms);
        if (typeof ref.pricing_version !== "string" || !ref.pricing_version.length || ref.pricing_version.length > 256
          || (ref.captured_at_ms as number) > 8640000000000000) throw new Error("city_cost_invalid");
      }
      if (cost.has_unresolved !== true) throw new Error("city_cost_invalid");
    }
    for (const item of cost.breakdown) { const part=object(item); integer(part.amount_minor); if (typeof part.currency !== "string" || typeof part.basis !== "string") throw new Error("city_cost_invalid"); }
  }
  if (!root.page && !root.detail && !root.result) throw new Error("city_projection_invalid");
  return value as CityProjectionV3;
}
