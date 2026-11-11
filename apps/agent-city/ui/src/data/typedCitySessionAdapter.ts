import type {
  TypedSessionDetailV1,
  TypedSessionExcerptsV1,
  TypedSessionCostFieldV1,
  TypedSessionCostV1,
  TypedSessionSourceStatusV1,
  TypedSessionFieldV3,
  TypedSessionFieldV4,
  TypedSessionResponseV3,
  TypedSessionResponseV4,
  TypedSessionIdentityV1,
  TypedSessionRowV3,
  TypedSessionRowV4,
  TypedSessionWindowV1,
  TypedActivitySummaryFieldV1,
  TypedActivitySummaryV1,
  TypedUsageSummaryFieldV1,
  TypedUsageSummaryV1,
  TypedModelUsageFieldV1,
  TypedModelUsageV1,
  TypedTimeCoverageFieldV1,
  TypedTimeCoverageV1,
  TypedFindingSummaryFieldV1,
  TypedFindingSummaryV1,
  TypedSkillUsageFieldV1,
  TypedSkillUsageV1,
  TypedWorkflowActivityFieldV1,
  TypedWorkflowActivityV1,
} from "@agent-vitals/app-sdk";
import type { PluginResponseV1 } from "@agent-vitals/app-sdk";

export const CITY_TYPED_SESSION_FIELDS = [
  "session.id",
  "session.harness_id",
  "session.title",
  "session.title_source",
  "session.window_order",
  "session.window_first_event_at_ms",
  "session.window_last_event_at_ms",
  "session.lifetime_first_event_at_ms",
  "session.lifetime_last_event_at_ms",
  "session.event_count",
  "session.tokens.input",
  "session.tokens.output",
  "session.tokens.total",
  "session.tokens.uncached_input",
  "session.tokens.cache_read",
  "session.tokens.cache_write",
  "session.model_ids",
  "session.model_coverage",
] as const satisfies readonly TypedSessionFieldV3[];
export const CITY_TYPED_STABLE_REF_FIELDS = ["session.id", "session.stable_ref"] as const satisfies readonly TypedSessionFieldV4[];

export function assertCitySourceStatusParity(
  legacyAssets: readonly { asset_ref: string; state: string }[],
  typed: TypedSessionSourceStatusV1,
  pin: { windowDays: TypedSessionWindowV1; toMs: number; fromMs: number; dataRevision: number },
): { compared: number; mismatches: number } {
  if (typed.dataRevision !== pin.dataRevision || typed.windowDays !== pin.windowDays
      || typed.window.toMs !== pin.toMs || typed.window.fromMs !== pin.fromMs
      || typed.sources.length !== legacyAssets.length) throw new Error("revision_changed");
  let mismatches = 0;
  for (let index = 0; index < legacyAssets.length; index += 1) {
    const asset = legacyAssets[index]!;
    const source = typed.sources[index]!;
    const typedState = cityAssetStateFromTypedSource(source);
    if (typedState !== asset.state) mismatches += 1;
  }
  return { compared: legacyAssets.length, mismatches };
}

export function cityAssetStateFromTypedSource(source: TypedSessionSourceStatusV1["sources"][number]): string {
  if (source.state === "active" && typeof source.has_usage_in_window === "boolean") {
    return source.has_usage_in_window ? "present" : "outside_window";
  }
  if ((source.state === "deleted" || source.state === "missing") && source.has_usage_in_window === null) {
    return source.state === "deleted" ? "source_deleted" : "orphaned";
  }
  throw new Error("typed_city_source_status_invalid");
}

export const CITY_TYPED_SUMMARY_FIELDS = [
  "summary.session_count", "summary.usage_event_count", "summary.tokens.input", "summary.tokens.output",
  "summary.tokens.total", "summary.tokens.uncached_input", "summary.tokens.cache_read", "summary.tokens.cache_write",
] as const satisfies readonly TypedUsageSummaryFieldV1[];
export const CITY_TYPED_ACTIVITY_FIELDS = [
  "activity.date", "activity.session_count", "activity.event_count", "activity.tokens",
] as const satisfies readonly TypedActivitySummaryFieldV1[];
export const CITY_TYPED_MODEL_FIELDS = [
  "model.model_id", "model.usage_event_count", "model.legacy_usage_event_count",
  "model.tokens.input", "model.tokens.output", "model.tokens.total", "model.tokens.uncached_input",
  "model.tokens.cache_read", "model.tokens.cache_write", "coverage.unknown_model_usage_events",
  "coverage.legacy_usage_events", "scope", "pricing_independent",
] as const satisfies readonly TypedModelUsageFieldV1[];
export const CITY_TYPED_TIME_COVERAGE_FIELDS = [
  "coverage.scope", "coverage.unknown_time_only", "coverage.mixed_time", "coverage.excluded_no_usage",
] as const satisfies readonly TypedTimeCoverageFieldV1[];
export const CITY_TYPED_FINDING_FIELDS = [
  "findings.current_backlog.harness_id", "findings.current_backlog.severity", "findings.current_backlog.count",
  "findings.window_new.harness_id", "findings.window_new.severity", "findings.window_new.count",
  "capabilities.harness_id", "capabilities.available", "capabilities.reason",
] as const satisfies readonly TypedFindingSummaryFieldV1[];
export const CITY_TYPED_SKILL_FIELDS = ["skill.harness_id", "skill.label", "skill.invocations", "skill.sessions",
  "skill.last_invoked_at_ms", "skill.finished_events", "skill.failed_events", "skill.succeeded_events"] as const satisfies readonly TypedSkillUsageFieldV1[];
export const CITY_TYPED_WORKFLOW_FIELDS = ["event.harness_id", "event.event_type", "event.count", "event.sessions",
  "event.last_event_at_ms", "event.failed_events"] as const satisfies readonly TypedWorkflowActivityFieldV1[];
export const CITY_TYPED_SESSION_COST_FIELDS = ["cost.status", "cost.reason", "cost.has_unresolved", "cost.complete", "cost.cost_minor",
  "cost.coverage", "cost.pricing_versions", "cost.reference_prices", "cost.pricing_sources", "cost.breakdown"] as const satisfies readonly TypedSessionCostFieldV1[];

export type CityTypedSessionDetailReader = {
  detail: (input: { sessionRef: string; windowDays: TypedSessionWindowV1; toMs?: number; dataRevision?: number }) => Promise<TypedSessionDetailV1>;
  excerpts: (input: { sessionRef: string; windowDays: TypedSessionWindowV1; toMs?: number; dataRevision?: number }) => Promise<TypedSessionExcerptsV1>;
  cost: (input: { sessionRef: string; windowDays: TypedSessionWindowV1; fields: readonly TypedSessionCostFieldV1[]; toMs?: number; dataRevision?: number }) => Promise<TypedSessionCostV1>;
};

export type CityTypedSessionDetail = {
  detail: TypedSessionDetailV1;
  excerpts: TypedSessionExcerptsV1;
  cost: TypedSessionCostV1;
};

