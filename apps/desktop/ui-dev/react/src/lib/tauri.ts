import { resolvedLanguage } from "./localePreference";

export type Unsubscribe = () => void;

/** Desktop `app-event` allowlist. `Invalidated` (RUNTIME_INVALIDATION spec §4.4)
 * replaced `FoldCompleted` + `FactsIngested`: the desktop now publishes one
 * level-triggered signal per authority-revision advance instead of forwarding
 * domain events one by one. */
export type AppEventType = "Invalidated" | "SyncStatusChanged" | "HarnessNavigationChanged" | "TrustMonitorEvent" | "TrustMonitorInvalidated" | "SourceDataDeleted" | "WatcherHealthChanged";
/** Only `Invalidated` carries fields across the bridge: a monotonic revision and
 * the harnesses touched by that drain (a lower bound, never an exact set). Every
 * other type is reduced to its tag — payloads stay on the desktop side. */
export type AppEvent = { type: AppEventType; revision?: number; harnesses?: string[] };

/** Data-refresh gate (spec §6 + REFRESH_STORM R1): refresh on `SourceDataDeleted`
 * (revision-carrying poll syntheses compare against the watermark; real deletions
 * and legacy events without a revision stay unconditional), and on `Invalidated`
 * only when its revision strictly advances past what this subscriber already
 * refreshed for. Same-revision repeats and every other event type are ignored —
 * a page that needs `SyncStatusChanged` or `WatcherHealthChanged` subscribes to
 * those explicitly.
 *
 * `SourceDataDeleted` compares but never advances the watermark: subscribers
 * refresh different field sets per event type, so a poll-synthesised deletion
 * must not suppress the full `Invalidated` fan-out that may still be in flight. */
export function makeInvalidationGate(): (event: AppEvent) => boolean {
  let seenRevision = -1;
  // NaN 不是合法 revision：按缺失处理（保守刷新/比较侧视分支），与出货路径的
  // Number.isFinite 守卫同口径。
  const validRevision = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : -1;
  return (event) => {
    if (event.type === "SourceDataDeleted") {
      const revision = validRevision(event.revision);
      if (revision < 0) return true; // 真删除/旧桥：保守刷新
      return revision > seenRevision; // 只比较，不推进水位
    }
    if (event.type !== "Invalidated") return false;
    const revision = validRevision(event.revision);
    if (revision < 0) return true; // 无 revision 的旧桌面进程：保守刷新
    if (revision <= seenRevision) return false;
    seenRevision = revision;
    return true;
  };
}

/** Convert bridge failures into bounded user-facing copy. Raw invoke errors
 * may contain local paths, command lines, or provider diagnostics and must not
 * cross the React serving face. Detailed diagnostics stay in the desktop log.
 */
export function safeUiError(reason: unknown, fallback: string): string {
  const english = resolvedLanguage() === "en";
  const safeFallback = english ? "This local operation is unavailable. Please retry." : fallback;
  const detail = reason instanceof Error ? reason.message : "";
  if (!detail) return safeFallback;
  if (/取消|cancel/i.test(detail)) return english ? "Operation cancelled." : "操作已取消";
  if (/proposal changed|profile changed|reload before|review the latest scope/i.test(detail)) return english ? "This profile changed. Review its latest scope before retrying." : "Profile 已更新；请重新检查最新授权范围后再操作";
  if (/DTO|schema|格式|字段|不匹配|不守恒|超出|上限/i.test(detail)) return english ? "Local data format is incompatible. Update the app or rebuild its projection." : "本地数据格式不兼容，请升级应用或重建投影";
  if (/权限|permission|access denied|拒绝访问/i.test(detail)) return english ? "Permission to read local data is missing." : "本地数据读取权限不足";
  if (/authority|数据库|database|sqlite/i.test(detail)) return english ? "The local database is unavailable." : "本地 authority 暂不可用";
  if (/日期|月份|参数|引用|cursor|session_ref|filter/i.test(detail)) return english ? "The date, filter, or reference is unavailable. Check it and retry." : "筛选或引用参数不可用，请检查后重试";
  return safeFallback;
}

type TauriGlobal = {
  core?: { invoke?: (command: string, args?: unknown) => Promise<unknown> };
  event?: { listen?: (event: string, handler: (payload: unknown) => void) => Promise<Unsubscribe> };
};

const browserPreview: OverviewSnapshot = {
  freshness: "浏览器预览 · 合成数据",
  harnesses: 5,
  findings: 0,
  evidence: 8,
  monitored: false,
  today_tokens: 374000,
  today_spend: { CNY: 3.21 },
  month_spend: { CNY: 57.64, USD: 20 },
  subscription_cny_month: 49,
  sync: { ok: true, stage: "complete", at: null },
  budget: { source: "sql", level: "warn", month_cost: 8.64, monthly_cny: 12, month_ratio: 0.72 },
  harness_rows: [],
};

export type OverviewSnapshot = {
  freshness: string;
  harnesses: number | null;
  findings: number | null;
  evidence: number | null;
  monitored: boolean;
  today_tokens: number | null;
  today_spend: Record<string, number>;
  month_spend: Record<string, number>;
  subscription_cny_month: number | null;
  sync: { ok: boolean; stage: string; at: string | null };
  budget: { source: "sql" | "alert" | "missing"; level: string; month_cost: number | null; monthly_cny: number | null; month_ratio: number | null };
  harness_rows: Array<{ harness: string; status: "ready" | "partial" | "unavailable"; today_tokens: number | null; today_sessions: number | null; recent_count: number }>;
};

export type UsageDay = {
  date: string;
  total_tokens: number;
  dsh_tokens: number;
  claude_tokens: number;
  codex_tokens: number;
  costs: Record<string, number>;
  cost_lines: Array<{ source: "dsh" | "claude" | "codex"; currency: string; amount: number; basis: "metered_actual" | "metered_estimate" | "api_equivalent" }>;
};

export type UsageCalendar = {
  month: string;
  days: UsageDay[];
};

export type UsageSourceSummary = {
  month: string;
  freshness: "fresh" | "stale" | "partial" | "unavailable" | "unknown";
  last_observed_at: string | null;
  coverage: { measured_fields: number; total_fields: number };
  excluded_harnesses: string[];
  actual_spend: Record<string, number>;
  spend_by_basis: Record<string, Record<string, number>>;
  tokens_by_harness: Record<string, SummaryHarnessTokens>;
  total_tokens: number;
  metered_view: Record<string, { amount: number; actual: number; declared_estimate: number; default_estimate: number; label: string }>;
  by_provider: Record<string, SummaryAmount>;
  has_unresolved: boolean;
};

export type SummaryHarnessTokens = {
  total: number;
  uncached_input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  cache_hit_ratio: number | null;
};

export type SummaryAmount = {
  harness_id: string;
  amounts_by_basis: Record<string, number>;
  currency: string | null;
  has_unresolved: boolean;
  evidence_basis: string | null;
  pricing_method: string | null;
};

export type DailySummary = Omit<UsageSourceSummary, "month"> & { date: string };

export type OverviewDetails = {
  month: string;
  date: string;
  monthly: UsageSourceSummary | null;
  daily: DailySummary | null;
  calendar: UsageCalendar | null;
  failure_hours: Record<string, number> | null;
  /** 趋势图本周/本月档：{"2026-09-15": 3}；null = 读不到（不是零失败）。 */
  failure_days: Record<string, number> | null;
  authority_revision: number | null;
  is_consistent: boolean;
  errors: string[];
};

export type StatisticsTimezone = { timezone: string };

export type StatisticsSettingsReport = {
  timezone: { status: "ok" | "unavailable"; timezone: string | null; system_timezone: string | null; system_timezone_fallback?: boolean; follows_system?: boolean };
  retention: { status: "ok" | "unavailable"; months: number | null; minimum_months: number | null; maximum_months: number | null };
  pricing: { status: "ok" | "unavailable"; state: "ok" | "updated" | "failed" | "rejected" | "never_checked" | "skipped" | "unknown"; version: string | null; model_count: number | null; last_success_at_ms: number | null; available: boolean };
};

export type MonthlyExportRow = {
  harness: string;
  provider: string | null;
  tokens: number | null;
  basis: string | null;
  currency: string | null;
  amount: number | null;
  unresolved: boolean;
  evidence_basis: string | null;
  pricing_method: string | null;
  freshness: UsageSourceSummary["freshness"];
};

export type MonthlyExportSummary = {
  month: string;
  rows: MonthlyExportRow[];
  coverage: { measured_fields: number; total_fields: number };
  freshness: UsageSourceSummary["freshness"];
  excluded_harnesses: string[];
};

export type AboutDiagnosticsReport = {
  status: "ok" | "unavailable";
  appVersion: string | null;
  cliVersion: string | null;
  engineVersion: string | null;
  architecture: "x86_64" | "aarch64" | "x86" | "unknown";
  authoritySchema: string | null;
  statisticsTimezone: string | null;
  pricing: { version: string | null; capturedAtMs: number | null } | null;
  sync: { state: "ok" | "needs_attention" | "unknown" };
};
export type DiagnosticExportReceipt = { status: "saved" | "cancelled"; uploadPerformed: false };
export type UpdateCheckResult = { status: "ok" | "no_release" | "unavailable"; currentVersion: string | null; latestTag: string | null; updateAvailable: boolean; automaticInstall: false; releaseUrl: string | null; onLatestStable: boolean };

export type SkillHarnessSummary = { harness: string; skills_on_disk: number; discoverable_skills: number; runtime_verified_loaded_skills: number | null; unique_discoverable_skills: number; description_budget: { available: boolean; used_chars: number | null; budget_chars: number | null; pct_used: number | null; source: string | null }; trigger_data: "available" | "unavailable" | "unknown" };
export type SkillDiagnostic = { code: string; name: string; severity: "critical" | "warning" | "info"; skill: string | null; evidence_count: number; impact: string | null; recommendation: string | null; caveats: string[] };
export type SkillScanReport = { status: "ok" | "unavailable"; schema_version: string | null; run: string | null; harness_selection: string; generated_at_ms: number | null; from_cache: boolean; harnesses: SkillHarnessSummary[]; diagnostics: SkillDiagnostic[]; not_assessed: Array<{ code: string; name: string; reason: string }> };
export type SkillDiffIdentity = { harness: string; name: string; namespace: string | null; instance_id: string | null };
export type SkillDiffReport = {
  schema_version: "skills-diff-v1";
  status: "ok" | "partial";
  baseline_available: true;
  truncated: boolean;
  dropped_rows: number;
  summary: { added: number; removed: number; usage_changed: number; newly_judgeable: number; new_overlap_candidates: number; new_security_findings: number };
  added_skills: SkillDiffIdentity[];
  removed_skills: SkillDiffIdentity[];
  usage_delta: Array<SkillDiffIdentity & { delta: number; now: number }>;
  newly_judgeable: Array<SkillDiffIdentity & { usage_count?: number; installed_days_ago?: number; verdict?: "zombie" | "alive" }>;
  new_overlap_candidates: Array<[string, string]>;
  new_security_findings: Array<{ skill: string; rule: string; line: number }>;
  budget_delta_chars: number | null;
  budget_pct_then_now: [number | null, number | null] | null;
  loaded_then_now: [number, number] | null;
};
export type SkillSnapshotSaveReceipt = { status: "saved"; upload_performed: false };
export type SkillScanSettings = { self_root: string; budget: number | null };
export type SkillExportReceipt = { status: "saved" | "cancelled"; upload_performed: false };

export type SourceConnectionState = "connected" | "needs_attention" | "paused" | "excluded" | "not_detected" | "unknown";
export type SourceErrorKind = "permission_denied" | "file_missing" | "all_files_failed" | "db_error" | "migration_failed" | "manifest_or_source_invalid" | "source_busy" | "authority_unavailable" | "source_unavailable" | "ingest_failed" | "read_failed";
export type SourceHealthRow = {
  harness: string;
  connection_state: SourceConnectionState;
  sessions: number;
  facts: number;
  source_count: number;
  first_event_at_ms: number | null;
  last_event_at_ms: number | null;
  last_scanned_at_ms: number | null;
  failed_sources: number;
  error_kinds: SourceErrorKind[];
};
export type SourceHealthReport = {
  status: "ok" | "unavailable";
  sources: SourceHealthRow[];
  sync: { paused: boolean | null; last_success_at: string | null; state: "ok" | "failed" | "never" | "unavailable" };
};
export type SourceHarnessControls = { status: "ok" | "unavailable"; excluded_harnesses: string[]; supported_harnesses: string[] };
export type SourceHarnessControlReceipt = { status: "saved"; changed: boolean; excluded: boolean };
export type DeleteImportedSourceReceipt = { status: "deleted"; harness: string; facts: number; sessions: number; source_files: number; trust_observations: number; route_evidence: number; session_excerpts: number };

export type SyncRequestStatus = { completed: boolean; failed: boolean };
export type CustomSourceRoot = { harness: string; root: string };
export type CustomSourceReport = { status: "ok" | "unavailable"; sources: CustomSourceRoot[]; locations: Record<string, string | null> };

export type BudgetLevel = "ok" | "warn" | "exceeded" | "incomplete" | "no_data" | "disabled";
export type BudgetProfile = {
  profile_id: "estimate" | "confirmed";
  currency: string;
  monthly_minor: number;
  daily_minor: number | null;
  warning_ratio_bp: number;
  spent_minor: number;
  total_spent_minor: number;
  ratio_bp: number | null;
  level: BudgetLevel;
  daily_spent_minor: number;
  daily_total_minor: number;
  daily_ratio_bp: number | null;
  daily_level: BudgetLevel;
  has_unresolved: boolean;
  daily_has_unresolved: boolean;
  updated_at_ms: number | null;
  subscription_amortized_minor: number;
  subscription_skipped: string[];
};
export type BudgetSettingsReport = {
  status: "ok" | "unavailable";
  month: string | null;
  estimate: BudgetProfile | null;
  confirmed: BudgetProfile | null;
  legacy: { monthly_minor: number; daily_minor: number; warning_ratio_bp: number; origin: "legacy_import" | "user" | "unknown" } | null;
  snoozed_until_ms: number | null;
};
export type BudgetSaveReceipt = { status: "saved"; profile_id: "estimate"; currency: "CNY" | "USD"; notification_permission: "granted" | "denied" | "unavailable" };
export type BudgetDisableReceipt = { status: "disabled"; profile_id: "estimate"; changed: boolean };
export type NotificationPermission = "granted" | "denied" | "unavailable";
export type QuotaReminderConfig = { status: "ok" | "unavailable"; enabled: boolean; notification_permission: NotificationPermission | null };
export type QuotaReminderReceipt = { status: "saved"; enabled: boolean; notification_permission: NotificationPermission };

export type BillingAmount = { amount_minor: number; currency: string; basis: string };
export type BillingCandidate = {
  candidate_id: string;
  harness: string;
  provider_id: string;
  currency: string;
  amount_minor: number;
  billing_period_start: string;
  status: "pending" | "accepted" | "dismissed" | "unknown";
  impact: { total_tokens: number; fact_count: number; session_count: number } | null;
};
export type BillingCandidateReceipt = { status: "dismissed" | "pending"; changed: boolean };
export type BillingScope = { scope_kind: "account" | "route" | "model" | "session" | "provider" | "settlement"; scope_value: string };
export type BillingImpactBucket = { fact_count: number; session_count: number; tokens: number; unpriced_tokens: number; amounts: BillingAmount[] };
export type BillingImpactPreview = {
  status: "ok" | "unavailable";
  relationship_kind: string;
  effective_start: string | null;
  effective_end: string | null;
  changes_amounts: boolean;
  moved: BillingImpactBucket;
  kept: { tokens: number; unpriced_tokens: number; amounts: BillingAmount[] };
  pending: { fact_count: number; tokens: number; reasons: string[] };
  first_event_ts_ms: number | null;
  last_event_ts_ms: number | null;
};
export type BillingDeclarationReceipt = {
  status: "saved";
  declaration_id: string;
  revision_id: string;
  changed: boolean;
  job: { job_id: string; status: "queued" | "enqueue_failed"; changed: boolean } | null;
};
export type BillingDeclarationRevokeReceipt = { status: "revoked"; declaration_id: string; revision_id: string; changed: boolean };
export type BillingGroup = {
  group_id: string;
  harness: string;
  provider_id: string;
  model_id: string;
  evidence_basis: string;
  pricing_basis: string;
  tokens: number;
  session_count: number;
  effective_start: string;
  effective_end: string | null;
  estimated_amounts: BillingAmount[];
  unpriced_tokens: number;
  unresolved_reason: string | null;
  evidence_state: "determined" | "needs_input" | "unresolved" | "unknown";
};
/** 计费声明属于服务商账号、按模型使用结算，**没有执行环境**——执行环境只是用量的来源壳。 */
export type BillingDeclaration = {
  declaration_id: string;
  provider_id: string;
  relationship_kind: string;
  subscription_name: string | null;
  amount_minor: number | null;
  currency: string | null;
  effective_start: string;
  effective_end: string | null;
  current_revision_id: string | null;
  source_candidate_id: string | null;
  scopes: BillingScope[];
  scope_count: number;
};
export type BillingJob = { job_id: string; status: "queued" | "running" | "failed" | "cancelled" | "succeeded" | "unknown"; error_code: string | null; requested_at_ms: number | null };
export type BillingJobRetryReceipt = { status: "queued"; job_id: string; changed: boolean };
export type HarnessBill = { bill_id: string; harness: string; provider_id: string; billing_period: string; billing_basis: string; amount_minor: number; currency: string; has_evidence: boolean };
export type BillingPanelStatus = "ok" | "partial" | "unavailable";
export type BillingSettingsReport = { status: "ok" | "unavailable"; month: string; candidates_status: BillingPanelStatus; groups_status: BillingPanelStatus; declarations_status: BillingPanelStatus; jobs_status: BillingPanelStatus; bills_status: BillingPanelStatus; candidates: BillingCandidate[]; groups: BillingGroup[]; declarations: BillingDeclaration[]; jobs: BillingJob[]; bills: HarnessBill[] };

export type UsageHour = {
  hour: number;
  dsh_tokens: number | null;
  claude_tokens: number | null;
  codex_tokens: number | null;
};

export type UsageHourly = {
  date: string;
  harnesses_available: { dsh: string | null; claude: string | null; codex: string | null };
  hours: UsageHour[];
};

export type SessionCost = {
  amount_minor: number;
  currency: string;
  basis: "metered_actual" | "metered_estimate" | "fixed_subscription" | "api_equivalent" | "other";
};

export type SessionCostStatus = {
  state: "estimated" | "subscription" | "unpriced" | "unavailable";
  reason: string;
  has_unresolved: boolean;
};

export type SessionRow = {
  session_ref: string;
  harness: string;
  first_event_at: string | null;
  last_event_at: string | null;
  event_count: number;
  model_ids: string[];
  tokens: {
    uncached_input_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    output_tokens: number;
    total: number;
  };
  peak_tokens: number;
  cost_minor: SessionCost | null;
  cost_status: SessionCostStatus;
};

export type SessionsPage = {
  sessions: SessionRow[];
  next_cursor: string | null;
  has_more: boolean;
  window_session_count: number;
  window_total_tokens: number;
  window_label: string | null;
};

export type SessionTimelineRow = {
  event_at: string | null;
  model_id: string;
  observation_kind: string;
  peak: boolean;
  tokens: SessionRow["tokens"];
};

export type SessionWorkflowEvent = {
  event_at: string | null;
  event_type: string;
  capability_kind: string | null;
  capability_id: string | null;
  capability_version: string | null;
  outcome: "succeeded" | "failed" | "unknown";
  duration_ms: number | null;
  error_fingerprint: string | null;
  invocation_fingerprint: string | null;
};

export type SessionBillingBucket = {
  provider_id: string;
  provider_raw: string | null;
  model_id: string;
  billing_template_id: string | null;
  billing_mode: string;
  pricing_basis: string;
  evidence_basis: string;
  pricing_version: string | null;
  pricing_source: string | null;
  cost_minor: SessionCost | null;
  peak: boolean;
  tokens: SessionRow["tokens"];
  has_unresolved: boolean;
  unresolved_reason: string | null;
};

export type SessionDetail = Omit<SessionRow, "peak_tokens"> & {
  billing_breakdown: SessionBillingBucket[];
  timeline: SessionTimelineRow[];
  workflow_timeline: SessionWorkflowEvent[];
  workflow_has_more: boolean;
  has_more: boolean;
  next_cursor: string | null;
};

export type SessionsWindow = "month" | "today" | "7d" | "day" | "custom";
export type SessionsCostFilter = "all" | SessionCostStatus["state"];
export type SessionsFilters = {
  window: SessionsWindow;
  month: string;
  /** R1 深链的单日窗（#sessions?date=YYYY-MM-DD）：北京日，serverArgs → args.day。 */
  day: string;
  date_from: string;
  date_to: string;
  harness_kind: string;
  model: string;
  provider: string;
  cost_status: SessionsCostFilter;
};

export type RouteQualityModel = {
  model: string;
  requests: number;
  tokens_total: number;
  last_event_ms: number;
};

export type RouteQualityFamily = {
  family: "anthropic" | "openai" | "deepseek" | "glm" | "minimax" | "gemini" | "qwen" | "synthetic" | "unknown";
  flag: "native" | "non_native" | "api_error" | "no_baseline";
  requests: number;
  sessions: number;
  tokens_total: number;
  last_event_ms: number;
  request_share: number;
  models: RouteQualityModel[];
};

export type RouteQualityHarness = {
  harness: string;
  has_baseline: boolean;
  native_families: string[];
  totals: { requests: number; sessions: number };
  families: RouteQualityFamily[];
};

export type RouteQualityReport = {
  since_ms: number;
  now_ms: number;
  families_vocabulary: string[];
  harnesses: RouteQualityHarness[];
};

export type TrustHarnessCandidate = {
  id: string;
  detected: boolean;
  artifact_profile_available: boolean;
  coverage_state: string;
};

export type TrustEvidence = {
  kind: string;
  stage: string;
  evidence_level: string;
  evidence_origin: string;
  observed_at_ms: number;
  workspace_ref: string | null;
  native_event_ref: string | null;
  scope_classes: string[];
  file_count: number | null;
  byte_count: number | null;
  destination_class: string | null;
  collector_id: string;
};

export type TrustAuditReport = {
  harness: string;
  discovered: number;
  inserted: number;
  duplicate: number;
  findings_upserted: number;
  evidence_links_added: number;
  stage_counts: Record<string, number>;
  observation_kind_counts: Record<string, number>;
  evidence: TrustEvidence[];
};

export type TrustEvidenceHistory = {
  harness: string | null;
  count: number;
  evidence: TrustEvidence[];
  next_cursor: string | null;
};

export type TrustDiscovery = { candidates: TrustHarnessCandidate[]; profile_errors: string[] };

export type TrustProfileScopePreview = {
  roots_count: number;
  root_classes: Array<"git_metadata" | "workspace_or_project" | "home_relative_app_data">;
  covers_workspace_or_project: boolean;
  may_include_git_metadata: boolean;
  home_relative_only: true;
};

export type TrustSourceScopePreview = {
  roots_count: number;
  root_classes: Array<"filesystem_root" | "parent_traversal" | "home_directory" | "home_relative" | "absolute_home_path" | "absolute_system_path" | "relative_path">;
  covers_workspace_or_project: boolean;
  may_include_git_metadata: boolean;
  covers_full_filesystem: boolean;
  may_leave_home_directory: boolean;
};

export type TrustProfileSummary = {
  slug: string;
  display_name: string;
  state: "pending" | "invalid" | "approved";
  manifest_hash: string;
  discovery_include_count: number;
  trust_roots_count: number;
  artifact_terms_count: number;
  extensions_count: number;
  trust_adapter: "generic_artifact_v1" | "zcode_checkpoint_v1" | "minimax_workspace_index_v1" | null;
  watch_priority: "normal" | "enhanced" | null;
  source_scope_preview: TrustSourceScopePreview | null;
  trust_scope_preview: TrustProfileScopePreview | null;
};

export type TrustProfileStatus = { pending: TrustProfileSummary[]; approved: TrustProfileSummary[] };
export type TrustSuppression = { suppression_id: string; issue_type: string; created_at_ms: number; revoked_at_ms: number | null };

export type TrustMonitorCapability = "not_started" | "available" | "partial" | "unavailable";
export type TrustMonitorConfig = {
  status: "ok" | "unavailable";
  reason: "authority_unavailable" | "monitor_state_unavailable" | null;
  enabled: boolean;
  interval_seconds: number;
  notifications_enabled: boolean;
  capability: TrustMonitorCapability;
  last_success_at_ms: number | null;
  last_error_code: "sensor_unavailable" | "snapshot_failed" | "sensor_partial" | "authority_unavailable" | "monitor_state_unavailable" | null;
  updated_at_ms: number | null;
  notification_permission: "granted" | "denied" | "unavailable" | null;
  /** R6a 知情同意四态：legacy_default 待询问 / default 出厂开（R6c 起）/ user 显式选择 / dismissed 永不再问。 */
  enabled_source: "legacy_default" | "default" | "user" | "dismissed";
};

export type TrustSnapshotCapability = "macos_lsof_partial" | "runtime_sensor_unavailable_on_this_platform" | "lsof_unavailable" | "lsof_no_visible_output" | "lsof_invalid_output" | "unavailable";
export type TrustRuntimeSnapshot = {
  capability: TrustSnapshotCapability;
  candidate_processes: number;
  observations: number;
  inserted: number;
  duplicate: number;
  findings_upserted: number;
  notification_candidates: number;
  evidence_links_added: number;
};

export type FindingStatusRollup = {
  open: number;
  later: number;
  acknowledged: number;
  resolved: number;
  not_applicable: number;
};

export type FindingSample = {
  has_evidence: boolean;
  reference: string | null;
  observed_first_at_ms: number | null;
  observed_last_at_ms: number | null;
  evidence_level: "E0" | "E1" | "E2" | "E3" | "E4" | "E5" | null;
  stage: "read_observed" | "package_observed" | "credential_observed" | "egress_attempted" | "egress_transmitted" | "remote_accepted" | null;
  evidence_origin: "local_artifact" | "client_state_claim" | "runtime_process_metadata" | "network_metadata" | "verified_receipt" | "unknown_legacy" | null;
  scope_classes: string[];
  observation_count: number | null;
  file_count: number | null;
  byte_count: number | null;
  destination_class: "vendor_api" | "object_storage" | "telemetry" | "eval" | "model_api" | "unknown" | null;
  confidence: "high" | "medium" | "low" | null;
};

export type FindingGroup = {
  group_id: string;
  action_kind: string;
  rule: string;
  harness: string;
  evidence_class: string;
  count: number;
  first_seen_at_ms: number;
  last_seen_at_ms: number;
  severity: string;
  status_rollup: FindingStatusRollup;
  sessions_count: number;
  sample_evidence: FindingSample[];
  read_only: boolean;
  manual_follow_up: boolean;
};

export type FindingsReport = {
  totals: { issues: number; findings: number; critical: number; warning: number; info: number; sessions: number; sessions_total: number };
  rules: Array<{ rule: string; severity: string; category: string; hits: number; sessions: number }>;
  issues: FindingGroup[];
  next_cursor: string | null;
  refreshed: boolean;
};

export type FindingsFreshness = {
  status: "ok" | "unavailable";
  state: "fresh" | "stale" | "not_yet_synced" | "unknown";
  last_successful_sync_at: string | null;
  stale_harnesses: string[];
  syncing: boolean;
};

