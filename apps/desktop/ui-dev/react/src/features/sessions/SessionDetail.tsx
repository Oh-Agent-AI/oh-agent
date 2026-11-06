import { stable } from "../../lib/stable";
import { useEffect, useRef, useState } from "react";
import { SessionTrace } from "./SessionTrace";
import { SessionInsightsPanel, fmtTokens } from "./SessionInsights";
import { costReasonText, formatCost, sessionCostCard } from "./costSummary";
import { readSessionDetail, safeUiError, type SessionBillingBucket, type SessionDetail as SessionDetailData, type SessionRow, type SessionWorkflowEvent } from "../../lib/tauri";
import { message, useLanguage, type AppLanguage, type MessageKey, formatTokenCount, modelLabel } from "../../lib/i18n";

function compact(value: number): string {
  return formatTokenCount(value);
}

function timeLabel(value: string | null, language: AppLanguage): string {
  if (!value) return message("sessions.unknownTime", language);
  return value.slice(0, 19).replace("T", " ");
}

function costLabel(row: Pick<SessionRow, "cost_minor">): string {
  return formatCost(row.cost_minor) ?? "—";
}

function shortTime(value: string | null): string {
  return value ? value.slice(5, 16).replace("T", " ") : "—";
}

function pricingSourceLabel(source: string | null, language: AppLanguage): string {
  const keys: Record<string, MessageKey> = { official: "detail.priceOfficial", fallback_official: "detail.priceFallback", backfilled: "detail.priceBackfilled" };
  return message(source ? keys[source] ?? "detail.priceUnknown" : "detail.priceNone", language);
}

function billingModeLabel(mode: string, language: AppLanguage): string {
  const keys: Record<string, MessageKey> = { subscription: "detail.modeSubscription", metered: "detail.modeMetered", unknown: "detail.modeUnknown" };
  return message(keys[mode] ?? "detail.modeUnknown", language);
}

function statusLabel(row: Pick<SessionRow, "cost_status">, language: AppLanguage): string {
  return message(`sessions.billing.${row.cost_status.state}`, language);
}

/// 时间范围卡的主值用时长：完整的起止时间在窄窗口下会被截成「2026-09-28 21:42…」。
function durationLabel(from: string | null, to: string | null, language: AppLanguage): string {
  if (!from || !to) return message("detail.durationUnavailable", language);
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return message("detail.durationUnavailable", language);
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return message("detail.lessMinute", language);
  if (minutes < 60) return message("detail.minutes", language, { count: minutes });
  const hours = minutes / 60;
  if (hours < 48) return message("detail.hours", language, { count: hours < 10 ? hours.toFixed(1).replace(/\.0$/, "") : Math.round(hours) });
  return message("detail.days", language, { count: Math.round(hours / 24) });
}

function workflowLabel(event: SessionWorkflowEvent, language: AppLanguage): string {
  const known = ["task_started", "task_finished", "skill_invoked", "skill_finished", "tool_invoked", "tool_finished", "model_switched"];
  return message(known.includes(event.event_type) ? `detail.event.${event.event_type}` as MessageKey : "detail.event.unknown", language);
}

function bucketCost(bucket: SessionBillingBucket): string {
  if (!bucket.cost_minor) return "—";
  return costLabel(bucket);
}