export type CityTypedSessionRow = {
  id: string;
  harness: string;
  title?: string;
  title_source?: string;
  title_state: "available" | "unavailable";
  window_order: number;
  first_event_at: string;
  last_event_at: string;
  lifetime_first_event_at: string | null;
  lifetime_last_event_at: string | null;
  event_count: number;
  tokens: { input: number; output: number; total: number; uncached_input: number; cache_read: number; cache_write: number };
  model_ids: string[];
  model_coverage: { unknown_model_usage_events: number; legacy_usage_events: number };
};

export type CityTypedSessionPageReader = (input: {
  windowDays: TypedSessionWindowV1;
  fields: readonly TypedSessionFieldV3[];
  offset: number;
  limit: number;
  toMs?: number;
  dataRevision?: number;
}) => Promise<TypedSessionResponseV3>;
export type CityTypedStableRefPageReader = (input: {
  windowDays: TypedSessionWindowV1;
  fields: readonly TypedSessionFieldV4[];
  offset: number;
  limit: number;
  toMs?: number;
  dataRevision?: number;
}) => Promise<TypedSessionResponseV4>;
export type CityTypedSessionIdentityPageReader = (input: {
  offset: number;
  limit: number;
  dataRevision?: number;
}) => Promise<TypedSessionIdentityV1>;

export type CityTypedUsageSummaryReader = (input: {
  windowDays: TypedSessionWindowV1;
  fields: readonly TypedUsageSummaryFieldV1[];
  toMs?: number;
  dataRevision?: number;
}) => Promise<TypedUsageSummaryV1>;

export type CityTypedUsageSummary = NonNullable<TypedUsageSummaryV1["summary"]>;
export type CityTypedActivityReader = (input: {
  windowDays: TypedSessionWindowV1;
  timezone: string;
  fields: readonly TypedActivitySummaryFieldV1[];
  toMs?: number;
  dataRevision?: number;
}) => Promise<TypedActivitySummaryV1>;
export type CityTypedModelUsageReader = (input: {
  windowDays: TypedSessionWindowV1;
  fields: readonly TypedModelUsageFieldV1[];
  toMs?: number;
  dataRevision?: number;
}) => Promise<TypedModelUsageV1>;

const PAGE_SIZE = 500;
const MAX_SESSIONS = 4_000;

