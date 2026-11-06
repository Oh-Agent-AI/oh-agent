import { harnessName } from "../../lib/harnessNames";
import { stable, isBackground } from "../../lib/stable";
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  listenAppEvents,
  makeInvalidationGate,
  readSessions,
  readStatisticsTimezone,
  safeUiError,
  type SessionCostStatus,
  type SessionRow,
  type SessionsCostFilter,
  type SessionsFilters,
  type SessionsPage as SessionsPageData,
  type SessionsWindow,
} from "../../lib/tauri";
import { readSessionsDeepLinkFromHash } from "../../lib/nav";
import { SessionDetail } from "./SessionDetail";
import { costReasonText, formatCost } from "./costSummary";
import { Button, DateInput, Field, FilterBar, SelectInput, TextInput } from "../../components/ui/FormControls";
import { ToolbarActions } from "../../components/ui/ToolbarActions";
import { message, useLanguage, type AppLanguage, type MessageKey, formatTokenCount, modelLabel } from "../../lib/i18n";

const costStates: Array<{ value: SessionsCostFilter; label: MessageKey }> = [
  { value: "all", label: "sessions.billing.all" },
  { value: "estimated", label: "sessions.billing.estimated" },
  { value: "subscription", label: "sessions.billing.subscription" },
  { value: "unpriced", label: "sessions.billing.unpriced" },
  { value: "unavailable", label: "sessions.billing.unavailable" },
];

const DEFAULT_STATISTICS_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const SESSIONS_VIEW_STATE_KEY = "agent-vitals.sessions-view.v1";
type SessionNavigationTarget = { type: "sessionDetail"; session_ref: string; harness_kind: string } | { type: "sessionList"; harness_kind: string | null };

function loadSessionsViewState(): { filters: SessionsFilters; selectedSessionRef: string | null } | null {
  try {
    const raw = window.sessionStorage.getItem(SESSIONS_VIEW_STATE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as { filters?: Partial<SessionsFilters>; selectedSessionRef?: unknown };
    const filters = value.filters;
    if (!filters || !["month", "today", "7d", "day", "custom"].includes(filters.window ?? "") || !["all", "estimated", "subscription", "unpriced", "unavailable"].includes(filters.cost_status ?? "")) return null;
    const fallback = filtersForTimezone(DEFAULT_STATISTICS_TIMEZONE);
    const date = (item: unknown, backup: string) => typeof item === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item) ? item : backup;
    return {
      filters: {
        ...fallback, ...filters,
        month: typeof filters.month === "string" && /^\d{4}-\d{2}$/.test(filters.month) ? filters.month : fallback.month,
        day: date(filters.day, fallback.day),
        date_from: date(filters.date_from, fallback.date_from), date_to: date(filters.date_to, fallback.date_to),
        harness_kind: typeof filters.harness_kind === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(filters.harness_kind) ? filters.harness_kind : "all",
        model: typeof filters.model === "string" ? filters.model.slice(0, 120) : "",
        provider: typeof filters.provider === "string" ? filters.provider.slice(0, 120) : "",
      } as SessionsFilters,
      selectedSessionRef: typeof value.selectedSessionRef === "string" && /^sr_[A-Za-z0-9_-]{8,128}$/.test(value.selectedSessionRef) ? value.selectedSessionRef : null,
    };
  } catch { return null; }
}