export type DecisionAmount = { amount_minor: number; currency: string; basis: string };
export type DecisionTopSession = {
  session_ref: string;
  span_first_ms: number;
  span_last_ms: number;
  tokens_total: number;
  failures: number;
};
export type DecisionMatrixRow = {
  harness: string;
  model_id: string;
  provider_id: string;
  sessions: number;
  tokens: { uncached_input: number; cache_read: number; cache_write: number; output: number; total: number };
  cache_hit_ratio: number | null;
  has_subscription: boolean;
  waste_rate: number | null;
  amounts: DecisionAmount[];
  top_sessions: DecisionTopSession[];
  harness_behavior: Record<string, number>;
  limit_pressure: { hits: number; per_session: number | null } | null;
  cost_provider_unresolved: boolean;
};
export type DecisionSummary = {
  kind: "cost_outlier" | "marathon" | "currency_split";
  currency?: string;
  outlier?: { harness: string; model_id: string; provider_id: string; per_session_minor: number; cache_hit_ratio: number | null; uncached_tokens: number };
  control?: { harness: string; model_id: string; provider_id: string; per_session_minor: number; cache_hit_ratio: number | null; uncached_tokens: number };
  ratio_vs_control?: number;
  saving_minor?: number;
  saving_pct?: number;
  session_ref?: string;
  span_hours?: number;
  tokens_total?: number;
  failures?: number;
  combo?: { harness: string; model_id: string };
  currencies?: string[];
  by_currency?: Record<string, { combos: number; tokens: number }>;
};
export type DecisionMatrixReport = {
  schema_version: "agent-vitals-decision-matrix/v1";
  status: "ok";
  month: string;
  rows: DecisionMatrixRow[];
  findings_summary: DecisionSummary[];
  limitations: string[];
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} DTO 格式不兼容`);
  return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 256) throw new Error(`${label} DTO 字段不安全`);
  return value;
}

function decisionLabel(value: unknown, label: string): string {
  const text = stringField(value, label);
  const valid = text === "<unknown>" || text === "<synthetic>" || (/^[A-Za-z0-9][A-Za-z0-9._:@+<>-]{0,127}(\/[A-Za-z0-9][A-Za-z0-9._:@+<>-]{0,127})?$/.test(text) && !text.includes("://") && !text.includes("..") && !text.startsWith("file:") && !/^[A-Za-z]:/.test(text));
  if (!valid) throw new Error(`${label} DTO 标识不安全`);
  return text;
}

function decisionCurrency(value: unknown, label: string): string {
  const text = stringField(value, label);
  if (!/^[A-Z0-9_]{1,12}$/.test(text)) throw new Error(`${label} DTO 币种不安全`);
  return text;
}

function decisionBasis(value: unknown, label: string): string {
  const text = stringField(value, label);
  if (text !== "metered_actual" && text !== "metered_estimate" && text !== "fixed_subscription" && text !== "api_equivalent" && text !== "other") throw new Error(`${label} DTO 计价口径不安全`);
  return text;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return stringField(value, label);
}

function nullableCount(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} DTO 计数不安全`);
  return value;
}

function nullableSourceTimestampMs(value: unknown, label: string): number | null {
  const timestamp = nullableCount(value, label);
  if (timestamp !== null && timestamp > 4_102_444_800_000) throw new Error(`${label} DTO 时间戳超限`);
  return timestamp;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} DTO 缺少数组字段`);
  return value;
}

function requiredCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} DTO 缺少安全计数`);
  return value;
}

function boundedCount(value: unknown, label: string, maximum = 1_000_000_000): number {
  const count = requiredCount(value, label);
  if (count > maximum) throw new Error(`${label} DTO 计数超限`);
  return count;
}

function boundedSignedCount(value: unknown, label: string, maximum = 1_000_000_000): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Math.abs(value) > maximum) throw new Error(`${label} DTO 有符号计数不安全`);
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} DTO 状态不安全`);
  return value;
}

function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} DTO 数值不安全`);
  return value;
}

function safeReference(value: unknown, label: string): string | null {
  const reference = nullableString(value, label);
  if (reference !== null && !/^tr_[A-Za-z0-9_-]{8,128}$/.test(reference)) throw new Error(`${label} DTO 引用格式不安全`);
  return reference;
}

const SESSION_PRICING_BASES = ["metered_estimate", "metered_actual", "metered_declared", "fixed_subscription", "harness_billed", "api_equivalent", "unavailable"] as const;
/// `backfilled`：当时快照没有这个模型的卡，用事后每日同步到的价卡补算（只补缺卡）。
const SESSION_PRICING_SOURCES = ["official", "fallback_official", "backfilled"] as const;

function boundedEnum(value: unknown, label: string, allowed: readonly string[], fallback: string): string {
  const candidate = stringField(value, label);
  return allowed.includes(candidate) ? candidate : fallback;
}

function safeHarnessLabel(value: unknown): string {
  if (typeof value !== "string") return "generic";
  const candidate = value;
  if (/^plugin:[a-z][a-z0-9-]{0,31}$/.test(candidate)) return candidate;
  if (/^harness:[a-z][a-z0-9_-]{0,31}$/.test(candidate)) return candidate;
  return /^[a-z][a-z0-9_-]{0,31}$/.test(candidate) ? candidate : "generic";
}

function safeLocalPath(value: unknown, label: string): string {
  const path = stringField(value, label);
  if (path.length > 4096 || /[\u0000-\u001f\u007f]/u.test(path) || !(/^(?:~\/|\/|[A-Za-z]:[\\/]|\\\\)/.test(path))) throw new Error(`${label} DTO 路径不安全`);
  return path;
}

function safeMoneyMap(value: unknown, label: string): Record<string, number> {
  if (value === null || value === undefined) return {};
  const source = record(value, label);
  return Object.fromEntries(Object.entries(source).slice(0, 8).flatMap(([currency, amount]) => {
    if (!/^[A-Z0-9_]{1,12}$/.test(currency) || typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1e15) return [];
    return [[currency, amount]];
  }));
}

function strictSummaryMoneyMap(value: unknown, label: string): Record<string, number> {
  if (value === null || value === undefined) return {};
  const source = record(value, label);
  const entries = Object.entries(source);
  if (entries.length > 8) throw new Error(`${label} DTO 币种数量超出上限`);
  const result: Record<string, number> = {};
  for (const [currency, amount] of entries) {
    if (!/^[A-Z0-9_]{1,12}$/.test(currency) || typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1e15) {
      throw new Error(`${label} DTO 金额不安全`);
    }
    result[currency] = amount;
  }
  return result;
}

function assertSummaryMoneyPartition(total: Record<string, number>, byBasis: Record<string, Record<string, number>>): void {
  const aggregate: Record<string, number> = {};
  for (const amounts of Object.values(byBasis)) {
    for (const [currency, amount] of Object.entries(amounts)) aggregate[currency] = (aggregate[currency] ?? 0) + amount;
  }
  const currencies = new Set([...Object.keys(total), ...Object.keys(aggregate)]);
  for (const currency of currencies) {
    const totalAmount = total[currency] ?? 0;
    const aggregateAmount = aggregate[currency] ?? 0;
    const tolerance = Math.max(1e-9, Math.max(Math.abs(totalAmount), Math.abs(aggregateAmount)) * 1e-12);
    if (Math.abs(totalAmount - aggregateAmount) > tolerance) throw new Error("usage spend by basis 不守恒");
  }
}

function nullableMoney(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e15) throw new Error(`${label} DTO 金额不安全`);
  return value;
}

function overviewTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null;
  return value;
}

const sourceStates = ["connected", "needs_attention", "paused", "excluded", "not_detected", "unknown"] as const;

function sourceErrorKind(value: unknown): SourceErrorKind {
  const raw = typeof value === "string" ? value : "";
  if (raw === "permission_denied" || raw === "permission") return "permission_denied";
  if (raw === "file_missing") return "file_missing";
  if (raw === "all_files_failed") return "all_files_failed";
  if (raw === "db_error") return "db_error";
  if (raw === "migration_failed") return "migration_failed";
  if (raw === "manifest_or_source_invalid" || raw === "source_busy" || raw === "authority_unavailable" || raw === "source_unavailable" || raw === "ingest_failed") return raw;
  return "read_failed";
}

function sourceErrorKinds(value: unknown): SourceErrorKind[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, 16).map(sourceErrorKind))];
}

function parseSourceHealth(value: unknown, pauseValue: unknown, overviewValue: unknown): SourceHealthReport {
  const root = record(value, "source health");
  const status = boundedEnum(root.status ?? "unavailable", "source health status", ["ok", "unavailable"], "unavailable") as SourceHealthReport["status"];
  const sources = requiredArray(root.sources, "source health sources");
  if (sources.length > 128) throw new Error("source health sources 超出上限");
  const rows = sources.map((item) => {
    const row = record(item, "source health row");
    const scan = row.scan == null ? {} : record(row.scan, "source health scan");
    const log = row.log == null ? {} : record(row.log, "source health log");
    const scope = row.import_scope == null ? {} : record(row.import_scope, "source health import scope");
    const failed = row.failed_scope == null ? {} : record(row.failed_scope, "source health failed scope");
    return {
      harness: safeHarnessLabel(row.harness),
      connection_state: boundedEnum(row.connection_state ?? "unknown", "source health state", sourceStates, "unknown") as SourceConnectionState,
      sessions: boundedCount(scope.sessions ?? 0, "source health sessions", 10_000_000),
      facts: boundedCount(scope.facts ?? 0, "source health facts", 100_000_000),
      source_count: boundedCount(scan.source_count ?? 0, "source health source count", 1_000_000),
      first_event_at_ms: nullableSourceTimestampMs(scope.first_event_at_ms, "source health first event"),
      last_event_at_ms: nullableSourceTimestampMs(scope.last_event_at_ms ?? log.last_event_at_ms, "source health last event"),
      last_scanned_at_ms: nullableSourceTimestampMs(scan.last_scanned_at_ms, "source health last scan"),
      failed_sources: boundedCount(failed.sources ?? 0, "source health failed sources", 1_000_000),
      error_kinds: sourceErrorKinds(failed.error_codes),
    };
  }).sort((left, right) => (left.connection_state === "needs_attention" ? -1 : 0) - (right.connection_state === "needs_attention" ? -1 : 0) || left.harness.localeCompare(right.harness));
  const pauseRoot = pauseValue == null ? {} : record(pauseValue, "source pause state");
  const paused = pauseRoot.paused === null || pauseRoot.paused === undefined ? null : requiredBoolean(pauseRoot.paused, "source pause state");
  const overviewRoot = overviewValue == null ? {} : record(overviewValue, "source sync overview");
  const sync = overviewRoot.sync == null ? {} : record(overviewRoot.sync, "source sync status");
  const syncStage = boundedEnum(sync.stage ?? "unknown", "source sync stage", ["complete", "fold", "discover", "resolve", "never", "paused", "unknown"], "unknown");
  const syncState: SourceHealthReport["sync"]["state"] = status !== "ok" ? "unavailable" : syncStage === "complete" ? "ok" : syncStage === "never" ? "never" : syncStage === "unknown" ? "unavailable" : "failed";
  return { status, sources: rows, sync: { paused, last_success_at: overviewTimestamp(sync.at), state: syncState } };
}

function parseSourceHarnessControls(value: unknown): SourceHarnessControls {
  const root = record(value, "source harness controls");
  const status = boundedEnum(root.status ?? "unavailable", "source harness controls status", ["ok", "unavailable"], "unavailable") as SourceHarnessControls["status"];
  const harnesses = requiredArray(root.excluded_harnesses ?? [], "excluded source harnesses").slice(0, 64).map((harness) => safeHarnessLabel(harness));
  const supported = requiredArray(root.supported_harnesses ?? [], "supported source harnesses").slice(0, 64).map((harness) => safeHarnessLabel(harness));
  return { status, excluded_harnesses: [...new Set(harnesses.filter((harness) => harness !== "generic"))], supported_harnesses: [...new Set(supported.filter((harness) => harness !== "generic"))] };
}

function parseCustomSourceReport(value: unknown, locationsValue: unknown): CustomSourceReport {
  const root = record(value, "custom source roots");
  const status = boundedEnum(root.status ?? "unavailable", "custom source status", ["ok", "unavailable"], "unavailable") as CustomSourceReport["status"];
  const rawSources = status === "unavailable" ? [] : requiredArray(root.sources, "custom source roots");
  if (rawSources.length > 64) throw new Error("custom source roots 超出上限");
  const sources = rawSources.map((item) => {
    const row = record(item, "custom source root");
    const harness = safeHarnessLabel(row.harness);
    if (!["claude-code", "codex", "dsh"].includes(harness)) throw new Error("custom source harness 不受支持");
    const rootPath = safeLocalPath(row.root, "custom source root");
    if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(rootPath)) throw new Error("custom source root DTO 必须为绝对路径");
    return { harness, root: rootPath };
  }).sort((left, right) => left.harness.localeCompare(right.harness) || left.root.localeCompare(right.root));
  const locationRoot = locationsValue == null ? {} : record(locationsValue, "source read locations");
  const locations: Record<string, string | null> = {};
  for (const [harness, rawPath] of Object.entries(locationRoot).slice(0, 16)) {
    const safeHarness = safeHarnessLabel(harness);
    if (!["claude-code", "codex", "dsh"].includes(safeHarness)) continue;
    if (rawPath === null || rawPath === undefined) locations[safeHarness] = null;
    else locations[safeHarness] = safeLocalPath(rawPath, "source read location");
  }
  return { status, sources, locations };
}

const budgetLevels = ["ok", "warn", "exceeded", "incomplete", "no_data", "disabled"] as const;

function budgetMinor(value: unknown, label: string, nullable = false): number | null {
  if (nullable && (value === null || value === undefined)) return null;
  return boundedCount(value, label, Number.MAX_SAFE_INTEGER);
}

function budgetRatio(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return boundedCount(value, label, Number.MAX_SAFE_INTEGER);
}

function budgetCurrency(value: unknown): string {
  const currency = stringField(value, "budget currency");
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("budget currency 不安全");
  return currency;
}

function parseBudgetProfile(value: unknown): BudgetProfile {
  const row = record(value, "budget profile");
  if (row.profile_id !== "estimate" && row.profile_id !== "confirmed") throw new Error("budget profile id 不受支持");
  const profileId = row.profile_id as BudgetProfile["profile_id"];
  const monthly = budgetMinor(row.monthly_minor, "budget monthly amount");
  if (monthly === null || monthly <= 0) throw new Error("budget monthly amount 不安全");
  return {
    profile_id: profileId,
    currency: budgetCurrency(row.currency),
    monthly_minor: monthly,
    daily_minor: budgetMinor(row.daily_minor, "budget daily amount", true),
    warning_ratio_bp: boundedCount(row.warning_ratio_bp ?? 8000, "budget warning ratio", 10000),
    spent_minor: budgetMinor(row.spent_minor ?? 0, "budget spent") ?? 0,
    total_spent_minor: budgetMinor(row.total_spent_minor ?? row.spent_minor ?? 0, "budget total spent") ?? 0,
    ratio_bp: budgetRatio(row.ratio_bp, "budget ratio"),
    level: boundedEnum(row.level ?? "no_data", "budget level", budgetLevels, "no_data") as BudgetLevel,
    daily_spent_minor: budgetMinor(row.daily_spent_minor ?? 0, "budget daily spent") ?? 0,
    daily_total_minor: budgetMinor(row.daily_total_minor ?? row.daily_spent_minor ?? 0, "budget daily total") ?? 0,
    daily_ratio_bp: budgetRatio(row.daily_ratio_bp, "budget daily ratio"),
    daily_level: boundedEnum(row.daily_level ?? (row.daily_minor == null ? "disabled" : "no_data"), "budget daily level", budgetLevels, "no_data") as BudgetLevel,
    has_unresolved: row.has_unresolved === true,
    daily_has_unresolved: row.daily_has_unresolved === true,
    updated_at_ms: nullableTimestampMs(row.updated_at_ms, "budget updated at"),
    subscription_amortized_minor: budgetMinor(row.subscription_amortized_minor ?? 0, "budget subscription amortized") ?? 0,
    subscription_skipped: Array.isArray(row.subscription_skipped) ? row.subscription_skipped.slice(0, 16).map((item) => safeHarnessLabel(item)) : [],
  };
}

function parseBudgetProfiles(value: unknown): { status: "ok" | "unavailable"; month: string | null; profiles: BudgetProfile[] } {
  const root = record(value, "budget profiles");
  if (root.status === "unavailable") return { status: "unavailable", month: null, profiles: [] };
  if (root.status !== "ok") throw new Error("budget profiles status 不兼容");
  const profiles = requiredArray(root.profiles ?? [], "budget profiles");
  if (profiles.length > 8) throw new Error("budget profiles 超出上限");
  return {
    status: "ok",
    month: root.month == null ? null : safeMonth(root.month, "budget month"),
    profiles: profiles.map(parseBudgetProfile),
  };
}

function parseLegacyBudget(value: unknown): BudgetSettingsReport["legacy"] {
  const root = record(value, "legacy budget");
  if (root.status !== "ok") return null;
  const monthly = budgetMinor(root.monthly_cny_minor, "legacy monthly amount");
  const daily = budgetMinor(root.daily_cny_minor ?? 0, "legacy daily amount");
  if (monthly === null || monthly <= 0) return null;
  const rawOrigin = root.origin;
  const origin = rawOrigin === "legacy_import" || rawOrigin === "user" ? rawOrigin : "unknown";
  return { monthly_minor: monthly, daily_minor: daily ?? 0, warning_ratio_bp: boundedCount(root.warning_ratio_bp ?? 8000, "legacy warning ratio", 10000), origin };
}

function snoozeTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function currentBudgetMonth(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  return `${year}-${month}`;
}

function parseBudgetSaveReceipt(value: unknown): BudgetSaveReceipt {
  const root = record(value, "budget save receipt");
  if (root.status !== "saved") throw new Error("预算保存未确认");
  if (root.currency !== "CNY" && root.currency !== "USD") throw new Error("budget saved currency 不受支持");
  const currency = root.currency as BudgetSaveReceipt["currency"];
  const rawPermission = typeof root.notification_permission === "string" ? root.notification_permission.toLowerCase() : "";
  const notification_permission = rawPermission === "granted" ? "granted" : rawPermission === "denied" || rawPermission === "prompt" || rawPermission === "restricted" ? "denied" : "unavailable";
  return { status: "saved", profile_id: "estimate", currency, notification_permission };
}

function parseBudgetDisableReceipt(value: unknown): BudgetDisableReceipt {
  const root = record(value, "budget disable receipt");
  if (root.status !== "disabled" || root.profile_id !== "estimate") throw new Error("预算停用未确认");
  return { status: "disabled", profile_id: "estimate", changed: requiredBoolean(root.changed, "budget disable changed") };
}

function parseNotificationPermission(value: unknown): NotificationPermission {
  if (typeof value !== "string") return "unavailable";
  const normalized = value.toLowerCase();
  if (normalized === "granted") return "granted";
  if (["denied", "prompt", "restricted"].includes(normalized)) return "denied";
  return "unavailable";
}

function parseQuotaReminderConfig(value: unknown): QuotaReminderConfig {
  const root = record(value, "quota reminder config");
  if (root.status === "unavailable") return { status: "unavailable", enabled: false, notification_permission: null };
  if (root.status !== "ok") throw new Error("quota reminder config status 不兼容");
  return {
    status: "ok",
    enabled: root.enabled === true,
    notification_permission: root.notification_permission == null ? null : parseNotificationPermission(root.notification_permission),
  };
}

function parseQuotaReminderReceipt(value: unknown): QuotaReminderReceipt {
  const root = record(value, "quota reminder receipt");
  if (root.status !== "saved" || typeof root.enabled !== "boolean") throw new Error("额度提醒保存未确认");
  return { status: "saved", enabled: root.enabled, notification_permission: parseNotificationPermission(root.notification_permission) };
}

function parseOverviewSnapshot(value: unknown): OverviewSnapshot {
  const root = record(value, "overview");
  const syncRow = root.sync == null ? {} : record(root.sync, "overview sync");
  const syncStage = boundedEnum(syncRow.stage ?? "unknown", "overview sync stage", ["complete", "fold", "discover", "resolve", "never", "paused", "partial", "light", "control", "facts", "unknown"], "unknown");
  const syncOk = syncRow.ok === true && syncStage !== "unknown";
  const syncAt = overviewTimestamp(syncRow.at);
  const budgetRow = root.budget == null ? {} : record(root.budget, "overview budget");
  const budgetSource = boundedEnum(budgetRow.source ?? "missing", "overview budget source", ["sql", "alert", "missing"], "missing") as OverviewSnapshot["budget"]["source"];
  const budgetLevel = boundedEnum(budgetRow.level ?? "unknown", "overview budget level", ["no_budget", "ok", "warn", "over", "snoozed", "disabled", "unknown"], "unknown");
  const rawHarnesses = Array.isArray(root.harnesses) ? root.harnesses : [];
  const harnessRows = rawHarnesses.slice(0, 16).map((item) => {
    const row = record(item, "overview harness");
    return {
      harness: safeHarnessLabel(row.harness_kind),
      status: boundedEnum(row.status, "overview harness status", ["ready", "partial", "unavailable"], "unavailable") as OverviewSnapshot["harness_rows"][number]["status"],
      today_tokens: nullableCount(row.today_tokens, "overview harness tokens"),
      today_sessions: nullableCount(row.today_sessions, "overview harness sessions"),
      recent_count: Array.isArray(row.recent) ? Math.min(row.recent.length, 100) : 0,
    };
  });
  const today = root.today == null ? null : record(root.today, "overview today");
  const month = root.month == null ? null : record(root.month, "overview month");
  const todaySpend = safeMoneyMap(today?.total_actual_spend, "overview today spend");
  const monthSpend = safeMoneyMap(month?.total_actual_spend, "overview month spend");
  const todayTokens = root.today_tokens_sql === null || root.today_tokens_sql === undefined
    ? null : boundedCount(root.today_tokens_sql, "overview today tokens");
  const subscription = nullableMoney(root.subscription_cny_month, "overview subscription");
  const harnessCount = rawHarnesses.length ? Math.min(rawHarnesses.length, 16) : (root.tokens_by_harness && typeof root.tokens_by_harness === "object" && !Array.isArray(root.tokens_by_harness) ? Math.min(Object.keys(root.tokens_by_harness).length, 16) : null);
  return {
    freshness: syncAt ? `本地同步 · ${syncAt}` : syncOk ? "本地同步 · 已完成" : "本地同步 · 状态不可用",
    harnesses: harnessCount,
    findings: null,
    evidence: null,
    monitored: false,
    today_tokens: todayTokens,
    today_spend: todaySpend,
    month_spend: monthSpend,
    subscription_cny_month: subscription,
    sync: { ok: syncOk, stage: syncStage, at: syncAt },
    budget: { source: budgetSource, level: budgetLevel, month_cost: nullableMoney(budgetRow.month_cost, "overview month cost"), monthly_cny: nullableMoney(budgetRow.monthly_cny, "overview monthly budget"), month_ratio: budgetRow.month_ratio == null ? null : Math.min(requiredFiniteNumber(budgetRow.month_ratio, "overview budget ratio"), 1000) },
    harness_rows: harnessRows,
  };
}

function safeMonth(value: unknown, label: string): string {
  const month = stringField(value, label);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`${label} DTO 月份不安全`);
  return month;
}