function timestamp(value: number | null | undefined, required: boolean): string | null {
  if (value == null) {
    if (required) throw new Error("typed_city_session_invalid");
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("typed_city_session_invalid");
  return new Date(value).toISOString().replace(/\.000Z$/, "Z");
}

function mapRow(row: TypedSessionRowV3): CityTypedSessionRow {
  const { tokens } = row;
  if (typeof row.id !== "string" || typeof row.harness_id !== "string"
      || !Number.isSafeInteger(row.window_order) || !Number.isSafeInteger(row.event_count)
      || !tokens || !Number.isSafeInteger(tokens.input) || !Number.isSafeInteger(tokens.output)
      || !Number.isSafeInteger(tokens.total) || !Number.isSafeInteger(tokens.uncached_input)
      || !Number.isSafeInteger(tokens.cache_read) || !Number.isSafeInteger(tokens.cache_write)
      || tokens.input! + tokens.output! !== tokens.total!
      || tokens.uncached_input! + tokens.cache_read! + tokens.cache_write! !== tokens.input!
      || !Array.isArray(row.model_ids) || !row.model_coverage) {
    throw new Error("typed_city_session_invalid");
  }
  const first = timestamp(row.window_first_event_at_ms, true)!;
  const last = timestamp(row.window_last_event_at_ms, true)!;
  if (Date.parse(first) > Date.parse(last)) throw new Error("typed_city_session_invalid");
  const lifetimeFirst = timestamp(row.lifetime_first_event_at_ms, false);
  const lifetimeLast = timestamp(row.lifetime_last_event_at_ms, false);
  const title = typeof row.title === "string" && row.title.trim() ? row.title : undefined;
  const titleSource = title && typeof row.title_source === "string" ? row.title_source : undefined;
  return {
    id: row.id,
    harness: row.harness_id,
    ...(title ? { title } : {}),
    ...(titleSource ? { title_source: titleSource } : {}),
    title_state: title ? "available" : "unavailable",
    window_order: row.window_order!,
    first_event_at: first,
    last_event_at: last,
    lifetime_first_event_at: lifetimeFirst,
    lifetime_last_event_at: lifetimeLast,
    event_count: row.event_count!,
    tokens: {
      input: tokens.input!, output: tokens.output!, total: tokens.total!,
      uncached_input: tokens.uncached_input!, cache_read: tokens.cache_read!, cache_write: tokens.cache_write!,
    },
    model_ids: [...row.model_ids],
    model_coverage: {
      unknown_model_usage_events: row.model_coverage.unknown_model_usage_events,
      legacy_usage_events: row.model_coverage.legacy_usage_events,
    },
  };
}

/**
 * Shadow adapter for City session rows. It reads only the generic typed dataset,
 * pins every continuation to one authority revision/window, then maps the DTO
 * into City presentation fields without changing the production provider path.
 */
export async function readTypedCitySessionShadow(
  readPage: CityTypedSessionPageReader,
  windowDays: TypedSessionWindowV1,
  pin?: { toMs: number; dataRevision: number },
): Promise<{ dataRevision: number; window: { fromMs: number; toMs: number }; sessions: CityTypedSessionRow[];
  coverage: { total: number; returned: number; truncated: boolean } }> {
  if (pin && (!Number.isSafeInteger(pin.toMs) || pin.toMs < 0 || !Number.isSafeInteger(pin.dataRevision) || pin.dataRevision < 0)) {
    throw new Error("typed_city_page_invalid");
  }
  let offset = 0;
  let dataRevision: number | undefined;
  let window: { fromMs: number; toMs: number } | undefined;
  let total: number | undefined;
  const sessions: CityTypedSessionRow[] = [];
  const ids = new Set<string>();
  const orders = new Set<number>();

  while (offset < MAX_SESSIONS) {
    const page = await readPage({
      windowDays, fields: CITY_TYPED_SESSION_FIELDS, offset, limit: PAGE_SIZE,
      ...(window ? { toMs: window.toMs, dataRevision } : pin ?? {}),
    });
    if (dataRevision === undefined) {
      dataRevision = page.dataRevision;
      window = page.window;
      total = page.coverage.total;
    } else if (page.dataRevision !== dataRevision || page.window.toMs !== window!.toMs
        || page.window.fromMs !== window!.fromMs || page.coverage.total !== total) {
      throw new Error("revision_changed");
    }
    if (page.pagination.offset !== offset || page.pagination.limit !== PAGE_SIZE
        || page.sessions.length !== page.coverage.returned
        || page.coverage.truncated !== (page.coverage.total > offset + page.sessions.length)) {
      throw new Error("typed_city_page_invalid");
    }
    for (const row of page.sessions) {
      const mapped = mapRow(row);
      if (ids.has(mapped.id) || orders.has(mapped.window_order)) throw new Error("typed_city_page_duplicate");
      ids.add(mapped.id);
      orders.add(mapped.window_order);
      sessions.push(mapped);
    }
    offset += page.sessions.length;
    if (page.coverage.truncated && page.sessions.length === 0) throw new Error("typed_city_page_invalid");
    if (!page.coverage.truncated) break;
  }

  if (dataRevision === undefined || !window || total === undefined) throw new Error("typed_city_page_invalid");
  if (sessions.length !== Math.min(total, MAX_SESSIONS)) throw new Error("typed_city_page_invalid");
  sessions.sort((a, b) => a.window_order - b.window_order);
  return { dataRevision, window, sessions, coverage: { total, returned: sessions.length, truncated: total > sessions.length } };
}

/** Run the shadow reader through the active built-in plugin instance. */
export async function readTypedCitySessionShadowFromHost(
  windowDays: TypedSessionWindowV1,
  signal?: AbortSignal,
  pin?: { toMs: number; dataRevision: number },
) {
  const instanceId = typeof window !== "undefined" ? window.__AV_PLUGIN_INSTANCE__ : undefined;
  if (!instanceId) throw new Error("plugin_instance_unavailable");
  const [{ createTypedDataClient }, { invokeHost }] = await Promise.all([
    import("@agent-vitals/app-sdk"), import("../host"),
  ]);
  const client = createTypedDataClient(instanceId, (request) =>
    invokeHost<PluginResponseV1>("plugin_request", { request }));
  return readTypedCitySessionShadow(async (input) => {
    if (signal?.aborted) throw new Error("city_request_cancelled");
    const page = await client.readSessionsLayoutPage(input);
    if (signal?.aborted) throw new Error("city_request_cancelled");
    return page;
  }, windowDays, pin);
}

/** Read stable source refs in the same pinned window as the City session projection. */
export async function readTypedCityStableRefs(
  readPage: CityTypedStableRefPageReader,
  windowDays: TypedSessionWindowV1,
  pin: { toMs: number; dataRevision: number },
): Promise<{ dataRevision: number; window: { fromMs: number; toMs: number }; bySessionId: Map<string, string> }> {
  if (!Number.isSafeInteger(pin.toMs) || pin.toMs < 0 || !Number.isSafeInteger(pin.dataRevision) || pin.dataRevision < 0) {
    throw new Error("typed_city_stable_ref_pin_invalid");
  }
  let offset = 0;
  let dataRevision: number | undefined;
  let window: { fromMs: number; toMs: number } | undefined;
  let total: number | undefined;
  const bySessionId = new Map<string, string>();
  const stableRefs = new Set<string>();
  while (offset < MAX_SESSIONS) {
    const page = await readPage({ windowDays, fields: CITY_TYPED_STABLE_REF_FIELDS, offset, limit: PAGE_SIZE,
      ...(window ? { toMs: window.toMs, dataRevision } : pin) });
    if (dataRevision === undefined) {
      dataRevision = page.dataRevision;
      window = page.window;
      total = page.coverage.total;
      if (dataRevision !== pin.dataRevision || window.toMs !== pin.toMs
          || window.fromMs !== pin.toMs - windowDays * 86_400_000) throw new Error("revision_changed");
    } else if (page.dataRevision !== dataRevision || page.window.toMs !== window!.toMs
        || page.window.fromMs !== window!.fromMs || page.coverage.total !== total) {
      throw new Error("revision_changed");
    }
    if (page.pagination.offset !== offset || page.pagination.limit !== PAGE_SIZE
        || page.sessions.length !== page.coverage.returned
        || page.coverage.truncated !== (page.coverage.total > offset + page.sessions.length)) {
      throw new Error("typed_city_stable_ref_page_invalid");
    }
    for (const row of page.sessions) {
      if (!row.id || !/^sr_[a-f0-9]{32}$/i.test(row.id) || !row.stable_ref || !/^srp_[a-f0-9]{32}$/.test(row.stable_ref)
          || bySessionId.has(row.id) || stableRefs.has(row.stable_ref)) throw new Error("typed_city_stable_ref_invalid");
      bySessionId.set(row.id, row.stable_ref);
      stableRefs.add(row.stable_ref);
    }
    offset += page.sessions.length;
    if (page.coverage.truncated && page.sessions.length === 0) throw new Error("typed_city_stable_ref_page_invalid");
    if (!page.coverage.truncated) break;
  }
  if (dataRevision === undefined || !window || total === undefined || bySessionId.size !== Math.min(total, MAX_SESSIONS)) {
    throw new Error("typed_city_stable_ref_page_invalid");
  }
  return { dataRevision, window, bySessionId };
}

/** Read the bounded, all-lifetime identity catalog used only for migrations/crosswalks. */
export async function readTypedCitySessionIdentities(
  readPage: CityTypedSessionIdentityPageReader,
  pin?: { dataRevision: number },
): Promise<{ dataRevision: number; bySessionId: Map<string, string>; total: number; truncated: boolean }> {
  let offset = 0;
  let dataRevision: number | undefined = pin?.dataRevision;
  let total: number | undefined;
  const bySessionId = new Map<string, string>();
  const stableRefs = new Set<string>();
  while (offset < 100_000) {
    const page = await readPage({ offset, limit: PAGE_SIZE, ...(dataRevision === undefined ? {} : { dataRevision }) });
    if (total === undefined) {
      if (dataRevision !== undefined && page.dataRevision !== dataRevision) throw new Error("revision_changed");
      dataRevision = page.dataRevision;
      total = page.coverage.total;
    } else if (page.dataRevision !== dataRevision || page.coverage.total !== total) {
      throw new Error("revision_changed");
    }
    if (page.pagination.offset !== offset || page.pagination.limit !== PAGE_SIZE
        || page.sessions.length !== page.coverage.returned
        || page.coverage.truncated !== (page.coverage.total > offset + page.sessions.length)) {
      throw new Error("typed_city_session_identity_page_invalid");
    }
    for (const row of page.sessions) {
      if (!/^sr_[a-f0-9]{32}$/i.test(row.id) || !/^srp_[a-f0-9]{32}$/.test(row.stable_ref)
          || bySessionId.has(row.id) || stableRefs.has(row.stable_ref)) {
        throw new Error("typed_city_session_identity_invalid");
      }
      bySessionId.set(row.id, row.stable_ref);
      stableRefs.add(row.stable_ref);
    }
    offset += page.sessions.length;
    if (!page.coverage.truncated || page.sessions.length === 0) break;
  }
  if (dataRevision === undefined || total === undefined || bySessionId.size !== Math.min(total, 100_000)) {
    throw new Error("typed_city_session_identity_page_invalid");
  }
  return { dataRevision, bySessionId, total, truncated: total > 100_000 };
}

export async function readTypedCitySessionIdentitiesFromHost(signal?: AbortSignal, pin?: { dataRevision: number }) {
  const instanceId = typeof window !== "undefined" ? window.__AV_PLUGIN_INSTANCE__ : undefined;
  if (!instanceId) throw new Error("plugin_instance_unavailable");
  const [{ createTypedDataClient }, { invokeHost }] = await Promise.all([
    import("@agent-vitals/app-sdk"), import("../host"),
  ]);
  const client = createTypedDataClient(instanceId, (request) =>
    invokeHost<PluginResponseV1>("plugin_request", { request }));
  return readTypedCitySessionIdentities(async (input) => {
    if (signal?.aborted) throw new Error("city_request_cancelled");
    const page = await client.readSessionIdentityPage(input);
    if (signal?.aborted) throw new Error("city_request_cancelled");
    return page;
  }, pin);
}

export async function readTypedCityStableRefsFromHost(
  windowDays: TypedSessionWindowV1,
  pin: { toMs: number; dataRevision: number },
  signal?: AbortSignal,
) {
  const instanceId = typeof window !== "undefined" ? window.__AV_PLUGIN_INSTANCE__ : undefined;
  if (!instanceId) throw new Error("plugin_instance_unavailable");
  const [{ createTypedDataClient }, { invokeHost }] = await Promise.all([
    import("@agent-vitals/app-sdk"), import("../host"),
  ]);
  const client = createTypedDataClient(instanceId, (request) =>
    invokeHost<PluginResponseV1>("plugin_request", { request }));
  return readTypedCityStableRefs(async (input) => {
    if (signal?.aborted) throw new Error("city_request_cancelled");
    const page = await client.readSessionsLayoutPageV4(input);
    if (signal?.aborted) throw new Error("city_request_cancelled");
    return page;
  }, windowDays, pin);
}

export async function readTypedCitySourceStatusFromHost(
  input: { references: readonly string[]; windowDays: TypedSessionWindowV1; toMs: number; dataRevision: number },
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new Error("city_request_cancelled");
  const instanceId = typeof window !== "undefined" ? window.__AV_PLUGIN_INSTANCE__ : undefined;
  if (!instanceId) throw new Error("plugin_instance_unavailable");
  const [{ createTypedDataClient }, { invokeHost }] = await Promise.all([
    import("@agent-vitals/app-sdk"), import("../host"),
  ]);
  const client = createTypedDataClient(instanceId, (request) =>
    invokeHost<PluginResponseV1>("plugin_request", { request }));
  const result = await client.readSessionSourceStatus({
    references: input.references,
    windowDays: input.windowDays,
    fields: ["source.stable_ref", "source.state", "source.has_usage_in_window"],
    toMs: input.toMs,
    dataRevision: input.dataRevision,
  });
  if (signal?.aborted) throw new Error("city_request_cancelled");
  return result;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Compare detail/excerpts/cost without ever folding pricing groups into one amount. */
export function assertCitySessionDetailShadowParity(
  cityDetail: Record<string, unknown>,
  typed: CityTypedSessionDetail,
  pin: { windowDays: TypedSessionWindowV1; toMs: number; dataRevision: number },
): void {
  const sessionRef = cityDetail.id;
  if (typeof sessionRef !== "string" || !/^sr_[a-f0-9]{32}$/i.test(sessionRef)) throw new Error("typed_city_detail_handle_invalid");
  const envelopes = [typed.detail, typed.excerpts, typed.cost];
  for (const envelope of envelopes) {
    if (envelope.sessionRef !== sessionRef || envelope.windowDays !== pin.windowDays
        || envelope.dataRevision !== pin.dataRevision || envelope.window.toMs !== pin.toMs
        || envelope.window.fromMs !== pin.toMs - pin.windowDays * 86_400_000) throw new Error("typed_city_detail_revision_changed");
  }

  const session = typed.detail.session;
  const tokens = cityDetail.tokens as Record<string, unknown> | undefined;
  const modelCoverage = cityDetail.model_coverage as Record<string, unknown> | undefined;
  const sameSession = session.id === cityDetail.id && session.harness === cityDetail.harness
    && session.title === (typeof cityDetail.title === "string" ? cityDetail.title : null)
    && session.title_source === (typeof cityDetail.title_source === "string" ? cityDetail.title_source : null)
    && Date.parse(session.first_event_at) === Date.parse(String(cityDetail.first_event_at))
    && Date.parse(session.last_event_at) === Date.parse(String(cityDetail.last_event_at))
    && Date.parse(session.window_first_event_at) === Date.parse(String(cityDetail.window_first_event_at))
    && Date.parse(session.window_last_event_at) === Date.parse(String(cityDetail.window_last_event_at))
    && (session.lifetime_first_event_at === null ? cityDetail.lifetime_first_event_at == null
      : Date.parse(session.lifetime_first_event_at) === Date.parse(String(cityDetail.lifetime_first_event_at)))
    && (session.lifetime_last_event_at === null ? cityDetail.lifetime_last_event_at == null
      : Date.parse(session.lifetime_last_event_at) === Date.parse(String(cityDetail.lifetime_last_event_at)))
    && session.event_count === cityDetail.usage_event_count
    && !!tokens && ["input", "output", "total", "uncached_input", "cache_read", "cache_write"]
      .every((key) => session.tokens[key] === tokens[key])
    && sameJson([...session.model_ids].sort(), Array.isArray(cityDetail.model_ids) ? [...cityDetail.model_ids].sort() : null)
    && !!modelCoverage && session.model_coverage.unknown_model_usage_events === modelCoverage.unknown_model_usage_events
    && session.model_coverage.legacy_usage_events === modelCoverage.legacy_usage_events;
  if (!sameSession) throw new Error("typed_city_parity_detail");

  const legacyExcerpts = Array.isArray(cityDetail.task_excerpts) ? cityDetail.task_excerpts : [];
  const normalizeExcerpt = (row: Record<string, unknown>) => ({ role: row.role, text: row.text,
    provenance: row.provenance, is_excerpt: row.is_excerpt, scope: row.scope, excerpt_at: row.excerpt_at });
  if (cityDetail.excerpt_scope !== "session_lifetime"
      || !sameJson(legacyExcerpts.map(normalizeExcerpt), typed.excerpts.excerpts.map(normalizeExcerpt))) {
    throw new Error("typed_city_parity_excerpts");
  }
  const legacyAvailability = cityDetail.excerpt_availability as Record<string, unknown> | undefined;
  if (!legacyAvailability || (legacyAvailability.state === "ready") !== typed.excerpts.excerptAvailability.available
      || legacyAvailability.reason !== typed.excerpts.excerptAvailability.reason) throw new Error("typed_city_parity_excerpt_availability");

  const legacyCost = cityDetail.cost as Record<string, unknown> | undefined;
  if (!legacyCost) throw new Error("typed_city_parity_cost");
  const costFields = ["status", "reason", "has_unresolved", "complete", "cost_minor", "coverage", "pricing_versions",
    "reference_prices", "pricing_sources", "breakdown"] as const;
  const legacyMinor = legacyCost.cost_minor && typeof legacyCost.cost_minor === "object"
    ? legacyCost.cost_minor as Record<string, unknown> : null;
  const left = Object.fromEntries(costFields.map((field) => [field, field === "cost_minor" && legacyMinor
    ? { amount_minor: legacyMinor.amount_minor, currency: legacyMinor.currency, basis: legacyMinor.basis }
    : legacyCost[field] ?? null]));
  const right = Object.fromEntries(costFields.map((field) => [field, typed.cost.cost[field] ?? null]));
  if (!sameJson(left, right)) throw new Error("typed_city_parity_cost");
  const breakdown = typed.cost.cost.breakdown ?? [];
  const distinctGroups = new Set(breakdown.map((row) => `${row.currency}\u0000${row.basis}`));
  if (distinctGroups.size > 1 && typed.cost.cost.cost_minor !== null) throw new Error("typed_city_cost_groups_collapsed");
}

/** Read three independently granted datasets using one session handle and snapshot pin. */
export async function readTypedCitySessionDetail(
  reader: CityTypedSessionDetailReader,
  input: { sessionRef: string; windowDays: TypedSessionWindowV1 },
): Promise<CityTypedSessionDetail> {
  if (!/^sr_[a-f0-9]{32}$/i.test(input.sessionRef)) throw new Error("typed_city_detail_input_invalid");
  const detail = await reader.detail(input);
  if (detail.sessionRef !== input.sessionRef || detail.windowDays !== input.windowDays
      || !Number.isSafeInteger(detail.dataRevision) || detail.dataRevision < 0
      || !Number.isSafeInteger(detail.window.toMs) || detail.window.toMs < 0
      || detail.window.toMs - detail.window.fromMs !== input.windowDays * 86_400_000) {
    throw new Error("typed_city_detail_revision_changed");
  }
  const pin = { ...input, toMs: detail.window.toMs, dataRevision: detail.dataRevision };
  const [excerpts, cost] = await Promise.all([
    reader.excerpts(pin),
    reader.cost({ ...pin, fields: CITY_TYPED_SESSION_COST_FIELDS }),
  ]);
  const result = { detail, excerpts, cost };
  // Validate the pinned envelope here as well as inside the SDK client so test
  // readers and future adapters cannot accidentally weaken the cross-dataset contract.
  for (const envelope of [detail, excerpts, cost]) {
    if (envelope.sessionRef !== input.sessionRef || envelope.windowDays !== input.windowDays
        || envelope.dataRevision !== pin.dataRevision || envelope.window.toMs !== pin.toMs
        || envelope.window.fromMs !== pin.toMs - input.windowDays * 86_400_000) throw new Error("typed_city_detail_revision_changed");
  }
  const detailKeys = ["id", "harness", "title", "title_source", "first_event_at", "last_event_at", "window_first_event_at",
    "window_last_event_at", "lifetime_first_event_at", "lifetime_last_event_at", "event_count", "tokens", "model_ids", "model_coverage"];
  if (detail.session.id !== input.sessionRef || Object.keys(detail.session).some((key) => !detailKeys.includes(key))
      || Object.keys(detail.session).length !== detailKeys.length
      || Object.keys(detail.session.tokens).some((key) => !["input", "output", "total", "uncached_input", "cache_read", "cache_write"].includes(key))) {
    throw new Error("typed_city_detail_shape_invalid");
  }
  return result;
}

/** Invoke only the statically compiled built-in typed-data client. */
export async function readTypedCitySessionDetailFromHost(
  input: { sessionRef: string; windowDays: TypedSessionWindowV1 },
  signal?: AbortSignal,
) {
  const instanceId = typeof window !== "undefined" ? window.__AV_PLUGIN_INSTANCE__ : undefined;
  if (!instanceId) throw new Error("plugin_instance_unavailable");
  const [{ createTypedDataClient }, { invokeHost }] = await Promise.all([
    import("@agent-vitals/app-sdk"), import("../host"),
  ]);
  const client = createTypedDataClient(instanceId, (request) =>
    invokeHost<PluginResponseV1>("plugin_request", { request }));
  const checked = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (signal?.aborted) throw new Error("city_request_cancelled");
    const result = await operation();
    if (signal?.aborted) throw new Error("city_request_cancelled");
    return result;
  };
  return readTypedCitySessionDetail({
    detail: (query) => checked(() => client.readSessionDetail(query)),
    excerpts: (query) => checked(() => client.readSessionExcerpts(query)),
    cost: (query) => checked(() => client.readSessionCost(query)),
  }, input);
}

export async function readTypedCityUsageSummaryShadow(
  readSummary: CityTypedUsageSummaryReader,
  windowDays: TypedSessionWindowV1,
  toMs?: number,
  dataRevision?: number,
): Promise<TypedUsageSummaryV1> {
  const result = await readSummary({
    windowDays, fields: CITY_TYPED_SUMMARY_FIELDS,
    ...(toMs !== undefined ? { toMs, dataRevision } : {}),
  });
  if (dataRevision !== undefined && result.dataRevision !== dataRevision) throw new Error("revision_changed");
  if (toMs !== undefined && result.window.toMs !== toMs) throw new Error("revision_changed");
  return result;
}

export async function readTypedCityUsageSummaryShadowFromHost(
  windowDays: TypedSessionWindowV1,
  toMs?: number,
  dataRevision?: number,
) {
  const instanceId = typeof window !== "undefined" ? window.__AV_PLUGIN_INSTANCE__ : undefined;
  if (!instanceId) throw new Error("plugin_instance_unavailable");
  const [{ createTypedDataClient }, { invokeHost }] = await Promise.all([
    import("@agent-vitals/app-sdk"), import("../host"),
  ]);
  const client = createTypedDataClient(instanceId, (request) =>
    invokeHost<PluginResponseV1>("plugin_request", { request }));
  return readTypedCityUsageSummaryShadow(
    (input) => client.readUsageSummary(input), windowDays, toMs, dataRevision,
  );
}

export async function readTypedCityActivityShadow(
  readActivity: CityTypedActivityReader,
  windowDays: TypedSessionWindowV1,
  timezone: string,
  toMs?: number,
  dataRevision?: number,
): Promise<TypedActivitySummaryV1> {
  const result = await readActivity({
    windowDays, timezone, fields: CITY_TYPED_ACTIVITY_FIELDS,
    ...(toMs !== undefined ? { toMs, dataRevision } : {}),
  });
  if (dataRevision !== undefined && result.dataRevision !== dataRevision) throw new Error("revision_changed");
  if (toMs !== undefined && result.window.toMs !== toMs) throw new Error("revision_changed");
  return result;
}

export async function readTypedCityActivityShadowFromHost(
  windowDays: TypedSessionWindowV1,
  timezone: string,
  toMs?: number,
  dataRevision?: number,
) {
  const instanceId = typeof window !== "undefined" ? window.__AV_PLUGIN_INSTANCE__ : undefined;
  if (!instanceId) throw new Error("plugin_instance_unavailable");
  const [{ createTypedDataClient }, { invokeHost }] = await Promise.all([
    import("@agent-vitals/app-sdk"), import("../host"),
  ]);
  const client = createTypedDataClient(instanceId, (request) =>
    invokeHost<PluginResponseV1>("plugin_request", { request }));
  return readTypedCityActivityShadow(
    (input) => client.readActivitySummary(input), windowDays, timezone, toMs, dataRevision,
  );
}

export async function readTypedCityModelUsageShadow(
  readModels: CityTypedModelUsageReader,
  windowDays: TypedSessionWindowV1,
  toMs?: number,
  dataRevision?: number,
): Promise<TypedModelUsageV1> {
  const result = await readModels({
    windowDays, fields: CITY_TYPED_MODEL_FIELDS,
    ...(toMs !== undefined ? { toMs, dataRevision } : {}),
  });
  if (dataRevision !== undefined && result.dataRevision !== dataRevision) throw new Error("revision_changed");
  if (toMs !== undefined && result.window.toMs !== toMs) throw new Error("revision_changed");
  return result;
}

export async function readTypedCityModelUsageShadowFromHost(
  windowDays: TypedSessionWindowV1,
  toMs?: number,
  dataRevision?: number,
) {
  const instanceId = typeof window !== "undefined" ? window.__AV_PLUGIN_INSTANCE__ : undefined;
  if (!instanceId) throw new Error("plugin_instance_unavailable");
  const [{ createTypedDataClient }, { invokeHost }] = await Promise.all([
    import("@agent-vitals/app-sdk"), import("../host"),
  ]);
  const client = createTypedDataClient(instanceId, (request) =>
    invokeHost<PluginResponseV1>("plugin_request", { request }));
  return readTypedCityModelUsageShadow((input) => client.readModelUsage(input), windowDays, toMs, dataRevision);
}

export async function readTypedCityTimeCoverageShadowFromHost(dataRevision?: number) {
  const instanceId = typeof window !== "undefined" ? window.__AV_PLUGIN_INSTANCE__ : undefined;
  if (!instanceId) throw new Error("plugin_instance_unavailable");
  const [{ createTypedDataClient }, { invokeHost }] = await Promise.all([
    import("@agent-vitals/app-sdk"), import("../host"),
  ]);
  const client = createTypedDataClient(instanceId, (request) =>
    invokeHost<PluginResponseV1>("plugin_request", { request }));
  return client.readTimeCoverage({ fields: CITY_TYPED_TIME_COVERAGE_FIELDS, dataRevision });
}

export async function readTypedCityFindingShadowFromHost(
  windowDays: TypedSessionWindowV1,
  toMs?: number,
  dataRevision?: number,
): Promise<TypedFindingSummaryV1> {
  const instanceId = typeof window !== "undefined" ? window.__AV_PLUGIN_INSTANCE__ : undefined;
  if (!instanceId) throw new Error("plugin_instance_unavailable");
  const [{ createTypedDataClient }, { invokeHost }] = await Promise.all([
    import("@agent-vitals/app-sdk"), import("../host"),
  ]);
  const client = createTypedDataClient(instanceId, (request) =>
    invokeHost<PluginResponseV1>("plugin_request", { request }));
  return client.readFindingSummary({
    windowDays, fields: CITY_TYPED_FINDING_FIELDS,
    ...(toMs !== undefined ? { toMs, dataRevision } : {}),
  });
}

export async function readTypedCitySkillWorkflowShadowFromHost(windowDays: TypedSessionWindowV1, toMs?: number, dataRevision?: number) {
  const instanceId = typeof window !== "undefined" ? window.__AV_PLUGIN_INSTANCE__ : undefined;
  if (!instanceId) throw new Error("plugin_instance_unavailable");
  const [{ createTypedDataClient }, { invokeHost }] = await Promise.all([import("@agent-vitals/app-sdk"), import("../host")]);
  const client = createTypedDataClient(instanceId, (request) => invokeHost<PluginResponseV1>("plugin_request", { request }));
  const pin = toMs !== undefined && dataRevision !== undefined ? { toMs, dataRevision } : {};
  const [skills, workflow] = await Promise.all([
    client.readSkillUsage({ windowDays, fields: CITY_TYPED_SKILL_FIELDS, ...pin }),
    client.readWorkflowActivity({ windowDays, fields: CITY_TYPED_WORKFLOW_FIELDS, ...pin }),
  ]);
  return { skills, workflow };
}

function normalizedRows(rows: unknown[], keys: string[]): string[] {
  return rows.map((row) => {
    if (!row || typeof row !== "object") return "invalid";
    const value = row as Record<string, unknown>;
    return JSON.stringify(keys.map((key) => value[key] ?? null));
  }).sort();
}

export function assertCitySkillWorkflowShadowParity(legacySkills: unknown, legacyWorkflow: unknown,
  typedSkills: TypedSkillUsageV1, typedWorkflow: TypedWorkflowActivityV1): void {
  const skillRows = (legacySkills as { data?: { skills?: unknown[] } } | undefined)?.data?.skills ?? [];
  const workflowRows = (legacyWorkflow as { data?: { events?: unknown[] } } | undefined)?.data?.events ?? [];
  if (JSON.stringify(normalizedRows(skillRows, ["harness", "skill", "invocations", "sessions", "last_invoked_at_ms", "finished_events", "failed_events", "succeeded_events"]))
      !== JSON.stringify(normalizedRows(typedSkills.skills.map((r) => ({ ...r, harness: r.harness_id, skill: r.label })),
        ["harness", "skill", "invocations", "sessions", "last_invoked_at_ms", "finished_events", "failed_events", "succeeded_events"]))) throw new Error("typed_city_parity_skills");
  if (JSON.stringify(normalizedRows(workflowRows, ["harness", "event_type", "events", "sessions", "last_event_at_ms", "failed_events"]))
      !== JSON.stringify(normalizedRows(typedWorkflow.events.map((r) => ({ ...r, harness: r.harness_id, events: r.count })),
        ["harness", "event_type", "events", "sessions", "last_event_at_ms", "failed_events"]))) throw new Error("typed_city_parity_workflow");
}

/** Compare the UI-relevant session subset against the current city:v3 page. */
export function assertCitySessionShadowParity(
  cityV3Rows: readonly Record<string, unknown>[],
  typedRows: readonly CityTypedSessionRow[],
): void {
  if (cityV3Rows.length !== typedRows.length) throw new Error("typed_city_parity_session_count");
  const expected = [...cityV3Rows].sort((a, b) => Number(a.layout_order) - Number(b.layout_order));
  const actual = [...typedRows].sort((a, b) => a.window_order - b.window_order);
  for (let index = 0; index < expected.length; index += 1) {
    const legacy = expected[index]!, candidate = actual[index]!;
    const tokens = legacy.tokens as Record<string, unknown> | undefined;
    const modelCoverage = legacy.model_coverage as Record<string, unknown> | undefined;
    const matches = legacy.id === candidate.id && legacy.harness === candidate.harness
      && (legacy.title ?? undefined) === candidate.title && (legacy.title_source ?? undefined) === candidate.title_source
      && Number(legacy.layout_order) === candidate.window_order
      && Date.parse(String(legacy.window_first_event_at)) === Date.parse(candidate.first_event_at)
      && Date.parse(String(legacy.window_last_event_at)) === Date.parse(candidate.last_event_at)
      && (legacy.lifetime_first_event_at == null ? candidate.lifetime_first_event_at === null
        : Date.parse(String(legacy.lifetime_first_event_at)) === Date.parse(candidate.lifetime_first_event_at ?? ""))
      && (legacy.lifetime_last_event_at == null ? candidate.lifetime_last_event_at === null
        : Date.parse(String(legacy.lifetime_last_event_at)) === Date.parse(candidate.lifetime_last_event_at ?? ""))
      && legacy.usage_event_count === candidate.event_count
      && tokens?.input === candidate.tokens.input && tokens.output === candidate.tokens.output && tokens.total === candidate.tokens.total
      && tokens.uncached_input === candidate.tokens.uncached_input && tokens.cache_read === candidate.tokens.cache_read
      && tokens.cache_write === candidate.tokens.cache_write
      && JSON.stringify(legacy.model_ids) === JSON.stringify(candidate.model_ids)
      && modelCoverage?.unknown_model_usage_events === candidate.model_coverage.unknown_model_usage_events
      && modelCoverage.legacy_usage_events === candidate.model_coverage.legacy_usage_events;
    if (!matches) throw new Error(`typed_city_parity_row_${index}`);
  }
}

export function assertCityUsageSummaryShadowParity(
  cityOverview: Record<string, unknown>,
  typedSummary: TypedUsageSummaryV1,
): void {
  const legacyTokens = cityOverview.tokens as Record<string, unknown> | undefined;
  const typedTokens = typedSummary.summary.tokens;
  if (cityOverview.session_count !== typedSummary.summary.session_count
      || cityOverview.usage_event_count !== typedSummary.summary.usage_event_count
      || !legacyTokens || !typedTokens
      || legacyTokens.input !== typedTokens.input || legacyTokens.output !== typedTokens.output
      || legacyTokens.total !== typedTokens.total || legacyTokens.uncached_input !== typedTokens.uncached_input
      || legacyTokens.cache_read !== typedTokens.cache_read || legacyTokens.cache_write !== typedTokens.cache_write) {
    throw new Error("typed_city_parity_summary");
  }
}

export function assertCityActivityShadowParity(
  cityActivity: Record<string, unknown>,
  typedActivity: TypedActivitySummaryV1,
): void {
  const cityDays = cityActivity.days;
  if (cityActivity.timezone !== typedActivity.timezone || !Array.isArray(cityDays)
      || cityDays.length !== typedActivity.days.length) throw new Error("typed_city_parity_activity");
  for (let index = 0; index < typedActivity.days.length; index += 1) {
    const cityDay = cityDays[index] as Record<string, unknown> | undefined;
    const typedDay = typedActivity.days[index];
    if (!cityDay || cityDay.date !== typedDay.date || cityDay.session_count !== typedDay.session_count
        || cityDay.event_count !== typedDay.event_count || cityDay.tokens !== typedDay.tokens) {
      throw new Error(`typed_city_parity_activity_day_${index}`);
    }
  }
}

export function assertCityModelUsageShadowParity(
  cityModels: Record<string, unknown>,
  typedModels: TypedModelUsageV1,
): void {
  const expectedIds = Array.isArray(cityModels.model_ids) ? cityModels.model_ids : [];
  const actualIds = typedModels.models.map(model => model.model_id).filter((id): id is string => typeof id === "string");
  const coverage = cityModels;
  if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)
      || coverage.unknown_model_usage_events !== typedModels.coverage.unknown_model_usage_events
      || coverage.legacy_usage_events !== typedModels.coverage.legacy_usage_events
      || typedModels.scope !== "window" || typedModels.pricingIndependent !== true) {
    throw new Error("typed_city_parity_models");
  }
}

