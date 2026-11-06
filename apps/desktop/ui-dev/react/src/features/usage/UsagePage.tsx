import { harnessName } from "../../lib/harnessNames";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  listenAppEvents,
  makeInvalidationGate,
  readUsageCalendar,
  readUsageHourly,
  readUsageSourceSummary,
  readStatisticsTimezone,
  safeUiError,
  type UsageCalendar,
  type UsageDay,
  type UsageHourly,
  type UsageSourceSummary,
} from "../../lib/tauri";
import { sessionsDateHref } from "../../lib/nav";
import { ToolbarActions } from "../../components/ui/ToolbarActions";
import { UsageTrendChart } from "../../components/UsageTrendChart";
import { buildHourBuckets } from "./trendBuckets";
import { stable, isBackground } from "../../lib/stable";
import { formatMajorMoney, message, resolvedLanguage, useLanguage, type MessageKey, formatTokenCount } from "../../lib/i18n";

type Metric = "tokens" | "cost";

function currentMonth(timezone?: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit" }).format(new Date());
}

function todayDate(timezone?: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function shiftMonth(month: string, delta: number): string {
  const [year, index] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, index - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function tokensLabel(value: number): string {
  return formatTokenCount(value);
}

function costsLabel(costs: Record<string, number>): string {
  const parts = Object.entries(costs).filter(([, amount]) => amount > 0).map(([currency, amount]) => formatMajorMoney(amount, currency));
  return parts.length ? parts.join(" · ") : message("usage.noCost");
}

/** 日历格子按 (币种, 口径) 分行：同币种不同口径（estimate / API 等价 / 实付）相加是编造，格子主值也不例外。 */
function dayBasisGroups(day: UsageDay): Array<{ amount: string; basis: string }> {
  const groups = new Map<string, { currency: string; basis: string; amount: number }>();
  for (const line of day.cost_lines) {
    const key = `${line.currency}|${line.basis}`;
    const entry = groups.get(key) ?? { currency: line.currency, basis: line.basis, amount: 0 };
    entry.amount += line.amount;
    groups.set(key, entry);
  }
  return [...groups.values()].filter((entry) => entry.amount > 0).map((entry) => ({ amount: formatMajorMoney(entry.amount, entry.currency), basis: entry.basis }));
}

function costLinesLabel(lines: UsageDay["cost_lines"]): string {
  const labels: Record<string, string> = { dsh: "DSH", claude: "Claude", codex: "Codex" };
  return lines.map((line) => `${labels[line.source]} ${formatMajorMoney(line.amount, line.currency)} (${message(`usage.basis.${line.basis}` as MessageKey)})`).join(" · ");
}

function spendBasisLabel(spend: UsageSourceSummary["spend_by_basis"]): string {
  const known = ["metered_actual", "harness_billed", "fixed_subscription", "metered_declared", "metered_estimate", "api_equivalent", "other"];
  const lines = Object.entries(spend).flatMap(([basis, amounts]) => Object.entries(amounts).filter(([, amount]) => amount > 0).map(([currency, amount]) => `${known.includes(basis) ? message(`usage.basis.${basis}` as MessageKey) : basis} ${formatMajorMoney(amount, currency)}`));
  return lines.length ? lines.join(" · ") : message("usage.noBillAmount");
}

// 日期/星期跟应用语言而非系统区域：系统是中文、应用选 English 时曾显示「2026年9月」「周日」。
function appLocale(): string { return resolvedLanguage() === "en" ? "en-US" : "zh-CN"; }

function monthTitle(month: string): string {
  const [year, index] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(appLocale(), { year: "numeric", month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, index - 1, 15)));
}

function sourceLabel(value: string | null): string {
  return message(value ? "usage.harnessFacts" : "usage.noHours");
}

function freshnessLabel(value: UsageSourceSummary["freshness"]): string {
  return message(`overview.${value}` as MessageKey);
}

function dateParts(month: string): { leading: number; days: number } {
  const [year, index] = month.split("-").map(Number);
  return { leading: new Date(Date.UTC(year, index - 1, 1)).getUTCDay(), days: new Date(Date.UTC(year, index, 0)).getUTCDate() };
}

function dayFor(calendar: UsageCalendar | null, date: string): UsageDay | undefined {
  return calendar?.days.find((day) => day.date === date);
}

function dayTokens(day: UsageDay | undefined): number {
  return day?.total_tokens ?? 0;
}

function harnessTokenLines(day: UsageDay | undefined): string {
  if (!day) return message("usage.noObservedHarnesses");
  const values: Array<[string, number]> = [["DSH", day.dsh_tokens], ["CC", day.claude_tokens], ["CX", day.codex_tokens]];
  const lines = values.filter(([, tokens]) => tokens > 0).map(([label, tokens]) => `${label} ${tokensLabel(tokens)}`);
  return lines.length ? lines.join(" · ") : message("usage.noObservedHarnesses");
}

export function UsagePage() {
  const language = useLanguage();
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [timezoneReady, setTimezoneReady] = useState(false);
  const [month, setMonth] = useState(() => currentMonth());
  const [metric, setMetric] = useState<Metric>("tokens");
  const [calendar, setCalendar] = useState<UsageCalendar | null>(null);
  const [source, setSource] = useState<UsageSourceSummary | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [hourly, setHourly] = useState<UsageHourly | null>(null);
  const [loading, setLoading] = useState(true);
  const [hourlyLoading, setHourlyLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [hourlyError, setHourlyError] = useState<string | null>(null);
  const monthRequest = useRef(0);
  const mounted = useRef(false);
  const loadedCalendarMonth = useRef<string | null>(null);
  const [hourlyReloadKey, setHourlyReloadKey] = useState(0);
  const hourlyDate = useRef<string | null>(null);

  const calendarSeen = useRef<string | null>(null);
  const loadMonth = (requestedMonth: string, background: unknown = false) => {
    const quiet = isBackground(background);
    const requestId = ++monthRequest.current;
    if (!quiet) setLoading(true);
    setError(null);
    setSourceError(null);
    // Keep the last known projection visible during a refresh. The rendered
    // month below is derived from the returned DTO, so stale data is never
    // presented as if it belonged to the newly requested month.
    const changingMonth = loadedCalendarMonth.current !== requestedMonth;
    if (changingMonth) {
      setSelectedDate(null);
      setHourly(null);
      setHourlyError(null);
    }
    void Promise.allSettled([readUsageCalendar(requestedMonth), readUsageSourceSummary(requestedMonth)]).then(([calendarResult, sourceResult]) => {
      if (!mounted.current || requestId !== monthRequest.current) return;
      if (calendarResult.status === "fulfilled") {
        setCalendar((previous) => stable(previous, calendarResult.value));
        loadedCalendarMonth.current = calendarResult.value.month;
        if (changingMonth) {
          const first = calendarResult.value.days.find((day) => day.total_tokens > 0)?.date ?? null;
          const today = todayDate(timezone);
          setSelectedDate(first && first <= today ? first : null);
        }
        // 后台刷新到「没变化的日历」时不重取小时数据；变了才触发。手动/换月照常。
        const fingerprint = JSON.stringify(calendarResult.value);
        if (!quiet || calendarSeen.current !== fingerprint) setHourlyReloadKey((value) => value + 1);
        calendarSeen.current = fingerprint;
      } else {
        setError(safeUiError(calendarResult.reason, "用量日历暂不可用"));
      }
      if (sourceResult.status === "fulfilled") {
        setSource((previous) => stable(previous, sourceResult.value));
      } else {
        setSourceError(safeUiError(sourceResult.reason, "来源状态暂不可用"));
      }
      setLoading(false);
    });
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      monthRequest.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!timezoneReady) return undefined;
    loadMonth(month);
    return () => { monthRequest.current += 1; };
  }, [month, timezoneReady]);

  useEffect(() => {
    let active = true;
    void readStatisticsTimezone().then(({ timezone: next }) => {
      if (!active) return;
      setTimezone(next);
      setMonth((value) => value === currentMonth() ? currentMonth(next) : value);
      setTimezoneReady(true);
    }).catch(() => { if (active) setTimezoneReady(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = () => { if (active && timezoneReady) loadMonth(month, true); };
    let cleanups: Array<() => void> = [];
    const gate = makeInvalidationGate();
    void listenAppEvents((event) => { if (gate(event)) refresh(); }).then((unsubscribe) => {
      if (active) cleanups = [unsubscribe];
      else unsubscribe();
    });
    return () => { active = false; cleanups.forEach((unsubscribe) => unsubscribe()); };
  }, [month, timezone, timezoneReady]);

  useEffect(() => {
    if (!selectedDate) return;
    let active = true;
    // 同一天的后台重取保留已显示的小时图（不换成「正在读取」再换回来）；换日期才清空。
    const dateChanged = hourlyDate.current !== selectedDate;
    if (dateChanged) { setHourly(null); setHourlyLoading(true); }
    setHourlyError(null);
    void readUsageHourly(selectedDate).then((value) => {
      if (active) { hourlyDate.current = selectedDate; setHourly((previous) => stable(previous, value)); }
    }).catch((reason: unknown) => {
      if (active) setHourlyError(safeUiError(reason, "小时用量暂不可用"));
    }).finally(() => { if (active) setHourlyLoading(false); });
    return () => { active = false; };
  }, [selectedDate, hourlyReloadKey]);

  const totals = useMemo(() => {
    const tokens = calendar?.days.reduce((sum, day) => sum + day.total_tokens, 0) ?? 0;
    const costs: Record<string, number> = {};
    calendar?.days.forEach((day) => Object.entries(day.costs).forEach(([currency, amount]) => { costs[currency] = (costs[currency] ?? 0) + amount; }));
    // 按 (币种, 口径) 分列：claude 的 metered_estimate 与 codex 的 api_equivalent
    // 同为 USD 但口径不同，相加成一个数（曾显示 USD 151.70）就是编造。
    const byBasis = new Map<string, { currency: string; basis: string; amount: number }>();
    calendar?.days.forEach((day) => day.cost_lines.forEach((line) => {
      const key = `${line.currency}|${line.basis}`;
      const entry = byBasis.get(key) ?? { currency: line.currency, basis: line.basis, amount: 0 };
      entry.amount += line.amount;
      byBasis.set(key, entry);
    }));
    return { tokens, costs, byBasis: [...byBasis.values()].filter((entry) => entry.amount > 0) };
  }, [calendar]);
  const today = todayDate(timezone);
  const displayedMonth = calendar?.month ?? source?.month ?? month;
  const calendarForDisplayedMonth = calendar?.month === displayedMonth ? calendar : null;
  // Calendar and source summary are independent projections. Summary cards
  // only combine matching windows; the source panel below can still show a
  // successfully-read older/newer source window with an explicit label.
  const sourceForDisplayedMonth = source?.month === displayedMonth ? source : null;
  const displayedTokens = sourceForDisplayedMonth?.total_tokens ?? (calendarForDisplayedMonth ? totals.tokens : null);
  const harnessTokens = sourceForDisplayedMonth ? Object.entries(sourceForDisplayedMonth.tokens_by_harness)
    .filter(([, value]) => value.total > 0).sort((a, b) => b[1].total - a[1].total) : [];
  const sourceForPanel = source;
  const layout = dateParts(displayedMonth);
  const selectedDay = dayFor(calendarForDisplayedMonth, selectedDate ?? "");

  return <>
    <h2 id="usage-title" className="visually-hidden">{message("usage.title", language)}</h2>
    <ToolbarActions>
      <div className="usage-toolbar">
        <button className="button button-secondary" type="button" aria-label={message("usage.previousMonth", language)} onClick={() => setMonth((value) => shiftMonth(value, -1))}>‹</button>
        <input className="usage-month" type="month" aria-label={message("usage.chooseMonth", language)} value={month} onChange={(event) => setMonth(event.target.value || currentMonth(timezone))} />
        <button className="button button-secondary" type="button" aria-label={message("usage.nextMonth", language)} disabled={month >= currentMonth(timezone)} onClick={() => setMonth((value) => shiftMonth(value, 1))}>›</button>
        <label className="usage-metric">{message("usage.display", language)}<select aria-label={message("usage.metric", language)} value={metric} onChange={(event) => setMetric(event.target.value as Metric)}><option value="tokens">Tokens</option><option value="cost">{message("usage.cost", language)}</option></select></label>
      </div>
    </ToolbarActions>
    {error && <div className="error-banner" role="alert">{message("usage.calendarError", language, { error })}</div>}
    {sourceError && <div className="error-banner" role="alert">{message("usage.sourceError", language, { error: sourceError })}</div>}
    {loading && !calendar && !source && <section className="empty-state" aria-live="polite"><p className="eyebrow">{message("usage.loading", language)}</p><h3>{message("usage.loadingMonth", language, { month: monthTitle(month) })}</h3><p>{message("usage.loadingDetail", language)}</p></section>}
    {loading && (calendar || source) && <div className="usage-refresh-status" role="status" aria-live="polite">{message("usage.refreshing", language, { requested: monthTitle(month), displayed: monthTitle(displayedMonth) })}</div>}
    {(calendar || source) && <div aria-busy={loading || undefined}>
      <section className="usage-summary-grid" aria-label={message("usage.summary", language)}>
        <article className="stat-card"><p className="eyebrow">{monthTitle(displayedMonth)} tokens</p><p className="stat-value">{displayedTokens !== null ? tokensLabel(displayedTokens) : "—"}</p><p className="stat-detail">{message(sourceForDisplayedMonth ? "usage.sourceAggregate" : calendarForDisplayedMonth ? "usage.calendarCoverageOnly" : "usage.monthUnavailable", language)}</p></article>
        <article className="stat-card"><p className="eyebrow">{calendarForDisplayedMonth ? message("usage.calendarCost", language, { month: monthTitle(displayedMonth) }) : message("usage.sourceCost", language)}</p><p className="stat-value stat-value-compact">{calendarForDisplayedMonth ? (totals.byBasis.length ? totals.byBasis.map((entry) => `${formatMajorMoney(entry.amount, entry.currency)} (${message(`usage.basis.${entry.basis}` as MessageKey)})`).join(" · ") : message("usage.noCost")) : "—"}</p><p className="stat-detail">{sourceForDisplayedMonth ? `${spendBasisLabel(sourceForDisplayedMonth.spend_by_basis)} · ${message("usage.calendarNoSubscription", language)}` : message("usage.sourceUnaligned", language)}</p></article>
        <article className="stat-card"><p className="eyebrow">{sourceForDisplayedMonth ? message("usage.monthFreshness", language, { month: monthTitle(sourceForDisplayedMonth.month) }) : message("usage.freshness", language)}</p><p className="stat-value stat-value-compact">{sourceForDisplayedMonth ? freshnessLabel(sourceForDisplayedMonth.freshness) : "—"}</p><p className="stat-detail">{sourceForDisplayedMonth?.last_observed_at ? message("usage.lastObserved", language, { date: sourceForDisplayedMonth.last_observed_at }) : message("usage.sourceStateUnaligned", language)}</p></article>
      </section>
      <section className="usage-harness-summary" aria-label={message("usage.harnessBreakdown", language)}>{harnessTokens.length ? harnessTokens.map(([harness, value]) => <div key={harness}><span>{harnessName(harness)}</span><strong>{tokensLabel(value.total)}</strong></div>) : <div><span>{message("usage.harnessBreakdownShort", language)}</span><strong>—</strong></div>}<p>{message("usage.harnessBreakdownNote", language, { month: monthTitle(displayedMonth) })}</p></section>
      <section className="usage-calendar-panel" aria-labelledby="usage-calendar-title">
        <div className="section-heading"><div><p className="eyebrow">{message("usage.calendar", language)}</p><h3 id="usage-calendar-title">{monthTitle(displayedMonth)}</h3></div><span className="count-badge">{message("count.days", language, { count: calendarForDisplayedMonth?.days.length ?? 0 })}</span></div>
        {calendarForDisplayedMonth && totals.tokens > 0 ? <div className="usage-calendar-grid" role="grid" aria-label={message("usage.calendarGrid", language, { month: monthTitle(displayedMonth) })}>
          {Array.from({ length: 7 }, (_, day) => new Intl.DateTimeFormat(appLocale(), { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + day)))).map((day, index) => <span className="usage-calendar-dow" role="columnheader" key={index}>{day}</span>)}
          {Array.from({ length: layout.leading }, (_, index) => <span className="usage-calendar-cell usage-calendar-blank" aria-hidden="true" key={`blank-${index}`} />)}
          {Array.from({ length: layout.days }, (_, index) => {
            const date = `${displayedMonth}-${String(index + 1).padStart(2, "0")}`;
            const day = dayFor(calendarForDisplayedMonth, date);
            const future = date > today;
            const selected = selectedDate === date;
            const value = metric === "tokens" ? (day ? tokensLabel(day.total_tokens) : "—") : (day ? (dayBasisGroups(day).map((group) => `${group.amount} (${message(`usage.basis.${group.basis}` as MessageKey)})`).join(" · ") || message("usage.noCost")) : "—");
            const harnesses = day && metric === "tokens" ? message("usage.dayHarnesses", language, { harnesses: harnessTokenLines(day) }) : "";
            return <button className={`usage-calendar-cell ${day && day.total_tokens > 0 ? "usage-calendar-has-data" : ""} ${selected ? "usage-calendar-selected" : ""} ${future ? "usage-calendar-future" : ""}`} type="button" role="gridcell" key={date} disabled={future} aria-selected={selected} aria-label={message("usage.dayCell", language, { date, value, harnesses, action: message(future ? "usage.futureDay" : "usage.openHour", language) })} onClick={() => setSelectedDate(date)}><span>{index + 1}</span>{metric === "cost" && day ? <strong className="usage-cost-lines">{dayBasisGroups(day).length ? dayBasisGroups(day).map((group) => <span key={group.basis + group.amount}>{group.amount}<small className="usage-basis-tag">{message(`usage.basisShort.${group.basis}` as MessageKey, language)}</small></span>) : message("usage.noCost", language)}</strong> : <strong>{value}</strong>}{metric === "tokens" && day && day.total_tokens > 0 && <small className="usage-harness-breakdown">{harnessTokenLines(day)}</small>}{metric === "cost" && day && day.total_tokens > 0 && <small>{day.cost_lines.length ? costLinesLabel(day.cost_lines) : `${tokensLabel(day.total_tokens)} tokens`}</small>}</button>;
          })}
        </div> : <div className="usage-empty">{message(calendarForDisplayedMonth ? "usage.emptyMeasured" : "usage.emptyUnavailable", language)}</div>}
        <p className="usage-note">{message(metric === "tokens" ? "usage.tokensNote" : "usage.costNote", language)}</p>
      </section>
      <section className="usage-detail-grid">
        <section className="usage-hourly-panel" aria-labelledby="usage-hourly-title">
          <div className="section-heading"><div><p className="eyebrow">{message("usage.hourly", language)}</p><h3 id="usage-hourly-title">{selectedDate ? `${selectedDate}${selectedDate === today ? ` · ${message("usage.today", language)}` : ""}` : message("usage.selectDay", language)}</h3></div><div className="heading-side">{selectedDay && <span className="count-badge">{tokensLabel(dayTokens(selectedDay))}</span>}{selectedDate && <a className="inline-drill" href={sessionsDateHref(selectedDate)}>{message("usage.daySessions", language)} <span aria-hidden="true">→</span></a>}</div></div>
          {hourlyLoading && <p className="usage-empty">{message("usage.loadingHours", language)}</p>}
          {hourlyError && <p className="usage-empty" role="alert">{hourlyError}</p>}
          {!hourlyLoading && !hourlyError && hourly && <><UsageTrendChart buckets={buildHourBuckets(hourly, undefined)} ariaLabel={message("usage.hourly", language)} showFailures={false} /><p className="usage-note">{message("usage.hourlyNote", language, { sources: Object.entries(hourly.harnesses_available).map(([harness, value]) => `${harness}: ${sourceLabel(value)}`).join(" · ") })}</p></>}
        </section>
        <section className="usage-source-panel" aria-labelledby="usage-source-title"><div className="section-heading"><div><p className="eyebrow">{message("usage.sourceStatus", language)}</p><h3 id="usage-source-title">{message("usage.coverageFreshness", language)}</h3>{sourceForPanel && <p className="section-meta">{message("usage.window", language, { month: monthTitle(sourceForPanel.month) })}</p>}</div><span className="count-badge">{sourceForPanel ? `${sourceForPanel.coverage.measured_fields}/${sourceForPanel.coverage.total_fields}` : "—"}</span></div>{sourceForPanel ? <dl className="usage-source-list"><div><dt>{message("usage.recordedCharges", language)}</dt><dd>{Object.keys(sourceForPanel.actual_spend).length ? costsLabel(sourceForPanel.actual_spend) : message("usage.noData", language)}</dd></div><div><dt>{message("usage.status", language)}</dt><dd>{freshnessLabel(sourceForPanel.freshness)}</dd></div><div><dt>{message("usage.lastObservedLabel", language)}</dt><dd>{sourceForPanel.last_observed_at ?? message("usage.noTimeEvidence", language)}</dd></div><div><dt>{message("usage.unresolved", language)}</dt><dd>{sourceForPanel.has_unresolved ? message("usage.unresolvedYes", language) : message("usage.none", language)}</dd></div><div><dt>{message("usage.excludedHarnesses", language)}</dt><dd>{sourceForPanel.excluded_harnesses.length ? sourceForPanel.excluded_harnesses.join(", ") : message("usage.none", language)}</dd></div></dl> : <p className="usage-empty">{message("usage.sourceUnavailable", language)}</p>}<p className="usage-note">{message("usage.coverageNote", language)}</p></section>
      </section>
    </div>}
  </>;
}
