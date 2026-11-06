import { harnessName } from "../../lib/harnessNames";
import { useEffect, useState } from "react";
import { StatusPill } from "../../components/ui/StatusPill";
import { readFindings, readUsageCalendar, readUsageHourly, type FindingGroup, type OverviewDetails, type OverviewSnapshot, type SummaryHarnessTokens, type UsageCalendar, type UsageHourly } from "../../lib/tauri";
import { UsageTrendChart } from "../../components/UsageTrendChart";
import { bucketTotal, buildDayBuckets, buildHourBuckets, monthDates, monthOf, weekDates, weekExtraMonth, type TrendBucket, type TrendRange } from "../usage/trendBuckets";
import { sessionsDateHref, sessionsHarnessHref } from "../../lib/nav";
import { todayCacheHitRatio } from "./cacheHit";
import { applyConversion, monthSpendCard, todaySpendCard } from "./spendCards";
import { useConvertedAmounts } from "../../lib/fx";
import { DecisionArea } from "./DecisionArea";
import { formatMajorMoney, message, useLanguage, type MessageKey, formatTokenCount } from "../../lib/i18n";

function tokensLabel(value: number | null): string {
  if (value == null) return "—";
  return formatTokenCount(value);
}

function moneyDetail(values: Record<string, number>): string {
  const entries = Object.entries(values);
  if (!entries.length) return message("overview.noPricedData");
  const remainder = entries.slice(1).map(([currency, amount]) => formatMajorMoney(amount, currency));
  return remainder.length ? message("overview.otherCurrencies", undefined, { amounts: remainder.join(" · ") }) : message("overview.separateCurrencies");
}

function basisLabel(value: string): string {
  const key = `overview.basis.${value}` as MessageKey;
  return ["metered_actual", "harness_billed", "fixed_subscription", "metered_declared", "metered_estimate", "api_equivalent", "other"].includes(value) ? message(key) : value;
}

function basisLines(values: Record<string, Record<string, number>>): string {
  const lines = Object.entries(values).flatMap(([basis, currencies]) => Object.entries(currencies).map(([currency, amount]) => `${basisLabel(basis)} ${formatMajorMoney(amount, currency)}`));
  return lines.length ? lines.join(" · ") : message("overview.noActualSpend");
}

function harnessTokensLabel(value: SummaryHarnessTokens): string {
  return `${tokensLabel(value.total)} · ${message("overview.cacheHit", undefined, { ratio: value.cache_hit_ratio == null ? "—" : (value.cache_hit_ratio * 100).toFixed(1) })}`;
}

function summaryState(value: "fresh" | "stale" | "partial" | "unavailable" | "unknown"): { label: string; tone: "success" | "warning" | "neutral" } {
  const tone = value === "fresh" ? "success" : value === "stale" || value === "partial" ? "warning" : "neutral";
  return { label: message(`overview.${value}` as MessageKey), tone };
}

function summaryTokens(value: { freshness: "fresh" | "stale" | "partial" | "unavailable" | "unknown"; total_tokens: number } | null): string {
  return value && value.freshness !== "unavailable" && value.freshness !== "unknown" ? `${tokensLabel(value.total_tokens)} tokens` : "—";
}

function summaryFreshnessNote(value: { freshness: "fresh" | "stale" | "partial" | "unavailable" | "unknown"; last_observed_at: string | null }): string {
  if (value.freshness === "stale") return ` · ${message("overview.staleObserved", undefined, { date: value.last_observed_at?.slice(0, 10) ?? "—" })}`;
  if (value.freshness === "partial") return ` · ${message("overview.partialObserved")}`;
  return "";
}

function budgetStatusLabel(level: string): string {
  const known = ["no_budget", "ok", "warn", "over", "snoozed", "disabled"].includes(level) ? level : "unknown";
  return message(`overview.budget.${known}` as MessageKey);
}

function harnessStatusLabel(status: OverviewSnapshot["harness_rows"][number]["status"]): string {
  return message(`overview.harness.${status}` as MessageKey);
}

function syncStageLabel(stage: string): string {
  const known = ["complete", "fold", "discover", "resolve", "never", "paused", "partial", "light", "control", "facts"].includes(stage) ? stage : "unknown";
  return message(`overview.sync.${known}` as MessageKey);
}

function StatCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article className="stat-card">
    <p className="eyebrow">{label}</p>
    <p className={`stat-value ${value.length > 10 ? "stat-value-compact" : ""}`}>{value}</p>
    <p className="stat-detail">{detail}</p>
  </article>;
}

/**
 * OVERVIEW_TREND_RANGE_SPEC v2.0：本日（24 小时）/ 本周（自然周 7 日，周一起）/
 * 本月（自然月）三档趋势。渲染交给共享的 UsageTrendChart，桶由 trendBuckets.ts 装配
 * （与用量页「小时明细」同一套）；失败标记：日档读 failure_hours，周/月档读 failure_days，
 * 任一为 null → 图例处诚实标「失败标记不可用」，绝不画假零。不放金额（r6）。
 * 降级：小时数据读不到 → 本日档说不可用；周跨月时上月日历读不到 → 那几天灰斜纹
 * （unavailable，不是 0）；有失败但零 token 的桶保留标记（没用量≠没失败）。
 */
const TREND_RANGE_KEY = "agent-vitals.overview.trendRange";
const TREND_RANGES: TrendRange[] = ["day", "week", "month"];

function readStoredTrendRange(): TrendRange {
  try {
    const value = localStorage.getItem(TREND_RANGE_KEY);
    if (value === "day" || value === "week" || value === "month") return value;
  } catch { /* 记住范围只是便利，读不到就用默认 */ }
  return "day";
}

function TrendPanel({ details }: { details: OverviewDetails }) {
  const language = useLanguage();
  const [range, setRange] = useState<TrendRange>(readStoredTrendRange);
  const [hourly, setHourly] = useState<UsageHourly | null>(null);
  const [hourlyState, setHourlyState] = useState<"loading" | "ok" | "unavailable">("loading");
  const [extraCalendar, setExtraCalendar] = useState<{ month: string; calendar: UsageCalendar | null } | null>(null);
  const today = details.date;
  const extraMonth = range === "week" ? weekExtraMonth(today) : null;
  const chooseRange = (next: TrendRange) => {
    setRange(next);
    try { localStorage.setItem(TREND_RANGE_KEY, next); } catch { /* 同上 */ }
  };
  useEffect(() => {
    let active = true;
    setHourlyState("loading");
    void readUsageHourly(today)
      .then((value) => { if (active) { setHourly(value); setHourlyState("ok"); } })
      .catch(() => { if (active) setHourlyState("unavailable"); });
    return () => { active = false; };
  }, [today, details.authority_revision]);
  useEffect(() => {
    if (!extraMonth) return; // 不清空：下方 month 比对已防陈旧，保留旧值避免切回周档时先闪一下灰斜纹
    let active = true;
    void readUsageCalendar(extraMonth)
      .then((calendar) => { if (active) setExtraCalendar({ month: extraMonth, calendar }); })
      .catch(() => { if (active) setExtraCalendar({ month: extraMonth, calendar: null }); });
    return () => { active = false; };
  }, [extraMonth]);

  const dayHref = (date: string) => sessionsDateHref(date);
  const buckets: TrendBucket[] = range === "day"
    ? buildHourBuckets(hourlyState === "ok" ? hourly : null, details.failure_hours, () => sessionsDateHref(today))
    : buildDayBuckets(
      range === "week" ? weekDates(today) : monthDates(monthOf(today)),
      today,
      { [monthOf(today)]: details.calendar, ...(extraMonth ? { [extraMonth]: extraCalendar?.month === extraMonth ? extraCalendar.calendar : null } : {}) },
      details.failure_days,
      dayHref,
      range === "month" ? 5 : 1,
    );
  const ready = range === "day" ? hourlyState !== "loading" : true;
  const hasUsage = buckets.some((bucket) => bucketTotal(bucket) > 0);
  const hasFailures = buckets.some((bucket) => (bucket.failures ?? 0) > 0);
  const subtitle = range === "day" ? today : range === "week" ? `${weekDates(today)[0]} – ${weekDates(today)[6]}` : monthOf(today);
  const unavailable = range === "day" && hourlyState === "unavailable";
  const note = range === "day" ? message("overview.trendNote", language) : message(range === "week" ? "trend.weekNote" : "trend.monthNote", language);
  return <section className="info-panel overview-trend" aria-labelledby="overview-trend-title">
    <div className="section-heading">
      <div><p className="eyebrow">{subtitle}</p><h3 id="overview-trend-title">{message(`trend.rangeTitle.${range}` as MessageKey, language)}</h3></div>
      <div className="trend-range-switch" role="group" aria-label={message("trend.rangeLabel", language)}>
        {TREND_RANGES.map((value) => <button key={value} type="button" aria-pressed={range === value} onClick={() => chooseRange(value)}>{message(`trend.range.${value}` as MessageKey, language)}</button>)}
      </div>
    </div>
    {unavailable ? <p className="overview-empty">{message("overview.trendHourlyUnavailable", language)}</p> : <>
      <UsageTrendChart buckets={buckets} ariaLabel={message(`trend.rangeTitle.${range}` as MessageKey, language)} barMax={range === "week" ? 72 : undefined} />
      {!hasUsage && !hasFailures && ready && <p className="overview-empty">{message(range === "day" ? "overview.trendEmpty" : "trend.noUsage", language)}</p>}
      <p className="overview-trend-note">{note}</p>
    </>}
  </section>;
}