export function assertCityTimeCoverageShadowParity(
  cityCoverage: Record<string, unknown>,
  typedCoverage: TypedTimeCoverageV1,
): void {
  if (cityCoverage.scope !== typedCoverage.coverage.scope
      || cityCoverage.unknown_time_only !== typedCoverage.coverage.unknown_time_only
      || cityCoverage.mixed_time !== typedCoverage.coverage.mixed_time
      || cityCoverage.excluded_no_usage !== typedCoverage.coverage.excluded_no_usage) {
    throw new Error("typed_city_parity_time_coverage");
  }
}

function normalizedFindingCounts(rows: unknown, harnessKey: string): Array<{ harness_id: string; severity: string; count: number }> {
  if (!Array.isArray(rows)) throw new Error("typed_city_parity_findings");
  const counts = new Map<string, { harness_id: string; severity: string; count: number }>();
  for (const item of rows) {
    if (!item || typeof item !== "object") throw new Error("typed_city_parity_findings");
    const row = item as Record<string, unknown>;
    const harness_id = row[harnessKey];
    if (typeof harness_id !== "string" || typeof row.severity !== "string"
        || typeof row.count !== "number" || !Number.isSafeInteger(row.count) || row.count < 0) {
      throw new Error("typed_city_parity_findings");
    }
    const key = `${harness_id}\u0000${row.severity}`;
    const prior = counts.get(key);
    if (prior) prior.count += row.count;
    else counts.set(key, { harness_id, severity: row.severity, count: row.count });
  }
  return [...counts.values()].sort((a, b) => a.harness_id.localeCompare(b.harness_id) || a.severity.localeCompare(b.severity));
}

