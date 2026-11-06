// 会话消耗诊断的桌面桥（SESSION_TRACE_DIAGNOSTICS_SPEC r6 §6、§8、§10）。
//
// 形状出处（形状来源纪律，CLAUDE.md）：
// - insights：crates/agent-vitals-domain/src/domain/session_insights.rs::build_insights
//   （axis / session / diagnostics / safety）+ crates/agent-vitals-query/src/query/
//   session_insights.rs::session_insights（lanes / harness / nominal_cost）。经 MCP
//   `session_trace(output = "insights")`，Tauri 命令 `session_trace` 转发 envelope。
// - evidence：同文件 `session_trace_evidence`，Tauri 命令 `session_trace_evidence`
//   直接返回 `{data}`（本地呈现层专属，不经 MCP）。
// 形状变更须同一 PR 同改本文件与 scripts/verify-react-session-insights-contract.mjs。

import { invoke } from "./tauri";

export type NominalCost = { amounts: { amount_minor: number; currency: string }[]; coverage: "full" | "partial" };
export type ToolCounts = { succeeded: number; failed: number; cancelled: number; unknown: number };
export type StepNote = { explanation: "possible_cache_expiry" | "after_model_change"; calls: number };
export type InsightStep = {
  index: number;
  started_at_ms: number;
  /// 这一步没有任何测量时服务端省略（§6.2）。
  ended_at_ms: number | null;
  outcome: "succeeded" | "failed" | "cancelled" | "unknown" | null;
  idle_before_ms: number | null;
  input: { cache_read: number; cache_write: number; uncached_input: number };
  output: number;
  input_peak: number;
  hit_rate: number | null;
  calls: number;
  model_ids: string[];
  tools: ToolCounts;
  notes: StepNote[];
  nominal_cost: NominalCost | null;
};
export type DiagnosticKind = "high_uncached_input" | "input_growth" | "repeated_failure";
export type Cause = "evidence" | "possible" | "unknown";
export type InsightDiagnostic = {
  kind: DiagnosticKind;
  steps: { from: number; to: number };
  fact: Record<string, number | boolean | string | null>;
  impact: { tokens: number; share_of_session_input: number };
  explanation: "possible_cache_expiry" | "after_model_change" | "hit_rate_drop" | "unexplained" | null;
  cause: Cause;
  evidence: string[];
  context_notes: { explanation: string; calls: number }[];
  remedy_id: string;
  failure_exposure?: {
    affected_input_tokens: number;
    nominal_amounts: Array<{ amount_minor: number; currency: string; billing_basis: "nominal" }>;
    coverage: "full" | "partial" | "unavailable";
    unpriced_tokens: number;
    granularity: "affected-turns";
    reason: null | "no_pricing_snapshot" | "no_price_card";
    disclaimer: string;
  };
};
export type LaneReason = "not_recorded_by_harness" | "not_ingested" | "no_data_in_session";
export type Lane = { state: "available" | "partial" | "unavailable"; coverage: number | null; reason: LaneReason | null };
export type SafetyRule = { rule: string; severity: "critical" | "warning" | "info"; count: number; steps: number[] };
export type SessionInsights = {
  harness: string;
  axis: {
    unit: "turn" | "assistant_call";
    turn_starts: number;
    /// 回合轴下的第 1 步是否是「首回合之前」补出来的前导步。
    leading_step: boolean;
    /// 按调用铺开的原因。
    fallback: "few_turn_starts" | "most_calls_before_first_turn" | null;
    steps: InsightStep[];
    unplaced: { usage_facts: number; workflow_events: number };
  };
  session: {
    calls: number; input: { cache_read: number; cache_write: number; uncached_input: number }; output: number;
    nominal_cost: NominalCost | null;
    /// 无金额时的原因（§8.5「暂无可用计价依据」）。
    nominal_cost_reason: "no_pricing_snapshot" | "no_price_card" | null;
  };
  /// 仍是工具名级旧指纹的失败次数（源日志已被执行环境清理，无法按参数区分调用）。
  quality: { legacy_fingerprints: number };
  diagnostics: InsightDiagnostic[];
  safety: { count: number; critical: number; rules: SafetyRule[] };
  lanes: { consumption: Lane; tools: Lane };
};
export type EvidenceCall = { step: number | null; ts_ms: number; model_id: string | null; input: { cache_read: number; cache_write: number; uncached_input: number }; output: number };
export type EvidenceFailure = { step: number | null; ts_ms: number; capability_id: string | null; invocation_key: string | null; error_excerpt: string | null; args_excerpt: string | null };
export type EvidenceSafety = { rule: string; severity: string; step: number | null; tool: string | null; summary: string | null };
export type SessionTraceEvidence = { steps: { from: number; to: number }; calls: EvidenceCall[]; failures: EvidenceFailure[]; safety: EvidenceSafety[] };