/**
 * R2（OVERVIEW_DRILLDOWN spec §4.3）：总览内嵌发现条——画布首发承诺
 * 「发现作为相关页面中的事项呈现」的落地。只读 findings_groups_safe 的
 * 既有脱敏投影（零新载荷字段），top 3；每项给「去看证据」的可达路径
 * （执行环境会话深链）。两态诚实降级：服务不可用如实说，零发现是诚实空态。
 */
function OverviewFindingsStrip() {
  const [state, setState] = useState<"loading" | "ok" | "unavailable">("loading");
  const [items, setItems] = useState<FindingGroup[]>([]);
  useEffect(() => {
    let active = true;
    void readFindings(null)
      .then((report) => { if (active) { setItems(report.issues.slice(0, 3)); setState("ok"); } })
      .catch(() => { if (active) setState("unavailable"); });
    return () => { active = false; };
  }, []);
  if (state === "loading") return null;
  if (state === "unavailable") {
    return <section className="info-panel overview-findings" aria-labelledby="overview-findings-title"><p id="overview-findings-title" className="overview-findings-note">{message("overview.findingsUnavailable")}</p></section>;
  }
  if (items.length === 0) {
    return <section className="info-panel overview-findings" aria-labelledby="overview-findings-title"><p id="overview-findings-title" className="overview-findings-note">{message("overview.findingsEmpty")}</p></section>;
  }
  return (
    <section className="info-panel overview-findings" aria-labelledby="overview-findings-title">
      <div className="section-heading"><p className="eyebrow">{message("overview.findings")}</p><h3 id="overview-findings-title">{message("overview.attention")}</h3></div>
      <ul className="overview-findings-list">
        {items.map((item) => (
          <li key={item.group_id} className={`overview-finding severity-${item.severity}`}>
            <span className="finding-rule">{item.rule}</span>
            <small>{harnessName(item.harness)} · {message("overview.findingCounts", undefined, { cases: item.count, sessions: item.sessions_count })}</small>
            {item.sessions_count > 0 && item.harness !== "generic" && item.harness !== "all" && item.harness
              ? <a className="inline-drill" href={sessionsHarnessHref(item.harness)}>{message("overview.openSessions")} <span aria-hidden="true">→</span></a>
              : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function OverviewPage({ overview, details }: { overview: OverviewSnapshot | null; details: OverviewDetails | null }) {
  const language = useLanguage();
  // hooks 必须在任何提前返回之前调用：overview 为 null（首屏加载）与有数据是同一组件的前后两次渲染，
  // 放在 return 后面会让 hook 数量变化，React 报「Rendered more hooks」并把页面渲成空白。
  const todayBase = todaySpendCard(details?.daily ?? null, details?.monthly ?? null);
  const monthBase = monthSpendCard(details?.monthly ?? null);
  const todayConversion = useConvertedAmounts(todayBase.amounts);
  const monthConversion = useConvertedAmounts(monthBase.amounts);
  if (!overview) return <section className="empty-state" aria-live="polite"><p className="eyebrow">{message("overview.loading", language)}</p><h2>{message("overview.preparing", language)}</h2><p>{message("overview.loadingDetail", language)}</p></section>;
  const budgetTone = overview.budget.level === "over" ? "warning" : overview.budget.level === "warn" ? "warning" : overview.budget.level === "ok" ? "success" : "neutral";
  const measuredHarnesses = details?.monthly && details.monthly.freshness !== "unavailable" && details.monthly.freshness !== "unknown"
    ? Object.values(details.monthly.tokens_by_harness).filter((harness) => harness.total > 0).length : null;
  const cacheHit = todayCacheHitRatio(details?.daily ?? null);
  // 报告币种折算（后端算、带出处）；折不了就保持分币种。
  const todaySpend = applyConversion(todayBase, todayConversion);
  const monthSpend = applyConversion(monthBase, monthConversion);
  return <>
    {details?.errors.length ? <div className="error-banner" role="status">{message("overview.partialError", language, { errors: details.errors.join("; ") })}</div> : null}
    <section className="stats-grid" aria-label={message("overview.status", language)}>
      <StatCard label={message("overview.todayTokens", language)} value={tokensLabel(overview.today_tokens)} detail={overview.today_tokens == null ? message("overview.noToday", language) : cacheHit == null ? message("overview.noCacheRatio", language) : message("overview.cacheRatio", language, { ratio: (cacheHit * 100).toFixed(2) })} />
      <StatCard label={message("overview.todayCost", language)} value={todaySpend.value} detail={todaySpend.detail} />
      <StatCard label={message("overview.monthSpend", language)} value={monthSpend.value} detail={monthSpend.detail} />
      <StatCard label={message("overview.activeHarnesses", language)} value={measuredHarnesses == null ? "—" : String(measuredHarnesses)} detail={measuredHarnesses == null ? message("overview.noMonthlyCoverage", language) : message("overview.harnessesObserved", language)} />
    </section>
    {details && <TrendPanel details={details} />}
    <section className="overview-detail-grid" aria-label={message("overview.authoritativeSummaries", language)}>
      <section className="info-panel overview-panel">
        <div><p className="eyebrow">{message("overview.monthlySummary", language, { month: details?.monthly?.month ?? details?.month ?? "—" })}</p><h3>{summaryTokens(details?.monthly ?? null)}</h3><p className="overview-panel-copy">{details?.monthly && details.monthly.freshness !== "unavailable" && details.monthly.freshness !== "unknown" ? `${basisLines(details.monthly.spend_by_basis)}${details.monthly.has_unresolved ? ` · ${message("overview.unresolved", language)}` : ""}${summaryFreshnessNote(details.monthly)}` : message("overview.monthlyUnavailable", language)}</p></div>
        {(() => { const state = summaryState(details?.monthly?.freshness ?? "unavailable"); return <StatusPill tone={state.tone}>{details?.monthly ? `${state.label} · ${details.monthly.coverage.measured_fields}/${details.monthly.coverage.total_fields}` : state.label}</StatusPill>; })()}
      </section>
      <section className="info-panel overview-panel">
        <div><p className="eyebrow">{message("overview.dailySummary", language, { date: details?.date ?? "—" })}</p><h3>{summaryTokens(details?.daily ?? null)}</h3><p className="overview-panel-copy">{details?.daily && details.daily.freshness !== "unavailable" && details.daily.freshness !== "unknown" ? `${basisLines(details.daily.spend_by_basis)}${Object.keys(details.monthly?.spend_by_basis.fixed_subscription ?? {}).length ? ` · ${message("overview.dailyAllocNote", language)}` : ""}${details.daily.has_unresolved ? ` · ${message("overview.unresolved", language)}` : ""}${summaryFreshnessNote(details.daily)}` : message("overview.dailyUnavailable", language)}</p></div>
        {(() => { const state = summaryState(details?.daily?.freshness ?? "unavailable"); return <StatusPill tone={state.tone}>{details?.daily ? `${state.label} · ${details.daily.coverage.measured_fields}/${details.daily.coverage.total_fields}` : state.label}</StatusPill>; })()}
      </section>
    </section>
    {details?.monthly && details.monthly.freshness !== "unavailable" && details.monthly.freshness !== "unknown" && <section className="overview-harness-panel" aria-labelledby="overview-month-harness-title">
      <div className="section-heading"><div><p className="eyebrow">{message("overview.harnessBreakdown", language)}</p><h3 id="overview-month-harness-title">{message("overview.harnessTokens", language)}</h3></div><span className="count-badge">{message("overview.harnessCount", language, { count: Object.values(details.monthly.tokens_by_harness).filter((harness) => harness.total > 0).length })}</span></div>
      <div className="overview-harness-list">{Object.entries(details.monthly.tokens_by_harness).filter(([, tokens]) => tokens.total > 0).map(([harness, tokens]) => <article className="overview-harness-row" key={harness}><div><strong>{harnessName(harness)}</strong><span>{harnessTokensLabel(tokens)}</span></div><b>{message("overview.tokensValue", language, { value: tokensLabel(tokens.total) })}</b></article>)}</div>
      {Object.values(details.monthly.tokens_by_harness).some((harness) => harness.total === 0) && <p className="overview-empty">{message("overview.harnessesNoUsage", language, { harnesses: Object.entries(details.monthly.tokens_by_harness).filter(([, tokens]) => tokens.total === 0).map(([harness]) => harness).join(", ") })}</p>}
      <p className="overview-empty">{message("overview.costScope", language)}</p>
    </section>}
    <DecisionArea monthly={details?.monthly ?? null} />
    <OverviewFindingsStrip />
    {details?.calendar && <section className="info-panel overview-recent-panel" aria-labelledby="overview-recent-title">
      <div className="section-heading"><div><p className="eyebrow">{message("overview.recentDays", language)}</p><h3 id="overview-recent-title">{details.calendar.month}</h3></div><span className="count-badge">{message("count.days", language, { count: details.calendar.days.length })}</span></div>
      <div className="overview-recent-list">{details.calendar.days.slice(-5).reverse().map((day) => <a className="overview-recent-row overview-drill" key={day.date} href={sessionsDateHref(day.date)} title={message("overview.openDate", language, { date: day.date })}><span>{day.date}</span><strong>{tokensLabel(day.total_tokens)} tokens</strong><small>{moneyDetail(day.costs)}</small></a>)}</div>
    </section>}
    <div className="overview-detail-grid">
      <section className="info-panel overview-panel" aria-labelledby="overview-budget-title">
        <div><p className="eyebrow">{message("overview.budget", language)}</p><h3 id="overview-budget-title">{message("overview.monthBudget", language)}</h3><p className="overview-panel-copy">{overview.budget.month_cost == null || overview.budget.monthly_cny == null ? message("overview.noBudgetAmount", language) : message("overview.budgetUsed", language, { used: formatMajorMoney(overview.budget.month_cost, "CNY"), limit: formatMajorMoney(overview.budget.monthly_cny, "CNY") })}</p></div>
        <StatusPill tone={budgetTone}>{budgetStatusLabel(overview.budget.level)}</StatusPill>
      </section>
      <section className="info-panel overview-panel" aria-labelledby="overview-sync-title">
        <div><p className="eyebrow">{message("overview.dataFreshness", language)}</p><h3 id="overview-sync-title">{overview.freshness}</h3><p className="overview-panel-copy">{message("overview.syncStage", language, { stage: syncStageLabel(overview.sync.stage), amount: formatMajorMoney(overview.subscription_cny_month, "CNY") })}</p></div>
        <button className="button button-secondary" type="button" onClick={() => { window.location.hash = "trust"; }}>{message("overview.viewTrust", language)}</button>
      </section>
    </div>
    <section className="overview-harness-panel" aria-labelledby="overview-harness-title">
      <div className="section-heading"><div><p className="eyebrow">{message("overview.harnessCoverage", language)}</p><h3 id="overview-harness-title">{message("overview.localAgents", language)}</h3></div><span className="count-badge">{overview.harness_rows.length ? overview.harness_rows.length : overview.harnesses == null ? "—" : overview.harnesses}</span></div>
      {overview.harness_rows.length ? <div className="overview-harness-list">{overview.harness_rows.map((harness) => <a className="overview-harness-row overview-drill" key={harness.harness} href={sessionsHarnessHref(harness.harness)} title={message("overview.openHarness", language, { harness: harnessName(harness.harness) })}><div><strong>{harnessName(harness.harness)}</strong><span>{harness.today_sessions == null ? message("overview.harnessSessionsUnavailable", language) : message("count.sessions", language, { count: harness.today_sessions })} · {harnessStatusLabel(harness.status)}</span></div><b>{tokensLabel(harness.today_tokens)} token</b></a>)}</div> : <p className="overview-empty">{message("overview.harnessSnapshotMissing", language)}</p>}
    </section>
  </>;
}