export function assertCityFindingShadowParity(
  cityFindings: Record<string, unknown>,
  typedFindings: TypedFindingSummaryV1,
): void {
  const cityBacklog = normalizedFindingCounts(cityFindings.current_backlog, "harness");
  const cityWindowNew = normalizedFindingCounts(cityFindings.window_new, "harness");
  const typedBacklog = normalizedFindingCounts(typedFindings.current_backlog, "harness_id");
  const typedWindowNew = normalizedFindingCounts(typedFindings.window_new, "harness_id");
  const cityCapabilities = Array.isArray(cityFindings.capabilities) ? cityFindings.capabilities.map(item => {
    if (!item || typeof item !== "object") throw new Error("typed_city_parity_findings");
    const row = item as Record<string, unknown>;
    const findings = row.findings && typeof row.findings === "object" ? row.findings as Record<string, unknown> : {};
    return { harness_id: row.id, available: findings.available, reason: findings.reason ?? null };
  }).sort((a, b) => String(a.harness_id).localeCompare(String(b.harness_id))) : [];
  const typedCapabilities = typedFindings.capabilities.map(row => ({
    harness_id: row.harness_id, available: row.available, reason: row.reason ?? null,
  })).sort((a, b) => String(a.harness_id).localeCompare(String(b.harness_id)));
  if (JSON.stringify(cityBacklog) !== JSON.stringify(typedBacklog)
      || JSON.stringify(cityWindowNew) !== JSON.stringify(typedWindowNew)
      || JSON.stringify(cityCapabilities) !== JSON.stringify(typedCapabilities)) {
    throw new Error("typed_city_parity_findings");
  }
}