const MAX_STEPS = 20_000;

function obj(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 格式不兼容`);
  return value as Record<string, unknown>;
}
function count(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 计数不安全`);
  return value;
}
function optCount(value: unknown, label: string): number | null {
  return value === undefined || value === null ? null : count(value, label);
}
function ratio(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} 比例不安全`);
  return value;
}
function optRatio(value: unknown, label: string): number | null {
  return value === undefined || value === null ? null : ratio(value, label);
}
function arr(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 缺少数组`);
  if (value.length > max) throw new Error(`${label} 超出上限`);
  return value;
}
function oneOf<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new Error(`${label} 取值不在词表内`);
  return value as T;
}
/// 标识类字符串（模型 id、工具名、规则码）：有界、无控制字符；React 以文本渲染。
function label(value: unknown, what: string, max = 160): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${what} 标识不安全`);
  return value;
}
function optLabel(value: unknown, what: string, max = 160): string | null {
  return value === undefined || value === null ? null : label(value, what, max);
}
/// 本地摘录（错误首行、参数摘要）：服务端已截断到 ~120 码点，这里再设硬上限。
function excerpt(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 2_000) throw new Error(`${what} 摘录不安全`);
  return value;
}
function inputBuckets(value: unknown, what: string) {
  const o = obj(value, what);
  return { cache_read: count(o.cache_read, `${what}.cache_read`), cache_write: count(o.cache_write, `${what}.cache_write`), uncached_input: count(o.uncached_input, `${what}.uncached_input`) };
}
function nominal(value: unknown, what: string): NominalCost | null {
  if (value === undefined || value === null) return null;
  const o = obj(value, what);
  const amounts = arr(o.amounts, `${what}.amounts`, 8).map((a, i) => {
    const m = obj(a, `${what}.amounts[${i}]`);
    const currency = label(m.currency, "币种", 12);
    if (!/^[A-Z0-9_]{1,12}$/.test(currency)) throw new Error("币种不安全");
    return { amount_minor: count(m.amount_minor, "金额"), currency };
  });
  return { amounts, coverage: oneOf(o.coverage, `${what}.coverage`, ["full", "partial"] as const) };
}
function lane(value: unknown, what: string): Lane {
  const o = obj(value, what);
  return {
    state: oneOf(o.state, `${what}.state`, ["available", "partial", "unavailable"] as const),
    coverage: optRatio(o.coverage, `${what}.coverage`),
    reason: o.reason === undefined || o.reason === null ? null : oneOf(o.reason, `${what}.reason`, ["not_recorded_by_harness", "not_ingested", "no_data_in_session"] as const),
  };
}

function parseStep(value: unknown, position: number): InsightStep {
  const s = obj(value, "step");
  const index = count(s.index, "step.index");
  if (index !== position + 1) throw new Error("回合序号不连续");
  const tools = obj(s.tools, "step.tools");
  return {
    index,
    started_at_ms: count(s.started_at_ms, "step.started_at_ms"),
    ended_at_ms: optCount(s.ended_at_ms, "step.ended_at_ms"),
    outcome: s.outcome === undefined || s.outcome === null ? null : oneOf(s.outcome, "step.outcome", ["succeeded", "failed", "cancelled", "unknown"] as const),
    idle_before_ms: optCount(s.idle_before_ms, "step.idle_before_ms"),
    input: inputBuckets(s.input, "step.input"),
    output: count(s.output, "step.output"),
    input_peak: count(s.input_peak, "step.input_peak"),
    hit_rate: optRatio(s.hit_rate, "step.hit_rate"),
    calls: count(s.calls, "step.calls"),
    model_ids: arr(s.model_ids, "step.model_ids", 16).map(m => label(m, "模型")),
    tools: { succeeded: count(tools.succeeded, "tools"), failed: count(tools.failed, "tools"), cancelled: count(tools.cancelled, "tools"), unknown: count(tools.unknown, "tools") },
    notes: arr(s.notes, "step.notes", 4).map(n => {
      const o = obj(n, "note");
      return { explanation: oneOf(o.explanation, "note.explanation", ["possible_cache_expiry", "after_model_change"] as const), calls: count(o.calls, "note.calls") };
    }),
    nominal_cost: nominal(s.nominal_cost, "step.nominal_cost"),
  };
}

function parseDiagnostic(value: unknown, steps: number): InsightDiagnostic {
  const d = obj(value, "diagnostic");
  const range = obj(d.steps, "diagnostic.steps");
  const from = count(range.from, "diagnostic.from");
  const to = count(range.to, "diagnostic.to");
  if (from < 1 || to < from || to > steps) throw new Error("诊断区间越界");
  const factIn = obj(d.fact, "diagnostic.fact");
  const fact: InsightDiagnostic["fact"] = {};
  for (const [key, v] of Object.entries(factIn).slice(0, 16)) {
    if (!/^[a-z_]{1,32}$/.test(key)) throw new Error("诊断事实键不安全");
    if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) fact[key] = v;
    else fact[key] = label(v, "诊断事实");
  }
  const impact = obj(d.impact, "diagnostic.impact");
  return {
    kind: oneOf(d.kind, "diagnostic.kind", ["high_uncached_input", "input_growth", "repeated_failure"] as const),
    steps: { from, to },
    fact,
    impact: { tokens: count(impact.tokens, "impact.tokens"), share_of_session_input: ratio(impact.share_of_session_input, "impact.share") },
    explanation: d.explanation === undefined || d.explanation === null ? null : oneOf(d.explanation, "diagnostic.explanation", ["possible_cache_expiry", "after_model_change", "hit_rate_drop", "unexplained"] as const),
    cause: oneOf(d.cause, "diagnostic.cause", ["evidence", "possible", "unknown"] as const),
    evidence: arr(d.evidence, "diagnostic.evidence", 8).map(e => oneOf(e, "diagnostic.evidence", ["error_excerpt"] as const)),
    context_notes: arr(d.context_notes, "diagnostic.context_notes", 8).map(n => {
      const o = obj(n, "context_note");
      return { explanation: label(o.explanation, "context_note"), calls: count(o.calls, "context_note.calls") };
    }),
    remedy_id: oneOf(d.remedy_id, "diagnostic.remedy_id", ["inspect-uncached-input", "review-context-growth", "inspect-repeated-failure"] as const),
    failure_exposure: parseFailureExposure(d.failure_exposure),
  };
}

/// WASTE S1：失败区间成本暴露（仅 repeated_failure）。闭集校验同严格纪律；
/// 免责声明必须与服务端常量逐字一致（契约钉住的口径红线）。
function parseFailureExposure(value: unknown): InsightDiagnostic["failure_exposure"] {
  if (value === undefined || value === null) return undefined;
  const e = obj(value, "failure_exposure");
  const amounts = arr(e.nominal_amounts, "failure_exposure.nominal_amounts", 8).map((a) => {
    const o = obj(a, "failure_exposure amount");
    return {
      amount_minor: count(o.amount_minor, "failure_exposure.amount_minor"),
      currency: label(o.currency, "failure_exposure.currency"),
      billing_basis: oneOf(o.billing_basis, "failure_exposure.billing_basis", ["nominal"] as const),
    };
  });
  const disclaimer = label(e.disclaimer, "failure_exposure.disclaimer");
  if (disclaimer !== "相关回合含正常工作；不是浪费、可节省额或实付账单") throw new Error("failure_exposure 免责声明与契约不一致");
  return {
    affected_input_tokens: count(e.affected_input_tokens, "failure_exposure.tokens"),
    nominal_amounts: amounts,
    coverage: oneOf(e.coverage, "failure_exposure.coverage", ["full", "partial", "unavailable"] as const),
    unpriced_tokens: count(e.unpriced_tokens, "failure_exposure.unpriced_tokens"),
    granularity: oneOf(e.granularity, "failure_exposure.granularity", ["affected-turns"] as const),
    reason: e.reason === null || e.reason === undefined ? null : oneOf(e.reason, "failure_exposure.reason", ["no_pricing_snapshot", "no_price_card"] as const),
    disclaimer,
  };
}

export function parseSessionInsights(value: unknown): SessionInsights {
  const root = obj(value, "insights envelope");
  if (root.error) throw new Error("消耗诊断暂不可用");
  const data = obj(root.data, "insights");
  const axis = obj(data.axis, "axis");
  const steps = arr(axis.steps, "axis.steps", MAX_STEPS).map(parseStep);
  const unplaced = obj(axis.unplaced, "axis.unplaced");
  const session = obj(data.session, "session");
  const safety = obj(data.safety, "safety");
  const lanes = obj(data.lanes, "lanes");
  return {
    harness: label(data.harness, "执行环境", 64),
    axis: {
      unit: oneOf(axis.unit, "axis.unit", ["turn", "assistant_call"] as const),
      turn_starts: count(axis.turn_starts, "axis.turn_starts"),
      leading_step: axis.leading_step === true,
      fallback: axis.fallback === undefined || axis.fallback === null ? null : oneOf(axis.fallback, "axis.fallback", ["few_turn_starts", "most_calls_before_first_turn"] as const),
      steps,
      unplaced: { usage_facts: count(unplaced.usage_facts, "unplaced"), workflow_events: count(unplaced.workflow_events, "unplaced") },
    },
    session: {
      calls: count(session.calls, "session.calls"), input: inputBuckets(session.input, "session.input"), output: count(session.output, "session.output"),
      nominal_cost: nominal(session.nominal_cost, "session.nominal_cost"),
      nominal_cost_reason: session.nominal_cost_reason === undefined || session.nominal_cost_reason === null ? null : oneOf(session.nominal_cost_reason, "session.nominal_cost_reason", ["no_pricing_snapshot", "no_price_card"] as const),
    },
    quality: { legacy_fingerprints: data.quality === undefined ? 0 : count(obj(data.quality, "quality").legacy_fingerprints, "quality.legacy_fingerprints") },
    diagnostics: arr(data.diagnostics, "diagnostics", 500).map(d => parseDiagnostic(d, steps.length)),
    safety: {
      count: count(safety.count, "safety.count"),
      critical: count(safety.critical, "safety.critical"),
      rules: arr(safety.rules, "safety.rules", 64).map(r => {
        const o = obj(r, "safety.rule");
        const rule = label(o.rule, "规则码", 16);
        if (!/^SV\d{3}$/.test(rule)) throw new Error("规则码不安全");
        return { rule, severity: oneOf(o.severity, "safety.severity", ["critical", "warning", "info"] as const), count: count(o.count, "safety.count"), steps: arr(o.steps, "safety.steps", MAX_STEPS).map(s => count(s, "safety.step")) };
      }),
    },
    lanes: { consumption: lane(lanes.consumption, "lanes.consumption"), tools: lane(lanes.tools, "lanes.tools") },
  };
}

export function parseSessionTraceEvidence(value: unknown): SessionTraceEvidence {
  const root = obj(value, "evidence envelope");
  if (root.error) throw new Error("证据暂不可用");
  const data = obj(root.data, "evidence");
  const range = obj(data.steps, "evidence.steps");
  const step = (v: unknown) => optCount(v, "evidence.step");
  return {
    steps: { from: count(range.from, "evidence.from"), to: count(range.to, "evidence.to") },
    calls: arr(data.calls, "evidence.calls", 50_000).map(c => {
      const o = obj(c, "evidence.call");
      return { step: step(o.step), ts_ms: count(o.ts_ms, "call.ts_ms"), model_id: optLabel(o.model_id, "模型"), input: inputBuckets(o.input, "call.input"), output: count(o.output, "call.output") };
    }),
    failures: arr(data.failures, "evidence.failures", 20_000).map(f => {
      const o = obj(f, "evidence.failure");
      return { step: step(o.step), ts_ms: count(o.ts_ms, "failure.ts_ms"), capability_id: optLabel(o.capability_id, "工具"), invocation_key: optLabel(o.invocation_key, "调用键"), error_excerpt: excerpt(o.error_excerpt, "错误"), args_excerpt: excerpt(o.args_excerpt, "参数") };
    }),
    safety: arr(data.safety, "evidence.safety", 20_000).map(s => {
      const o = obj(s, "evidence.safety");
      return { rule: label(o.rule, "规则码", 16), severity: label(o.severity, "严重度", 16), step: step(o.step), tool: optLabel(o.tool, "工具"), summary: excerpt(o.summary, "命令摘要") };
    }),
  };
}

function safeRef(sessionRef: string): string {
  if (typeof sessionRef !== "string" || !/^sr_[A-Za-z0-9_-]{8,128}$/.test(sessionRef)) throw new Error("session_ref 不安全");
  return sessionRef;
}

export async function readSessionInsights(sessionRef: string): Promise<SessionInsights> {
  return parseSessionInsights(await invoke<unknown>("session_trace", { sessionRef: safeRef(sessionRef), output: "insights" }));
}

/// 本地证据（摘录）：只在本机呈现，永不上送。`from`/`to` 为 1 基步号（含两端）。
/// `includeCalls = false`：只要失败与安全提醒（安全视图跨整个会话，逐次调用可能上万条）。
export async function readSessionTraceEvidence(sessionRef: string, from: number, to: number, includeCalls = true): Promise<SessionTraceEvidence> {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) throw new Error("证据区间不安全");
  if (includeCalls && to - from > 5_000) throw new Error("证据区间过大");
  return parseSessionTraceEvidence(await invoke<unknown>("session_trace_evidence", { sessionRef: safeRef(sessionRef), from, to, includeCalls }));
}