function safeDate(value: unknown, label: string): string {
  const date = stringField(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${label} DTO 日期不安全`);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) throw new Error(`${label} DTO 日期不安全`);
  return date;
}

function safeNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e15) throw new Error(`${label} DTO 数值不安全`);
  return value;
}

function safeNullableToken(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return boundedCount(value, label, 1_000_000_000_000_000);
}

function parseUsageDay(value: unknown, date: string): UsageDay {
  const row = record(value, "usage day");
  const costs: Record<string, number> = {};
  const rawCosts = [
    ["dsh", "CNY", row.dsh_cost_cny, "metered_actual"],
    ["claude", "CNY", row.claude_cost_cny, "metered_estimate"],
    ["claude", "USD", row.claude_cost_usd, "metered_estimate"],
    ["codex", "USD", row.codex_cost_usd, "api_equivalent"],
  ] as const;
  const costLines = rawCosts.map(([source, currency, rawAmount, basis]) => {
    const amount = safeNonNegativeNumber(rawAmount, `usage ${source} ${currency} cost`);
    costs[currency] = (costs[currency] ?? 0) + amount;
    return { source, currency, amount, basis };
  }).filter((line) => line.amount > 0);
  const dshTokens = boundedCount(row.dsh_tokens, "usage dsh tokens", 1_000_000_000_000_000);
  const claudeTokens = boundedCount(row.claude_tokens, "usage claude tokens", 1_000_000_000_000_000);
  const codexTokens = boundedCount(row.codex_tokens, "usage codex tokens", 1_000_000_000_000_000);
  const totalTokens = boundedCount(row.total_tokens, "usage total tokens", 1_000_000_000_000_000);
  if (totalTokens !== dshTokens + claudeTokens + codexTokens) throw new Error("usage token totals 不守恒");
  return {
    date,
    total_tokens: totalTokens, dsh_tokens: dshTokens, claude_tokens: claudeTokens, codex_tokens: codexTokens, costs, cost_lines: costLines,
  };
}

function parseUsageCalendar(value: unknown): UsageCalendar {
  const root = record(value, "usage calendar");
  const month = safeMonth(root.month, "usage month");
  const daysObject = record(root.days, "usage days");
  const entries = Object.entries(daysObject);
  if (entries.length > 62) throw new Error("usage days 超出月份范围");
  const days = entries.map(([date, item]) => {
    const safe = safeDate(date, "usage day key");
    if (!safe.startsWith(`${month}-`)) throw new Error("usage day 不属于请求月份");
    return parseUsageDay(item, safe);
  });
  return { month, days: days.sort((left, right) => left.date.localeCompare(right.date)) };
}

function parseSummaryHarnessTokens(value: unknown, label: string): SummaryHarnessTokens {
  const row = record(value, label);
  const total = boundedCount(row.total, `${label} total`, 1_000_000_000_000_000);
  const uncached = boundedCount(row.uncached_input, `${label} uncached input`, 1_000_000_000_000_000);
  const cacheRead = boundedCount(row.cache_read, `${label} cache read`, 1_000_000_000_000_000);
  const cacheWrite = boundedCount(row.cache_write, `${label} cache write`, 1_000_000_000_000_000);
  const output = boundedCount(row.output, `${label} output`, 1_000_000_000_000_000);
  if (total !== uncached + cacheRead + cacheWrite + output) throw new Error(`${label} token totals 不守恒`);
  const ratio = row.cache_hit_ratio === null || row.cache_hit_ratio === undefined ? null : requiredFiniteNumber(row.cache_hit_ratio, `${label} cache hit ratio`);
  if (ratio !== null && (ratio < 0 || ratio > 1)) throw new Error(`${label} cache hit ratio 不安全`);
  return { total, uncached_input: uncached, cache_read: cacheRead, cache_write: cacheWrite, output, cache_hit_ratio: ratio };
}

function parseSummaryAmount(value: unknown, label: string): SummaryAmount {
  const row = record(value, label);
  const rawAmounts = record(row.amounts_by_basis ?? {}, `${label} amounts`);
  const amounts_by_basis: Record<string, number> = {};
  for (const [basis, amount] of Object.entries(rawAmounts).slice(0, 12)) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(basis)) continue;
    amounts_by_basis[basis] = safeNonNegativeNumber(amount, `${label} ${basis}`);
  }
  const currency = row.currency === null || row.currency === undefined ? null : stringField(row.currency, `${label} currency`);
  if (currency !== null && !/^[A-Z0-9_]{1,12}$/.test(currency)) throw new Error(`${label} currency 不安全`);
  return {
    harness_id: safeHarnessLabel(row.harness_id), amounts_by_basis, currency,
    has_unresolved: row.has_unresolved === true,
    evidence_basis: row.evidence_basis == null ? null : decisionLabel(row.evidence_basis, `${label} evidence basis`),
    pricing_method: row.pricing_method == null ? null : decisionLabel(row.pricing_method, `${label} pricing method`),
  };
}

function parseSummaryRoot(value: unknown, windowKind: "month" | "date"): UsageSourceSummary | DailySummary {
  const root = record(value, "usage source summary");
  const window = windowKind === "month" ? safeMonth(root.month, "usage summary month") : safeDate(root.date, "usage summary date");
  const freshnessRow = record(root.freshness, "usage freshness");
  const freshness = boundedEnum(freshnessRow.state, "usage freshness state", ["fresh", "stale", "partial", "unavailable"], "unknown") as UsageSourceSummary["freshness"];
  const coverageRow = record(root.coverage, "usage coverage");
  const excluded = requiredArray(root.excluded_harnesses, "usage excluded harnesses").slice(0, 32).map((harness) => safeHarnessLabel(harness));
  const measured = boundedCount(coverageRow.measured_fields, "usage measured fields", 1_000);
  const total = boundedCount(coverageRow.total_fields, "usage total fields", 1_000);
  if (measured > total) throw new Error("usage coverage 不守恒");
  const rawBasis = record(root.actual_spend_by_basis, "usage spend by basis");
  const spendByBasis: Record<string, Record<string, number>> = {};
  const allowedBases = ["metered_actual", "harness_billed", "fixed_subscription", "metered_declared", "metered_estimate", "api_equivalent", "other"] as const;
  for (const basis of Object.keys(rawBasis)) {
    if (!(allowedBases as readonly string[]).includes(basis)) throw new Error("usage spend basis 不受支持");
  }
  for (const basis of allowedBases) {
    if (rawBasis[basis] !== undefined) spendByBasis[basis] = strictSummaryMoneyMap(rawBasis[basis], `usage ${basis} spend`);
  }
  const rawTokens = record(root.tokens_by_harness ?? {}, "usage tokens by harness");
  const tokens_by_harness: Record<string, SummaryHarnessTokens> = {};
  for (const [harness, item] of Object.entries(rawTokens).slice(0, 64)) tokens_by_harness[safeHarnessLabel(harness)] = parseSummaryHarnessTokens(item, `usage tokens ${harness}`);
  const total_tokens = Object.values(tokens_by_harness).reduce((sum, item) => sum + item.total, 0);
  const rawMetered = record(root.metered_view ?? {}, "usage metered view");
  const metered_view: UsageSourceSummary["metered_view"] = {};
  for (const [currency, item] of Object.entries(rawMetered).slice(0, 16)) {
    const row = record(item, `usage metered ${currency}`);
    metered_view[currency] = {
      amount: safeNonNegativeNumber(row.amount, `usage metered ${currency} amount`),
      actual: safeNonNegativeNumber(row.actual, `usage metered ${currency} actual`),
      declared_estimate: safeNonNegativeNumber(row.declared_estimate, `usage metered ${currency} declared`),
      default_estimate: safeNonNegativeNumber(row.default_estimate, `usage metered ${currency} default`),
      label: decisionLabel(row.label, `usage metered ${currency} label`),
    };
  }
  const rawProviders = record(root.by_provider ?? {}, "usage providers");
  const by_provider: Record<string, SummaryAmount> = {};
  for (const [provider, item] of Object.entries(rawProviders).slice(0, 128)) by_provider[provider.slice(0, 128)] = parseSummaryAmount(item, `usage provider ${provider}`);
  const common = {
    freshness,
    last_observed_at: safeTimestamp(freshnessRow.last_observed_at, "usage observed at"),
    coverage: { measured_fields: measured, total_fields: total },
    excluded_harnesses: excluded,
    actual_spend: strictSummaryMoneyMap(root.total_actual_spend, "usage actual spend"),
    spend_by_basis: spendByBasis,
    tokens_by_harness, total_tokens, metered_view, by_provider,
    has_unresolved: root.has_unresolved === true,
  };
  assertSummaryMoneyPartition(common.actual_spend, common.spend_by_basis);
  return windowKind === "month" ? { month: window, ...common } : { date: window, ...common };
}

function parseUsageSourceSummary(value: unknown): UsageSourceSummary {
  const parsed = parseSummaryRoot(value, "month");
  if (!("month" in parsed)) throw new Error("usage summary 月份字段缺失");
  return parsed;
}

function parseDailySummary(value: unknown): DailySummary {
  const parsed = parseSummaryRoot(value, "date");
  if (!("date" in parsed)) throw new Error("daily summary 日期字段缺失");
  return parsed;
}

const freshnessStates = ["fresh", "stale", "partial", "unavailable"] as const;

function parseFreshness(value: unknown, label: string): UsageSourceSummary["freshness"] {
  const row = value == null ? {} : record(value, label);
  return boundedEnum(row.state ?? "unknown", label, freshnessStates, "unknown") as UsageSourceSummary["freshness"];
}

function parseStatisticsTimezone(value: unknown): StatisticsSettingsReport["timezone"] {
  const root = record(value, "statistics timezone");
  if (root.status === "unavailable") return { status: "unavailable", timezone: null, system_timezone: null };
  if (root.status !== "ok") throw new Error("statistics timezone status 不兼容");
  const timezone = stringField(root.timezone, "statistics timezone");
  const systemTimezone = root.system_timezone == null ? null : stringField(root.system_timezone, "system timezone");
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); } catch (_) { throw new Error("统计时区不可用"); }
  if (systemTimezone !== null) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: systemTimezone }).format(); } catch (_) { throw new Error("系统时区不可用"); }
  }
  return { status: "ok", timezone, system_timezone: systemTimezone, system_timezone_fallback: root.system_timezone_fallback === true, follows_system: root.follows_system === true };
}

function parseRetentionConfig(value: unknown): StatisticsSettingsReport["retention"] {
  const root = record(value, "retention config");
  if (root.status === "unavailable") return { status: "unavailable", months: null, minimum_months: null, maximum_months: null };
  if (root.status !== "ok") throw new Error("retention config status 不兼容");
  const months = boundedCount(root.months, "retention months", 120);
  const minimum = boundedCount(root.minimum_months ?? 1, "retention minimum", 120);
  const maximum = boundedCount(root.maximum_months ?? 60, "retention maximum", 120);
  if (minimum < 1 || maximum < minimum || months < minimum || months > maximum) throw new Error("retention config 范围不安全");
  return { status: "ok", months, minimum_months: minimum, maximum_months: maximum };
}

const pricingStates = ["ok", "updated", "failed", "rejected", "never_checked", "skipped"] as const;

function parsePricingCatalogStatus(value: unknown): StatisticsSettingsReport["pricing"] {
  const root = record(value, "pricing catalog status");
  const state = boundedEnum(root.state ?? "unknown", "pricing catalog state", pricingStates, "unknown") as StatisticsSettingsReport["pricing"]["state"];
  const version = root.source_version == null ? null : decisionLabel(root.source_version, "pricing catalog version");
  const modelCount = root.model_count == null ? null : boundedCount(root.model_count, "pricing catalog model count", 100_000);
  const lastSuccess = root.last_success_at_ms == null ? null : nullableSourceTimestampMs(root.last_success_at_ms, "pricing catalog last success");
  return { status: "ok", state, version, model_count: modelCount, last_success_at_ms: lastSuccess, available: state === "ok" || state === "updated" };
}

function safeVersion(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  const text = stringField(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+:-]*(?: [A-Za-z0-9._+:-]+){0,3}$/.test(text)) throw new Error(`${label} DTO 版本不安全`);
  return text;
}

function parseAboutDiagnostics(value: unknown): AboutDiagnosticsReport {
  const root = record(value, "about diagnostics");
  if (root.status !== "ok") return { status: "unavailable", appVersion: null, cliVersion: null, engineVersion: null, architecture: "unknown", authoritySchema: null, statisticsTimezone: null, pricing: null, sync: { state: "unknown" } };
  const architecture = boundedEnum(root.architecture ?? "unknown", "diagnostic architecture", ["x86_64", "aarch64", "x86", "unknown"], "unknown") as AboutDiagnosticsReport["architecture"];
  const pricing = root.pricing == null ? null : (() => { const row = record(root.pricing, "diagnostic pricing"); return { version: safeVersion(row.version, "diagnostic pricing version"), capturedAtMs: row.captured_at_ms == null ? null : nullableSourceTimestampMs(row.captured_at_ms, "diagnostic pricing timestamp") }; })();
  const sync = root.sync == null ? { state: "unknown" as const } : (() => { const row = record(root.sync, "diagnostic sync"); return { state: row.ok === true ? "ok" as const : row.ok === false ? "needs_attention" as const : "unknown" as const }; })();
  return { status: "ok", appVersion: safeVersion(root.app_version, "diagnostic app version"), cliVersion: safeVersion(root.cli_version, "diagnostic cli version"), engineVersion: safeVersion(root.engine_version, "diagnostic engine version"), architecture, authoritySchema: safeVersion(root.authority_schema, "diagnostic authority schema"), statisticsTimezone: root.statistics_timezone == null ? null : validateIanaTimezone(stringField(root.statistics_timezone, "diagnostic timezone")), pricing, sync };
}

function parseDiagnosticExportReceipt(value: unknown): DiagnosticExportReceipt {
  const root = record(value, "diagnostic export receipt");
  const status = boundedEnum(root.status, "diagnostic export status", ["saved", "cancelled"], "cancelled") as DiagnosticExportReceipt["status"];
  if (status === "saved" && root.upload_performed !== false) throw new Error("诊断包上传状态不安全");
  if (status === "cancelled" && root.upload_performed !== undefined && root.upload_performed !== false) throw new Error("诊断包取消状态不安全");
  return { status, uploadPerformed: false };
}

const APP_RELEASE_TAG = /^app-v[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function parseTrustedReleaseUrl(value: unknown, expectedTag: string | null): string | null {
  if (value == null) return null;
  const url = stringField(value, "release url");
  // 离线门禁禁止源码写远端 origin；按 path 段校验发布根或 /releases/tag/<safe app-v>。
  if (/[?#@\\]/.test(url)) throw new Error("发布页链接不安全");
  const parts = url.split("/");
  if (parts[0] !== "https:" || parts[1] !== "" || parts[2] !== "github.com" || parts[3] !== "Oh-Agent-AI" || parts[4] !== "oh-agent" || parts[5] !== "releases") {
    throw new Error("发布页链接不安全");
  }
  if (parts.length === 6) return url;
  if (parts.length === 8 && parts[6] === "tag" && APP_RELEASE_TAG.test(parts[7])) {
    if (expectedTag !== null && parts[7] !== expectedTag) throw new Error("发布页链接与标签不一致");
    return url;
  }
  throw new Error("发布页链接不安全");
}

function parseUpdateCheck(value: unknown): UpdateCheckResult {
  const root = record(value, "update check");
  const status = boundedEnum(root.status, "update check status", ["ok", "no_release"], "unavailable") as UpdateCheckResult["status"];
  const currentVersion = safeVersion(root.current_version, "current version");
  const latestTag = root.latest_tag == null ? null : stringField(root.latest_tag, "latest release tag");
  if (latestTag !== null && !APP_RELEASE_TAG.test(latestTag)) throw new Error("最新发布标签不安全");
  if (root.automatic_install !== false) throw new Error("自动安装状态不安全");
  // 后端按通道（beta 用户看 beta + 正式版，正式版用户只看正式版）与 semver 比较后给出；缺省视为无更新。
  const updateAvailable = status === "ok" && latestTag !== null && root.update_available === true;
  const onLatestStable = status === "ok" && !updateAvailable && root.reason === "on_latest_stable";
  const releaseUrl = parseTrustedReleaseUrl(root.release_url, latestTag);
  return { status, currentVersion, latestTag, updateAvailable, automaticInstall: false, releaseUrl, onLatestStable };
}

function safeSkillText(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  const text = stringField(value, label);
  if (/[\u0000-\u001f\u007f]/u.test(text) || text.length > 256) throw new Error(`${label} DTO 文本不安全`);
  if (/(^|\s)(?:~\/|\/|[A-Za-z]:[\\/]|file:\/\/)/u.test(text)) return "本机路径已省略";
  return text;
}

function parseSkillScan(value: unknown, expectedHarness?: string): SkillScanReport {
  const root = record(value, "skill scan");
  const report = root.report == null ? null : record(root.report, "skill scan report");
  const meta = root.desktop_meta == null ? {} : record(root.desktop_meta, "skill scan metadata");
  if (!report) return { status: "unavailable", schema_version: null, run: null, harness_selection: "all", generated_at_ms: null, from_cache: false, harnesses: [], diagnostics: [], not_assessed: [] };
  const rawHarnesses = record(report.harness_summaries ?? {}, "skill harness summaries");
  const harnesses: SkillHarnessSummary[] = Object.entries(rawHarnesses).slice(0, 16).map(([harnessKey, raw]) => {
    const row = record(raw, "skill harness summary");
    const budget = row.description_budget_detail == null ? {} : record(row.description_budget_detail, "skill budget detail");
    const budgetAvailable = budget.available === true;
    const used = budget.used_chars == null ? null : boundedCount(budget.used_chars, "skill budget used", 10_000_000);
    const limit = budget.budget_chars == null ? null : boundedCount(budget.budget_chars, "skill budget limit", 10_000_000);
    const pct = budget.pct_used == null ? null : Math.min(requiredFiniteNumber(budget.pct_used, "skill budget percent"), 1000);
    const trigger = boundedEnum(row.trigger_data ?? "unknown", "skill trigger data", ["available", "unavailable"], "unknown") as SkillHarnessSummary["trigger_data"];
    return { harness: safeHarnessLabel(harnessKey), skills_on_disk: boundedCount(row.skills_on_disk ?? 0, "skills on disk", 10_000_000), discoverable_skills: boundedCount(row.discoverable_skills ?? 0, "discoverable skills", 10_000_000), runtime_verified_loaded_skills: row.runtime_verified_loaded_skills == null ? null : boundedCount(row.runtime_verified_loaded_skills, "runtime verified skills", 10_000_000), unique_discoverable_skills: boundedCount(row.unique_discoverable_skills ?? row.discoverable_skills ?? 0, "unique discoverable skills", 10_000_000), description_budget: { available: budgetAvailable, used_chars: used, budget_chars: limit, pct_used: pct, source: safeSkillText(budget.source, "skill budget source") }, trigger_data: trigger };
  });
  const diagnostics = requiredArray(root.diagnostics ?? [], "skill diagnostics").slice(0, 512).map((raw) => {
    const row = record(raw, "skill diagnostic");
    const evidence = row.evidence == null ? null : record(row.evidence, "skill evidence");
    const evidenceCount = evidence?.count != null ? boundedCount(evidence.count, "skill evidence count", 10_000_000) : ["hits", "skills", "pairs"].reduce((sum, key) => sum + (Array.isArray(evidence?.[key]) ? Math.min(evidence?.[key].length ?? 0, 10_000) : 0), 0);
    return { code: safeSkillText(row.code, "skill diagnostic code") ?? "unknown", name: safeSkillText(row.name, "skill diagnostic name") ?? "未命名规则", severity: boundedEnum(row.severity ?? "info", "skill severity", ["critical", "warning", "info"], "info") as SkillDiagnostic["severity"], skill: safeSkillText(row.skill, "skill diagnostic skill"), evidence_count: evidenceCount, impact: safeSkillText(row.impact, "skill diagnostic impact"), recommendation: safeSkillText(row.recommendation, "skill diagnostic recommendation"), caveats: Array.isArray(row.caveats) ? row.caveats.slice(0, 16).map((item) => safeSkillText(item, "skill caveat") ?? "").filter(Boolean) : [] };
  });
  const notAssessed = requiredArray(root.not_assessed ?? [], "skill not assessed").slice(0, 128).map((raw) => { const row = record(raw, "skill not assessed row"); return { code: safeSkillText(row.code, "skill not assessed code") ?? "unknown", name: safeSkillText(row.name, "skill not assessed name") ?? "未评估规则", reason: safeSkillText(row.reason, "skill not assessed reason") ?? "原因不可用" }; });
  const harnessSelection = safeSkillText(root.harness_selection, "skill harness selection") ?? "all";
  if (expectedHarness !== undefined && harnessSelection !== expectedHarness) throw new Error("skill scan harness_selection 不匹配");
  return { status: "ok", schema_version: safeVersion(root.schema_version, "skill schema") ?? null, run: safeSkillText(root.run, "skill run"), harness_selection: harnessSelection, generated_at_ms: meta.generated_at_ms == null ? null : nullableSourceTimestampMs(meta.generated_at_ms, "skill generated at"), from_cache: meta.from_cache === true, harnesses, diagnostics, not_assessed: notAssessed };
}

function parseSkillDiffIdentity(value: unknown): SkillDiffIdentity {
  const row = record(value, "skill diff identity");
  return {
    harness: safeSkillText(row.harness, "skill diff harness") ?? "unknown",
    name: safeSkillText(row.name, "skill diff name") ?? "未命名 skill",
    namespace: row.namespace == null ? null : safeSkillText(row.namespace, "skill diff namespace"),
    instance_id: row.instance_id == null ? null : safeSkillText(row.instance_id, "skill diff instance"),
  };
}

function parseSkillDiff(value: unknown): SkillDiffReport {
  const root = record(value, "skill diff");
  if (root.schema_version !== "skills-diff-v1" || (root.status !== "ok" && root.status !== "partial") || root.baseline_available !== true) throw new Error("Skill 对比结果不可用");
  const identityArray = (key: string): SkillDiffIdentity[] => requiredArray(root[key], `skill diff ${key}`).slice(0, 256).map(parseSkillDiffIdentity);
  const usageDelta = requiredArray(root.usage_delta, "skill diff usage delta").slice(0, 256).map((value) => {
    const row = record(value, "skill diff usage delta row");
    return { ...parseSkillDiffIdentity(row), delta: boundedSignedCount(row.delta, "skill diff delta", 1_000_000), now: boundedCount(row.now, "skill diff total", 1_000_000) };
  });
  const newlyJudgeable = requiredArray(root.newly_judgeable, "skill diff newly judgeable").slice(0, 256).map((value) => {
    const row = record(value, "skill diff newly judgeable row");
    const verdict: "zombie" | "alive" | undefined = row.verdict === "zombie" || row.verdict === "alive" ? row.verdict : undefined;
    return { ...parseSkillDiffIdentity(row), usage_count: row.usage_count == null ? undefined : boundedCount(row.usage_count, "skill diff usage count", 1_000_000), installed_days_ago: row.installed_days_ago == null ? undefined : boundedCount(row.installed_days_ago, "skill diff age", 100_000), verdict };
  });
  const overlap = requiredArray(root.new_overlap_candidates, "skill diff overlap").slice(0, 256).map((value) => {
    const pair = requiredArray(value, "skill diff overlap pair");
    if (pair.length !== 2) throw new Error("Skill 对比候选格式不安全");
    return [safeSkillText(pair[0], "skill diff overlap left") ?? "未命名 skill", safeSkillText(pair[1], "skill diff overlap right") ?? "未命名 skill"] as [string, string];
  });
  const findings = requiredArray(root.new_security_findings, "skill diff findings").slice(0, 256).map((value) => { const row = record(value, "skill diff finding"); return { skill: safeSkillText(row.skill, "skill diff finding skill") ?? "未命名 skill", rule: safeSkillText(row.rule, "skill diff finding rule") ?? "unknown", line: boundedCount(row.line, "skill diff finding line", 1_000_000) }; });
  const budget = root.budget_pct_then_now == null ? null : (() => { const values = requiredArray(root.budget_pct_then_now, "skill diff budget percent"); if (values.length !== 2) throw new Error("Skill 对比预算格式不安全"); return values.map((value) => value == null ? null : Math.min(requiredFiniteNumber(value, "skill diff budget percent"), 100_000)) as [number | null, number | null]; })();
  const loaded = root.loaded_then_now == null ? null : (() => { const values = requiredArray(root.loaded_then_now, "skill diff loaded count"); if (values.length !== 2) throw new Error("Skill 对比加载数格式不安全"); return values.map((value) => boundedCount(value, "skill diff loaded count", 1_000_000)) as [number, number]; })();
  const summaryRow = record(root.summary, "skill diff summary");
  return { schema_version: "skills-diff-v1", status: root.status as "ok" | "partial", baseline_available: true, truncated: requiredBoolean(root.truncated, "skill diff truncated"), dropped_rows: boundedCount(root.dropped_rows, "skill diff dropped rows", 1_000_000), summary: { added: boundedCount(summaryRow.added, "skill diff summary added", 1_000_000), removed: boundedCount(summaryRow.removed, "skill diff summary removed", 1_000_000), usage_changed: boundedCount(summaryRow.usage_changed, "skill diff summary usage", 1_000_000), newly_judgeable: boundedCount(summaryRow.newly_judgeable, "skill diff summary newly judgeable", 1_000_000), new_overlap_candidates: boundedCount(summaryRow.new_overlap_candidates, "skill diff summary overlap", 1_000_000), new_security_findings: boundedCount(summaryRow.new_security_findings, "skill diff summary security", 1_000_000) }, added_skills: identityArray("added_skills"), removed_skills: identityArray("removed_skills"), usage_delta: usageDelta, newly_judgeable: newlyJudgeable, new_overlap_candidates: overlap, new_security_findings: findings, budget_delta_chars: root.budget_delta_chars == null ? null : boundedSignedCount(root.budget_delta_chars, "skill diff budget delta", 100_000_000), budget_pct_then_now: budget, loaded_then_now: loaded };
}

function parseMonthlyExportSummary(value: unknown): MonthlyExportSummary {
  const root = record(value, "monthly export summary");
  const month = safeMonth(root.month, "monthly export month");
  const coverageRow = record(root.coverage, "monthly export coverage");
  const measured = boundedCount(coverageRow.measured_fields, "monthly export measured fields", 1_000);
  const total = boundedCount(coverageRow.total_fields, "monthly export total fields", 1_000);
  if (measured > total) throw new Error("monthly export coverage 不守恒");
  const excluded = requiredArray(root.excluded_harnesses, "monthly export excluded harnesses").slice(0, 32).map((harness) => safeHarnessLabel(harness));
  const freshness = parseFreshness(root.freshness, "monthly export freshness");
  const byHarness = record(root.by_harness ?? {}, "monthly export harnesses");
  const tokensByHarness = record(root.tokens_by_harness ?? {}, "monthly export tokens");
  const byProvider = record(root.by_provider ?? {}, "monthly export providers");
  const rows: MonthlyExportRow[] = [];
  Object.entries(byProvider).slice(0, 128).forEach(([key, raw]) => {
    const parts = key.split("/");
    const harness = safeHarnessLabel(parts.shift() ?? "generic");
    const provider = parts.length ? decisionLabel(parts.join("/"), "monthly export provider") : null;
    const amount = record(raw, "monthly export provider row");
    const amounts = record(amount.amounts_by_basis ?? {}, "monthly export provider amounts");
    const basisEntries = Object.entries(amounts).filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0).slice(0, 16);
    const currency = amount.currency == null ? null : decisionCurrency(amount.currency, "monthly export currency");
    if (!basisEntries.length) basisEntries.push(["other", 0]);
    basisEntries.forEach(([basis, rawAmount]) => rows.push({
      harness,
      provider,
      tokens: null,
      basis: boundedEnum(basis, "monthly export basis", ["metered_actual", "harness_billed", "fixed_subscription", "metered_declared", "metered_estimate", "api_equivalent", "other"], "other"),
      currency,
      amount: safeNonNegativeNumber(rawAmount, "monthly export amount"),
      unresolved: amount.has_unresolved === true,
      evidence_basis: amount.evidence_basis == null ? null : decisionLabel(amount.evidence_basis, "monthly export evidence"),
      pricing_method: amount.pricing_method == null ? null : decisionLabel(amount.pricing_method, "monthly export pricing"),
      freshness: parseFreshness(amount.freshness, "monthly export provider freshness"),
    }));
  });
  Object.entries(byHarness).slice(0, 64).forEach(([harnessKey, raw]) => {
    const harness = safeHarnessLabel(harnessKey);
    const amount = record(raw, "monthly export harness row");
    const tokenRow = tokensByHarness[harness] == null ? null : record(tokensByHarness[harness], "monthly export harness tokens");
    rows.push({ harness, provider: null, tokens: tokenRow == null ? null : boundedCount(tokenRow.total ?? 0, "monthly export harness tokens", 1_000_000_000_000_000), basis: null, currency: amount.currency == null ? null : decisionCurrency(amount.currency, "monthly export currency"), amount: null, unresolved: amount.has_unresolved === true, evidence_basis: null, pricing_method: null, freshness: parseFreshness(amount.freshness, "monthly export harness freshness") });
  });
  return { month, rows, coverage: { measured_fields: measured, total_fields: total }, freshness, excluded_harnesses: excluded };
}

function parseUsageHourly(value: unknown): UsageHourly {
  const root = record(value, "usage hourly");
  const date = safeDate(root.date, "usage hourly date");
  const source = record(root.harnesses_available, "usage hourly sources");
  const sourceValue = (key: string): string | null => {
    if (source[key] === null || source[key] === undefined) return null;
    const value = boundedEnum(source[key], `usage hourly ${key} source`, ["sql-facts"], "unknown");
    return value === "sql-facts" ? value : null;
  };
  const rawHours = requiredArray(root.hours, "usage hours");
  if (rawHours.length !== 24) throw new Error("usage hours 必须有 24 个小时");
  const hours = rawHours.map((item) => {
    const row = record(item, "usage hour");
    const hour = requiredCount(row.hour, "usage hour index");
    if (hour > 23) throw new Error("usage hour index 超出范围");
    return { hour, dsh_tokens: safeNullableToken(row.dsh_tokens, "usage hourly dsh"), claude_tokens: safeNullableToken(row.claude_tokens, "usage hourly claude"), codex_tokens: safeNullableToken(row.codex_tokens, "usage hourly codex") };
  }).sort((left, right) => left.hour - right.hour);
  if (hours.length !== 24 || new Set(hours.map((hour) => hour.hour)).size !== 24) throw new Error("usage hours 必须覆盖 0-23 且不可重复");
  return { date, harnesses_available: { dsh: sourceValue("dsh"), claude: sourceValue("claude"), codex: sourceValue("codex") }, hours };
}

function parseSessionCost(value: unknown, label: string): SessionCost | null {
  if (value === null || value === undefined) return null;
  const row = record(value, label);
  return {
    amount_minor: boundedCount(row.amount_minor, `${label} amount`, 1_000_000_000_000_000),
    currency: decisionCurrency(row.currency, `${label} currency`),
    basis: decisionBasis(row.basis, `${label} basis`) as SessionCost["basis"],
  };
}

function parseSessionTokens(value: unknown, label: string): SessionRow["tokens"] {
  const tokenRow = record(value, label);
  const uncached = boundedCount(tokenRow.uncached_input_tokens, `${label} uncached input`, 1_000_000_000_000_000);
  const cacheRead = boundedCount(tokenRow.cache_read_tokens, `${label} cache read`, 1_000_000_000_000_000);
  const cacheWrite = boundedCount(tokenRow.cache_write_tokens, `${label} cache write`, 1_000_000_000_000_000);
  const output = boundedCount(tokenRow.output_tokens, `${label} output`, 1_000_000_000_000_000);
  const total = boundedCount(tokenRow.total, `${label} total`, 1_000_000_000_000_000);
  if (total !== uncached + cacheRead + cacheWrite + output) throw new Error(`${label} token totals 不守恒`);
  return { uncached_input_tokens: uncached, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite, output_tokens: output, total };
}

function parseSessionCostStatus(value: unknown): SessionCostStatus {
  const costStatus = record(value, "session cost status");
  const state = boundedEnum(costStatus.state, "session cost state", ["estimated", "subscription", "unpriced", "unavailable"], "unavailable") as SessionCostStatus["state"];
  const reason = boundedEnum(costStatus.reason, "session cost reason", [
    "no-usage-facts", "subscription-token-usage-is-not-a-per-token-bill", "official-card-fallback-estimate",
    "metered-estimate", "multiple-provider-costs-require-breakdown", "no-pricing-snapshot", "no-price-card",
    "cost-unavailable", "cost-query-failed",
  ], "cost-unavailable");
  return { state, reason, has_unresolved: requiredBoolean(costStatus.has_unresolved, "session cost unresolved") };
}

function parseSessionBase(value: unknown): Omit<SessionRow, "peak_tokens"> {
  const row = record(value, "session row");
  const sessionRef = stringField(row.session_ref, "session ref");
  if (!/^sr_[A-Za-z0-9_-]{8,128}$/.test(sessionRef)) throw new Error("session ref DTO 引用格式不安全");
  const tokens = parseSessionTokens(row.tokens, "session tokens");
  const modelIds = requiredArray(row.model_ids, "session model ids").slice(0, 16).map((model) => decisionLabel(model, "session model"));
  return {
    session_ref: sessionRef,
    harness: safeHarnessLabel(row.harness),
    first_event_at: safeTimestamp(row.first_event_at, "session first event"),
    last_event_at: safeTimestamp(row.last_event_at, "session last event"),
    event_count: boundedCount(row.event_count, "session event count", 1_000_000_000),
    model_ids: modelIds,
    tokens,
    cost_minor: parseSessionCost(row.cost_minor, "session cost"),
    cost_status: parseSessionCostStatus(row.cost_status),
  };
}

function parseSessionRow(value: unknown): SessionRow {
  const row = record(value, "session row");
  return { ...parseSessionBase(row), peak_tokens: boundedCount(row.peak_tokens, "session peak tokens", 1_000_000_000_000_000) };
}

function safeWorkflowLabel(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  const text = stringField(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@+\-]{0,127}$/.test(text) || text.includes("..")) return null;
  return text;
}

function safeFingerprint(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  const text = stringField(value, label);
  return /^fnv1a64:[0-9a-f]{16}$/.test(text) ? text : null;
}

function safeBillingReason(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return boundedEnum(value, "session billing reason", [
    "subscription token usage is not a per-token bill",
    "no pricing snapshot covers this event time",
    "no compatible price card for this provider/model bucket",
    "provider-specific price card unavailable; official-card fallback estimate required",
  ], "cost-unavailable");
}

function parseSessionTimeline(value: unknown): SessionTimelineRow {
  const row = record(value, "session timeline row");
  return {
    event_at: safeTimestamp(row.event_at, "session timeline event"),
    model_id: decisionLabel(row.model_id, "session timeline model"),
    observation_kind: safeWorkflowLabel(row.observation_kind, "session observation") ?? "unknown",
    peak: requiredBoolean(row.peak, "session timeline peak"),
    tokens: parseSessionTokens(row.tokens, "session timeline tokens"),
  };
}

function parseSessionWorkflowEvent(value: unknown): SessionWorkflowEvent {
  const row = record(value, "session workflow event");
  const eventType = boundedEnum(row.event_type, "session workflow event type", ["task_started", "task_finished", "skill_invoked", "skill_finished", "tool_invoked", "tool_finished", "model_switched"], "unknown");
  const outcome = boundedEnum(row.outcome, "session workflow outcome", ["succeeded", "failed"], "unknown") as SessionWorkflowEvent["outcome"];
  const duration = row.duration_ms === null || row.duration_ms === undefined ? null : boundedCount(row.duration_ms, "session workflow duration", 86_400_000);
  return {
    event_at: safeTimestamp(row.event_at, "session workflow event time"),
    event_type: eventType,
    capability_kind: row.capability_kind === null || row.capability_kind === undefined ? null : boundedEnum(row.capability_kind, "session capability kind", ["skill", "tool", "model", "subagent"], "unknown"),
    capability_id: safeWorkflowLabel(row.capability_id, "session capability id"),
    capability_version: safeWorkflowLabel(row.capability_version, "session capability version"),
    outcome,
    duration_ms: duration,
    error_fingerprint: safeFingerprint(row.error_fingerprint, "session error fingerprint"),
    invocation_fingerprint: safeFingerprint(row.invocation_fingerprint, "session invocation fingerprint"),
  };
}

function parseSessionBillingBucket(value: unknown): SessionBillingBucket {
  const row = record(value, "session billing bucket");
  return {
    provider_id: decisionLabel(row.provider_id ?? "<unknown>", "session provider"),
    provider_raw: row.provider_raw === null || row.provider_raw === undefined ? null : decisionLabel(row.provider_raw, "session provider raw"),
    model_id: decisionLabel(row.model_id, "session billing model"),
    billing_template_id: safeWorkflowLabel(row.billing_template_id, "session billing template"),
    billing_mode: safeWorkflowLabel(row.billing_mode, "session billing mode") ?? "unknown",
    // 这两个字段是后端的封闭枚举，而且值里有下划线：之前走 safeWorkflowLabel（不允许
    // 下划线），`metered_estimate` / `fallback_official` 被静默丢成 unavailable / null，
    // 计费归因表里有金额的桶也显示「无可用价格」。
    pricing_basis: boundedEnum(row.pricing_basis ?? "unavailable", "session pricing basis", SESSION_PRICING_BASES, "unavailable"),
    evidence_basis: safeWorkflowLabel(row.evidence_basis, "session evidence basis") ?? "unknown",
    pricing_version: safeWorkflowLabel(row.pricing_version, "session pricing version"),
    pricing_source: row.pricing_source === null || row.pricing_source === undefined
      ? null
      : boundedEnum(row.pricing_source, "session pricing source", SESSION_PRICING_SOURCES, "unknown"),
    cost_minor: parseSessionCost(row.cost_minor, "session bucket cost"),
    peak: requiredBoolean(row.peak, "session billing peak"),
    tokens: parseSessionTokens(row.tokens, "session billing tokens"),
    has_unresolved: requiredBoolean(row.has_unresolved, "session billing unresolved"),
    unresolved_reason: safeBillingReason(row.unresolved_reason),
  };
}

function parseSessionDetail(value: unknown, expectedSessionRef?: string): SessionDetail {
  const root = record(value, "session detail envelope");
  const data = record(root.data, "session detail data");
  // session_detail intentionally has no peak_tokens aggregate; that field only
  // belongs to sessions_search rows. Do not reject a valid detail or invent 0.
  const base = parseSessionBase(data);
  if (expectedSessionRef !== undefined && base.session_ref !== expectedSessionRef) throw new Error("session detail session_ref 不匹配");
  const timeline = requiredArray(data.timeline, "session detail timeline").slice(0, 1000).map(parseSessionTimeline);
  const workflow = requiredArray(data.workflow_timeline, "session workflow timeline").slice(0, 1000).map(parseSessionWorkflowEvent);
  const billing = requiredArray(data.billing_breakdown, "session billing breakdown").slice(0, 500).map(parseSessionBillingBucket);
  const hasMore = requiredBoolean(data.has_more, "session detail has more");
  const nextCursor = data.next_cursor === null || data.next_cursor === undefined ? null : stringField(data.next_cursor, "session detail cursor");
  if (nextCursor !== null && (nextCursor.length < 1 || nextCursor.length > 4096)) throw new Error("session detail cursor DTO 不安全");
  if (hasMore && nextCursor === null) throw new Error("session detail 分页缺少 next_cursor");
  return { ...base, billing_breakdown: billing, timeline, workflow_timeline: workflow, workflow_has_more: requiredBoolean(data.workflow_has_more, "session workflow has more"), has_more: hasMore, next_cursor: nextCursor };
}

function parseSessionsPage(value: unknown): SessionsPage {
  const root = record(value, "sessions envelope");
  const data = record(root.data, "sessions data");
  const rows = requiredArray(data.sessions, "sessions rows");
  if (rows.length > 500) throw new Error("sessions rows 超出页面上限");
  const sessions = rows.map(parseSessionRow);
  const hasMore = requiredBoolean(data.has_more, "sessions has more");
  const nextCursor = data.next_cursor === null || data.next_cursor === undefined ? null : stringField(data.next_cursor, "sessions cursor");
  if (nextCursor !== null && (nextCursor.length < 1 || nextCursor.length > 4096)) throw new Error("sessions cursor DTO 不安全");
  if (hasMore && nextCursor === null) throw new Error("sessions 分页缺少 next_cursor");
  const windowSessionCount = boundedCount(data.window_session_count, "sessions window count", 10_000_000);
  const windowTotalTokens = boundedCount(data.window_total_tokens, "sessions window tokens", 1_000_000_000_000_000);
  if (windowSessionCount < sessions.length) throw new Error("sessions window count 小于当前页");
  const pageTokens = sessions.reduce((sum, session) => sum + session.tokens.total, 0);
  if (pageTokens > windowTotalTokens) throw new Error("sessions 当前页 token 超出窗口总量");
  const window = data.window === null || data.window === undefined ? null : record(data.window, "sessions window");
  return { sessions, next_cursor: nextCursor, has_more: hasMore, window_session_count: windowSessionCount, window_total_tokens: windowTotalTokens, window_label: window ? nullableString(window.label, "sessions window label") : null };
}

const routeFamilies = ["anthropic", "openai", "deepseek", "glm", "minimax", "gemini", "qwen", "synthetic", "unknown"] as const;
const routeFlags = ["native", "non_native", "api_error", "no_baseline"] as const;

function routeFamily(value: unknown, label: string): RouteQualityFamily["family"] {
  return boundedEnum(value, label, routeFamilies, "unknown") as RouteQualityFamily["family"];
}

function routeModel(value: unknown, label: string): string {
  // Route-quality reports preserve the model string from the provider response.
  // Some real variants use bracketed capability suffixes, e.g. `[1M]`, which
  // are valid model identifiers but intentionally are not accepted by the
  // stricter provider/billing label grammar used by decisionLabel(). Keep the
  // same path/URL/control-character exclusions while allowing only brackets
  // as the additional model-specific syntax.
  const text = stringField(value, label);
  if (text === "<synthetic>" || text === "<unknown>") return text;
  const valid = /^[A-Za-z0-9][A-Za-z0-9._:@+<>\-\[\]]{0,127}(\/[A-Za-z0-9][A-Za-z0-9._:@+<>\-\[\]]{0,127})?$/.test(text)
    && !text.includes("://")
    && !text.includes("..")
    && !text.startsWith("file:")
    && !/^[A-Za-z]:/.test(text);
  if (!valid) throw new Error(`${label} DTO 模型标识不安全`);
  return text;
}

function parseRouteQualityModel(value: unknown): RouteQualityModel {
  const row = record(value, "route quality model");
  return {
    model: routeModel(row.model, "route quality model id"),
    requests: boundedCount(row.requests, "route quality model requests", 1_000_000_000),
    tokens_total: boundedCount(row.tokens_total, "route quality model tokens", 1_000_000_000_000_000),
    last_event_ms: boundedCount(row.last_event_ms, "route quality model last event", 9_000_000_000_000),
  };
}

function parseRouteQualityFamily(value: unknown): RouteQualityFamily {
  const row = record(value, "route quality family");
  const models = requiredArray(row.models, "route quality models");
  if (models.length > 128) throw new Error("route quality models 超出上限");
  const share = requiredFiniteNumber(row.request_share, "route quality request share");
  if (share > 100) throw new Error("route quality request share 超出范围");
  return {
    family: routeFamily(row.family, "route quality family name"),
    flag: boundedEnum(row.flag, "route quality family flag", routeFlags, "no_baseline") as RouteQualityFamily["flag"],
    requests: boundedCount(row.requests, "route quality family requests", 1_000_000_000),
    sessions: boundedCount(row.sessions, "route quality family sessions", 1_000_000_000),
    tokens_total: boundedCount(row.tokens_total, "route quality family tokens", 1_000_000_000_000_000),
    last_event_ms: boundedCount(row.last_event_ms, "route quality family last event", 9_000_000_000_000),
    request_share: share,
    models: models.map(parseRouteQualityModel),
  };
}

function parseRouteQuality(value: unknown): RouteQualityReport {
  const root = record(value, "route quality report");
  const harnesses = requiredArray(root.harnesses, "route quality harnesses");
  if (harnesses.length > 128) throw new Error("route quality harnesses 超出上限");
  const sinceMs = boundedCount(root.since_ms, "route quality since", 9_000_000_000_000);
  const nowMs = boundedCount(root.now_ms, "route quality now", 9_000_000_000_000);
  if (sinceMs > nowMs) throw new Error("route quality 时间范围不安全");
  const vocabulary = requiredArray(root.families_vocabulary, "route quality vocabulary").slice(0, 32).map((item) => {
    const family = stringField(item, "route quality vocabulary item");
    if (!(routeFamilies as readonly string[]).includes(family)) throw new Error("route quality vocabulary 含未知模型族");
    return family;
  });
  return {
    since_ms: sinceMs,
    now_ms: nowMs,
    families_vocabulary: vocabulary,
    harnesses: harnesses.map((item) => {
      const row = record(item, "route quality harness");
      const totals = record(row.totals, "route quality totals");
      const native = requiredArray(row.native_families, "route quality native families").slice(0, 16).map((family) => routeFamily(family, "route quality native family"));
      const families = requiredArray(row.families, "route quality harness families");
      if (families.length > 32) throw new Error("route quality families 超出上限");
      return {
        harness: safeHarnessLabel(row.harness),
        has_baseline: requiredBoolean(row.has_baseline, "route quality baseline"),
        native_families: native,
        totals: { requests: boundedCount(totals.requests, "route quality total requests", 1_000_000_000), sessions: boundedCount(totals.sessions, "route quality total sessions", 1_000_000_000) },
        families: families.map(parseRouteQualityFamily),
      };
    }),
  };
}

function safeTrustIdentifier(value: unknown, label: string, fallback = "unknown"): string {
  if (typeof value !== "string" || value.length > 96 || !/^[a-z][a-z0-9_-]{0,95}$/.test(value)) return fallback;
  return value;
}

function safeTimestamp(value: unknown, _label: string): string | null {
  if (value === null || value === undefined || typeof value !== "string") return null;
  const candidate = value;
  // Rust emits RFC3339 timestamps; reject permissive Date.parse inputs so a
  // malformed freshness payload cannot be rendered as "fresh".
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(candidate) || Number.isNaN(Date.parse(candidate))) {
    return null;
  }
  return candidate;
}

function safeHash(value: unknown, label: string): string {
  const reference = stringField(value, label);
  if (!/^fnv1a64:[0-9a-f]{16}$/.test(reference)) throw new Error(`${label} DTO 引用格式不安全`);
  return reference;
}

function parseTrustDiscovery(value: unknown): TrustDiscovery {
  const root = record(value, "trust discovery");
  const candidates = requiredArray(root.candidates, "trust candidates").map((item) => {
    const row = record(item, "trust candidate");
    if (typeof row.detected !== "boolean" || typeof row.artifact_profile_available !== "boolean") throw new Error("trust candidate 状态不安全");
    return {
      id: safeHarnessLabel(row.id),
      detected: row.detected,
      artifact_profile_available: row.artifact_profile_available,
      coverage_state: boundedEnum(row.coverage_state, "trust coverage state", ["not_detected", "profiled", "detected_unprofiled"], "unknown"),
    };
  });
  const profileErrors = requiredArray(root.profile_errors, "profile errors").slice(0, 16).map((item) => safeTrustIdentifier(item, "profile error", "profile_error_unavailable"));
  return { candidates, profile_errors: profileErrors };
}

function trustCommandData(value: unknown, label: string): Record<string, unknown> {
  const envelope = record(value, `${label} envelope`);
  return envelope.data === undefined ? envelope : record(envelope.data, `${label} data`);
}

function parseTrustProfileSummary(value: unknown, expectedState: TrustProfileSummary["state"] | null): TrustProfileSummary {
  const row = record(value, "Trust profile summary");
  const slug = stringField(row.slug, "Trust profile slug");
  const displayName = stringField(row.display_name, "Trust profile display name");
  const manifestHash = stringField(row.manifest_hash, "Trust profile hash");
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(slug) || displayName.length > 48 || !/^[0-9a-f]{16}$/.test(manifestHash)) throw new Error("Trust profile summary 标识不安全");
  const state = row.state;
  if (state !== "pending" && state !== "invalid" && state !== "approved") throw new Error("Trust profile state 不安全");
  if (expectedState !== null && state !== expectedState) throw new Error("Trust profile state 不匹配");
  const boolField = (item: unknown, label: string): boolean => {
    if (typeof item !== "boolean") throw new Error(`${label} DTO 状态不安全`);
    return item;
  };
  let sourceScopePreview: TrustSourceScopePreview | null = null;
  if (row.source_scope_preview !== null && row.source_scope_preview !== undefined) {
    const scope = record(row.source_scope_preview, "Trust source scope preview");
    const classes = requiredArray(scope.root_classes, "Trust source root classes");
    if (classes.length > 16) throw new Error("Trust source root classes 超出上限");
    const allowedClasses = new Set(["filesystem_root", "parent_traversal", "home_directory", "home_relative", "absolute_home_path", "absolute_system_path", "relative_path"]);
    const rootClasses = classes.map((item) => {
      if (typeof item !== "string" || !allowedClasses.has(item)) throw new Error("Trust source root class 不安全");
      return item as TrustSourceScopePreview["root_classes"][number];
    });
    sourceScopePreview = {
      roots_count: boundedCount(scope.roots_count, "Trust source roots", 16),
      root_classes: rootClasses,
      covers_workspace_or_project: boolField(scope.covers_workspace_or_project, "Trust source workspace coverage"),
      may_include_git_metadata: boolField(scope.may_include_git_metadata, "Trust source Git coverage"),
      covers_full_filesystem: boolField(scope.covers_full_filesystem, "Trust source filesystem coverage"),
      may_leave_home_directory: boolField(scope.may_leave_home_directory, "Trust source home boundary"),
    };
  }
  let trustScopePreview: TrustProfileScopePreview | null = null;
  if (row.trust_scope_preview !== null && row.trust_scope_preview !== undefined) {
    const scope = record(row.trust_scope_preview, "Trust profile scope preview");
    const rootsCount = boundedCount(scope.roots_count, "Trust profile preview roots", 8);
    const classes = requiredArray(scope.root_classes, "Trust profile root classes");
    if (classes.length > 3) throw new Error("Trust profile root classes 超出上限");
    const allowedClasses = new Set(["git_metadata", "workspace_or_project", "home_relative_app_data"]);
    const rootClasses = classes.map((item) => {
      if (typeof item !== "string" || !allowedClasses.has(item)) throw new Error("Trust profile root class 不安全");
      return item as TrustProfileScopePreview["root_classes"][number];
    });
    if (scope.home_relative_only !== true || state === "invalid") throw new Error("Trust profile scope must belong to a valid home-relative proposal");
    trustScopePreview = {
      roots_count: rootsCount,
      root_classes: rootClasses,
      covers_workspace_or_project: boolField(scope.covers_workspace_or_project, "Trust profile workspace coverage"),
      may_include_git_metadata: boolField(scope.may_include_git_metadata, "Trust profile Git coverage"),
      home_relative_only: true,
    };
  }
  if (state !== "invalid" && (!sourceScopePreview || !trustScopePreview)) throw new Error("valid Trust profile is missing a scope preview");
  if (state === "invalid" && (sourceScopePreview || trustScopePreview)) throw new Error("invalid Trust profile cannot carry an approval scope preview");
  const adapterValue = row.trust_adapter === null ? null : boundedEnum(row.trust_adapter, "Trust profile adapter", ["generic_artifact_v1", "zcode_checkpoint_v1", "minimax_workspace_index_v1"], "unknown");
  if (adapterValue === "unknown") throw new Error("Trust profile adapter 不安全");
  const adapter = adapterValue as TrustProfileSummary["trust_adapter"];
  const priorityValue = row.watch_priority === null ? null : boundedEnum(row.watch_priority, "Trust profile watch priority", ["normal", "enhanced"], "unknown");
  if (priorityValue === "unknown") throw new Error("Trust profile watch priority 不安全");
  const priority = priorityValue as TrustProfileSummary["watch_priority"];
  return {
    slug,
    display_name: displayName,
    state,
    manifest_hash: manifestHash,
    discovery_include_count: boundedCount(row.discovery_include_count, "Trust profile include patterns", 16),
    trust_roots_count: boundedCount(row.trust_roots_count, "Trust profile roots", 8),
    artifact_terms_count: boundedCount(row.artifact_terms_count, "Trust profile artifact terms", 8),
    extensions_count: boundedCount(row.extensions_count, "Trust profile extensions", 8),
    trust_adapter: adapter,
    watch_priority: priority,
    source_scope_preview: sourceScopePreview,
    trust_scope_preview: trustScopePreview,
  };
}

function parseTrustProfileStatus(value: unknown): TrustProfileStatus {
  const root = trustCommandData(value, "Trust profile status");
  const pending = requiredArray(root.pending, "Trust pending profiles");
  const approved = requiredArray(root.approved, "Trust approved profiles");
  if (pending.length > 64 || approved.length > 128) throw new Error("Trust profile 数量超出上限");
  const pendingProfiles = pending.map((item) => parseTrustProfileSummary(item, null));
  if (pendingProfiles.some((item) => item.state !== "pending" && item.state !== "invalid")) throw new Error("Trust pending profile state 不匹配");
  return {
    pending: pendingProfiles,
    approved: approved.map((item) => parseTrustProfileSummary(item, "approved")),
  };
}

function parseTrustSuppressions(value: unknown): TrustSuppression[] {
  const root = record(value, "Trust suppressions");
  if (root.status !== "ok") throw new Error("Trust suppression status 不可用");
  const rows = requiredArray(root.suppressions, "Trust suppressions");
  if (rows.length > 256) throw new Error("Trust suppression 数量超出上限");
  return rows.map((item) => {
    const row = record(item, "Trust suppression");
    const id = stringField(row.suppression_id, "Trust suppression id");
    const issueType = stringField(row.issue_type, "Trust suppression issue");
    if (!/^trust-suppression-SV70[1-9]-\d{1,20}$|^trust-suppression-SV710-\d{1,20}$/.test(id) || !/^SV70[1-9]$|^SV710$/.test(issueType)) throw new Error("Trust suppression 标识不安全");
    const created = boundedCount(row.created_at_ms, "Trust suppression created", 4_102_444_800_000);
    const revoked = row.revoked_at_ms === null ? null : boundedCount(row.revoked_at_ms, "Trust suppression revoked", 4_102_444_800_000);
    return { suppression_id: id, issue_type: issueType, created_at_ms: created, revoked_at_ms: revoked };
  });
}

function parseTrustProfileReceipt(value: unknown, expectedStatus: string): { status: string; slug: string } {
  const root = trustCommandData(value, "Trust profile receipt");
  const status = stringField(root.status, "Trust profile receipt status");
  const slug = stringField(root.slug, "Trust profile receipt slug");
  if (status !== expectedStatus || !/^[a-z][a-z0-9-]{0,31}$/.test(slug)) throw new Error("Trust profile receipt 不安全");
  return { status, slug };
}

function parseTrustEvidence(item: unknown): TrustEvidence {
    const row = record(item, "trust evidence");
    const scopes = Array.isArray(row.scope_classes) ? row.scope_classes.slice(0, 16).map((scope) => safeTrustIdentifier(scope, "scope class", "unknown_scope")) : [];
    if (typeof row.observed_at_ms !== "number" || !Number.isSafeInteger(row.observed_at_ms) || row.observed_at_ms < 0) throw new Error("trust evidence timestamp 不安全");
    return {
      kind: boundedEnum(row.kind, "evidence kind", ["file_scope", "package", "credential", "connection", "outbound_bytes", "remote_ack", "consent_state", "retry"], "unknown"),
      stage: boundedEnum(row.stage, "evidence stage", ["read_observed", "package_observed", "credential_observed", "egress_attempted", "egress_transmitted", "remote_accepted"], "unknown"),
      evidence_level: boundedEnum(row.evidence_level, "evidence level", ["E0", "E1", "E2", "E3", "E4", "E5"], "unknown"),
      evidence_origin: boundedEnum(row.evidence_origin, "evidence origin", ["local_artifact", "client_state_claim", "runtime_process_metadata", "network_metadata", "verified_receipt", "unknown_legacy"], "unknown"),
      observed_at_ms: row.observed_at_ms, workspace_ref: safeReference(row.workspace_ref, "workspace ref"),
      native_event_ref: safeReference(row.native_event_ref, "native event ref"), scope_classes: scopes,
      file_count: nullableCount(row.file_count, "file count"), byte_count: nullableCount(row.byte_count, "byte count"),
      destination_class: row.destination_class == null ? null : boundedEnum(row.destination_class, "destination class", ["vendor_api", "object_storage", "telemetry", "eval", "model_api", "unknown"], "unknown"), collector_id: safeTrustIdentifier(row.collector_id, "collector id"),
    };
}

function parseTrustAudit(value: unknown): TrustAuditReport {
  const root = record(value, "trust audit");
  const evidence = requiredArray(root.evidence, "trust evidence").map(parseTrustEvidence);
  const count = (name: string) => requiredCount(root[name], name);
  const map = (name: string) => {
    const source = record(root[name], name);
    return Object.fromEntries(Object.entries(source).map(([key, item]) => [stringField(key, name), requiredCount(item, name)]));
  };
  return {
    harness: stringField(root.harness, "trust harness"), discovered: count("discovered"), inserted: count("inserted"), duplicate: count("duplicate"),
    findings_upserted: count("findings_upserted"), evidence_links_added: count("evidence_links_added"),
    stage_counts: map("stage_counts"), observation_kind_counts: map("observation_kind_counts"), evidence,
  };
}

function nullableTimestampMs(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return requiredCount(value, label);
}

function parseTrustMonitorConfig(value: unknown): TrustMonitorConfig {
  const root = record(value, "trust monitor config");
  const status = root.status === "ok" ? "ok" : "unavailable";
  const reason = root.reason === "authority_unavailable" || root.reason === "monitor_state_unavailable" ? root.reason : null;
  const capability = boundedEnum(root.capability, "trust monitor capability", ["not_started", "available", "partial", "unavailable"], "unavailable") as TrustMonitorCapability;
  const rawInterval = root.interval_seconds;
  const interval_seconds = typeof rawInterval === "number" && Number.isSafeInteger(rawInterval) && rawInterval >= 5 && rawInterval <= 3600 ? rawInterval : 30;
  const rawError = root.last_error_code;
  const allowedErrors = ["sensor_unavailable", "snapshot_failed", "sensor_partial", "authority_unavailable", "monitor_state_unavailable"] as const;
  const last_error_code = rawError === null || rawError === undefined ? null : boundedEnum(rawError, "trust monitor error", allowedErrors, "sensor_unavailable") as TrustMonitorConfig["last_error_code"];
  const rawPermission = root.notification_permission;
  const notification_permission = rawPermission === null || rawPermission === undefined
    ? null
    : boundedEnum(rawPermission, "notification permission", ["granted", "denied", "unavailable"], "unavailable") as TrustMonitorConfig["notification_permission"];
  const enabled_source = boundedEnum(
    root.enabled_source ?? "legacy_default",
    "trust monitor enabled source",
    ["legacy_default", "default", "user", "dismissed"],
    "legacy_default",
  ) as TrustMonitorConfig["enabled_source"];
  return {
    status, reason,
    enabled: root.enabled === true,
    interval_seconds,
    notifications_enabled: root.notifications_enabled === true,
    capability,
    last_success_at_ms: nullableTimestampMs(root.last_success_at_ms, "last monitor success"),
    last_error_code,
    updated_at_ms: nullableTimestampMs(root.updated_at_ms, "monitor updated at"),
    notification_permission,
    enabled_source,
  };
}

function parseTrustRuntimeSnapshot(value: unknown): TrustRuntimeSnapshot {
  const root = record(value, "trust runtime snapshot");
  return {
    capability: boundedEnum(root.capability, "runtime capability", ["macos_lsof_partial", "runtime_sensor_unavailable_on_this_platform", "lsof_unavailable", "lsof_no_visible_output", "lsof_invalid_output"], "unavailable") as TrustSnapshotCapability,
    candidate_processes: boundedCount(root.candidate_processes, "candidate processes"),
    observations: boundedCount(root.observations, "runtime observations"),
    inserted: boundedCount(root.inserted, "runtime inserted"),
    duplicate: boundedCount(root.duplicate, "runtime duplicate"),
    findings_upserted: boundedCount(root.findings_upserted, "runtime findings"),
    notification_candidates: boundedCount(root.notification_candidates, "runtime notifications"),
    evidence_links_added: boundedCount(root.evidence_links_added, "runtime evidence links"),
  };
}

function parseFindingGroup(value: unknown): FindingGroup {
  const row = record(value, "finding group");
  const status = record(row.status_rollup, "finding status rollup");
  const rawSamples = requiredArray(row.sample_evidence, "finding sample evidence");
  if (rawSamples.length > 3) throw new Error("finding sample evidence 超出上限");
  const firstSeen = requiredCount(row.first_seen_at_ms, "finding first seen");
  const lastSeen = requiredCount(row.last_seen_at_ms, "finding last seen");
  if (firstSeen > lastSeen) throw new Error("finding 时间范围不安全");
  const sampleEvidence = rawSamples.map((item) => {
    const sample = record(item, "finding sample");
    if (typeof sample.available !== "boolean") throw new Error("finding sample DTO 状态不安全");
    const reference = sample.reference == null ? null : safeHash(sample.reference, "finding sample reference");
    const optionalTimestamp = (candidate: unknown, label: string): number | null => {
      if (candidate == null) return null;
      const timestamp = requiredCount(candidate, label);
      if (timestamp > 4_102_444_800_000 || timestamp < firstSeen || timestamp > lastSeen) throw new Error(`${label} DTO 时间范围不安全`);
      return timestamp;
    };
    const optionalEnum = <T extends string>(candidate: unknown, allowed: readonly T[], label: string): T | null => {
      if (candidate == null) return null;
      if (typeof candidate !== "string" || !allowed.includes(candidate as T)) throw new Error(`${label} DTO 值不安全`);
      return candidate as T;
    };
    const scopes = Array.isArray(sample.scope_classes) ? sample.scope_classes.slice(0, 16).map((scope) => safeTrustIdentifier(scope, "finding evidence scope", "unknown_scope")) : [];
    const observedFirst = optionalTimestamp(sample.observed_first_at_ms, "finding evidence first timestamp");
    const observedLast = optionalTimestamp(sample.observed_last_at_ms, "finding evidence last timestamp");
    if (observedFirst !== null && observedLast !== null && observedFirst > observedLast) throw new Error("finding evidence 时间范围不安全");
    return {
      has_evidence: sample.available,
      reference,
      observed_first_at_ms: observedFirst,
      observed_last_at_ms: observedLast,
      evidence_level: optionalEnum(sample.evidence_level, ["E0", "E1", "E2", "E3", "E4", "E5"] as const, "finding evidence level"),
      stage: optionalEnum(sample.stage, ["read_observed", "package_observed", "credential_observed", "egress_attempted", "egress_transmitted", "remote_accepted"] as const, "finding evidence stage"),
      evidence_origin: optionalEnum(sample.evidence_origin, ["local_artifact", "client_state_claim", "runtime_process_metadata", "network_metadata", "verified_receipt", "unknown_legacy"] as const, "finding evidence origin"),
      scope_classes: scopes,
      observation_count: sample.observation_count == null ? null : boundedCount(sample.observation_count, "finding observation count"),
      file_count: sample.file_count == null ? null : boundedCount(sample.file_count, "finding file count"),
      byte_count: sample.byte_count == null ? null : boundedCount(sample.byte_count, "finding byte count", Number.MAX_SAFE_INTEGER),
      destination_class: optionalEnum(sample.destination_class, ["vendor_api", "object_storage", "telemetry", "eval", "model_api", "unknown"] as const, "finding destination class"),
      confidence: optionalEnum(sample.confidence, ["high", "medium", "low"] as const, "finding confidence"),
    };
  });
  const count = (name: string) => requiredCount(status[name], name);
  return {
    group_id: safeHash(row.group_id, "finding group id"),
    action_kind: boundedEnum(row.action_kind, "finding action kind", ["behavior", "billing", "budget", "source", "usage", "probe", "other"], "other"),
    rule: stringField(row.rule, "finding rule"), harness: safeHarnessLabel(row.harness),
    evidence_class: boundedEnum(row.evidence_class, "finding evidence class", ["egress", "billing", "data_source", "trust", "usage", "behavior", "generic"], "generic"),
    count: requiredCount(row.count, "finding count"), first_seen_at_ms: firstSeen,
    last_seen_at_ms: lastSeen, severity: stringField(row.severity, "finding severity"),
    status_rollup: { open: count("open"), later: count("later"), acknowledged: count("acknowledged"), resolved: count("resolved"), not_applicable: count("not_applicable") },
    sessions_count: requiredCount(row.sessions_count, "finding sessions"), sample_evidence: sampleEvidence,
    read_only: requiredBoolean(row.read_only, "finding read_only"), manual_follow_up: requiredBoolean(row.manual_follow_up, "finding manual_follow_up"),
  };
}

function parseFindings(value: unknown): FindingsReport {
  const root = record(value, "findings report");
  if (root.schema_version !== "agent-vitals-findings/v1" || root.status !== "ok") throw new Error("findings DTO schema mismatch");
  const totals = record(root.totals, "findings totals");
  const rawRules = requiredArray(root.rules, "finding rules");
  const rawIssues = requiredArray(root.issues, "finding groups");
  if (rawRules.length > 128 || rawIssues.length > 100) throw new Error("findings DTO 数量超限");
  const rules = rawRules.map((item) => {
    const row = record(item, "finding rule");
    return { rule: stringField(row.rule, "rule"), severity: stringField(row.severity, "rule severity"), category: typeof row.category === "string" ? row.category : "—", hits: requiredCount(row.hits, "rule hits"), sessions: requiredCount(row.sessions, "rule sessions") };
  });
  const nextCursor = root.next_cursor == null ? null : stringField(root.next_cursor, "findings cursor");
  return {
    totals: { issues: requiredCount(totals.issues, "issues total"), findings: requiredCount(totals.findings, "findings total"), critical: requiredCount(totals.critical, "critical total"), warning: requiredCount(totals.warning, "warning total"), info: requiredCount(totals.info, "info total"), sessions: requiredCount(totals.sessions, "findings sessions"), sessions_total: requiredCount(totals.sessions_total, "total sessions") },
    rules, issues: rawIssues.map(parseFindingGroup), next_cursor: nextCursor, refreshed: requiredBoolean(root.refreshed, "findings refreshed"),
  };
}

function parseFindingsFreshness(value: unknown): FindingsFreshness {
  const root = record(value, "findings freshness");
  if (root.status === "unavailable") return { status: "unavailable", state: "unknown", last_successful_sync_at: null, stale_harnesses: [], syncing: false };
  if (root.status !== "ok") throw new Error("findings freshness 状态不兼容");
  const freshness = record(root.freshness, "findings freshness data");
  const stale = requiredArray(freshness.stale_harnesses, "stale harnesses").map((harness) => safeHarnessLabel(harness));
  const lastSuccessfulSyncAt = safeTimestamp(freshness.last_successful_sync_at, "last sync");
  const requestedState = freshness.state === "fresh" || freshness.state === "stale" || freshness.state === "not_yet_synced" ? freshness.state : "unknown";
  const state = requestedState === "fresh" && lastSuccessfulSyncAt === null ? "unknown" : requestedState;
  return { status: "ok", state, last_successful_sync_at: lastSuccessfulSyncAt, stale_harnesses: stale, syncing: freshness.syncing === true };
}

function boundedRatio(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} DTO 比例不安全`);
  return value;
}