export type CityTypedWindowReaders = {
  summary: (windowDays: TypedSessionWindowV1, toMs: number, dataRevision: number) => Promise<TypedUsageSummaryV1>;
  activity: (windowDays: TypedSessionWindowV1, timezone: string, toMs: number, dataRevision: number) => Promise<TypedActivitySummaryV1>;
  models: (windowDays: TypedSessionWindowV1, toMs: number, dataRevision: number) => Promise<TypedModelUsageV1>;
  timeCoverage: (dataRevision: number) => Promise<TypedTimeCoverageV1>;
  findings: (windowDays: TypedSessionWindowV1, toMs: number, dataRevision: number) => Promise<TypedFindingSummaryV1>;
};

export type CityTypedWindowValues = {
  summary: TypedUsageSummaryV1["summary"];
  activity: TypedActivitySummaryV1;
  models: TypedModelUsageV1;
  timeCoverage: TypedTimeCoverageV1["coverage"];
  findings: TypedFindingSummaryV1;
};

/**
 * Read each bounded typed aggregate against one revision/window. During a
 * legacy overlap, compare with the v3 value; after that route is removed, rely
 * on the fixed SDK DTO contract. A denied dataset degrades independently.
 */
export async function promoteCityTypedWindowValues(input: {
  readers: CityTypedWindowReaders;
  legacy: {
    overview?: Record<string, unknown>;
    activity?: Record<string, unknown>;
  };
  windowDays: TypedSessionWindowV1;
  timezone: string;
  window: { fromMs: number; toMs: number };
  dataRevision: number;
  signal?: AbortSignal;
}): Promise<{ values: Partial<CityTypedWindowValues>; statuses: Record<string, { status: "matched" | "fallback"; reason?: string }> }> {
  const values: Partial<CityTypedWindowValues> = {};
  const statuses: Record<string, { status: "matched" | "fallback"; reason?: string }> = {};
  const pin = { windowDays: input.windowDays, toMs: input.window.toMs, dataRevision: input.dataRevision };
  const checkCancelled = () => { if (input.signal?.aborted) throw new Error("city_request_cancelled"); };
  const checkWindow = (value: { dataRevision: number; windowDays: TypedSessionWindowV1; window: { fromMs: number; toMs: number } }) => {
    if (value.dataRevision !== pin.dataRevision || value.windowDays !== pin.windowDays
        || value.window.fromMs !== input.window.fromMs || value.window.toMs !== input.window.toMs) {
      throw new Error("typed_city_parity_window");
    }
  };
  const run = async (key: keyof CityTypedWindowValues, operation: () => Promise<unknown>, validate: (value: any) => void,
    promote: (value: any) => void) => {
    checkCancelled();
    try {
      const value = await operation();
      checkCancelled();
      validate(value);
      promote(value);
      statuses[key] = { status: "matched" };
    } catch (error) {
      if (input.signal?.aborted || (error instanceof Error && error.message === "city_request_cancelled")) throw error;
      statuses[key] = { status: "fallback", reason: error instanceof Error ? error.message : "typed_city_unavailable" };
    }
  };

  await Promise.all([
    run("summary", () => input.readers.summary(pin.windowDays, pin.toMs, pin.dataRevision), (value) => {
      checkWindow(value);
      if (input.legacy.overview) assertCityUsageSummaryShadowParity(input.legacy.overview, value);
    }, (value) => { values.summary = value.summary; }),
    run("activity", () => input.readers.activity(pin.windowDays, input.timezone, pin.toMs, pin.dataRevision), (value) => {
      checkWindow(value);
      if (input.legacy.activity) assertCityActivityShadowParity(input.legacy.activity, value);
    }, (value) => { values.activity = value; }),
    run("models", () => input.readers.models(pin.windowDays, pin.toMs, pin.dataRevision), (value) => {
      checkWindow(value);
      if (input.legacy.overview?.models) assertCityModelUsageShadowParity(input.legacy.overview.models as Record<string, unknown>, value);
    }, (value) => { values.models = value; }),
    run("timeCoverage", () => input.readers.timeCoverage(pin.dataRevision), (value) => {
      if (value.dataRevision !== pin.dataRevision) throw new Error("typed_city_parity_revision");
      if (input.legacy.overview?.time_classification) assertCityTimeCoverageShadowParity(input.legacy.overview.time_classification as Record<string, unknown>, value);
    }, (value) => { values.timeCoverage = value.coverage; }),
    run("findings", () => input.readers.findings(pin.windowDays, pin.toMs, pin.dataRevision), (value) => {
      checkWindow(value);
    }, (value) => { values.findings = value; }),
  ]);
  checkCancelled();
  return { values, statuses };
}