function dateInTimezone(timezone: string, date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function filtersForTimezone(timezone: string): SessionsFilters {
  const today = dateInTimezone(timezone);
  return { window: "month", month: today.slice(0, 7), day: today, date_from: shiftDate(today, -6), date_to: today, harness_kind: "all", model: "", provider: "", cost_status: "all" };
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function compact(value: number): string {
  return formatTokenCount(value);
}

function dateLabel(value: string | null, language: AppLanguage): string {
  if (!value) return message("sessions.unknownTime", language);
  return value.slice(0, 16).replace("T", " ");
}

function dayLabel(value: string | null, language: AppLanguage): string {
  if (!value) return message("sessions.unknownDate", language);
  return value.slice(0, 10).replaceAll("-", "/");
}

function sessionTitle(row: SessionRow, language: AppLanguage): string {
  return message("sessions.sessionTitle", language, { harness: harnessName(row.harness), date: dayLabel(row.first_event_at, language) });
}

function costStateLabel(status: SessionCostStatus, language: AppLanguage): string {
  return `${costStateShort(status.state, language)} · ${costReasonText(status, language)}`;
}

function costStateShort(state: SessionCostStatus["state"], language: AppLanguage): string {
  return message(`sessions.billing.${state}`, language);
}

function costLabel(row: SessionRow): string {
  return formatCost(row.cost_minor) ?? "—";
}

function costBasisLabel(basis: string, language: AppLanguage): string {
  const known = ["metered_actual", "harness_billed", "fixed_subscription", "metered_declared", "metered_estimate", "api_equivalent"];
  return message(known.includes(basis) ? `usage.basis.${basis}` as MessageKey : "usage.basis.other", language);
}

function serverArgs(filters: SessionsFilters, cursor: string | null, timezone: string): Parameters<typeof readSessions>[0] {
  const args: Parameters<typeof readSessions>[0] = { page_size: 50, cursor };
  if (filters.window === "month") args.month = filters.month;
  const today = dateInTimezone(timezone);
  if (filters.window === "today") args.day = today;
  if (filters.window === "day") args.day = filters.day;
  if (filters.window === "7d") { args.date_from = shiftDate(today, -6); args.date_to = today; }
  if (filters.window === "custom") { args.date_from = filters.date_from; args.date_to = filters.date_to; }
  if (filters.harness_kind !== "all") args.harness_kind = filters.harness_kind;
  if (filters.model.trim()) args.model = filters.model.trim();
  if (filters.provider.trim()) args.provider = filters.provider.trim();
  return args;
}

function updateFilter(setFilters: Dispatch<SetStateAction<SessionsFilters>>, key: keyof SessionsFilters, value: string) {
  setFilters((current) => ({ ...current, [key]: value } as SessionsFilters));
}

export function SessionsPage({ navigationTarget = null, onNavigationTargetApplied }: { navigationTarget?: SessionNavigationTarget | null; onNavigationTargetApplied?: () => void }) {
  const language = useLanguage();
  const initialViewState = useMemo(() => loadSessionsViewState(), []);
  // R1 深链（OVERVIEW_DRILLDOWN spec §4.2）：#sessions?date=…&harness=… 优先于
  // 恢复的 view-state——深链是用户此刻的意图；切换窗口控件即离开 day 态。
  // date 与 harness 可组合（同时过滤）。**一次性消费**：应用后立即 replaceState
  // 去掉 query——否则 F5 会用旧深链压回用户后来切好的窗口（验收 P2-1）。
  const deepLinkToFilters = (base: SessionsFilters, deep: ReturnType<typeof readSessionsDeepLinkFromHash>): SessionsFilters => {
    if (!deep.date && !deep.harness) return base;
    let next: SessionsFilters = deep.date ? { ...base, window: "day" as const, day: deep.date } : base;
    if (deep.harness) next = { ...next, harness_kind: deep.harness };
    return next;
  };
  const consumeDeepLink = () => {
    if (window.location.hash.includes("?")) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#sessions`);
    }
  };
  const [filters, setFilters] = useState<SessionsFilters>(() => {
    const base = initialViewState?.filters ?? filtersForTimezone(DEFAULT_STATISTICS_TIMEZONE);
    const next = deepLinkToFilters(base, readSessionsDeepLinkFromHash());
    if (next !== base) consumeDeepLink();
    return next;
  });
  // 同页 hash 变化（侧栏重点「会话」/同页深链再进入）：重读深链参数——
  // 裸 #sessions 不动现有过滤；带新参数则应用并消费（验收 P2-2）。
  useEffect(() => {
    const onHashChange = () => {
      const deep = readSessionsDeepLinkFromHash();
      if (deep.date || deep.harness) {
        setFilters((current) => deepLinkToFilters(current, deep));
        consumeDeepLink();
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const [statisticsTimezone, setStatisticsTimezone] = useState(DEFAULT_STATISTICS_TIMEZONE);
  const [timezoneReady, setTimezoneReady] = useState(false);
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [windowTokens, setWindowTokens] = useState<number | null>(null);
  const [selectedSessionRef, setSelectedSessionRef] = useState<string | null>(() => initialViewState?.selectedSessionRef ?? null);
  const [detailRefreshKey, setDetailRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const requestInFlight = useRef(false);
  const pendingRefresh = useRef(false);
  // 详情现在是叠在列表上一层的浮层（不是并排列布局）：记住触发它的那一行，
  // 关闭时把焦点还回去；打开时锁住背景滚动、Esc 与点击背景都能关（2026-09-29
  // 真机反馈：并排列布局让用户看不出「点了一行之后发生了什么」）。
  const detailTriggerRef = useRef<HTMLElement | null>(null);
  const closeSessionDetail = () => {
    setSelectedSessionRef(null);
    detailTriggerRef.current?.focus();
  };
  const openSessionDetail = (ref: string, trigger: HTMLElement) => {
    detailTriggerRef.current = trigger;
    setSelectedSessionRef(ref);
  };
  useEffect(() => {
    if (!selectedSessionRef) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closeSessionDetail(); };
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionRef]);
  const dateFiltersTouched = useRef(Boolean(initialViewState));
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  useEffect(() => {
    try { window.sessionStorage.setItem(SESSIONS_VIEW_STATE_KEY, JSON.stringify({ filters, selectedSessionRef })); } catch { /* Optional UI preference; authority data remains unaffected. */ }
  }, [filters, selectedSessionRef]);
  const serverKey = useMemo(() => JSON.stringify([filters.window, filters.month, filters.day, filters.date_from, filters.date_to, filters.harness_kind, filters.model, filters.provider]), [filters]);
  const visibleRows = useMemo(() => filters.cost_status === "all" ? rows : rows.filter((row) => row.cost_status.state === filters.cost_status), [filters.cost_status, rows]);

  useEffect(() => {
    if (!navigationTarget) return;
    setFilters((current) => ({ ...current, harness_kind: navigationTarget.harness_kind || "all" }));
    setSelectedSessionRef(navigationTarget.type === "sessionDetail" ? navigationTarget.session_ref : null);
    onNavigationTargetApplied?.();
  }, [navigationTarget, onNavigationTargetApplied]);

  useEffect(() => {
    let active = true;
    void readStatisticsTimezone().catch(() => ({ timezone: DEFAULT_STATISTICS_TIMEZONE })).then(({ timezone }) => {
      if (!active) return;
      setStatisticsTimezone(timezone);
      if (!dateFiltersTouched.current) setFilters((current) => ({ ...filtersForTimezone(timezone), harness_kind: current.harness_kind }));
      setTimezoneReady(true);
    });
    return () => { active = false; };
  }, []);

  // 后台刷新（失效事件触发）不翻转 loading、不先清空分页游标、不换内容相同的数据引用，
  // 也只在列表真的变了才让详情面板重取——避免每次同步整个页面闪一遍。手动/换筛选照旧。
  const rowsFingerprint = useRef<string | null>(null);
  const pendingQuiet = useRef(true);
  const fetchFirstPage = async (background: unknown = false) => {
    const quiet = isBackground(background);
    if (!quiet) setDetailRefreshKey((value) => value + 1);
    if (requestInFlight.current) {
      pendingRefresh.current = true;
      if (!quiet) pendingQuiet.current = false;
      generation.current += 1;
      if (!quiet) setLoading(true);
      setError(null);
      return;
    }
    const currentFilters = filtersRef.current;
    const currentGeneration = ++generation.current;
    requestInFlight.current = true;
    if (!quiet) { setLoading(true); setNextCursor(null); }
    setError(null);
    try {
      const page = await readSessions(serverArgs(currentFilters, null, statisticsTimezone));
      if (currentGeneration !== generation.current) return;
      const fingerprint = JSON.stringify(page.sessions);
      if (quiet && rowsFingerprint.current !== fingerprint) setDetailRefreshKey((value) => value + 1);
      rowsFingerprint.current = fingerprint;
      setRows((previous) => stable(previous, page.sessions));
      setNextCursor(page.next_cursor);
      setTotal(page.window_session_count);
      setWindowTokens(page.window_total_tokens);
    } catch (reason: unknown) {
      if (currentGeneration !== generation.current) return;
      setError(safeUiError(reason, "会话数据暂不可用"));
      setTotal(null);
      setWindowTokens(null);
    } finally {
      if (currentGeneration === generation.current) setLoading(false);
      requestInFlight.current = false;
      if (pendingRefresh.current) {
        pendingRefresh.current = false;
        const quietNext = pendingQuiet.current;
        pendingQuiet.current = true;
        void fetchFirstPage(quietNext);
      }
    }
  };

  useEffect(() => { if (timezoneReady) void fetchFirstPage(); }, [serverKey, statisticsTimezone, timezoneReady]);

  useEffect(() => {
    let active = true;
    const refresh = () => { if (active) void fetchFirstPage(true); };
    let cleanups: Array<() => void> = [];
    const gate = makeInvalidationGate();
    void listenAppEvents((event) => { if (gate(event)) refresh(); })
      .then((unsubscribe) => { if (active) cleanups = [unsubscribe]; else unsubscribe(); });
    return () => { active = false; cleanups.forEach((unsubscribe) => unsubscribe()); };
  }, [serverKey, statisticsTimezone, timezoneReady]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore || requestInFlight.current) return;
    const currentGeneration = generation.current;
    requestInFlight.current = true;
    setLoadingMore(true);
    try {
      const page = await readSessions(serverArgs(filters, nextCursor, statisticsTimezone));
      if (currentGeneration !== generation.current) return;
      setRows((current) => {
        const known = new Set(current.map((row) => row.session_ref));
        return current.concat(page.sessions.filter((row) => !known.has(row.session_ref)));
      });
      setNextCursor(page.next_cursor);
      setTotal(page.window_session_count);
      setWindowTokens(page.window_total_tokens);
    } catch (reason: unknown) {
      if (currentGeneration === generation.current) setError(safeUiError(reason, "更多会话暂不可用"));
    } finally {
      setLoadingMore(false);
      requestInFlight.current = false;
      if (pendingRefresh.current) {
        pendingRefresh.current = false;
        void fetchFirstPage();
      }
    }
  };

  const selectedRow = rows.find((row) => row.session_ref === selectedSessionRef) ?? null;

  return <div className="sessions-workspace">
    <main className="sessions-list-pane">
    <>
    <h1 className="visually-hidden">{message("nav.sessions", language)}</h1>
    <ToolbarActions>
      <div className="sessions-header-actions">
        <span className="status-pill"><span aria-hidden="true" className="status-dot" />{message("sessions.safeList", language)}</span>
        <Button type="button" onClick={() => void fetchFirstPage()} disabled={loading}>{message("action.refresh", language)}</Button>
      </div>
    </ToolbarActions>

    <FilterBar aria-label={message("sessions.filters", language)} data-window={filters.window}>
      <Field label={message("sessions.window", language)} htmlFor="sessions-window"><SelectInput id="sessions-window" value={filters.window} onChange={(event) => { dateFiltersTouched.current = true; updateFilter(setFilters, "window", event.target.value); }}><option value="month">{message("sessions.month", language)}</option><option value="today">{message("sessions.today", language)}</option><option value="7d">{message("sessions.lastSevenDays", language)}</option><option value="day">{message("sessions.singleDay", language)}</option><option value="custom">{message("sessions.custom", language)}</option></SelectInput></Field>
      {filters.window === "day" && <Field label={message("sessions.date", language)} htmlFor="sessions-day"><DateInput id="sessions-day" type="date" value={filters.day} onChange={(event) => { dateFiltersTouched.current = true; updateFilter(setFilters, "day", event.target.value); }} /></Field>}
      {filters.window === "month" && <Field label={message("sessions.month", language)} htmlFor="sessions-month"><DateInput id="sessions-month" type="month" value={filters.month} onChange={(event) => { dateFiltersTouched.current = true; updateFilter(setFilters, "month", event.target.value); }} /></Field>}
      {filters.window === "custom" && <><Field label={message("sessions.startDate", language)} htmlFor="sessions-date-from"><DateInput id="sessions-date-from" type="date" value={filters.date_from} onChange={(event) => { dateFiltersTouched.current = true; updateFilter(setFilters, "date_from", event.target.value); }} /></Field><Field label={message("sessions.endDate", language)} htmlFor="sessions-date-to"><DateInput id="sessions-date-to" type="date" value={filters.date_to} onChange={(event) => { dateFiltersTouched.current = true; updateFilter(setFilters, "date_to", event.target.value); }} /></Field></>}
      <Field label={message("sessions.harness", language)} htmlFor="sessions-harness"><TextInput id="sessions-harness" list="session-harness-options" value={filters.harness_kind === "all" ? "" : filters.harness_kind} placeholder={message("sessions.allHarnesses", language)} onChange={(event) => updateFilter(setFilters, "harness_kind", event.target.value || "all")} /></Field>
      <datalist id="session-harness-options"><option value="codex" /><option value="claude-code" /><option value="dsh" /><option value="workbuddy" /><option value="harness:zcode" /><option value="harness:minimax-code" /></datalist>
      <Field label={message("sessions.model", language)} htmlFor="sessions-model"><TextInput id="sessions-model" value={filters.model} placeholder={message("sessions.exactMatch", language)} onChange={(event) => updateFilter(setFilters, "model", event.target.value)} /></Field>
      <Field label={message("sessions.provider", language)} htmlFor="sessions-provider"><TextInput id="sessions-provider" value={filters.provider} placeholder={message("sessions.exactMatch", language)} onChange={(event) => updateFilter(setFilters, "provider", event.target.value)} /></Field>
      <Field label={message("sessions.billingStatus", language)} htmlFor="sessions-cost"><SelectInput id="sessions-cost" value={filters.cost_status} onChange={(event) => updateFilter(setFilters, "cost_status", event.target.value)}>{costStates.map((state) => <option key={state.value} value={state.value}>{message(state.label, language)}</option>)}</SelectInput></Field>
    </FilterBar>

    {error && <div className="error-banner" role="alert">{message("sessions.dataError", language, { error })}</div>}
    {loading && rows.length > 0 && <div className="sessions-refresh-status" role="status" aria-live="polite">{message("sessions.refreshingWindow", language)}</div>}
    <section className="sessions-summary" aria-live="polite">
      <div><strong>{total === null ? "—" : total}</strong><span>{message("sessions.windowSessions", language)}</span></div>
      <div><strong>{windowTokens === null ? "—" : compact(windowTokens)}</strong><span>{message("sessions.windowTokens", language)}</span></div>
      <div><strong>{visibleRows.length}</strong><span>{message(filters.cost_status === "all" ? "sessions.currentPage" : "sessions.currentMatches", language)}</span></div>
      <p>{message("sessions.loaded", language, { count: rows.length })}</p>
    </section>

    <section className="sessions-panel" aria-labelledby="sessions-list-title">
      <div className="section-heading"><div><p className="eyebrow">{message("sessions.safeProjection", language)}</p><h3 id="sessions-list-title">{message("sessions.list", language)}</h3></div><span className="count-badge">{message(nextCursor ? "sessions.moreAvailable" : "sessions.loadedBadge", language)}</span></div>
      {loading && rows.length === 0 ? <div className="sessions-state" role="status"><strong>{message("sessions.loading", language)}</strong><p>{message("sessions.loadingDetail", language)}</p></div> : visibleRows.length === 0 ? <div className="sessions-state"><strong>{message(error ? "sessions.cannotDisplay" : rows.length ? "sessions.noBillingMatch" : "sessions.empty", language)}</strong><p>{message(error ? "sessions.retryHelp" : "sessions.emptyHelp", language)}</p></div> : <>
        <div className="sessions-table-wrap"><table className="sessions-table"><thead><tr><th scope="col">{message("sessions.column.session", language)}</th><th scope="col">{message("sessions.column.harnessModel", language)}</th><th scope="col">{message("sessions.column.time", language)}</th><th scope="col">{message("sessions.column.tokens", language)}</th><th scope="col">{message("sessions.column.cost", language)}</th><th scope="col">{message("sessions.column.status", language)}</th></tr></thead><tbody>{visibleRows.map((row) => <tr key={row.session_ref} className={`sessions-table-row-clickable ${row.session_ref === selectedSessionRef ? "sessions-row-selected" : ""}`} tabIndex={0} role="button" aria-pressed={row.session_ref === selectedSessionRef} onClick={(event) => openSessionDetail(row.session_ref, event.currentTarget)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openSessionDetail(row.session_ref, event.currentTarget); } }}><td><strong>{sessionTitle(row, language)}</strong><code>{row.session_ref.slice(0, 15)}…</code></td><td>{harnessName(row.harness)}<small>{row.model_ids.length ? row.model_ids.map((id) => modelLabel(id, language)).join(" · ") : message("sessions.unknownModel", language)}</small></td><td>{dateLabel(row.first_event_at, language)}<small>{row.last_event_at ? message("sessions.until", language, { time: dateLabel(row.last_event_at, language) }) : message("sessions.unknownEnd", language)}</small></td><td><strong>{compact(row.tokens.total)}</strong><small>{message("sessions.eventPeak", language, { count: row.event_count, peak: compact(row.peak_tokens) })}</small></td><td><strong>{costLabel(row)}</strong><small>{row.cost_minor ? costBasisLabel(row.cost_minor.basis, language) : message("sessions.noAmount", language)}</small></td><td><span className={`session-cost-state session-cost-${row.cost_status.state}`} title={costStateLabel(row.cost_status, language)}>{costStateLabel(row.cost_status, language)}</span></td></tr>)}</tbody></table></div>
        <div className="sessions-card-list">{visibleRows.map((row) => <article className={`session-card session-card-clickable ${row.session_ref === selectedSessionRef ? "sessions-row-selected" : ""}`} key={row.session_ref} tabIndex={0} role="button" aria-pressed={row.session_ref === selectedSessionRef} onClick={(event) => openSessionDetail(row.session_ref, event.currentTarget)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openSessionDetail(row.session_ref, event.currentTarget); } }}><div className="session-card-heading"><strong>{sessionTitle(row, language)}</strong><span className={`session-cost-state session-cost-${row.cost_status.state}`}>{costStateShort(row.cost_status.state, language)}</span></div><p>{row.harness} · {row.model_ids.map((id) => modelLabel(id, language)).join(" · ") || message("sessions.unknownModel", language)}</p><div><span>{compact(row.tokens.total)} tokens · {message("sessions.eventCount", language, { count: row.event_count })}</span><strong>{costLabel(row)}</strong></div><small>{dateLabel(row.first_event_at, language)} · {message("sessions.until", language, { time: dateLabel(row.last_event_at, language) })}</small><code>{row.session_ref.slice(0, 15)}…</code></article>)}</div>
        {nextCursor && <div className="sessions-more"><Button type="button" onClick={() => void loadMore()} busy={loadingMore} disabled={loading}>{message(loadingMore ? "sessions.loadingMore" : "sessions.loadMore", language)}</Button></div>}
      </>}
    </section>
    </>
    </main>
    {selectedSessionRef && <>
      <div className="sessions-overlay-backdrop" onClick={closeSessionDetail} />
      <div className="sessions-overlay-panel" role="dialog" aria-modal="true" aria-label={message("sessions.detail", language)}>
        <div className="sessions-overlay-bar"><button type="button" className="sessions-overlay-close" onClick={closeSessionDetail} aria-label={message("sessions.closeDetail", language)}>×</button></div>
        <div className="sessions-overlay-body"><SessionDetail row={selectedRow} sessionRef={selectedSessionRef} harnessKind={filters.harness_kind} refreshKey={detailRefreshKey} onBack={closeSessionDetail} /></div>
      </div>
    </>}
  </div>;
}