function parseDecisionAmount(value: unknown): DecisionAmount {
  const row = record(value, "decision amount");
  return { amount_minor: requiredCount(row.amount_minor, "decision amount"), currency: decisionCurrency(row.currency, "decision currency"), basis: decisionBasis(row.basis, "decision basis") };
}

function parseDecisionSession(value: unknown): DecisionTopSession {
  const row = record(value, "decision top session");
  const first = requiredCount(row.span_first_ms, "decision session first");
  const last = requiredCount(row.span_last_ms, "decision session last");
  if (first > last) throw new Error("decision session 时间范围不安全");
  const reference = stringField(row.session_ref, "decision session ref");
  if (!/^sr_[A-Za-z0-9_-]{8,128}$/.test(reference)) throw new Error("decision session ref 不安全");
  return { session_ref: reference, span_first_ms: first, span_last_ms: last, tokens_total: requiredCount(row.tokens_total, "decision session tokens"), failures: requiredCount(row.failures, "decision session failures") };
}

function parseDecisionRow(value: unknown): DecisionMatrixRow {
  const row = record(value, "decision matrix row");
  const tokens = record(row.tokens, "decision token buckets");
  const harnessBehavior = record(row.harness_behavior, "decision harness behavior");
  const behavior = Object.fromEntries(Object.entries(harnessBehavior).filter(([key]) => ["SV607", "SV608", "SV610"].includes(key)).map(([key, item]) => [key, requiredCount(item, `decision ${key}`)]));
  const rawPressure = row.limit_pressure;
  let limitPressure: DecisionMatrixRow["limit_pressure"] = null;
  if (rawPressure !== null && rawPressure !== undefined) {
    const pressure = record(rawPressure, "decision pressure");
    limitPressure = { hits: requiredCount(pressure.hits, "decision pressure hits"), per_session: pressure.per_session === null ? null : requiredFiniteNumber(pressure.per_session, "decision pressure per session") };
  }
  return {
    harness: safeHarnessLabel(row.harness), model_id: decisionLabel(row.model_id, "decision model"), provider_id: decisionLabel(row.provider_id, "decision provider"),
    sessions: requiredCount(row.sessions, "decision sessions"),
    tokens: { uncached_input: requiredCount(tokens.uncached_input, "uncached input"), cache_read: requiredCount(tokens.cache_read, "cache read"), cache_write: requiredCount(tokens.cache_write, "cache write"), output: requiredCount(tokens.output, "output tokens"), total: requiredCount(tokens.total, "total tokens") },
    cache_hit_ratio: boundedRatio(row.cache_hit_ratio, "cache hit"), has_subscription: requiredBoolean(row.has_subscription, "subscription"), waste_rate: boundedRatio(row.waste_rate, "waste rate"),
    amounts: requiredArray(row.amounts, "decision amounts").slice(0, 8).map(parseDecisionAmount), top_sessions: requiredArray(row.top_sessions, "decision top sessions").slice(0, 3).map(parseDecisionSession),
    harness_behavior: behavior, limit_pressure: limitPressure, cost_provider_unresolved: requiredBoolean(row.cost_provider_unresolved, "provider resolution"),
  };
}