/** Map the same-revision typed workflow datasets into the established v3 module result shape. */
export function promoteCityTypedWorkflowValues(input: {
  legacySkills: unknown;
  legacyWorkflow: unknown;
  skills: TypedSkillUsageV1;
  workflow: TypedWorkflowActivityV1;
  windowDays: TypedSessionWindowV1;
  window: { fromMs: number; toMs: number };
  dataRevision: number;
}): { skills: Record<string, unknown>; workflow: Record<string, unknown> } {
  for (const value of [input.skills, input.workflow]) {
    if (value.dataRevision !== input.dataRevision || value.windowDays !== input.windowDays
        || value.window.fromMs !== input.window.fromMs || value.window.toMs !== input.window.toMs) {
      throw new Error("typed_city_parity_window");
    }
  }
  assertCitySkillWorkflowShadowParity(input.legacySkills, input.legacyWorkflow, input.skills, input.workflow);
  const legacySkillsData = (input.legacySkills as { data?: Record<string, unknown> } | undefined)?.data ?? {};
  const legacyWorkflowData = (input.legacyWorkflow as { data?: Record<string, unknown> } | undefined)?.data ?? {};
  return {
    skills: { ...legacySkillsData, skills: input.skills.skills.map((row) => ({
      harness: row.harness_id, skill: row.label, invocations: row.invocations, sessions: row.sessions,
      last_invoked_at_ms: row.last_invoked_at_ms, finished_events: row.finished_events,
      failed_events: row.failed_events, succeeded_events: row.succeeded_events,
    })) },
    workflow: { ...legacyWorkflowData, events: input.workflow.events.map((row) => ({
      harness: row.harness_id, event_type: row.event_type, events: row.count, sessions: row.sessions,
      last_event_at_ms: row.last_event_at_ms, failed_events: row.failed_events,
    })) },
  };
}
