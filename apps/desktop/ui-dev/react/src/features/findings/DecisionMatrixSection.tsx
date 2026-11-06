import { harnessName } from "../../lib/harnessNames";
import { useMemo, useState } from "react";
import type { DecisionMatrixReport, DecisionMatrixRow, DecisionSummary } from "../../lib/tauri";
import { message, resolvedLanguage, useLanguage, type MessageKey } from "../../lib/i18n";

const tx = (key: MessageKey, params: Record<string, string | number> = {}): string => message(key, resolvedLanguage(), params);

function compact(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function money(minor: number, currency: string, basis: string): string {
  const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : `${currency} `;
  return `${basis === "metered_estimate" ? "≈" : ""}${symbol}${(minor / 100).toFixed(2)}`;
}

function rowKey(row: DecisionMatrixRow): string {
  return JSON.stringify([row.harness, row.model_id, row.provider_id]);
}

function summaryTitle(summary: DecisionSummary): string {
  if (summary.kind === "cost_outlier") return tx("dm.outlierTitle");
  if (summary.kind === "marathon") return tx("dm.marathonTitle", { hours: summary.span_hours ?? "—", tokens: compact(summary.tokens_total ?? 0) });
  return tx("dm.currencyTitle");
}

function summaryBody(summary: DecisionSummary): string {
  if (summary.kind === "cost_outlier" && summary.outlier && summary.control) {
    return tx("dm.outlierBody", { model: summary.outlier.model_id, amount: money(summary.outlier.per_session_minor, summary.currency ?? "<unknown>", "metered_estimate"), control: summary.control.model_id, ratio: summary.ratio_vs_control ?? "—", hit: summary.outlier.cache_hit_ratio == null ? "—" : `${Math.round(summary.outlier.cache_hit_ratio * 100)}%` });
  }
  if (summary.kind === "marathon") return tx("dm.marathonBody", { harness: summary.combo?.harness ?? "<unknown>", model: summary.combo?.model_id ?? "<unknown>", failures: summary.failures ?? 0 });
  const detail = Object.entries(summary.by_currency ?? {}).map(([currency, value]) => tx("dm.comboTokens", { currency, combos: value.combos, tokens: compact(value.tokens) })).join(tx("dm.sep"));
  return detail ? tx("dm.pricedCombos", { detail }) : tx("dm.currencyMixed");
}

const limitationLabel = (id: string): string => {
  const keys: Record<string, MessageKey> = {
    waste_rate_unavailable: "dm.limWaste", harness_behavior_harness_level: "dm.limHarness", amounts_currency_separated: "dm.limCurrency",
    fingerprint_link_deferred: "dm.limFingerprint", top_sessions_unavailable: "dm.limTop", pricing_unavailable: "dm.limPricing",
  };
  return keys[id] ? tx(keys[id]) : tx("dm.limPartial");
};

function sortRows(rows: DecisionMatrixRow[]): { rows: DecisionMatrixRow[]; note: string; sorted: boolean } {
  const unpriced = rows.filter((row) => row.amounts.length === 0 && !row.has_subscription);
  const subscriptions = rows.filter((row) => row.has_subscription);
  const candidates = rows.filter((row) => row.amounts.length > 0 && !row.has_subscription);
  const currencies = new Set(candidates.flatMap((row) => row.amounts.map((amount) => amount.currency)));
  const canSort = candidates.length > 0 && currencies.size === 1 && candidates.every((row) => row.amounts.length === 1 && row.sessions > 0 && !row.cost_provider_unresolved && row.waste_rate !== null);
  const byTokens = (a: DecisionMatrixRow, b: DecisionMatrixRow) => b.tokens.total - a.tokens.total;
  if (!canSort) {
    const reason = currencies.size > 1 ? tx("dm.noteCurrency") : candidates.some((row) => row.waste_rate === null) ? tx("dm.noteWaste") : tx("dm.noteAttr");
    return { rows: [...unpriced].sort(byTokens).concat([...candidates].sort(byTokens), [...subscriptions].sort(byTokens)), note: reason, sorted: false };
  }
  const currency = [...currencies][0];
  const score = (row: DecisionMatrixRow) => (row.amounts[0].amount_minor / row.sessions) * (1 + (row.waste_rate ?? 0));
  return { rows: [...unpriced].sort(byTokens).concat([...candidates].sort((a, b) => score(b) - score(a)), [...subscriptions].sort(byTokens)), note: tx("dm.noteSorted", { currency }), sorted: true };
}

function MatrixRow({ row, expanded, detailId, onToggle }: { row: DecisionMatrixRow; expanded: boolean; detailId: string; onToggle: () => void }) {
  const amount = row.amounts.length === 1 ? money(row.amounts[0].amount_minor, row.amounts[0].currency, row.amounts[0].basis) : row.amounts.map((item) => money(item.amount_minor, item.currency, item.basis)).join(" · ");
  const perSession = row.amounts.length === 1 && row.sessions > 0 && !row.has_subscription ? money(Math.round(row.amounts[0].amount_minor / row.sessions), row.amounts[0].currency, row.amounts[0].basis) : "—";
  const tags = [row.has_subscription ? tx("dm.tagSub") : row.amounts.length === 0 ? tx("dm.tagUnknown") : null, row.cost_provider_unresolved ? tx("dm.tagUnresolved") : null].filter(Boolean);
  return <>
    <article className="matrix-row" role="listitem" data-testid="decision-matrix-row">
      <button className="matrix-row-toggle" type="button" aria-expanded={expanded} aria-controls={detailId} onClick={onToggle}>
        <span className="matrix-combo"><strong>{harnessName(row.harness)} · {row.model_id}</strong><small>{row.provider_id}{tags.length ? ` · ${tags.join(" · ")}` : ""}</small></span>
        <span className="matrix-cell"><b>{row.sessions}</b><small>{tx("dm.sessions")}</small></span>
        <span className="matrix-cell"><b>{compact(row.tokens.total)}</b><small>token</small></span>
        <span className="matrix-cell"><b>{amount}</b><small>{tx("dm.nominal")}</small></span>
        <span className="matrix-cell"><b>{perSession}</b><small>{tx("dm.perSession")}</small></span>
        <span className="matrix-cell"><b>{row.cache_hit_ratio == null ? "—" : `${Math.round(row.cache_hit_ratio * 100)}%`}</b><small>{tx("dm.cacheHit")}</small></span>
        <span className="matrix-cell"><b>{row.waste_rate == null ? "—" : `${Math.round(row.waste_rate * 100)}%`}</b><small>{tx("dm.wasteRate")}</small></span>
        <span className="matrix-cell"><b>{row.limit_pressure == null ? "—" : `${tx("dm.hitsN", { n: row.limit_pressure.hits })}${row.limit_pressure.per_session == null ? "" : tx("dm.perSessionN", { n: row.limit_pressure.per_session })}`}</b><small>{tx("dm.limitHits")}</small></span>
        <span className="matrix-chevron" aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
      </button>
    </article>
    {expanded && <div id={detailId} className="matrix-detail" role="region" aria-label={tx("dm.evidenceAria", { harness: row.harness, model: row.model_id })}>
      <p>{tx("dm.buckets", { uncached: compact(row.tokens.uncached_input), read: compact(row.tokens.cache_read), write: compact(row.tokens.cache_write), output: compact(row.tokens.output) })}</p>
      {Object.keys(row.harness_behavior).length > 0 && <p>{tx("dm.harnessBehavior")}{Object.entries(row.harness_behavior).map(([rule, count]) => `${rule} × ${count}`).join(" · ")}</p>}
      {row.top_sessions.length > 0 ? row.top_sessions.map((session) => <p key={session.session_ref}>{tx("dm.contributing")} <code>{session.session_ref.slice(0, 18)}…</code>{tx("dm.sessionTail", { hours: ((session.span_last_ms - session.span_first_ms) / 3_600_000).toFixed(1), tokens: compact(session.tokens_total), failures: session.failures })}</p>) : <p>{tx("dm.topNA")}</p>}
    </div>}
  </>;
}

export function DecisionMatrixSection({ report, loading, error }: { report: DecisionMatrixReport | null; loading: boolean; error: string | null }) {
  useLanguage();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const sorted = useMemo(() => sortRows(report?.rows ?? []), [report]);
  const hasStaleReport = Boolean(report && (loading || error));
  const staleMessage = loading
    ? tx("dm.refreshing")
    : error && report
      ? tx("dm.incomplete", { month: report.month })
      : null;
  return <section className="finding-section matrix-section" aria-labelledby="matrix-title">
    <div className="section-heading"><div><p className="eyebrow">{tx("dm.eyebrow")}</p><h3 id="matrix-title">{tx("dm.title")} {report && <small className="section-meta">{tx("dm.window")} {report.month}</small>}</h3><p className="section-description">{tx("dm.desc")}</p></div><div className="section-heading-side">{hasStaleReport && <span className="status-pill status-pill-warning" aria-label={tx("dm.prevResult")}><span aria-hidden="true" className="status-dot" />{tx("dm.prevPill")}</span>}<span className="count-badge">{report?.rows.length ?? 0}</span></div></div>
    {loading && <p className="inline-status" aria-busy="true">{staleMessage ?? tx("dm.readingAgg")}</p>}
    {error && <div className="error-banner" role="alert">{tx("dm.readFailed", { error })} · {staleMessage ?? tx("dm.todosStill")}</div>}
    {report && report.findings_summary.length > 0 && <div className="decision-summary-list">{report.findings_summary.map((summary, index) => <article className="decision-summary" key={`${summary.kind}-${index}`}><strong>{summaryTitle(summary)}</strong><p>{summaryBody(summary)}</p>{summary.saving_minor != null && <span>{tx("dm.gap", { amount: money(summary.saving_minor, summary.currency ?? "<unknown>", "metered_estimate") })}</span>}</article>)}</div>}
    {report && <p className="matrix-sort-note">{sorted.note}{sorted.sorted ? "" : tx("dm.byTokens")}</p>}
    {report && sorted.rows.length > 0 ? <div className="matrix-list" role="list">{sorted.rows.map((row, index) => { const key = rowKey(row); const detailId = `matrix-detail-${index}`; return <MatrixRow key={key} row={row} detailId={detailId} expanded={Boolean(expanded[key])} onToggle={() => setExpanded((current) => ({ ...current, [key]: !current[key] }))} />; })}</div> : !loading && <div className="finding-empty"><strong>{tx("dm.noCombos")}</strong><p>{tx("dm.noCombosNote")}</p></div>}
    {report && report.limitations.length > 0 && <p className="matrix-limitations">{tx("dm.limits")}{report.limitations.map((item) => limitationLabel(item)).join(" · ")}</p>}
  </section>;
}