function parseDecisionSummary(value: unknown): DecisionSummary {
  const row = record(value, "decision summary");
  const kind = row.kind;
  if (kind !== "cost_outlier" && kind !== "marathon" && kind !== "currency_split") throw new Error("decision summary 类型不安全");
  const summary: DecisionSummary = { kind };
  if (row.currency !== undefined) summary.currency = decisionCurrency(row.currency, "decision currency");
  if (row.outlier !== undefined) summary.outlier = parseDecisionSummaryCombo(row.outlier);
  if (row.control !== undefined) summary.control = parseDecisionSummaryCombo(row.control);
  for (const key of ["ratio_vs_control", "saving_pct", "span_hours"] as const) if (row[key] !== undefined) { if (typeof row[key] !== "number" || !Number.isFinite(row[key]) || row[key] < 0) throw new Error(`decision ${key} 不安全`); summary[key] = row[key]; }
  for (const key of ["saving_minor", "tokens_total", "failures"] as const) if (row[key] !== undefined) summary[key] = requiredCount(row[key], `decision ${key}`);
  if (row.session_ref !== undefined) { const reference = stringField(row.session_ref, "decision summary session"); if (!/^sr_[A-Za-z0-9_-]{8,128}$/.test(reference)) throw new Error("decision summary session 不安全"); summary.session_ref = reference; }
  if (row.combo !== undefined) { const combo = record(row.combo, "decision summary combo"); summary.combo = { harness: safeHarnessLabel(combo.harness), model_id: decisionLabel(combo.model_id, "summary model") }; }
  if (row.currencies !== undefined) summary.currencies = requiredArray(row.currencies, "summary currencies").slice(0, 8).map((item) => decisionCurrency(item, "summary currency"));
  if (row.by_currency !== undefined) { const source = record(row.by_currency, "summary currency values"); summary.by_currency = Object.fromEntries(Object.entries(source).slice(0, 8).map(([key, item]) => { const value = record(item, "summary currency value"); return [decisionCurrency(key, "summary currency key"), { combos: requiredCount(value.combos, "summary combos"), tokens: requiredCount(value.tokens, "summary tokens") }]; })); }
  return summary;
}

function parseDecisionSummaryCombo(value: unknown): NonNullable<DecisionSummary["outlier"]> {
  const row = record(value, "decision summary combo");
  return { harness: safeHarnessLabel(row.harness), model_id: decisionLabel(row.model_id, "summary model"), provider_id: row.provider_id === undefined ? "<unknown>" : decisionLabel(row.provider_id, "summary provider"), per_session_minor: requiredCount(row.per_session_minor, "summary per session"), cache_hit_ratio: boundedRatio(row.cache_hit_ratio, "summary cache hit"), uncached_tokens: row.uncached_tokens === undefined ? 0 : requiredCount(row.uncached_tokens, "summary uncached") };
}

function parseDecisionMatrix(value: unknown): DecisionMatrixReport {
  const root = record(value, "decision matrix");
  if (root.schema_version !== "agent-vitals-decision-matrix/v1" || root.status !== "ok") throw new Error("decision matrix DTO schema mismatch");
  const month = stringField(root.month, "decision month");
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("decision month DTO 格式不安全");
  const rows = requiredArray(root.rows, "decision rows");
  const summaries = requiredArray(root.findings_summary, "decision summary");
  const limitations = requiredArray(root.limitations, "decision limitations");
  const allowedLimitations = new Set(["waste_rate_unavailable", "harness_behavior_harness_level", "amounts_currency_separated", "fingerprint_link_deferred", "top_sessions_unavailable", "pricing_unavailable"]);
  if (rows.length > 500 || summaries.length > 4 || limitations.length > 6) throw new Error("decision matrix DTO 数量超限");
  return { schema_version: "agent-vitals-decision-matrix/v1", status: "ok", month, rows: rows.map(parseDecisionRow), findings_summary: summaries.map(parseDecisionSummary), limitations: limitations.map((item) => { const limitation = stringField(item, "decision limitation"); if (!allowedLimitations.has(limitation)) throw new Error("decision limitation 不安全"); return limitation; }) };
}

export async function discoverTrust(): Promise<TrustDiscovery> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { candidates: [{ id: "zcode", detected: true, artifact_profile_available: true, coverage_state: "artifact_profile_available" }], profile_errors: [] };
  return parseTrustDiscovery(await handler("trust_discover"));
}

export async function readTrustProfileStatus(): Promise<TrustProfileStatus> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { pending: [], approved: [] };
  return parseTrustProfileStatus(await handler("trust_profile_proposal_status"));
}

async function trustProfileDecision(command: "trust_profile_approve" | "trust_profile_reject" | "trust_profile_revoke", slug: string, manifestHash: string, status: "approved" | "rejected" | "revoked"): Promise<{ status: string; slug: string }> {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(slug) || !/^[0-9a-f]{16}$/.test(manifestHash)) throw new Error("Trust profile decision reference is invalid");
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { status, slug };
  return parseTrustProfileReceipt(await handler(command, { slug, manifestHash }), status);
}

export function approveTrustProfile(profile: TrustProfileSummary): Promise<{ status: string; slug: string }> {
  return trustProfileDecision("trust_profile_approve", profile.slug, profile.manifest_hash, "approved");
}

export function rejectTrustProfile(profile: TrustProfileSummary): Promise<{ status: string; slug: string }> {
  return trustProfileDecision("trust_profile_reject", profile.slug, profile.manifest_hash, "rejected");
}

export function revokeTrustProfile(profile: TrustProfileSummary): Promise<{ status: string; slug: string }> {
  return trustProfileDecision("trust_profile_revoke", profile.slug, profile.manifest_hash, "revoked");
}

export async function readTrustSuppressions(): Promise<TrustSuppression[]> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return [];
  return parseTrustSuppressions(await handler("trust_suppression_list"));
}

export async function revokeTrustSuppression(suppressionId: string): Promise<"revoked" | "not_found"> {
  if (!/^trust-suppression-SV70[1-9]-\d{1,20}$|^trust-suppression-SV710-\d{1,20}$/.test(suppressionId)) throw new Error("Trust suppression reference is invalid");
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return "revoked";
  const root = trustCommandData(await handler("trust_suppression_revoke", { suppressionId }), "Trust suppression receipt");
  const status = stringField(root.status, "Trust suppression receipt status");
  const id = stringField(root.suppression_id, "Trust suppression receipt id");
  if ((status !== "revoked" && status !== "not_found") || id !== suppressionId) throw new Error("Trust suppression receipt 不安全");
  return status;
}

export async function createTrustSuppression(issueType: string): Promise<string> {
  if (!/^SV70[1-9]$|^SV710$/.test(issueType)) throw new Error("Trust issue type is invalid");
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return `preview-${issueType}`;
  const root = trustCommandData(await handler("trust_suppression_create", {
    issueType,
    instanceFingerprint: null,
    reason: "React Workbench user suppression",
  }), "Trust suppression receipt");
  const status = stringField(root.status, "Trust suppression receipt status");
  const id = stringField(root.suppression_id, "Trust suppression receipt id");
  if (status !== "saved" || !/^trust-suppression-SV70[1-9]-\d{1,20}$|^trust-suppression-SV710-\d{1,20}$/.test(id)) throw new Error("Trust suppression receipt 不安全");
  return id;
}

export async function auditTrust(harness: string): Promise<TrustAuditReport> {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(harness)) throw new Error("执行环境标识不安全");
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return {
    harness, discovered: 1, inserted: 1, duplicate: 0, findings_upserted: 0, evidence_links_added: 0,
    stage_counts: { package_observed: 1 }, observation_kind_counts: { package: 1 }, evidence: [{
      kind: "package", stage: "package_observed", evidence_level: "E1", evidence_origin: "local_artifact", observed_at_ms: Date.now(),
      workspace_ref: "hmac:preview-workspace", native_event_ref: "hmac:preview-event", scope_classes: ["workspace_current", "git_history"],
      file_count: 42, byte_count: 1024 * 1024, destination_class: "object_storage", collector_id: "preview",
    }],
  };
  const result = await handler("trust_audit", { harness });
  const root = record(result, "trust audit envelope");
  const reports = Array.isArray(root.reports) ? root.reports : [];
  if (reports.length !== 1) throw new Error("trust audit 未返回单一执行环境报告");
  return parseTrustAudit(reports[0]);
}

export async function readTrustEvidence(harness: string | null = null, limit = 200, cursor: string | null = null): Promise<TrustEvidenceHistory> {
  if (harness !== null && !/^[a-z][a-z0-9_-]{0,31}$/.test(harness)) throw new Error("执行环境标识不安全");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Trust 证据读取范围不安全");
  const handler = globalTauri()?.core?.invoke;
  if (cursor !== null && (cursor.length > 320 || !/^[A-Za-z0-9_.:-]+$/.test(cursor))) throw new Error("Trust 证据游标不安全");
  if (!handler) return { harness, count: 0, evidence: [], next_cursor: null };
  const result = record(await handler("trust_evidence_read", { harness, limit, cursor }), "trust evidence history");
  const evidence = requiredArray(result.evidence, "trust evidence history evidence").map((item) => parseTrustEvidence(item));
  const count = requiredCount(result.count, "trust evidence history count");
  if (count !== evidence.length) throw new Error("Trust 证据数量与记录不一致");
  const returnedHarness = result.harness === null ? null : stringField(result.harness, "trust evidence history harness");
  if (returnedHarness !== harness) throw new Error("Trust 证据执行环境范围不一致");
  const next_cursor = result.next_cursor == null ? null : result.next_cursor;
  if (next_cursor !== null && (typeof next_cursor !== "string" || next_cursor.length > 320 || !/^[A-Za-z0-9_.:-]+$/.test(next_cursor))) throw new Error("Trust 证据游标不安全");
  return { harness: returnedHarness, count, evidence, next_cursor };
}

export async function readTrustMonitorConfig(): Promise<TrustMonitorConfig> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return parseTrustMonitorConfig({
    status: "ok", reason: null, enabled: false, interval_seconds: 30, notifications_enabled: false,
    capability: "not_started", last_success_at_ms: null, last_error_code: null,
    updated_at_ms: null, notification_permission: null, enabled_source: "legacy_default",
  });
  return parseTrustMonitorConfig(await handler("trust_monitor_config"));
}

export async function saveTrustMonitorConfig(input: {
  enabled: boolean;
  interval_seconds: number;
  notifications_enabled: boolean;
}): Promise<TrustMonitorConfig> {
  if (typeof input.enabled !== "boolean" || typeof input.notifications_enabled !== "boolean") {
    throw new Error("实时监测开关参数不安全");
  }
  if (!Number.isSafeInteger(input.interval_seconds) || input.interval_seconds < 5 || input.interval_seconds > 3600) {
    throw new Error("实时监测间隔必须在 5 秒到 3600 秒之间");
  }
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return parseTrustMonitorConfig({
    status: "ok", reason: null, enabled: input.enabled, interval_seconds: input.interval_seconds,
    notifications_enabled: input.enabled && input.notifications_enabled, capability: input.enabled ? "partial" : "not_started",
    last_success_at_ms: null, last_error_code: null, updated_at_ms: Date.now(), notification_permission: null,
  });
  return parseTrustMonitorConfig(await handler("save_trust_monitor_config", {
    enabled: input.enabled,
    intervalSeconds: input.interval_seconds,
    notificationsEnabled: input.notifications_enabled,
  }));
}

/** R6a：询问条幅的「稍后」——dismiss 后永不再问；enabled 保持不动。 */
export async function dismissTrustMonitorPrompt(): Promise<TrustMonitorConfig> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return parseTrustMonitorConfig({
    status: "ok", reason: null, enabled: false, interval_seconds: 30, notifications_enabled: false,
    capability: "not_started", last_success_at_ms: null, last_error_code: null,
    updated_at_ms: Date.now(), notification_permission: null, enabled_source: "dismissed",
  });
  return parseTrustMonitorConfig(await handler("trust_monitor_dismiss"));
}

export async function runTrustRuntimeSnapshot(): Promise<TrustRuntimeSnapshot> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return parseTrustRuntimeSnapshot({
    capability: "macos_lsof_partial", candidate_processes: 1, observations: 2, inserted: 2,
    duplicate: 0, findings_upserted: 1, notification_candidates: 1, evidence_links_added: 2,
  });
  return parseTrustRuntimeSnapshot(await handler("trust_runtime_snapshot"));
}

export async function readFindings(cursor: string | null = null): Promise<FindingsReport> {
  if (cursor !== null && (typeof cursor !== "string" || !/^\d{1,12}$/.test(cursor))) throw new Error("发现分页游标不安全");
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return parseFindings({
    schema_version: "agent-vitals-findings/v1", status: "ok",
    totals: { issues: 2, findings: 2, critical: 1, warning: 1, info: 0, sessions: 2, sessions_total: 5 },
    rules: [{ rule: "SV709", severity: "critical", category: "object_storage_egress", hits: 1, sessions: 1 }, { rule: "PRICE_COVERAGE", severity: "warning", category: "billing", hits: 1, sessions: 1 }],
    issues: [
      { group_id: "fnv1a64:0123456789abcdef", action_kind: "behavior", rule: "SV709", harness: "zcode", evidence_class: "egress", count: 1, first_seen_at_ms: 1789891200000, last_seen_at_ms: 1789891200000, severity: "critical", status_rollup: { open: 1, later: 0, acknowledged: 0, resolved: 0, not_applicable: 0 }, sessions_count: 1, sample_evidence: [{ available: true, reference: "fnv1a64:2222222222222222", observed_first_at_ms: 1789891200000, observed_last_at_ms: 1789891200000, evidence_level: "E3", stage: "egress_attempted", evidence_origin: "network_metadata", scope_classes: ["git_history"], observation_count: 1, file_count: null, byte_count: 3145728, destination_class: "object_storage", confidence: "high" }], read_only: true, manual_follow_up: false },
      { group_id: "fnv1a64:1111111111111111", action_kind: "billing", rule: "PRICE_COVERAGE", harness: "minimax-code", evidence_class: "billing", count: 1, first_seen_at_ms: 1789891200000, last_seen_at_ms: 1789891200000, severity: "warning", status_rollup: { open: 1, later: 0, acknowledged: 0, resolved: 0, not_applicable: 0 }, sessions_count: 1, sample_evidence: [{ available: true, reference: "fnv1a64:3333333333333333", observed_first_at_ms: 1789891200000, observed_last_at_ms: 1789891200000, evidence_level: null, stage: null, evidence_origin: "local_artifact", scope_classes: [], observation_count: 1, file_count: null, byte_count: null, destination_class: null, confidence: "medium" }], read_only: false, manual_follow_up: true },
    ], next_cursor: null, refreshed: false,
  });
  return parseFindings(await handler("findings_groups_safe", { pageSize: 50, cursor }));
}

export async function readFindingsFreshness(): Promise<FindingsFreshness> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { status: "ok", state: "stale", last_successful_sync_at: "2026-09-20T15:00:00+08:00", stale_harnesses: ["dsh"], syncing: false };
  return parseFindingsFreshness(await handler("findings_freshness"));
}

export async function readDecisionMatrix(): Promise<DecisionMatrixReport> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return parseDecisionMatrix({
    schema_version: "agent-vitals-decision-matrix/v1", status: "ok", month: "2026-09",
    rows: [{ harness: "harness:zcode", model_id: "glm-5", provider_id: "zhipu", sessions: 4, tokens: { uncached_input: 1200, cache_read: 8800, cache_write: 300, output: 900, total: 11200 }, cache_hit_ratio: 0.8544, has_subscription: false, waste_rate: null, amounts: [{ amount_minor: 781, currency: "CNY", basis: "metered_estimate" }], top_sessions: [{ session_ref: "sr_0123456789", span_first_ms: 1789891200000, span_last_ms: 1789894800000, tokens_total: 6400, failures: 2 }], harness_behavior: { SV610: 2 }, limit_pressure: { hits: 1, per_session: 0.25 }, cost_provider_unresolved: false }],
    findings_summary: [{ kind: "marathon", session_ref: "sr_0123456789", span_hours: 25.2, tokens_total: 11200, failures: 2, combo: { harness: "zcode", model_id: "glm-5" }}],
    limitations: ["waste_rate_unavailable", "harness_behavior_harness_level", "amounts_currency_separated", "fingerprint_link_deferred"],
  });
  return parseDecisionMatrix(await handler("decision_matrix_safe", { month: null }));
}

function globalTauri(): TauriGlobal | undefined {
  return (window as Window & { __TAURI__?: TauriGlobal }).__TAURI__;
}

export async function invoke<T>(command: string, args?: unknown): Promise<T> {
  const handler = globalTauri()?.core?.invoke;
  if (handler) return (await handler(command, args)) as T;

  // The preview is intentionally synthetic and contains no local paths,
  // session data, evidence contents, or credentials.
  if (command === "react_preview_overview") return browserPreview as T;
  throw new Error(`本地 API 不可用：${command}`);
}

export function hasNativeBridge(): boolean {
  return typeof globalTauri()?.core?.invoke === "function";
}

export async function readOverviewSnapshot(): Promise<OverviewSnapshot> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return browserPreview;
  return parseOverviewSnapshot(await handler("read_overview"));
}

export async function readUsageCalendar(month: string): Promise<UsageCalendar> {
  const safe = safeMonth(month, "usage month");
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return parseUsageCalendar({ month: safe, days: [] });
  const parsed = parseUsageCalendar(await handler("read_calendar_month", { month: safe }));
  if (parsed.month !== safe) throw new Error("usage calendar 返回了错误月份");
  return parsed;
}

export async function readUsageSourceSummary(month: string): Promise<UsageSourceSummary> {
  const safe = safeMonth(month, "usage summary month");
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return parseUsageSourceSummary({
    month: safe,
    freshness: { state: "unavailable", last_observed_at: null },
    coverage: { measured_fields: 0, total_fields: 0 },
    excluded_harnesses: [], total_actual_spend: {}, actual_spend_by_basis: {},
  });
  const parsed = parseUsageSourceSummary(await handler("data_monthly_summary", { month: safe }));
  if (parsed.month !== safe) throw new Error("usage source summary 返回了错误月份");
  return parsed;
}

export async function readDailySummary(date: string): Promise<DailySummary> {
  const safe = safeDate(date, "daily summary date");
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return parseDailySummary({ date: safe, freshness: { state: "unavailable", last_observed_at: null }, coverage: { measured_fields: 0, total_fields: 0 }, excluded_harnesses: [], total_actual_spend: {}, actual_spend_by_basis: {}, tokens_by_harness: {}, by_provider: {}, has_unresolved: false });
  const parsed = parseDailySummary(await handler("data_daily_summary", { date: safe }));
  if (parsed.date !== safe) throw new Error("daily summary 返回了错误日期");
  return parsed;
}