export function SessionDetail({ row, sessionRef, harnessKind, onBack, refreshKey = 0 }: { row: SessionRow | null; sessionRef: string; harnessKind?: string; onBack: () => void; refreshKey?: number }) {
  const language = useLanguage();
  const [detail, setDetail] = useState<SessionDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paginationError, setPaginationError] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const generation = useRef(0);
  // 已显示的是哪个会话。后台同步每轮都会 bump refreshKey：同一会话的刷新保留旧内容、
  // 数据到了再替换；只有换会话才清空。之前每次刷新都先 setDetail(null)，整棵子树
  // （含消耗诊断图表）随之卸载重挂——真机表现为详情浮层周期性变成空白再重新加载。
  const shownRef = useRef<string | null>(null);

  useEffect(() => {
    const current = ++generation.current;
    const sameSession = shownRef.current === sessionRef;
    setLoadingMore(false);
    setPaginationError(null);
    if (!sameSession) {
      setLoading(true);
      setError(null);
      setRefreshFailed(false);
      setDetail(null);
    }
    void readSessionDetail(sessionRef).then((value) => {
      if (generation.current !== current) return;
      shownRef.current = sessionRef;
      setRefreshFailed(false);
      // 用户已经「加载更多」翻过的时间线不因后台刷新缩回第一页
      setDetail((previous) => stable(previous, sameSession && previous && previous.timeline.length > value.timeline.length
        ? { ...value, timeline: previous.timeline, has_more: previous.has_more, next_cursor: previous.next_cursor }
        : value));
    }).catch((reason: unknown) => {
      if (generation.current !== current) return;
      if (sameSession) setRefreshFailed(true); else setError(safeUiError(reason, "会话详情暂不可用"));
    }).finally(() => {
      if (generation.current === current) setLoading(false);
    });
  }, [sessionRef, refreshKey]);

  const loadMore = async () => {
    if (!detail?.next_cursor || loadingMore) return;
    const currentGeneration = generation.current;
    setLoadingMore(true);
    setPaginationError(null);
    try {
      const page = await readSessionDetail(sessionRef, detail.next_cursor);
      if (generation.current === currentGeneration) setDetail((current) => current ? { ...current, timeline: current.timeline.concat(page.timeline), has_more: page.has_more, next_cursor: page.next_cursor } : current);
      setPaginationError(null);
    } catch (reason: unknown) {
      if (generation.current === currentGeneration) setPaginationError(safeUiError(reason, "更多事实暂不可用"));
    } finally {
      if (generation.current === currentGeneration) setLoadingMore(false);
    }
  };

  return <>
    <div className="session-detail-header"><button className="button button-secondary" type="button" onClick={onBack}>← {message("detail.back", language)}</button><div><p className="eyebrow">{message("detail.safe", language)}</p><h2>{message("detail.sessionTitle", language, { harness: row?.harness ?? detail?.harness ?? harnessKind ?? message("nav.sessions", language) })}</h2></div><span className="status-pill"><span aria-hidden="true" className="status-dot" />{message("detail.readOnly", language)}</span></div>
    <p className="section-description session-detail-intro">{message("detail.intro", language)} <code>{sessionRef.slice(0, 18)}…</code></p>
    {loading && <div className="sessions-state" role="status"><strong>{message("detail.loading", language)}</strong><p>{message("detail.loadingTimeline", language)}</p></div>}
    {error && <div className="error-banner" role="alert">{message("detail.error", language, { error })}</div>}
    {refreshFailed && <div className="session-detail-refresh-note" role="status">{message("detail.refreshFailed", language)}</div>}
    {paginationError && <div className="error-banner" role="alert">{message("detail.paginationError", language, { error: paginationError })}</div>}
    {!loading && !detail && !error && <div className="sessions-state"><strong>{message("detail.empty", language)}</strong><p>{message("detail.emptyHelp", language)}</p></div>}
    {detail && <>
      <section className="session-detail-stats" aria-label={message("detail.summary", language)}><div><span>{message("detail.events", language)}</span><strong>{detail.event_count}</strong></div><div><span>Tokens</span><strong>{fmtTokens(detail.tokens.total)}</strong></div>{(() => { const card = sessionCostCard(detail, language); return <div title={card.title}><span>{message("detail.cost", language)}</span><strong>{card.value}</strong><small className={`session-cost-note${card.warn ? " session-cost-note-warn" : ""}`}>{card.note}</small></div>; })()}<div><span>{message("detail.timeRange", language)}</span><strong>{durationLabel(detail.first_event_at, detail.last_event_at, language)}</strong><small>{shortTime(detail.first_event_at)} · {message("sessions.until", language, { time: shortTime(detail.last_event_at) })}</small></div></section>
      <SessionInsightsPanel key={sessionRef} sessionRef={sessionRef} refreshKey={refreshKey} />
      <details className="session-detail-panel session-trace-legacy"><summary>{message("detail.toolSequence", language)}</summary><SessionTrace key={sessionRef} sessionRef={sessionRef} refreshKey={refreshKey} /></details>
      <section className="session-detail-panel"><div className="section-heading"><div><p className="eyebrow">{message("detail.billingAttribution", language)}</p><h3>{message("detail.basisCoverage", language)}</h3></div><span className={`session-cost-state session-cost-${detail.cost_status.state}`} title={costReasonText(detail.cost_status, language)}>{statusLabel(detail, language)}</span></div>{detail.billing_breakdown.length === 0 ? <p className="session-detail-muted">{message("detail.noBuckets", language)}</p> : <div className="sessions-table-wrap"><table className="sessions-table session-billing-table"><thead><tr><th scope="col">{message("detail.providerModel", language)}</th><th scope="col">{message("detail.billingBasis", language)}</th><th scope="col">{message("detail.pricingSource", language)}</th><th scope="col">Tokens</th><th scope="col">{message("detail.amount", language)}</th><th scope="col">{message("sessions.column.status", language)}</th></tr></thead><tbody>{detail.billing_breakdown.map((bucket, index) => <tr key={`${bucket.model_id}-${bucket.peak}-${index}`}><td><strong>{bucket.provider_raw ?? bucket.provider_id} · {modelLabel(bucket.model_id)}</strong><small>{message(bucket.peak ? "detail.peakBucket" : "detail.regularBucket", language)}</small></td><td>{billingModeLabel(bucket.billing_mode, language)}<small>{bucket.pricing_basis}</small></td><td>{pricingSourceLabel(bucket.pricing_source, language)}<small>{bucket.pricing_version ?? message("detail.versionUnavailable", language)}</small></td><td>{compact(bucket.tokens.total)}</td><td><strong>{bucketCost(bucket)}</strong></td><td><span className={`session-cost-state ${bucket.has_unresolved ? "session-cost-unavailable" : "session-cost-estimated"}`}>{message(bucket.has_unresolved ? "detail.attributionUnresolved" : "detail.auditable", language)}</span></td></tr>)}</tbody></table></div>}</section>
      <section className="session-detail-panel"><div className="section-heading"><div><p className="eyebrow">Usage timeline</p><h3>{message("detail.factsTimeline", language)}</h3></div><span className="count-badge">{message("detail.factCount", language, { count: `${detail.timeline.length}${detail.has_more ? "+" : ""}` })}</span></div>{detail.timeline.length === 0 ? <p className="session-detail-muted">{message("detail.noFacts", language)}</p> : <div className="sessions-table-wrap"><table className="sessions-table session-timeline-table"><thead><tr><th scope="col">{message("sessions.column.time", language)}</th><th scope="col">{message("sessions.model", language)}</th><th scope="col">{message("detail.observationType", language)}</th><th scope="col">{message("detail.peak", language)}</th><th scope="col">Tokens</th></tr></thead><tbody>{detail.timeline.map((event, index) => <tr key={`${event.event_at}-${event.model_id}-${index}`}><td>{timeLabel(event.event_at, language)}</td><td>{modelLabel(event.model_id)}</td><td>{event.observation_kind}</td><td>{event.peak ? message("detail.peak", language) : "—"}</td><td><strong>{compact(event.tokens.total)}</strong></td></tr>)}</tbody></table></div>}{detail.has_more && <div className="sessions-more"><button className="button button-secondary" type="button" onClick={() => void loadMore()} disabled={loadingMore}>{message(loadingMore ? "sessions.loadingMore" : "detail.loadFacts", language)}</button></div>}</section>
      <section className="session-detail-panel"><div className="section-heading"><div><p className="eyebrow">Workflow timeline</p><h3>{message("detail.workflowTimeline", language)}</h3></div><span className="count-badge">{detail.workflow_has_more ? message("detail.firstThousand", language) : message("detail.factCount", language, { count: detail.workflow_timeline.length })}</span></div><p className="session-detail-note">{message("detail.workflowNote", language)} {detail.workflow_has_more ? message("detail.workflowLimit", language) : ""}</p>{detail.workflow_timeline.length === 0 ? <p className="session-detail-muted">{message("detail.noWorkflow", language)}</p> : <ol className="session-workflow-list">{detail.workflow_timeline.map((event, index) => <li key={`${event.event_at}-${event.event_type}-${index}`}><span className={`workflow-marker workflow-${event.outcome}`} aria-hidden="true" /><div><strong>{workflowLabel(event, language)}</strong><p>{event.capability_kind ?? message("detail.capabilityUnavailable", language)}{event.capability_id ? ` · ${event.capability_id}` : ""} · {message(event.outcome === "failed" ? "detail.outcomeFailed" : event.outcome === "succeeded" ? "detail.outcomeSucceeded" : "detail.outcomeUnavailable", language)}</p><small>{timeLabel(event.event_at, language)}{event.duration_ms == null ? "" : ` · ${event.duration_ms}ms`}</small></div></li>)}</ol>}</section>
    </>}
  </>;
}