function statisticsMonthAndDate(timezone: string): { month: string; date: string } {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = formatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return { month: `${year}-${month}`, date: `${year}-${month}-${day}` };
}

// OVERVIEW_TREND_PANEL spec v1.1 §4：失败小时标记容错降级——形状不对、外层
// date 与请求日不一致 → null（读不到 ≠ 零失败），绝不抛错连累同一 bundle 里的
// token 面板。键只接受 "0".."23"、值正整数；任何条目非法也整体 null：丢弃坏
// 条目剩下的「空对象」会被当成真零失败渲染，那是编造。
function parseFailureHours(value: unknown, expectedDate: string): Record<string, number> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (root.date !== expectedDate) return null;
  const hours = root.hours;
  if (hours == null || typeof hours !== "object" || Array.isArray(hours)) return null;
  const out: Record<string, number> = {};
  for (const [hour, count] of Object.entries(hours as Record<string, unknown>)) {
    if (!/^(?:[0-9]|1[0-9]|2[0-3])$/.test(hour)) return null;
    if (typeof count !== "number" || !Number.isFinite(count) || count <= 0 || !Number.isInteger(count)) return null;
    out[hour] = count;
  }
  return out;
}

// OVERVIEW_TREND_RANGE_SPEC §2.2：失败日聚合的容错降级，语义同 parseFailureHours——
// 形状不对 / 任一键非 YYYY-MM-DD / 任一值非正整数 → 整体 null，不抛错、不丢弃坏条目
// 后冒充真零。`to` 必须等于请求日（窗口守卫）。Shape：lib.rs overview_details_snapshot_at
// → issues::failure_days_trailing  {from,to,days:{date:count}}。
function parseFailureDays(value: unknown, expectedTo: string): Record<string, number> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (root.to !== expectedTo) return null;
  const days = root.days;
  if (days == null || typeof days !== "object" || Array.isArray(days)) return null;
  const out: Record<string, number> = {};
  for (const [day, count] of Object.entries(days as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    if (typeof count !== "number" || !Number.isFinite(count) || count <= 0 || !Number.isInteger(count)) return null;
    out[day] = count;
  }
  return out;
}

export async function readOverviewDetails(): Promise<OverviewDetails> {
  const timezone = (await readStatisticsTimezone()).timezone;
  const { month, date } = statisticsMonthAndDate(timezone);
  const handler = globalTauri()?.core?.invoke;
  if (handler) {
    const root = record(await handler("read_overview_details_snapshot", { month, date }), "overview details snapshot");
    if (safeMonth(root.month, "overview snapshot month") !== month || safeDate(root.date, "overview snapshot date") !== date) throw new Error("总览快照窗口与请求不一致");
    const authority_revision = root.authority_revision == null ? null : boundedCount(root.authority_revision, "overview authority revision", Number.MAX_SAFE_INTEGER);
    const is_consistent = requiredBoolean(root.is_consistent, "overview snapshot consistency");
    const errors = requiredArray(root.errors, "overview snapshot errors").slice(0, 8).map((error) => safeUiError(error, "总览数据快照暂不可用"));
    if (!is_consistent && errors.length === 0) errors.push("总览数据可能跨越多个权威版本，请刷新重试");
    return {
      month, date,
      monthly: root.monthly == null ? null : parseUsageSourceSummary(root.monthly),
      daily: root.daily == null ? null : parseDailySummary(root.daily),
      calendar: root.calendar == null ? null : parseUsageCalendar(root.calendar),
      failure_hours: parseFailureHours(root.failure_hours, date),
      failure_days: parseFailureDays(root.failure_days, date),
      authority_revision, is_consistent, errors,
    };
  }
  // Standalone browser preview has no authority revision API. Keep its isolated
  // projections usable but label the result as unverified, never as consistent.
  const results = await Promise.allSettled([readUsageSourceSummary(month), readDailySummary(date), readUsageCalendar(month)]);
  const errors: string[] = ["浏览器预览未连接 authority，无法校验跨面板数据版本"];
  const monthly = results[0].status === "fulfilled" ? results[0].value : (errors.push(safeUiError(results[0].reason, "月度汇总暂不可用")), null);
  const daily = results[1].status === "fulfilled" ? results[1].value : (errors.push(safeUiError(results[1].reason, "今日汇总暂不可用")), null);
  const calendar = results[2].status === "fulfilled" ? results[2].value : (errors.push(safeUiError(results[2].reason, "日历暂不可用")), null);
  return { month, date, monthly, daily, calendar, failure_hours: null, failure_days: null, authority_revision: null, is_consistent: false, errors };
}

export async function readUsageHourly(date: string): Promise<UsageHourly> {
  const safe = safeDate(date, "usage hourly date");
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return parseUsageHourly({ date: safe, harnesses_available: { dsh: null, claude: null, codex: null }, hours: Array.from({ length: 24 }, (_, hour) => ({ hour, dsh_tokens: null, claude_tokens: null, codex_tokens: null })) });
  const parsed = parseUsageHourly(await handler("read_hourly_distribution", { date: safe }));
  if (parsed.date !== safe) throw new Error("usage hourly 返回了错误日期");
  return parsed;
}

export async function readRouteQuality(days: 30 | 90 | 365): Promise<RouteQualityReport> {
  if (days !== 30 && days !== 90 && days !== 365) throw new Error("路线质量统计窗口不安全");
  const now = Date.now();
  const fallback: RouteQualityReport = {
    since_ms: now - days * 86_400_000,
    now_ms: now,
    families_vocabulary: [...routeFamilies],
    harnesses: [{
      harness: "harness:zcode",
      has_baseline: true,
      native_families: ["glm"],
      totals: { requests: 12, sessions: 3 },
      families: [{
        family: "glm", flag: "native", requests: 9, sessions: 3, tokens_total: 18000, last_event_ms: now - 3_600_000, request_share: 75,
        models: [{ model: "glm-5", requests: 9, tokens_total: 18000, last_event_ms: now - 3_600_000 }],
      }, {
        family: "deepseek", flag: "non_native", requests: 2, sessions: 1, tokens_total: 4200, last_event_ms: now - 7_200_000, request_share: 16.7,
        models: [{ model: "deepseek-v4-flash", requests: 2, tokens_total: 4200, last_event_ms: now - 7_200_000 }],
      }, {
        family: "synthetic", flag: "api_error", requests: 1, sessions: 1, tokens_total: 0, last_event_ms: now - 10_800_000, request_share: 8.3,
        models: [{ model: "<synthetic>", requests: 1, tokens_total: 0, last_event_ms: now - 10_800_000 }],
      }],
    }],
  };
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return parseRouteQuality(fallback);
  try {
    return parseRouteQuality(await handler("routes_quality", { days }));
  } catch {
    // Do not surface Rust/CLI diagnostics, local paths, or provider details in
    // the UI. The desktop log remains the place for operator-level debugging.
    throw new Error("路线质量报告读取失败");
  }
}

/** 「测试」板 Claude IP 自检：Rust 侧 ip_check::ip_check_run 的一份完整报告。
 * 全部出站探测（trace / ipip / edns / ip-api / favicon 探针 / STUN）都在应用
 * 进程执行并按 scutil --proxy 对齐系统代理路由；React 只渲染，零网络。 */
export type IpCheckTrace = { ip: string; colo?: string; loc?: string; warp?: string };
export type IpCheckReport = {
  proxy_mode: "direct" | "static" | "pac" | "socks";
  claude: IpCheckTrace | null;
  cloudflare: IpCheckTrace | null;
  china: { ip: string; location: string } | null;
  dns: { ip: string; geo: string } | null;
  intel: {
    country?: string; countryCode?: string; regionName?: string; city?: string;
    isp?: string; org?: string; as?: string;
    mobile?: boolean | null; proxy?: boolean | null; hosting?: boolean | null;
  } | null;
  latency: Array<{ host: string; ms: number | null; ok: boolean }>;
  stun: { ip: string } | null;
};

export async function readIpCheckReport(): Promise<IpCheckReport> {
  const value = await invoke<IpCheckReport>("ip_check_run");
  if (!value || typeof value !== "object" || !Array.isArray(value.latency)) {
    throw new Error("ip 自检报告读取失败");
  }
  return value;
}

export async function readSessions(input: {
  day?: string;
  month?: string;
  date_from?: string;
  date_to?: string;
  harness_kind?: string;
  model?: string;
  provider?: string;
  page_size?: number;
  cursor?: string | null;
  /** "oldest"：first_event 升序分页（City 一年窗口从最老数据开始装载）。 */
  order?: "oldest" | "tokens";
}): Promise<SessionsPage> {
  if ((input.date_from === undefined) !== (input.date_to === undefined)) throw new Error("sessions 日期范围必须成对提供");
  // IPC 边界统一 camelCase：Tauri 2 命令参数只认 camel（dateFrom/harnessKind/…）。
  // snake key 会被静默丢成 None——城市/会话页的日期窗口曾因此退化为"今天"。
  const args: Record<string, unknown> = {};
  if (input.day !== undefined) args.day = safeDate(input.day, "sessions day");
  if (input.month !== undefined) args.month = safeMonth(input.month, "sessions month");
  if (input.date_from !== undefined && input.date_to !== undefined) {
    const from = safeDate(input.date_from, "sessions date from");
    const to = safeDate(input.date_to, "sessions date to");
    if (from > to) throw new Error("sessions 日期范围起点不能晚于终点");
    args.dateFrom = from;
    args.dateTo = to;
  }
  if (input.harness_kind) {
    const harness = safeHarnessLabel(input.harness_kind);
    if (harness === "generic") throw new Error("sessions harness filter 不安全");
    args.harnessKind = harness;
  }
  if (input.model) args.model = decisionLabel(input.model, "sessions model filter");
  if (input.provider) args.provider = decisionLabel(input.provider, "sessions provider filter");
  if (input.page_size !== undefined) {
    if (!Number.isSafeInteger(input.page_size) || input.page_size < 1 || input.page_size > 500) throw new Error("sessions page size 不安全");
    args.pageSize = input.page_size;
  }
  if (input.cursor) {
    if (input.cursor.length > 4096) throw new Error("sessions cursor 不安全");
    args.cursor = input.cursor;
  }
  if (input.order) {
    if (input.order !== "oldest" && input.order !== "tokens") throw new Error("sessions order 不安全");
    if (input.order === "oldest") args.order = input.order;
  }
  const handler = globalTauri()?.core?.invoke;
  if (!handler) {
    const preview = new Date();
    const iso = preview.toISOString();
    const sample = {
      session_ref: "sr_browser_mock_01",
      harness: "codex",
      first_event_at: new Date(preview.valueOf() - 3_600_000).toISOString(),
      last_event_at: iso,
      event_count: 24,
      model_ids: ["gpt-5.6-sol"],
      tokens: { uncached_input_tokens: 92000, cache_read_tokens: 128000, cache_write_tokens: 12000, output_tokens: 14000, total: 246000 },
      peak_tokens: 34000,
      cost_minor: { amount_minor: 84, currency: "USD", basis: "metered_estimate" },
      cost_status: { state: "estimated", reason: "metered-estimate", has_unresolved: false },
    };
    return parseSessionsPage({ data: { sessions: [sample], next_cursor: null, has_more: false, window_session_count: 1, window_total_tokens: 246000, window: { label: input.month ?? "preview" } } });
  }
  return parseSessionsPage(await handler("sessions_list", args));
}

export async function readSessionDetail(sessionRef: string, cursor: string | null = null): Promise<SessionDetail> {
  if (typeof sessionRef !== "string" || !/^sr_[A-Za-z0-9_-]{8,128}$/.test(sessionRef)) throw new Error("session_ref 不安全");
  // Tauri's sessions_read command translates this field to the CLI's
  // `--page-size`; keeping the name explicit prevents the old MCP `limit`
  // spelling from being silently dropped at the desktop boundary.
  const args: Record<string, unknown> = { sessionRef, pageSize: 200 };
  if (cursor !== null) {
    if (typeof cursor !== "string" || cursor.length < 1 || cursor.length > 4096) throw new Error("session detail cursor 不安全");
    args.cursor = cursor;
  }
  const handler = globalTauri()?.core?.invoke;
  if (!handler) {
    const now = new Date();
    const makeEvent = (offset: number, total: number, model: string, peak = false): SessionTimelineRow => ({
      event_at: new Date(now.valueOf() - offset).toISOString(), model_id: model, observation_kind: "assistant-usage", peak,
      tokens: { uncached_input_tokens: total, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, total },
    });
    const sample = {
      session_ref: sessionRef, harness: "codex", first_event_at: new Date(now.valueOf() - 3_600_000).toISOString(), last_event_at: now.toISOString(),
      event_count: 24, model_ids: ["gpt-5.6-sol"], tokens: { uncached_input_tokens: 92000, cache_read_tokens: 128000, cache_write_tokens: 12000, output_tokens: 14000, total: 246000 }, peak_tokens: 34000,
      cost_minor: { amount_minor: 84, currency: "USD", basis: "metered_estimate" }, cost_status: { state: "estimated", reason: "metered-estimate", has_unresolved: false },
      billing_breakdown: [{ provider_id: "openai", provider_raw: "openai", model_id: "gpt-5.6-sol", billing_template_id: null, billing_mode: "metered", pricing_basis: "metered_estimate", evidence_basis: "explicit-official-route", pricing_version: "preview-v1", pricing_source: "official", cost_minor: { amount_minor: 84, currency: "USD", basis: "metered_estimate" }, peak: true, tokens: { uncached_input_tokens: 92000, cache_read_tokens: 128000, cache_write_tokens: 12000, output_tokens: 14000, total: 246000 }, has_unresolved: false, unresolved_reason: null }],
      timeline: [makeEvent(3_600_000, 92000, "gpt-5.6-sol"), makeEvent(1_800_000, 154000, "gpt-5.6-sol", true)],
      workflow_timeline: [{ event_at: new Date(now.valueOf() - 3_500_000).toISOString(), event_type: "tool_finished", capability_kind: "tool", capability_id: "bash", capability_version: null, outcome: "succeeded", duration_ms: 1400, error_fingerprint: null, invocation_fingerprint: null }],
      workflow_has_more: false, has_more: false, next_cursor: null,
    };
    return parseSessionDetail({ data: sample }, sessionRef);
  }
  return parseSessionDetail(await handler("sessions_read", args), sessionRef);
}

export async function readStatisticsTimezone(): Promise<StatisticsTimezone> {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { timezone: fallback };
  const root = record(await handler("statistics_timezone_config"), "statistics timezone");
  const timezone = stringField(root.timezone, "statistics timezone");
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); } catch (_) { throw new Error("统计时区不可用"); }
  return { timezone };
}

export async function readStatisticsSettings(): Promise<StatisticsSettingsReport> {
  const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const fallback: StatisticsSettingsReport = {
    timezone: { status: "ok", timezone: systemTimezone, system_timezone: systemTimezone },
    retention: { status: "ok", months: 13, minimum_months: 1, maximum_months: 60 },
    pricing: { status: "ok", state: "ok", version: "browser-preview", model_count: 7, last_success_at_ms: Date.now() - 3_600_000, available: true },
  };
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return fallback;
  const results = await Promise.allSettled([
    handler("statistics_timezone_config"),
    handler("retention_config"),
    handler("public_pricing_catalog_status"),
  ]);
  const parseOrUnavailable = <T,>(result: PromiseSettledResult<unknown>, parse: (value: unknown) => T, unavailable: T): T => {
    if (result.status === "rejected") return unavailable;
    try { return parse(result.value); } catch { return unavailable; }
  };
  return {
    timezone: parseOrUnavailable(results[0], parseStatisticsTimezone, { status: "unavailable", timezone: null, system_timezone: null }),
    retention: parseOrUnavailable(results[1], parseRetentionConfig, { status: "unavailable", months: null, minimum_months: null, maximum_months: null }),
    pricing: parseOrUnavailable(results[2], parsePricingCatalogStatus, { status: "unavailable", state: "unknown", version: null, model_count: null, last_success_at_ms: null, available: false }),
  };
}

function validateIanaTimezone(timezone: string): string {
  if (typeof timezone !== "string" || timezone.length < 1 || timezone.length > 96 || /[\u0000-\u001f\u007f]/u.test(timezone)) throw new Error("统计时区不安全");
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); } catch (_) { throw new Error("统计时区不可用"); }
  return timezone;
}

/** 「跟随系统」的保存哨兵：后端删偏好文件，之后随 OS 时区走（见 statistics_timezone.rs）。 */
export const FOLLOW_SYSTEM_TIMEZONE = "system";

export async function saveStatisticsTimezone(timezone: string): Promise<{ status: "saved"; timezone: string }> {
  const safe = timezone === FOLLOW_SYSTEM_TIMEZONE ? FOLLOW_SYSTEM_TIMEZONE : validateIanaTimezone(timezone);
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { status: "saved", timezone: safe === FOLLOW_SYSTEM_TIMEZONE ? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC") : safe };
  const root = record(await handler("save_statistics_timezone_config", { timezone: safe }), "save statistics timezone");
  if (root.status !== "saved") throw new Error("统计时区保存未确认");
  const saved = validateIanaTimezone(stringField(root.timezone, "saved statistics timezone"));
  return { status: "saved", timezone: saved };
}

export async function saveRetentionMonths(months: number, minimum = 1, maximum = 60): Promise<{ status: "saved"; months: number }> {
  if (!Number.isSafeInteger(months) || months < minimum || months > maximum) throw new Error(`保留期必须是 ${minimum}-${maximum} 之间的整数`);
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { status: "saved", months };
  const root = record(await handler("save_retention_config", { input: { months } }), "save retention config");
  if (root.status !== "saved") throw new Error("保留期保存未确认");
  return { status: "saved", months: boundedCount(root.months, "saved retention months", 120) };
}

export async function readMonthlyExportSummary(month: string): Promise<MonthlyExportSummary> {
  const safe = safeMonth(month, "monthly export month");
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return parseMonthlyExportSummary({ month: safe, by_harness: {}, by_provider: {}, tokens_by_harness: {}, coverage: { measured_fields: 0, total_fields: 0 }, freshness: { state: "unavailable" }, excluded_harnesses: [] });
  const parsed = parseMonthlyExportSummary(await handler("data_monthly_summary", { month: safe }));
  if (parsed.month !== safe) throw new Error("月度导出返回了错误月份");
  return parsed;
}

export async function readAboutDiagnostics(): Promise<AboutDiagnosticsReport> {
  const fallback: AboutDiagnosticsReport = { status: "ok", appVersion: "browser-preview", cliVersion: "browser-preview", engineVersion: "browser-preview", architecture: "unknown", authoritySchema: "browser-preview", statisticsTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", pricing: { version: "browser-preview", capturedAtMs: Date.now() - 3_600_000 }, sync: { state: "ok" } };
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return fallback;
  try { return parseAboutDiagnostics(await handler("about_diagnostics")); } catch { return { status: "unavailable", appVersion: null, cliVersion: null, engineVersion: null, architecture: "unknown", authoritySchema: null, statisticsTimezone: null, pricing: null, sync: { state: "unknown" } }; }
}

export async function readSkillScan(harness: string = "all", force = false): Promise<SkillScanReport> {
  if (!/^(?:all|[a-z][a-z0-9-]{0,31})$/.test(harness)) throw new Error("Skill 执行环境筛选不安全");
  const now = Date.now();
  const fallback = { schema_version: "1.0", run: "browser-preview", harness_selection: harness, desktop_meta: { generated_at_ms: now, from_cache: !force, harness }, diagnostics: [{ code: "SV501", name: "提示注入模式", severity: "warning", skill: "browser-preview", evidence: { count: 1 }, impact: "发现 1 条需要人工复核的启发式命中。", recommendation: "打开对应 skill 定义后人工复核。", caveats: ["启发式命中不是恶意结论。"] }], not_assessed: [{ code: "SV003", name: "描述长度", reason: "当前执行环境没有可辩护的统一阈值。" }], report: { harness_summaries: { "claude-code": { skills_on_disk: 12, discoverable_skills: 8, runtime_verified_loaded_skills: null, unique_discoverable_skills: 8, description_budget: "available", description_budget_detail: { available: true, source: "configurable", budget_chars: 15000, used_chars: 4200, pct_used: 28.0 }, trigger_data: "available" } } } };
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return parseSkillScan(fallback, harness);
  try { return parseSkillScan(await handler("skills_doctor_report", { harness, force }), harness); }
  catch (reason: unknown) {
    const row = reason && typeof reason === "object" ? reason as Record<string, unknown> : {};
    const detail = row.error && typeof row.error === "object" ? row.error as Record<string, unknown> : row;
    const code = typeof detail.code === "string" ? detail.code : "";
    if (code === "no_binary") throw new Error("未找到可用的 agent-vitals CLI；请先修复安装或版本。");
    if (code === "cancelled") throw new Error("Skill 扫描已取消。");
    throw new Error("Skill 扫描失败；请确认本机 CLI 可用后重试");
  }
}

export async function cancelSkillScan(): Promise<"cancelled" | "not_running"> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return "not_running";
  try { const result = await handler("skills_scan_cancel"); return result === true ? "cancelled" : "not_running"; }
  catch { throw new Error("取消 Skill 扫描失败"); }
}

export async function saveSkillsSnapshot(): Promise<SkillSnapshotSaveReceipt> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { status: "saved", upload_performed: false };
  try {
    const root = record(await handler("skills_snapshot_save"), "skills snapshot receipt");
    if (root.status !== "saved") throw new Error("Skill 快照保存未确认");
    if (root.upload_performed !== false) throw new Error("Skill 快照上传状态不安全");
    return { status: "saved", upload_performed: false };
  } catch (reason: unknown) {
    const row = reason && typeof reason === "object" ? reason as Record<string, unknown> : {};
    const detail = row.error && typeof row.error === "object" ? row.error as Record<string, unknown> : row;
    const code = typeof detail.code === "string" ? detail.code : "";
    if (code === "no_binary") throw new Error("未找到可用的 agent-vitals CLI；请先修复安装或版本。");
    if (code === "storage_failed") throw new Error("本机快照保存失败；请检查快照目录权限或磁盘空间。");
    throw new Error("Skill 快照保存失败；请确认本机 CLI 可用后重试");
  }
}

export async function readSkillsDiff(): Promise<SkillDiffReport> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) {
    return parseSkillDiff({
      schema_version: "skills-diff-v1", status: "ok", baseline_available: true, truncated: false, dropped_rows: 0,
      summary: { added: 1, removed: 0, usage_changed: 1, newly_judgeable: 0, new_overlap_candidates: 0, new_security_findings: 1 },
      added_skills: [{ harness: "claude-code", name: "browser-preview", namespace: null, instance_id: null }], removed_skills: [],
      usage_delta: [{ harness: "claude-code", name: "browser-preview", namespace: null, instance_id: null, delta: 2, now: 8 }], newly_judgeable: [], new_overlap_candidates: [], new_security_findings: [{ skill: "browser-preview", rule: "SV501", line: 12 }], budget_delta_chars: null, budget_pct_then_now: [null, null], loaded_then_now: [8, 9],
    });
  }
  try { return parseSkillDiff(await handler("skills_diff_latest")); }
  catch (reason: unknown) {
    const row = reason && typeof reason === "object" ? reason as Record<string, unknown> : {};
    const detail = row.error && typeof row.error === "object" ? row.error as Record<string, unknown> : row;
    const code = typeof detail.code === "string" ? detail.code : "";
    if (code === "diff_unavailable") throw new Error("没有可比较的本机 Skill 快照；请先存为快照。");
    if (code === "output_too_large") throw new Error("Skill 对比结果过大，已停止显示；请缩小扫描范围后重试。");
    throw new Error("Skill 对比结果暂不可用；未将原始输出展示到页面。");
  }
}

function safeSkillSettingPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} 不安全`);
  return value.trim();
}

function parseSkillScanSettings(value: unknown): SkillScanSettings {
  const root = record(value, "skills scan settings");
  const self_root = safeSkillSettingPath(root.self_root ?? "", "skill self root");
  const rawBudget = root.budget;
  const budget = rawBudget == null ? null : typeof rawBudget === "number" ? rawBudget : NaN;
  if (budget !== null && (!Number.isSafeInteger(budget) || budget <= 0 || budget > 10_000_000)) throw new Error("Skill 描述预算不安全");
  return { self_root, budget: budget as number | null };
}

function parseSkillExportReceipt(value: unknown): SkillExportReceipt {
  const root = record(value, "skills export receipt");
  const status = boundedEnum(root.status, "skills export status", ["saved", "cancelled"], "cancelled") as SkillExportReceipt["status"];
  if (status === "saved" && root.upload_performed !== false) throw new Error("Skill 导出上传状态不安全");
  if (status === "cancelled" && root.upload_performed !== false) throw new Error("Skill 导出取消状态不安全");
  return { status, upload_performed: false };
}

export async function readSkillsScanSettings(): Promise<SkillScanSettings> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { self_root: "", budget: null };
  try { return parseSkillScanSettings(await handler("skills_scan_settings")); }
  catch { throw new Error("Skill 扫描设置暂不可用"); }
}

export async function saveSkillsScanSettings(selfRoot: string, budget: number | null): Promise<{ status: "saved" }> {
  const safeRoot = safeSkillSettingPath(selfRoot, "skill self root");
  if (budget !== null && (!Number.isSafeInteger(budget) || budget <= 0 || budget > 10_000_000)) throw new Error("描述预算必须是 1-10000000 之间的整数");
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { status: "saved" };
  try {
    const root = record(await handler("save_skills_scan_settings", { selfRoot: safeRoot, budget }), "skills scan settings receipt");
    if (root.status !== "saved") throw new Error("Skill 扫描设置保存未确认");
    return { status: "saved" };
  } catch (reason: unknown) {
    const row = reason && typeof reason === "object" ? reason as Record<string, unknown> : {};
    const detail = row.error && typeof row.error === "object" ? row.error as Record<string, unknown> : row;
    if (detail.code === "invalid_budget") throw new Error("描述预算必须是正整数");
    throw new Error("Skill 扫描设置保存失败；请确认本机配置目录可写");
  }
}

export async function exportSkillsRedacted(selfRoot: string | null): Promise<SkillExportReceipt> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { status: "saved", upload_performed: false };
  try {
    const picked = record(await handler("skills_export_pick_path"), "skills export path");
    if (picked.status === "cancelled") return { status: "cancelled", upload_performed: false };
    if (picked.status !== "picked") throw new Error("Skill 导出路径未确认");
    const path = safeSkillSettingPath(picked.path, "skills export path");
    if (!path) throw new Error("Skill 导出路径为空");
    const root = parseSkillExportReceipt(await handler("skills_export_redacted", { path, selfRoot: selfRoot ? safeSkillSettingPath(selfRoot, "skill self root") : null }));
    return root;
  } catch (reason: unknown) {
    const row = reason && typeof reason === "object" ? reason as Record<string, unknown> : {};
    const detail = row.error && typeof row.error === "object" ? row.error as Record<string, unknown> : row;
    if (detail.code === "no_binary") throw new Error("未找到可用的 agent-vitals CLI；请先修复安装或版本。");
    if (detail.code === "invalid_path") throw new Error("导出路径不可用");
    throw new Error("Skill 脱敏导出失败；未将原始输出展示到页面");
  }
}

export async function saveDiagnosticPackage(): Promise<DiagnosticExportReceipt> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { status: "saved", uploadPerformed: false };
  return parseDiagnosticExportReceipt(await handler("export_diagnostic_package"));
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { status: "no_release", currentVersion: "browser-preview", latestTag: null, updateAvailable: false, automaticInstall: false, releaseUrl: null, onLatestStable: false };
  try { return parseUpdateCheck(await handler("check_for_updates")); } catch { return { status: "unavailable", currentVersion: null, latestTag: null, updateAvailable: false, automaticInstall: false, releaseUrl: null, onLatestStable: false }; }
}

export async function openTrustedReleasesPage(releaseUrl?: string | null): Promise<{ status: "opened" }> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { status: "opened" };
  const url = releaseUrl ? parseTrustedReleaseUrl(releaseUrl, null) : null;
  const root = record(await handler("open_trusted_releases_page", url ? { url } : {}), "open releases page");
  if (root.status !== "opened") throw new Error("发布页打开未确认");
  return { status: "opened" };
}

// ── 决策区桥接（DECISION_AREA_REACT_PORT spec R1）：两个既有 quota IPC 的
// 严格解析包装。畸形 DTO 抛错（进组件错误态），无 Tauri 桥（浏览器预览）
// 返回 null = 不可用——与既有桥降级同纪律，不静默编数。

export type CodexQuotaWindow = {
  plan_type: string | null;
  used_percent: number;
  resets_at: number;
  observed_at: string;
};

export type ClaudeQuotaState =
  | { state: "unknown"; observed_at: string | null; windows_recent: number; last_resets_at: number | null; last_window: string | null }
  | { state: "exhausted"; window: string; window_label: string | null; resets_at: number; observed_at: string | null; windows_recent: number };

function parseCodexQuota(value: unknown): CodexQuotaWindow {
  const root = record(value, "codex quota snapshot");
  const limits = record(root.limits ?? null, "codex quota limits");
  const primary = record(limits.primary ?? null, "codex quota primary window");
  // used_percent 是 float 契约（adapter 保留小数，usage.rs:207-215）——
  // 必须用有限数校验 + 显式上界，不得走整数门（评审 P1-1）。
  const used = requiredFiniteNumber(primary.used_percent, "codex used_percent");
  if (used > 100) throw new Error("codex used_percent 越界");
  const resets = boundedCount(primary.resets_at, "codex resets_at", 4_102_444_800);
  if (!Number.isSafeInteger(resets) || resets <= 0) throw new Error("codex resets_at 不安全");
  const observed = nullableString(root.observed_at, "codex quota observed_at");
  if (observed === null || !Number.isFinite(Date.parse(observed))) throw new Error("codex quota observed_at 不可解析");
  const planType = nullableString(root.plan_type, "codex plan_type");
  return { plan_type: planType === null ? null : planType.slice(0, 64), used_percent: used, resets_at: resets, observed_at: observed };
}

function parseClaudeQuota(value: unknown): ClaudeQuotaState {
  const root = record(value, "claude quota state");
  const observed = nullableString(root.observed_at, "claude quota observed_at");
  const windowsRecent = boundedCount(root.windows_recent, "claude windows_recent", 100_000);
  if (root.state === "exhausted") {
    const resets = boundedCount(root.resets_at, "claude resets_at", 4_102_444_800);
    if (!Number.isSafeInteger(resets) || resets <= 0) throw new Error("claude resets_at 不安全");
    const window = nullableString(root.window, "claude window") ?? "five_hour";
    const label = nullableString(root.window_label, "claude window_label");
    return { state: "exhausted", window: window.slice(0, 32), window_label: label === null ? null : label.slice(0, 32), resets_at: resets, observed_at: observed, windows_recent: windowsRecent };
  }
  if (root.state !== "unknown") throw new Error("claude quota state 越界");
  const lastResets = root.last_resets_at === null || root.last_resets_at === undefined ? null : boundedCount(root.last_resets_at, "claude last_resets_at", 4_102_444_800);
  const lastWindow = nullableString(root.last_window, "claude last_window");
  return { state: "unknown", observed_at: observed, windows_recent: windowsRecent, last_resets_at: lastResets, last_window: lastWindow === null ? null : lastWindow.slice(0, 32) };
}

export async function readCodexQuota(): Promise<CodexQuotaWindow | null> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return null;
  return parseCodexQuota(await handler("data_codex_quota"));
}

export async function readClaudeQuota(): Promise<ClaudeQuotaState | null> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return null;
  return parseClaudeQuota(await handler("data_claude_quota"));
}

export async function readSourceHealth(): Promise<SourceHealthReport> {
  const fallback = {
    status: "ok",
    sources: [
      { harness: "codex", connection_state: "connected", scan: { source_count: 12, last_scanned_at_ms: Date.now() - 3_600_000 }, log: { last_event_at_ms: Date.now() - 3_600_000 }, import_scope: { facts: 42, sessions: 8, first_event_at_ms: Date.now() - 30 * 86_400_000, last_event_at_ms: Date.now() - 3_600_000 }, failed_scope: { sources: 0, error_codes: [] } },
      { harness: "claude-code", connection_state: "needs_attention", scan: { source_count: 4, last_scanned_at_ms: Date.now() - 7_200_000 }, log: { last_event_at_ms: Date.now() - 7_200_000 }, import_scope: { facts: 18, sessions: 3, first_event_at_ms: Date.now() - 20 * 86_400_000, last_event_at_ms: Date.now() - 7_200_000 }, failed_scope: { sources: 1, error_codes: ["permission_denied"] } },
      { harness: "dsh", connection_state: "connected", scan: { source_count: 2, last_scanned_at_ms: Date.now() - 1_800_000 }, log: { last_event_at_ms: Date.now() - 1_800_000 }, import_scope: { facts: 9, sessions: 2, first_event_at_ms: Date.now() - 5 * 86_400_000, last_event_at_ms: Date.now() - 1_800_000 }, failed_scope: { sources: 0, error_codes: [] } },
      { harness: "workbuddy", connection_state: "not_detected", scan: { source_count: 0, last_scanned_at_ms: null }, log: {}, import_scope: { facts: 0, sessions: 0, first_event_at_ms: null, last_event_at_ms: null }, failed_scope: { sources: 0, error_codes: ["vendor_internal_code"] } },
    ],
  };
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return parseSourceHealth(fallback, { status: "ok", paused: false }, { sync: { stage: "complete", at: "2026-09-21 22:00:00" } });
  try {
    const [sources, pause, overview] = await Promise.allSettled([
      handler("data_source_status"),
      handler("sync_pause_state"),
      handler("read_overview"),
    ]);
    if (sources.status === "rejected") throw new Error("来源状态读取失败");
    return parseSourceHealth(
      sources.value,
      pause.status === "fulfilled" ? pause.value : null,
      overview.status === "fulfilled" ? overview.value : null,
    );
  } catch {
    throw new Error("来源状态读取失败");
  }
}

export async function readSourceHarnessControls(): Promise<SourceHarnessControls> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { status: "ok", excluded_harnesses: [], supported_harnesses: [] };
  try { return parseSourceHarnessControls(await handler("source_harness_controls")); } catch { return { status: "unavailable", excluded_harnesses: [], supported_harnesses: [] }; }
}

export async function readSourceDataRevision(): Promise<number> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return 0;
  try {
    const root = record(await handler("source_data_revision"), "source data revision");
    return boundedCount(root.revision, "source data revision", Number.MAX_SAFE_INTEGER);
  } catch {
    return 0;
  }
}

export async function setSourceHarnessExcluded(harness: string, excluded: boolean): Promise<SourceHarnessControlReceipt> {
  if (safeHarnessLabel(harness) !== harness || harness === "generic") throw new Error("source harness is not supported");
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { status: "saved", changed: true, excluded };
  const root = record(await handler("set_source_harness_excluded", { input: { harness, excluded } }), "source harness control receipt");
  if (root.status !== "saved" && root.status !== "ok") throw new Error("source harness control was not saved");
  return { status: "saved", changed: requiredBoolean(root.changed ?? true, "source harness control changed"), excluded: requiredBoolean(root.excluded, "source harness control excluded") };
}

export async function deleteImportedSourceData(harness: string): Promise<DeleteImportedSourceReceipt> {
  if (safeHarnessLabel(harness) !== harness || harness === "generic") throw new Error("source harness is not supported");
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { status: "deleted", harness, facts: 0, sessions: 0, source_files: 0, trust_observations: 0, route_evidence: 0, session_excerpts: 0 };
  const root = record(await handler("delete_imported_source_data", { harness }), "delete source data receipt");
  if (root.status !== "deleted" || root.harness !== harness) throw new Error("delete source data receipt was not confirmed");
  return { status: "deleted", harness, facts: boundedCount(root.facts, "deleted source facts", 100_000_000), sessions: boundedCount(root.sessions, "deleted source sessions", 10_000_000), source_files: boundedCount(root.source_files, "deleted source files", 1_000_000), trust_observations: boundedCount(root.trust_observations, "deleted trust observations", 10_000_000), route_evidence: boundedCount(root.route_evidence, "deleted route evidence", 10_000_000), session_excerpts: boundedCount(root.session_excerpts, "deleted session excerpts", 10_000_000) };
}

export async function readCustomSourceConfig(): Promise<CustomSourceReport> {
  const fallback = { status: "ok", sources: [] };
  const fallbackLocations = { "claude-code": "~/.claude/projects", codex: "~/.codex/sessions", dsh: "~/.deepseek/sessions" };
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return parseCustomSourceReport(fallback, fallbackLocations);
  try {
    const [roots, locations] = await Promise.allSettled([
      handler("custom_source_roots"),
      handler("source_read_locations"),
    ]);
    if (roots.status === "rejected") throw new Error("自定义来源配置读取失败");
    let locationValue: unknown = {};
    if (locations.status === "fulfilled") {
      const locationRoot = record(locations.value, "source read locations response");
      if (locationRoot.status === "ok") locationValue = locationRoot.locations ?? {};
    }
    return parseCustomSourceReport(roots.value, locationValue);
  } catch {
    throw new Error("自定义来源配置读取失败");
  }
}

export async function readBudgetSettings(): Promise<BudgetSettingsReport> {
  const month = currentBudgetMonth((await readStatisticsTimezone()).timezone);
  const fallbackProfiles = {
    status: "ok", month, profiles: [{
      profile_id: "estimate", currency: "CNY", monthly_minor: 20000, daily_minor: null, warning_ratio_bp: 8000,
      spent_minor: 864, total_spent_minor: 864, ratio_bp: 432, level: "ok", has_unresolved: false,
      daily_spent_minor: 0, daily_total_minor: 0, daily_ratio_bp: null, daily_level: "disabled", updated_at_ms: Date.now(), subscription_amortized_minor: 0, subscription_skipped: false,
    }],
  };
  const fallbackLegacy = { status: "ok", monthly_cny_minor: 10000, daily_cny_minor: 500, warning_ratio_bp: 8000, origin: "legacy_import" };
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { status: "ok", month, estimate: parseBudgetProfiles(fallbackProfiles).profiles[0] ?? null, confirmed: null, legacy: parseLegacyBudget(fallbackLegacy), snoozed_until_ms: null };
  const [legacyResult, profilesResult, overviewResult] = await Promise.allSettled([
    handler("budget_config"),
    handler("budget_profiles_status", { month }),
    handler("read_overview"),
  ]);
  let legacy: BudgetSettingsReport["legacy"] = null;
  let profiles: { status: "ok" | "unavailable"; month: string | null; profiles: BudgetProfile[] } = { status: "unavailable", month: null, profiles: [] };
  try {
    if (legacyResult.status === "fulfilled") legacy = parseLegacyBudget(legacyResult.value);
    if (profilesResult.status === "fulfilled") profiles = parseBudgetProfiles(profilesResult.value);
  } catch {
    throw new Error("预算状态读取失败");
  }
  if (legacyResult.status === "rejected" && profilesResult.status === "rejected") throw new Error("预算状态读取失败");
  let snoozedUntil: number | null = null;
  if (overviewResult.status === "fulfilled") {
    const root = record(overviewResult.value, "budget overview");
    const budget = root.budget == null ? {} : record(root.budget, "budget overview row");
    snoozedUntil = snoozeTimestamp(budget.snoozed_until);
  }
  return {
    status: profiles.status === "ok" || legacy !== null ? "ok" : "unavailable",
    month: profiles.month ?? month,
    estimate: profiles.profiles.find((profile) => profile.profile_id === "estimate") ?? null,
    confirmed: profiles.profiles.find((profile) => profile.profile_id === "confirmed") ?? null,
    legacy,
    snoozed_until_ms: snoozedUntil,
  };
}

export async function saveBudgetProfile(input: { currency: "CNY" | "USD"; monthly_minor: number; daily_minor: number | null }): Promise<BudgetSaveReceipt> {
  if (input.currency !== "CNY" && input.currency !== "USD") throw new Error("预算币种不受支持");
  if (!Number.isSafeInteger(input.monthly_minor) || input.monthly_minor <= 0 || input.monthly_minor > Number.MAX_SAFE_INTEGER) throw new Error("月预算必须为正数");
  if (input.daily_minor !== null && (!Number.isSafeInteger(input.daily_minor) || input.daily_minor <= 0 || input.daily_minor > Number.MAX_SAFE_INTEGER)) throw new Error("日预算必须为正数或留空");
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { status: "saved", profile_id: "estimate", currency: input.currency, notification_permission: "granted" };
  try {
    return parseBudgetSaveReceipt(await handler("save_budget_profile", { input: { profile_id: "estimate", currency: input.currency, monthly_minor: input.monthly_minor, daily_minor: input.daily_minor, warning_ratio_bp: 8000 } }));
  } catch {
    throw new Error("预算保存失败，请稍后重试");
  }
}

export async function disableBudgetProfile(): Promise<BudgetDisableReceipt> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { status: "disabled", profile_id: "estimate", changed: true };
  try { return parseBudgetDisableReceipt(await handler("disable_budget_profile")); }
  catch { throw new Error("预算停用失败，请稍后重试"); }
}

export async function readQuotaReminderConfig(): Promise<QuotaReminderConfig> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { status: "ok", enabled: false, notification_permission: null };
  return parseQuotaReminderConfig(await handler("quota_reminder_config"));
}

export async function saveQuotaReminderConfig(enabled: boolean): Promise<QuotaReminderReceipt> {
  if (typeof enabled !== "boolean") throw new Error("额度提醒开关参数不安全");
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { status: "saved", enabled, notification_permission: "granted" };
  return parseQuotaReminderReceipt(await handler("save_quota_reminder_config", { enabled }));
}

export async function snoozeBudgetCurrentPeriod(): Promise<number | null> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return Date.now() + 7 * 86_400_000;
  try {
    const root = record(await handler("snooze_budget_current_period"), "budget snooze receipt");
    if (root.status !== "snoozed" && root.status !== "ok") throw new Error("budget snooze not confirmed");
    return snoozeTimestamp(root.until_ms);
  } catch {
    throw new Error("本周期静默失败");
  }
}

export async function clearBudgetSnooze(): Promise<void> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return;
  try {
    const root = record(await handler("clear_budget_snooze"), "budget clear snooze receipt");
    if (root.status !== "cleared" && root.status !== "ok") throw new Error("budget clear not confirmed");
  } catch {
    throw new Error("恢复预算提醒失败");
  }
}

function safeBillingPeriod(value: unknown, label: string, nullable = false): string | null {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  const text = stringField(value, label);
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) return text;
  return safeDate(text, label);
}

function parseBillingAmount(value: unknown): BillingAmount {
  const row = record(value, "billing amount");
  return {
    amount_minor: boundedCount(row.amount_minor, "billing amount", Number.MAX_SAFE_INTEGER),
    currency: billingCurrency(row.currency),
    basis: billingBasis(row.basis),
  };
}

function billingCurrency(value: unknown): string {
  const currency = stringField(value, "billing currency");
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("billing currency 不安全");
  return currency;
}

function billingBasis(value: unknown): string {
  const basis = stringField(value, "billing basis");
  return ["metered_actual", "metered_estimate", "fixed_subscription", "harness_billed", "api_equivalent", "other"].includes(basis) ? basis : "unknown";
}

function parseBillingCandidate(value: unknown): BillingCandidate {
  const row = record(value, "billing candidate");
  const rawStatus = typeof row.status === "string" ? row.status : "unknown";
  const status = (["pending", "accepted", "dismissed"] as const).includes(rawStatus as never) ? rawStatus as BillingCandidate["status"] : "unknown";
  const impact = row.impact == null || record(row.impact, "billing candidate impact").status !== "ok" ? null : (() => {
    const data = record(row.impact, "billing candidate impact");
    return { total_tokens: boundedCount(data.total_tokens ?? 0, "candidate impact tokens", Number.MAX_SAFE_INTEGER), fact_count: boundedCount(data.fact_count ?? 0, "candidate impact facts", Number.MAX_SAFE_INTEGER), session_count: boundedCount(data.session_count ?? 0, "candidate impact sessions", Number.MAX_SAFE_INTEGER) };
  })();
  return {
    candidate_id: decisionLabel(row.candidate_id, "billing candidate id"), harness: safeHarnessLabel(row.harness), provider_id: decisionLabel(row.provider_id, "billing candidate provider"),
    currency: billingCurrency(row.currency), amount_minor: boundedCount(row.amount_minor, "billing candidate amount", Number.MAX_SAFE_INTEGER),
    billing_period_start: safeDate(row.billing_period_start, "billing candidate start") as string,
    status, impact,
  };
}

function parseBillingCandidateReceipt(value: unknown): BillingCandidateReceipt {
  const root = record(value, "billing candidate receipt");
  if (root.status !== "dismissed" && root.status !== "pending") throw new Error("计费候选处置未确认");
  return { status: root.status, changed: root.changed === true };
}

function parseBillingImpactBucket(value: unknown, label: string): BillingImpactBucket {
  const row = record(value, label);
  return {
    fact_count: boundedCount(row.fact_count ?? 0, `${label} facts`, Number.MAX_SAFE_INTEGER),
    session_count: boundedCount(row.session_count ?? 0, `${label} sessions`, Number.MAX_SAFE_INTEGER),
    tokens: boundedCount(row.tokens ?? 0, `${label} tokens`, Number.MAX_SAFE_INTEGER),
    unpriced_tokens: boundedCount(row.unpriced_tokens ?? 0, `${label} unpriced`, Number.MAX_SAFE_INTEGER),
    amounts: requiredArray(row.amounts ?? [], `${label} amounts`).slice(0, 16).map(parseBillingAmount),
  };
}

function parseBillingImpactPreview(value: unknown): BillingImpactPreview {
  const root = record(value, "billing impact preview");
  if (root.status === "unavailable") throw new Error("计费影响预览暂不可用");
  if (root.status !== "ok") throw new Error("计费影响预览状态不兼容");
  const kept = record(root.kept ?? {}, "billing impact kept");
  const pending = record(root.pending ?? {}, "billing impact pending");
  return {
    status: "ok",
    relationship_kind: decisionLabel(root.relationship_kind ?? "unknown", "billing impact relationship"),
    effective_start: root.effective_start == null ? null : safeDate(root.effective_start, "billing impact start"),
    effective_end: root.effective_end == null ? null : safeDate(root.effective_end, "billing impact end"),
    changes_amounts: root.changes_amounts === true,
    moved: parseBillingImpactBucket(root.moved ?? {}, "billing impact moved"),
    kept: { tokens: boundedCount(kept.tokens ?? 0, "billing impact kept tokens", Number.MAX_SAFE_INTEGER), unpriced_tokens: boundedCount(kept.unpriced_tokens ?? 0, "billing impact kept unpriced", Number.MAX_SAFE_INTEGER), amounts: requiredArray(kept.amounts ?? [], "billing impact kept amounts").slice(0, 16).map(parseBillingAmount) },
    pending: { fact_count: boundedCount(pending.fact_count ?? 0, "billing impact pending facts", Number.MAX_SAFE_INTEGER), tokens: boundedCount(pending.tokens ?? 0, "billing impact pending tokens", Number.MAX_SAFE_INTEGER), reasons: requiredArray(pending.reasons ?? [], "billing impact pending reasons").slice(0, 16).map((item) => decisionLabel(item, "billing impact reason")) },
    first_event_ts_ms: nullableTimestampMs(root.first_event_ts_ms, "billing impact first event"),
    last_event_ts_ms: nullableTimestampMs(root.last_event_ts_ms, "billing impact last event"),
  };
}

function parseBillingDeclarationReceipt(value: unknown): BillingDeclarationReceipt {
  const root = record(value, "billing declaration receipt");
  if (root.status !== "saved") throw new Error("计费声明保存未确认");
  const job = root.job == null ? null : (() => {
    const row = record(root.job, "billing declaration job");
    if (row.status !== "queued" && row.status !== "enqueue_failed") throw new Error("计费重算回执状态不兼容");
    return { job_id: decisionLabel(row.job_id, "billing job id"), status: row.status as "queued" | "enqueue_failed", changed: row.changed === true };
  })();
  return { status: "saved", declaration_id: decisionLabel(root.declaration_id, "billing declaration id"), revision_id: decisionLabel(root.revision_id, "billing revision id"), changed: root.changed === true, job };
}

function parseBillingDeclarationRevokeReceipt(value: unknown): BillingDeclarationRevokeReceipt {
  const root = record(value, "billing declaration revoke receipt");
  if (root.status !== "revoked") throw new Error("计费声明撤销未确认");
  return { status: "revoked", declaration_id: decisionLabel(root.declaration_id, "billing declaration id"), revision_id: decisionLabel(root.revision_id, "billing revision id"), changed: root.changed === true };
}

function validateBillingScopes(scopes: BillingScope[]): void {
  if (scopes.length > 128 || scopes.some((scope) => !["account", "route", "model", "session", "provider", "settlement"].includes(scope.scope_kind) || !scope.scope_value || scope.scope_value.length > 256)) throw new Error("计费声明范围不安全");
}

function validateBillingCandidateReference(value: string | null | undefined): void {
  if (value !== null && value !== undefined && !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw new Error("计费候选引用不安全");
}

function parseBillingGroup(value: unknown): BillingGroup {
  const row = record(value, "billing group");
  const amounts = requiredArray(row.estimated_amounts ?? [], "billing group amounts");
  if (amounts.length > 16) throw new Error("billing group amounts 超出上限");
  const unresolved = boundedCount(row.unpriced_tokens ?? 0, "billing group unpriced tokens", Number.MAX_SAFE_INTEGER) > 0 || typeof row.unresolved_reason === "string";
  const verdict = row.auto_verdict == null ? null : record(row.auto_verdict, "billing group verdict");
  const verdictState = verdict?.state;
  const evidenceState = unresolved ? "unresolved" : verdictState === "determined" ? "determined" : verdictState === "one_question" || verdictState === "needs_input" ? "needs_input" : "unknown";
  return {
    group_id: decisionLabel(row.group_id, "billing group id"), harness: safeHarnessLabel(row.harness), provider_id: decisionLabel(row.provider_id, "billing group provider"), model_id: row.model_id == null ? "<unknown>" : decisionLabel(row.model_id, "billing group model"),
    evidence_basis: decisionLabel(row.evidence_basis ?? "unknown", "billing evidence basis"), pricing_basis: decisionLabel(row.pricing_basis ?? "unknown", "billing pricing basis"),
    tokens: boundedCount(row.tokens ?? 0, "billing group tokens", Number.MAX_SAFE_INTEGER), session_count: boundedCount(row.session_count ?? 0, "billing group sessions", Number.MAX_SAFE_INTEGER),
    effective_start: safeBillingPeriod(row.effective_start, "billing group start") as string, effective_end: safeBillingPeriod(row.effective_end, "billing group end", true),
    estimated_amounts: amounts.map(parseBillingAmount), unpriced_tokens: boundedCount(row.unpriced_tokens ?? 0, "billing group unpriced", Number.MAX_SAFE_INTEGER), unresolved_reason: row.unresolved_reason == null ? null : "部分用量尚未完成计价",
    evidence_state: evidenceState,
  };
}

function parseBillingDeclaration(value: unknown): BillingDeclaration {
  const row = record(value, "billing declaration");
  const scopes = requiredArray(row.scopes ?? [], "billing declaration scopes").slice(0, 128).map((item) => {
    const scope = record(item, "billing declaration scope");
    if (!["account", "route", "model", "session", "provider", "settlement"].includes(String(scope.scope_kind))) throw new Error("billing declaration scope kind 不受支持");
    return { scope_kind: scope.scope_kind as BillingScope["scope_kind"], scope_value: decisionLabel(scope.scope_value, "billing declaration scope value") };
  });
  return {
    declaration_id: decisionLabel(row.declaration_id, "billing declaration id"), provider_id: decisionLabel(row.provider_id, "billing declaration provider"), relationship_kind: decisionLabel(row.relationship_kind, "billing relationship"),
    subscription_name: row.subscription_name == null ? null : decisionLabel(row.subscription_name, "billing subscription name"), amount_minor: row.amount_minor == null ? null : boundedCount(row.amount_minor, "billing declaration amount", Number.MAX_SAFE_INTEGER), currency: row.currency == null ? null : billingCurrency(row.currency),
    effective_start: safeDate(row.effective_start, "billing declaration start"), effective_end: row.effective_end == null ? null : safeDate(row.effective_end, "billing declaration end"), current_revision_id: row.current_revision_id == null ? null : decisionLabel(row.current_revision_id, "billing revision id"), source_candidate_id: row.source_candidate_id == null ? null : decisionLabel(row.source_candidate_id, "billing candidate id"), scopes, scope_count: scopes.length,
  };
}

function parseBillingJob(value: unknown): BillingJob {
  const row = record(value, "billing job");
  const rawStatus = typeof row.status === "string" ? row.status : "unknown";
  const allowed = ["queued", "running", "failed", "cancelled", "succeeded"] as const;
  const status = (allowed as readonly string[]).includes(rawStatus) ? rawStatus as BillingJob["status"] : "unknown";
  return { job_id: decisionLabel(row.job_id, "billing job id"), status, error_code: row.error_code == null ? null : "重算失败，请重试", requested_at_ms: nullableTimestampMs(row.requested_at_ms, "billing job requested") };
}

function parseBillingJobRetryReceipt(value: unknown): BillingJobRetryReceipt {
  const root = record(value, "billing job retry receipt");
  if (root.status !== "queued") throw new Error("重算重试未入队");
  return { status: "queued", job_id: decisionLabel(root.job_id, "billing job id"), changed: root.changed === true };
}

function parseHarnessBill(value: unknown, billingPeriod: string): HarnessBill {
  const row = record(value, "harness bill");
  return { bill_id: decisionLabel(row.bill_id, "bill id"), harness: safeHarnessLabel(row.harness), provider_id: decisionLabel(row.provider_id, "bill provider"), billing_period: row.billing_period == null ? billingPeriod : safeMonth(row.billing_period, "bill period"), billing_basis: billingBasis(row.billing_basis ?? "unknown"), amount_minor: boundedCount(row.amount_minor, "bill amount", Number.MAX_SAFE_INTEGER), currency: billingCurrency(row.currency), has_evidence: typeof row.evidence_ref === "string" && row.evidence_ref.length > 0 };
}

function parseBillingList(value: unknown, key: string): { status: "ok" | "unavailable"; items: unknown[] } {
  const root = record(value, `billing ${key}`);
  if (root.status === "unavailable") return { status: "unavailable", items: [] };
  if (root.status !== "ok") throw new Error(`billing ${key} status 不兼容`);
  const items = requiredArray(root[key], `billing ${key}`);
  if (items.length > 512) throw new Error(`billing ${key} 超出上限`);
  return { status: "ok", items };
}

export async function readBillingSettings(): Promise<BillingSettingsReport> {
  const month = currentBudgetMonth((await readStatisticsTimezone()).timezone);
  const handler = globalTauri()?.core?.invoke;
  if (!handler) {
    return { status: "ok", month, candidates_status: "ok", groups_status: "ok", declarations_status: "ok", jobs_status: "ok", bills_status: "ok", candidates: [parseBillingCandidate({ candidate_id: "browser-candidate-1", harness: "codex", provider_id: "openai", currency: "USD", amount_minor: 2000, billing_period_start: `${month}-01`, status: "pending", impact: { status: "ok", total_tokens: 18000, fact_count: 4, session_count: 1 } })], groups: [], declarations: [], jobs: [], bills: [] };
  }
  const results = await Promise.allSettled([
    handler("billing_import_candidates"), handler("billing_confirmation_groups", { month }), handler("billing_declarations"), handler("billing_recalculation_jobs"), handler("harness_bills_for_period", { billingPeriod: month }),
  ]);
  const parse = <T,>(index: number, key: string, mapper: (item: unknown) => T): { status: BillingPanelStatus; items: T[] } => {
    const result = results[index];
    if (result.status === "rejected") return { status: "unavailable", items: [] };
    let list: { status: "ok" | "unavailable"; items: unknown[] };
    try { list = parseBillingList(result.value, key); } catch { return { status: "unavailable", items: [] }; }
    if (list.status === "unavailable") return { status: "unavailable", items: [] };
    const items: T[] = [];
    let rejected = 0;
    for (const item of list.items) {
      try { items.push(mapper(item)); } catch { rejected += 1; }
    }
    return { status: rejected === 0 ? "ok" : items.length ? "partial" : "unavailable", items };
  };
  const candidates = parse(0, "candidates", parseBillingCandidate);
  const groups = parse(1, "groups", parseBillingGroup);
  const declarations = parse(2, "declarations", parseBillingDeclaration);
  const jobs = parse(3, "jobs", parseBillingJob);
  const bills = parse(4, "bills", (item) => parseHarnessBill(item, month));
  const pendingUnavailable = candidates.status === "unavailable" && groups.status === "unavailable";
  return { status: pendingUnavailable ? "unavailable" : "ok", month, candidates_status: candidates.status, groups_status: groups.status, declarations_status: declarations.status, jobs_status: jobs.status, bills_status: bills.status, candidates: candidates.items, groups: groups.items, declarations: declarations.items, jobs: jobs.items, bills: bills.items };
}

export async function resolveBillingImportCandidate(candidateId: string, decision: "dismiss" | "reopen"): Promise<BillingCandidateReceipt> {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(candidateId)) throw new Error("计费候选引用不安全");
  if (decision !== "dismiss" && decision !== "reopen") throw new Error("计费候选处置不受支持");
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { status: decision === "dismiss" ? "dismissed" : "pending", changed: true };
  return parseBillingCandidateReceipt(await handler("resolve_billing_import_candidate", { candidateId, decision }));
}

export async function retryBillingRecalculation(jobId: string): Promise<BillingJobRetryReceipt> {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(jobId)) throw new Error("重算任务引用不安全");
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { status: "queued", job_id: jobId, changed: true };
  return parseBillingJobRetryReceipt(await handler("retry_billing_recalculation", { jobId }));
}

export async function previewBillingDeclaration(input: { provider_id: string; relationship_kind: "official_api" | "third_party" | "organization"; effective_start: string; effective_end: string | null; scopes: BillingScope[] }): Promise<BillingImpactPreview> {
  decisionLabel(input.provider_id, "计费声明服务商");
  if (!/^(?:official_api|third_party|organization)$/.test(input.relationship_kind)) throw new Error("计费声明关系不受支持");
  if (!/^\d{4}-\d{2}(?:-\d{2})?$/.test(input.effective_start) || (input.effective_end !== null && !/^\d{4}-\d{2}(?:-\d{2})?$/.test(input.effective_end))) throw new Error("计费声明日期格式不安全");
  validateBillingScopes(input.scopes);
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return parseBillingImpactPreview({ status: "ok", relationship_kind: input.relationship_kind, effective_start: input.effective_start, effective_end: input.effective_end, changes_amounts: false, moved: { fact_count: 0, session_count: 0, tokens: 0, unpriced_tokens: 0, amounts: [] }, kept: { tokens: 0, unpriced_tokens: 0, amounts: [] }, pending: { fact_count: 0, tokens: 0, reasons: [] }, first_event_ts_ms: null, last_event_ts_ms: null });
  return parseBillingImpactPreview(await handler("billing_candidate_impact_preview", { providerId: input.provider_id, relationshipKind: input.relationship_kind, effectiveStart: input.effective_start, effectiveEnd: input.effective_end, scopes: input.scopes }));
}

export async function saveBillingDeclaration(input: { revision_id: string; declaration_id: string; provider_id: string; relationship_kind: "official_api" | "third_party" | "organization"; effective_start: string; effective_end: string | null; source_candidate_id?: string | null; evidence_ref: string; scopes: BillingScope[] }): Promise<BillingDeclarationReceipt> {
  if (![input.revision_id, input.declaration_id].every((value) => /^[A-Za-z0-9_.:-]{1,128}$/.test(value))) throw new Error("计费声明引用不安全");
  decisionLabel(input.provider_id, "计费声明服务商");
  if (!/^(?:official_api|third_party|organization)$/.test(input.relationship_kind)) throw new Error("计费声明关系不受支持");
  if (!/^\d{4}-\d{2}(?:-\d{2})?$/.test(input.effective_start) || (input.effective_end !== null && !/^\d{4}-\d{2}(?:-\d{2})?$/.test(input.effective_end))) throw new Error("计费声明日期格式不安全");
  if (!input.evidence_ref || input.evidence_ref.length > 512) throw new Error("计费声明证据引用不安全");
  validateBillingScopes(input.scopes);
  validateBillingCandidateReference(input.source_candidate_id);
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { status: "saved", declaration_id: input.declaration_id, revision_id: input.revision_id, changed: true, job: null };
  return parseBillingDeclarationReceipt(await handler("save_billing_declaration_revision", { revisionId: input.revision_id, declarationId: input.declaration_id, supersedesRevisionId: null, providerId: input.provider_id, relationshipKind: input.relationship_kind, subscriptionName: null, amountMinor: null, currency: null, effectiveStart: input.effective_start, effectiveEnd: input.effective_end, sourceCandidateId: input.source_candidate_id ?? null, evidenceRef: input.evidence_ref, scopes: input.scopes }));
}

export async function amendBillingDeclaration(input: { declaration_id: string; supersedes_revision_id: string; provider_id: string; subscription_name: string | null; amount_minor: number | null; currency: string | null; effective_start: string; effective_end: string | null; source_candidate_id: string | null; scopes: BillingScope[] }): Promise<BillingDeclarationReceipt> {
  if (![input.declaration_id, input.supersedes_revision_id].every((value) => /^[A-Za-z0-9_.:-]{1,128}$/.test(value))) throw new Error("计费声明修订引用不安全");
  decisionLabel(input.provider_id, "计费声明服务商");
  safeDate(input.effective_start, "计费声明起始日");
  if (input.effective_end !== null) safeDate(input.effective_end, "计费声明结束日");
  if (input.subscription_name !== null && (input.subscription_name.length > 256 || /[\u0000-\u001f\u007f]/u.test(input.subscription_name))) throw new Error("套餐名不安全");
  if (input.amount_minor !== null && (!Number.isSafeInteger(input.amount_minor) || input.amount_minor < 0)) throw new Error("月费必须为非负整数分");
  if ((input.amount_minor === null) !== (input.currency === null)) throw new Error("月费和币种必须同时填写或同时留空");
  if (input.currency !== null) billingCurrency(input.currency);
  validateBillingCandidateReference(input.source_candidate_id);
  validateBillingScopes(input.scopes);
  const handler = globalTauri()?.core?.invoke;
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = { revisionId: `rev-amend-${suffix}`, declarationId: input.declaration_id, supersedesRevisionId: input.supersedes_revision_id, providerId: input.provider_id, relationshipKind: "official_subscription", subscriptionName: input.subscription_name, amountMinor: input.amount_minor, currency: input.currency, effectiveStart: input.effective_start, effectiveEnd: input.effective_end, sourceCandidateId: input.source_candidate_id, evidenceRef: `amend:${input.supersedes_revision_id}`, scopes: input.scopes };
  if (!handler) return { status: "saved", declaration_id: input.declaration_id, revision_id: payload.revisionId, changed: true, job: null };
  return parseBillingDeclarationReceipt(await handler("save_billing_declaration_revision", payload));
}

export async function revokeBillingDeclaration(input: { declaration_id: string; supersedes_revision_id: string }): Promise<BillingDeclarationRevokeReceipt> {
  if (![input.declaration_id, input.supersedes_revision_id].every((value) => /^[A-Za-z0-9_.:-]{1,128}$/.test(value))) throw new Error("计费声明修订引用不安全");
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { status: "revoked", declaration_id: input.declaration_id, revision_id: `revoked-${input.supersedes_revision_id}`, changed: true };
  const revisionId = `rev-revoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return parseBillingDeclarationRevokeReceipt(await handler("revoke_billing_declaration", { revisionId, declarationId: input.declaration_id, supersedesRevisionId: input.supersedes_revision_id }));
}

function validateCustomSourceInput(harness: string, root: string): void {
  if (!["claude-code", "codex", "dsh"].includes(harness)) throw new Error("该工具暂不支持自定义位置");
  if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(root) || root.length > 4096 || /[\u0000-\u001f\u007f]/u.test(root)) throw new Error("请输入绝对目录路径");
}

export async function pickCustomSourceRoot(): Promise<string | null> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return "/tmp/agent-vitals-browser-custom-source";
  try {
    const value = await handler("pick_custom_source_root");
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") throw new Error("目录选择回执无效");
    validateCustomSourceInput("codex", value);
    return value;
  } catch {
    throw new Error("无法打开目录选择");
  }
}

export async function addCustomSourceRoot(harness: string, root: string): Promise<{ changed: boolean }> {
  validateCustomSourceInput(harness, root);
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { changed: true };
  try {
    const value = record(await handler("add_custom_source_root", { input: { harness, root } }), "custom source add result");
    return { changed: requiredBoolean(value.changed, "custom source add changed") };
  } catch {
    throw new Error("添加读取位置失败，请确认目录存在且可读取");
  }
}

export async function removeCustomSourceRoot(harness: string, root: string): Promise<{ changed: boolean }> {
  validateCustomSourceInput(harness, root);
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { changed: true };
  try {
    const value = record(await handler("remove_custom_source_root", { input: { harness, root } }), "custom source remove result");
    return { changed: requiredBoolean(value.changed, "custom source remove changed") };
  } catch {
    throw new Error("移除读取位置失败");
  }
}

export async function triggerSync(): Promise<string> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return "browser-mock-sync";
  try {
    const value = await handler("trigger_sync");
    if (typeof value !== "string" || (value !== "browser-mock-sync" && !/^sync-[A-Za-z0-9_-]{1,64}$/.test(value))) throw new Error("同步请求回执无效");
    return value;
  } catch {
    throw new Error("同步请求未能发起");
  }
}

export async function readSyncRequestStatus(requestId: string): Promise<SyncRequestStatus> {
  if (!/^sync-[A-Za-z0-9_-]{1,64}$/.test(requestId) && requestId !== "browser-mock-sync") throw new Error("同步请求引用无效");
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return { completed: true, failed: false };
  try {
    const value = record(await handler("sync_request_status", { requestId }), "sync request status");
    const error = value.error;
    if (error !== undefined && error !== "unknown_request") throw new Error("同步状态返回未知错误");
    return { completed: requiredBoolean(value.completed, "sync request completed"), failed: error === "unknown_request" };
  } catch {
    throw new Error("同步状态读取失败");
  }
}

export async function setSyncPaused(paused: boolean): Promise<boolean> {
  const handler = globalTauri()?.core?.invoke;
  if (!handler) return paused;
  try {
    const value = record(await handler("set_sync_paused", { paused }), "sync pause result");
    return requiredBoolean(value.paused, "sync pause result");
  } catch {
    throw new Error("自动同步设置未保存");
  }
}

export async function listen(event: string, handler: (payload: unknown) => void): Promise<Unsubscribe> {
  const listener = globalTauri()?.event?.listen;
  if (event !== "source-data-deleted") {
    if (!listener) return () => undefined;
    return listener(event, handler);
  }
  const windowHandler = () => handler({ source: "revision-poll" });
  window.addEventListener("agent-vitals-source-data-deleted", windowHandler);
  if (!listener) return () => window.removeEventListener("agent-vitals-source-data-deleted", windowHandler);
  const unsubscribeTauri = await listener(event, handler);
  return () => {
    window.removeEventListener("agent-vitals-source-data-deleted", windowHandler);
    unsubscribeTauri();
  };
}

const appEventTypes = new Set<AppEventType>(["Invalidated", "SyncStatusChanged", "HarnessNavigationChanged", "TrustMonitorEvent", "TrustMonitorInvalidated", "SourceDataDeleted", "WatcherHealthChanged"]);

/** Closed harness vocabulary for `Invalidated.harnesses` (unknown names are dropped). */
const invalidationHarnesses: ReadonlySet<string> = new Set(["claude-code", "codex", "dsh", "workbuddy"]);

function safeAppEvent(raw: unknown): AppEvent | null {
  const candidate = raw && typeof raw === "object" && "payload" in raw
    ? (raw as { payload?: unknown }).payload
    : raw;
  if (!candidate || typeof candidate !== "object") return null;
  const type = (candidate as { type?: unknown }).type;
  if (typeof type !== "string" || !appEventTypes.has(type as AppEventType)) return null;
  if (type !== "Invalidated") return { type: type as AppEventType };
  const record = candidate as Record<string, unknown>;
  const rawRevision = record.revision;
  const revision = typeof rawRevision === "number" && Number.isFinite(rawRevision) && rawRevision >= 0 && rawRevision <= Number.MAX_SAFE_INTEGER
    ? Math.floor(rawRevision)
    : undefined;
  const harnesses = Array.isArray(record.harnesses)
    ? record.harnesses.filter((h): h is string => typeof h === "string" && invalidationHarnesses.has(h))
    : [];
  return revision === undefined ? { type: "Invalidated", harnesses } : { type: "Invalidated", revision, harnesses };
}

/** Subscribe to the single desktop event bus and expose only its allowlisted type. */
export async function listenAppEvents(handler: (event: AppEvent) => void): Promise<Unsubscribe> {
  const listener = globalTauri()?.event?.listen;
  // R1：5s 轮询合成的窗口事件带 detail.revision（App.tsx dispatch 的 CustomEvent），
  // 让 gate 能按水位吞掉与 Invalidated 同 revision 的重复刷新；无 detail 的
  // 旧派发保持无 revision 语义（gate 保守放行）。
  const windowHandler = (raw?: Event) => {
    const detail = raw ? (raw as CustomEvent<{ revision?: unknown }>).detail : undefined;
    const rawRevision = detail && typeof detail === "object" ? detail.revision : undefined;
    const revision = typeof rawRevision === "number" && Number.isFinite(rawRevision) && rawRevision >= 0 && rawRevision <= Number.MAX_SAFE_INTEGER
      ? Math.floor(rawRevision)
      : undefined;
    handler(revision === undefined ? { type: "SourceDataDeleted" } : { type: "SourceDataDeleted", revision });
  };
  window.addEventListener("agent-vitals-source-data-deleted", windowHandler);
  if (!listener) return () => window.removeEventListener("agent-vitals-source-data-deleted", windowHandler);
  let unsubscribeTauri: Unsubscribe = () => undefined;
  try {
    unsubscribeTauri = await listener("app-event", (raw) => {
      const event = safeAppEvent(raw);
      if (event) handler(event);
    });
  } catch {
    // A desktop event bridge can be unavailable during webview teardown or an
    // old app/CLI combination. Keep the revision-poll fallback, but make its
    // cleanup explicit instead of leaking a window listener or rejecting an
    // otherwise safe page refresh.
  }
  return () => {
    window.removeEventListener("agent-vitals-source-data-deleted", windowHandler);
    unsubscribeTauri();
  };
}


/** watcher 健康的有界 DTO（HARDENING spec §5.6）：闭集枚举 + 计数，无路径。 */
export type WatcherHealthStatus = {
  mode: "active" | "degraded" | "disabled" | "unavailable";
  reasonCode: string | null;
  topologyRevision: number;
  pendingRoots: number;
};

const watcherModes: ReadonlySet<WatcherHealthStatus["mode"]> = new Set(["active", "degraded", "disabled", "unavailable"]);

/** 原因码闭集（HARDENING spec §5.5 允许的 10 个：`root_attach_failed` 与
 * `throttled` 都是 2026-09-22 同日两条独立分支各自补的）——枚举值与 mode
 * 同纪律：未知一律拒为 null（spec §5.6「reject unrecognized enum values」）。
 * `throttled` 与其余 9 个不同的是：它可能与 `mode: "active"` 共存（watcher
 * 后端本身没坏，只是 CPU 持续过高把同步冷却拉长了，REVIEW P4 自看护）——UI
 * 文案不能假设 reason_code 非空就等于 watcher 故障。 */
const watcherReasonCodes: ReadonlySet<string> = new Set([
  "feature_disabled", "no_roots", "home_unavailable", "backend_init_failed",
  "root_pending", "root_permission_denied", "root_attach_failed", "worker_terminated",
  "topology_rejected", "throttled",
]);

/** 闭集校验 + 数值限幅：未知枚举/越界计数一律拒绝为 null（degrade，不穿墙）。 */
export function parseWatcherHealth(raw: unknown): WatcherHealthStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  const mode = candidate.mode;
  if (typeof mode !== "string" || !watcherModes.has(mode as WatcherHealthStatus["mode"])) return null;
  const rawReason = candidate.reason_code;
  const reasonCode = typeof rawReason === "string" && watcherReasonCodes.has(rawReason) ? rawReason : null;
  const bounded = (value: unknown, max: number): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? Math.floor(value) : 0;
  return {
    mode: mode as WatcherHealthStatus["mode"],
    reasonCode,
    topologyRevision: bounded(candidate.topology_revision, 1_000_000_000),
    pendingRoots: bounded(candidate.pending_roots, 1_000_000),
  };
}

/** 读 watcher 健康（命令不可用/旧进程 = null，页面按「不可判定」渲染）。 */
export async function fetchWatcherHealth(): Promise<WatcherHealthStatus | null> {
  try {
    return parseWatcherHealth(await invoke<unknown>("watcher_health"));
  } catch {
    return null;
  }
}


// ───────────────────── 汇率 V2（报告币种 + 参考汇率）─────────────────────
// 形状来源：src-tauri/src/lib.rs 的 fx_status / fx_convert_amounts（同一 PR 同改）。
// 账单层始终原币种；这里只是展示偏好与带出处的折算，折算不可用时界面回退原币种。

export type FxManualRate = { from: string; to: string; rate: number; as_of: string | null };
export type FxStatus = {
  reporting_currency: string;
  default_currency: string;
  reporting_currency_is_default: boolean;
  system_locale: string;
  rate_date: string;
  rate_age_days: number | null;
  rate_stale: boolean;
  rate_source: "bundled_snapshot" | "synced_snapshot";
  rate_fetched_at_ms: number | null;
  supported_currencies: string[];
  manual_rates: FxManualRate[];
};
export type FxConvertItem = { currency: string; amount: number; converted: number; rate: number; rate_source: "bundled_snapshot" | "user_assumption" | "identity"; rate_date: string | null };
export type FxConvertResult = { target: string; total: number; approximate: boolean; items: FxConvertItem[]; unavailable: Array<{ currency: string; amount: number }> };

const FX_CHANGED_EVENT = "agent-vitals-fx-changed";
export const onFxChanged = (listener: () => void): (() => void) => { window.addEventListener(FX_CHANGED_EVENT, listener); return () => window.removeEventListener(FX_CHANGED_EVENT, listener); };
const announceFxChanged = () => window.dispatchEvent(new Event(FX_CHANGED_EVENT));

function parseFxStatus(value: unknown): FxStatus {
  const root = record(value, "fx status");
  if (root.status !== "ok") throw new Error("fx status unavailable");
  const currencies = Array.isArray(root.supported_currencies) ? root.supported_currencies.filter((item): item is string => typeof item === "string") : [];
  const manual = (Array.isArray(root.manual_rates) ? root.manual_rates : []).map((row) => {
    const entry = record(row, "fx manual rate");
    if (typeof entry.rate !== "number" || !Number.isFinite(entry.rate) || entry.rate <= 0) throw new Error("fx manual rate invalid");
    return { from: stringField(entry.from, "fx from"), to: stringField(entry.to, "fx to"), rate: entry.rate, as_of: typeof entry.as_of === "string" ? entry.as_of : null };
  });
  return {
    reporting_currency: stringField(root.reporting_currency, "reporting currency"),
    default_currency: stringField(root.default_currency, "default currency"),
    reporting_currency_is_default: root.reporting_currency_is_default === true,
    system_locale: typeof root.system_locale === "string" ? root.system_locale : "",
    rate_date: stringField(root.rate_date, "fx rate date"),
    rate_age_days: typeof root.rate_age_days === "number" ? root.rate_age_days : null,
    rate_stale: root.rate_stale !== false,
    rate_source: root.rate_source === "synced_snapshot" ? "synced_snapshot" : "bundled_snapshot",
    rate_fetched_at_ms: typeof root.rate_fetched_at_ms === "number" ? root.rate_fetched_at_ms : null,
    supported_currencies: currencies,
    manual_rates: manual,
  };
}

export async function readFxStatus(): Promise<FxStatus | null> {
  if (!hasNativeBridge()) return null;
  return parseFxStatus(await invoke<unknown>("fx_status"));
}

export async function saveReportingCurrency(currency: string): Promise<void> {
  if (!hasNativeBridge()) return;
  const root = record(await invoke<unknown>("save_reporting_currency_config", { currency }), "save reporting currency");
  if (root.status !== "saved") throw new Error("reporting currency not saved");
  announceFxChanged();
}

export async function saveFxManualRate(from: string, to: string, rate: number, asOf: string | null): Promise<void> {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("rate must be a positive number");
  if (!hasNativeBridge()) return;
  await invoke("save_fx_manual_rate", { from, to, rate, asOf });
  announceFxChanged();
}

export async function removeFxManualRate(from: string, to: string): Promise<void> {
  if (!hasNativeBridge()) return;
  await invoke("remove_fx_manual_rate", { from, to });
  announceFxChanged();
}

/** `{币种: 金额}` → 报告币种的约数合计（后端按快照/手动汇率算，界面不自造汇率）。无桥接 → null。 */
export async function convertAmounts(amounts: Record<string, number>): Promise<FxConvertResult | null> {
  if (!hasNativeBridge()) return null;
  const root = record(await invoke<unknown>("fx_convert_amounts", { amounts }), "fx convert");
  if (root.status !== "ok" || typeof root.target !== "string" || typeof root.total !== "number" || !Number.isFinite(root.total)) throw new Error("fx convert unavailable");
  const items = (Array.isArray(root.items) ? root.items : []).map((row) => {
    const entry = record(row, "fx convert item");
    const source = entry.rate_source === "user_assumption" ? "user_assumption" : entry.rate_source === "identity" ? "identity" : "bundled_snapshot";
    const item = { currency: stringField(entry.currency, "fx currency"), amount: Number(entry.amount), converted: Number(entry.converted), rate: Number(entry.rate), rate_source: source as FxConvertItem["rate_source"], rate_date: typeof entry.rate_date === "string" ? entry.rate_date : null };
    if (![item.amount, item.converted, item.rate].every(Number.isFinite) || item.rate <= 0) throw new Error("fx convert item invalid");
    return item;
  });
  const unavailable = (Array.isArray(root.unavailable) ? root.unavailable : []).map((row) => { const entry = record(row, "fx unavailable"); return { currency: stringField(entry.currency, "fx currency"), amount: Number(entry.amount) }; });
  return { target: root.target, total: root.total, approximate: root.approximate === true, items, unavailable };
}


// ───────────────────── 补价卡（用户价卡覆盖层）─────────────────────
// 形状来源：src-tauri/src/lib.rs 的 price_cards / price_card_providers / save_price_card /
// delete_price_card / official_price_card（同一 PR 同改）。价格单位：每百万 token。

export type PriceCardRates = { off_peak: number; peak: number };
export type UserPriceCard = { provider: string; model: string; input_uncached: PriceCardRates; input_cached: PriceCardRates; output: PriceCardRates; cache_write: PriceCardRates | null };
export type PriceCardProvider = { id: string; currency: string | null; offered: string[] };

function parseRates(value: unknown, label: string): PriceCardRates {
  const row = record(value, label);
  const read = (key: string) => { const n = row[key]; if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error(`${label}.${key} invalid`); return n; };
  return { off_peak: read("off_peak"), peak: read("peak") };
}

export async function readUserPriceCards(): Promise<UserPriceCard[]> {
  if (!hasNativeBridge()) return [];
  const root = record(await invoke<unknown>("price_cards"), "price cards");
  if (root.status !== "ok") throw new Error("price cards unavailable");
  const out: UserPriceCard[] = [];
  for (const [provider, models] of Object.entries(record(root.cards ?? {}, "price cards by provider"))) {
    for (const [model, card] of Object.entries(record(models, "price cards by model"))) {
      const row = record(card, "price card");
      out.push({
        provider, model,
        input_uncached: parseRates(row.input_uncached, "input_uncached"), input_cached: parseRates(row.input_cached, "input_cached"), output: parseRates(row.output, "output"),
        cache_write: row.cache_write == null ? null : parseRates(row.cache_write, "cache_write"),
      });
    }
  }
  return out.sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`));
}

export async function readPriceCardProviders(): Promise<PriceCardProvider[]> {
  if (!hasNativeBridge()) return [];
  const root = record(await invoke<unknown>("price_card_providers"), "price card providers");
  if (root.status !== "ok" || !Array.isArray(root.providers)) throw new Error("price card providers unavailable");
  return root.providers.map((row) => { const entry = record(row, "price card provider"); return { id: stringField(entry.id, "provider id"), currency: typeof entry.currency === "string" ? entry.currency : null, offered: Array.isArray(entry.offered) ? entry.offered.filter((code): code is string => typeof code === "string") : [] }; });
}

export async function saveUserPriceCard(payload: Record<string, unknown>): Promise<void> {
  if (!hasNativeBridge()) return;
  const root = record(await invoke<unknown>("save_price_card", { input: payload }), "save price card");
  if (root.status !== "saved") throw new Error("price card not saved");
}

export async function deleteUserPriceCard(providerId: string, modelId: string): Promise<void> {
  if (!hasNativeBridge()) return;
  await invoke("delete_price_card", { providerId, modelId });
}

export type OfficialPriceCard = { found: true; currency: string; input_uncached: PriceCardRates; input_cached: PriceCardRates; output: PriceCardRates } | { found: false; reason: string | null };

export async function readOfficialPriceCard(providerId: string, modelId: string): Promise<OfficialPriceCard> {
  if (!hasNativeBridge()) return { found: false, reason: null };
  const root = record(await invoke<unknown>("official_price_card", { providerId, modelId }), "official price card");
  if (root.found !== true) return { found: false, reason: typeof root.reason === "string" ? root.reason : null };
  const rates = record(root.rates, "official rates");
  return { found: true, currency: stringField(root.currency, "official card currency"), input_uncached: parseRates(rates.input_uncached, "input_uncached"), input_cached: parseRates(rates.input_cached, "input_cached"), output: parseRates(rates.output, "output") };
}


// ───────────────────── 并列报价（同一服务商官方给了多个币种各一套价）─────────────────────
// 形状来源：src-tauri/src/lib.rs 的 quote_variants_status / save_quote_choice，
// 与 runtime-core pricing/quote_variants.rs::status（同一 PR 同改）。

export type QuoteSource = "user_choice" | "default_assumption" | "base_quote" | "pinned_by_user_cards";
export type QuoteVariantProvider = { provider: string; label: string; active_currency: string; source: QuoteSource; available: string[]; chosen_currency: string | null };
const QUOTE_SOURCES: QuoteSource[] = ["user_choice", "default_assumption", "base_quote", "pinned_by_user_cards"];

export async function readQuoteVariants(): Promise<QuoteVariantProvider[]> {
  if (!hasNativeBridge()) return [];
  const root = record(await invoke<unknown>("quote_variants_status"), "quote variants");
  if (root.status !== "ok" || !Array.isArray(root.providers)) throw new Error("quote variants unavailable");
  return root.providers.map((row) => {
    const entry = record(row, "quote variant provider");
    const source = QUOTE_SOURCES.find((candidate) => candidate === entry.source);
    if (!source) throw new Error("quote variant source unknown");
    const available = Array.isArray(entry.available) ? entry.available.filter((code): code is string => typeof code === "string") : [];
    return {
      provider: stringField(entry.provider, "quote provider"), label: typeof entry.label === "string" ? entry.label : stringField(entry.provider, "quote provider"),
      active_currency: stringField(entry.active_currency, "active currency"), source, available,
      chosen_currency: typeof entry.chosen_currency === "string" ? entry.chosen_currency : null,
    };
  });
}

/** `currency === null` 清除选择，回到默认假设。 */
export async function saveQuoteChoice(providerId: string, currency: string | null): Promise<void> {
  if (!hasNativeBridge()) return;
  const root = record(await invoke<unknown>("save_quote_choice", { providerId, currency }), "save quote choice");
  if (root.status !== "saved") throw new Error("quote choice not saved");
}
