import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { safeUiError } from "../../lib/tauri";
import { message, resolvedLanguage, useLanguage, type MessageKey, modelLabel } from "../../lib/i18n";
import {
  readSessionInsights, readSessionTraceEvidence,
  type InsightDiagnostic, type InsightStep, type NominalCost, type SessionInsights, type SessionTraceEvidence,
} from "../../lib/sessionInsights";
import { bandFor, GAP_WIDTH, groupBandVisibility, layoutSteps, maxVisibleSteps, miniColumns, niceCeil, packBands, placeGapLabels, resolveWindow, tickStep } from "./insightsGeometry";
import "./session-insights.css";

// 会话消耗诊断（SESSION_TRACE_DIAGNOSTICS_SPEC r6 §8）：摘要 → 紧凑诊断列表 →
// 联动的轨迹与检查器。数据全部来自 `session_trace(output = "insights")`；错误
// 摘录等原始证据只经本地命令 `session_trace_evidence` 按需读取（§10）。

// ─────────────────────────── 文案与格式 ───────────────────────────

// 本文件的文案在调用时按应用语言解析（不是模块加载时定死），SessionInsightsPanel 用
// useLanguage() 订阅切换；纯函数（diagText / fmtTokens）与测试用同一条路径。
const tx = (key: MessageKey, params: Record<string, string | number> = {}): string => message(key, resolvedLanguage(), params);
const isEn = (): boolean => resolvedLanguage() === "en";
/** 英文按数量取复数（1 turn / 3 turns）；中文量词不变。 */
const uN = (unit: string, n: number): string => (isEn() && n !== 1 ? `${unit}s` : unit);

export function fmtTokens(n: number): string {
  if (isEn()) {
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
    return String(Math.round(n));
  }
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (n >= 1e6) return `${Math.round(n / 1e4)} 万`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  return String(Math.round(n));
}
export function fmtPct(v: number): string {
  return `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
}
export function fmtDuration(ms: number): string {
  if (ms >= 3_600_000) return tx("ins.durHours", { n: (ms / 3_600_000).toFixed(1) });
  if (ms >= 60_000) return tx("ins.durMinutes", { n: Math.round(ms / 60_000) });
  return tx("ins.durSeconds", { n: Math.round(ms / 1000) });
}
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(isEn() ? "en-US" : "zh-CN", { hour: "2-digit", minute: "2-digit", hour12: isEn() });
}
export function fmtMoney(cost: NominalCost | null): string | null {
  if (!cost || cost.amounts.length === 0) return null;
  const language = resolvedLanguage();
  const parts = cost.amounts.map((amount) => {
    if (!Number.isSafeInteger(amount.amount_minor)) return "—";
    if (amount.currency !== "USD" && amount.currency !== "CNY") {
      return message("billing.minorUnitsUnknown", language, { currency: amount.currency, amount: amount.amount_minor });
    }
    const symbol = amount.currency === "USD" ? "$" : "¥";
    return `${symbol}${(amount.amount_minor / 100).toFixed(2)}`;
  });
  return parts.join(" + ") + (cost.coverage === "partial" ? message("sessionInsights.partialPrice", language) : "");
}
const inputOf = (s: { input: { cache_read: number; cache_write: number; uncached_input: number } }) => s.input.cache_read + s.input.cache_write + s.input.uncached_input;
const missOf = (s: { input: { cache_write: number; uncached_input: number } }) => s.input.cache_write + s.input.uncached_input;

const REMEDY_KEYS: Record<string, [MessageKey, MessageKey]> = {
  "inspect-repeated-failure": ["ins.remedy.fail.a", "ins.remedy.fail.b"],
  "review-context-growth": ["ins.remedy.growth.a", "ins.remedy.growth.b"],
  "inspect-uncached-input": ["ins.remedy.uncached.a", "ins.remedy.uncached.b"],
};
const remedyOf = (id: string): [string, string] | undefined => { const keys = REMEDY_KEYS[id]; return keys ? [tx(keys[0]), tx(keys[1])] : undefined; };
const NOTE_KEYS: Record<string, MessageKey> = { possible_cache_expiry: "ins.note.idle", after_model_change: "ins.note.model" };
const noteText = (explanation: string): string | undefined => (NOTE_KEYS[explanation] ? tx(NOTE_KEYS[explanation]) : undefined);
/// 线格式里没有缓存写入字段的执行环境（codex / workbuddy 的用量只有 cached / uncached 两档）：
/// 图例写「执行环境不报告」，与「测到为 0」分开（§8.2）。
const HARNESSES_WITHOUT_CACHE_WRITE = new Set(["codex", "workbuddy"]);

const LANE_KEYS: Record<string, MessageKey> = { not_recorded_by_harness: "ins.lane.harness", not_ingested: "ins.lane.notIngested", no_data_in_session: "ins.lane.none" };
const laneReason = (reason: string | null | undefined): string => (LANE_KEYS[reason ?? ""] ? tx(LANE_KEYS[reason ?? ""]) : tx("ins.reasonUnknown"));

/// 回合区间文案：起止相同时只写一个数（真机截图里「回合 17–17」读起来像笔误）。
export function stepRange(unit: string, from: number, to: number): string {
  return from === to ? `${unit} ${from}` : `${unit} ${from}–${to}`;
}

export type DiagText = { title: string; chip: [string, string]; fact: string; why: string };

export function diagText(d: InsightDiagnostic, unit: string): DiagText {
  const f = d.fact;
  const num = (k: string) => (typeof f[k] === "number" ? (f[k] as number) : 0);
  const chip: [string, string] = d.cause === "evidence" ? ["ev", tx("ins.chipEvidence")] : d.cause === "possible" ? ["maybe", tx("ins.chipPossible")] : ["unk", tx("ins.chipUnknown")];
  if (d.kind === "repeated_failure") {
    const tool = typeof f.capability_id === "string" ? f.capability_id : tx("ins.tool");
    const groups = num("groups");
    const title = f.same_invocation ? tx("ins.titleSameCall", { n: num("failures") }) : groups > 1 ? tx("ins.titleGroups", { groups, n: num("failures") }) : tx("ins.titleTool", { tool, n: num("failures") });
    const fact = f.same_invocation
      ? tx("ins.factSameArgs", { tool, steps: num("steps_hit"), unit: uN(unit, num("steps_hit")), n: num("failures") })
      : tx("ins.factManyCalls", { tool, steps: num("steps_hit"), unit: uN(unit, num("steps_hit")), n: num("failures") });
    const why = d.cause === "evidence" ? tx("ins.whyEvidence") : tx("ins.whyNoExcerpt");
    return { title, chip, fact, why };
  }
  if (d.kind === "input_growth") {
    return {
      title: tx("ins.titleGrowth", { ratio: num("ratio").toFixed(1) }), chip,
      fact: tx("ins.factGrowth", { from: fmtTokens(num("peak_from")), to: fmtTokens(num("peak_to")), share: fmtPct(d.impact.share_of_session_input) }),
      why: tx("ins.whyGrowth"),
    };
  }
  const drop = d.explanation === "hit_rate_drop";
  let fact = tx("ins.factUncached", { calls: num("calls"), tokens: fmtTokens(num("uncached_tokens")), share: fmtPct(d.impact.share_of_session_input) });
  if (drop) fact += tx("ins.factHitDrop", { from: fmtPct(num("hit_before")), to: fmtPct(num("hit_after")) });
  let why = tx("ins.whyUncached");
  const notes = d.context_notes.filter(n => noteText(n.explanation)).map(n => tx("ins.noteHappened", { calls: n.calls, note: noteText(n.explanation) ?? "" }));
  if (notes.length) why += tx("ins.whyNotes", { notes: notes.join(isEn() ? "; " : "，") });
  return { title: drop ? tx("ins.titleHitDrop") : tx("ins.titleHighUncached"), chip, fact, why };
}

// ─────────────────────────── 组件 ───────────────────────────

type Mode =
  | { kind: "diag"; diag: number }
  | { kind: "step"; step: number }
  | { kind: "calls"; from: number; to: number }
  | { kind: "failure"; step: number; ts: number }
  | { kind: "safety" };

const PAD_L = 52;
const PAD_R = 52;

export function SessionInsightsPanel({ sessionRef, refreshKey }: { sessionRef: string; refreshKey: number }) {
  useLanguage();
  const [data, setData] = useState<{ ref: string; insights: SessionInsights } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [mode, setMode] = useState<Mode | null>(null);
  const modeRef = useRef<Mode | null>(null);
  modeRef.current = mode;
  const [history, setHistory] = useState<{ mode: Mode; cursor: number }[]>([]);
  const [cursor, setCursor] = useState(1);
  const [win, setWin] = useState<{ view: [number, number]; navKey: string } | null>(null);
  // 导航计数：每次点诊断 / 回合 / 方向键 +1。同一诊断再点一次也算新导航（缩略图拖走后
  // 按 Esc 或「下一处」要能把它带回视野）。
  const [nav, setNav] = useState(0);
  const lastView = useRef<[number, number] | null>(null);
  // 数据代次：同一会话刷新后 +1。证据缓存按代次校验（旧值先照常显示、后台重取，
  // 不闪「正在读取」）；迟到的旧响应不得覆盖新值。
  const [dataGen, setDataGen] = useState(0);
  const dataGenRef = useRef(0);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const inflight = useRef(new Set<string>());
  const sessionToken = useRef(0);
  const [width, setWidth] = useState(800);
  const [evidence, setEvidence] = useState<Record<string, { value: SessionTraceEvidence | "loading" | "error"; gen: number }>>({});
  const chartBox = useRef<HTMLDivElement | null>(null);

  // 换会话才清空；同一会话的后台刷新（每次同步都会触发）保留当前视图与选择，
  // 只在新数据到达后校验选择是否仍然有效（验收 Major：每次同步都把用户拽回诊断 1）。
  const loadedRef = useRef<string | null>(null);
  const insightsFingerprint = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    const sameSession = loadedRef.current === sessionRef;
    if (!sameSession) { sessionToken.current += 1; inflight.current.clear(); setData(null); setMode(null); setHistory([]); setWin(null); setEvidence({}); lastView.current = null; }
    setError(null);
    void readSessionInsights(sessionRef).then(insights => {
      if (!active) return;
      // 同一会话、内容没变的后台刷新：什么都不更新（不换对象、不递增数据代次、不让证据缓存失效重取）。
      const fingerprint = `${sessionRef}|${JSON.stringify(insights)}`;
      if (sameSession && insightsFingerprint.current === fingerprint) { setRefreshFailed(false); return; }
      insightsFingerprint.current = fingerprint;
      loadedRef.current = sessionRef;
      setData({ ref: sessionRef, insights });
      setRefreshFailed(false);
      dataGenRef.current += 1;
      setDataGen(dataGenRef.current);
      const current = modeRef.current;
      if (!(sameSession && current && modeStillValid(current, insights))) {
        setHistory([]);
        setNav(n => n + 1);
        if (insights.diagnostics.length) { setCursor(insights.diagnostics[0].steps.from); setMode({ kind: "diag", diag: 0 }); }
        else { const s = insights.axis.steps.find(x => x.notes.length)?.index ?? 1; setCursor(s); setMode({ kind: "step", step: s }); }
      }
      setCursor(c => Math.min(Math.max(1, c), Math.max(1, insights.axis.steps.length)));
    }).catch((reason: unknown) => {
      if (!active) return;
      // 首次加载失败 → 整块报错；刷新失败 → 保留旧数据并提示（不静默吞掉）。
      if (sameSession) setRefreshFailed(true); else setError(safeUiError(reason, tx("ins.unavailable")));
    });
    return () => { active = false; };
  }, [sessionRef, refreshKey, retry]);

  useEffect(() => {
    const el = chartBox.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(entries => { const w = Math.floor(entries[0].contentRect.width); if (w > 0) setWidth(Math.max(340, w)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);

  const insights = data?.ref === sessionRef ? data.insights : null;
  const steps = insights?.axis.steps ?? [];
  const unit = tx(insights?.axis.unit === "turn" ? "ins.unitTurn" : "ins.unitCall");
  const plotW = width - PAD_L - PAD_R;
  const maxVisible = maxVisibleSteps(plotW);
  const focus: [number, number] = useMemo(() => {
    if (!insights || !mode) return [cursor, cursor];
    if (mode.kind === "diag") { const d = insights.diagnostics[mode.diag]; return d ? [d.steps.from, d.steps.to] : [cursor, cursor]; }
    if (mode.kind === "calls") return [mode.from, mode.to];
    return [cursor, cursor];
  }, [insights, mode, cursor]);
  const navKey = String(nav);
  const view: [number, number] = resolveWindow(steps.length, maxVisible, win, navKey, focus[0], focus[1], lastView.current);
  lastView.current = view;
  const setUserWindow = (next: [number, number]) => setWin({ view: next, navKey });

  // 需要原始证据的模式按需加载（按区间缓存）。
  const evidenceRange: [number, number] | null = (() => {
    if (!insights || !mode) return null;
    if (mode.kind === "diag") { const d = insights.diagnostics[mode.diag]; return d?.kind === "repeated_failure" ? [d.steps.from, d.steps.to] : null; }
    if (mode.kind === "calls") return [mode.from, mode.to];
    if (mode.kind === "failure" || mode.kind === "step") return [mode.step, mode.step];
    if (mode.kind === "safety") return [1, Math.max(1, steps.length)];
    return null;
  })();
  const evKey = evidenceRange ? `${mode?.kind === "safety" ? "safety" : "calls"}:${evidenceRange[0]}-${evidenceRange[1]}` : null;
  const includeCalls = mode?.kind !== "safety";
  // 证据缓存（确认轮 finding）：
  // - 是否要取只看「这一代数据有没有这条的新值」，在途与否用 `inflight`（键 = 条目@代次）判断，
  //   不看 value === "loading"——否则首读在途时来一次同步，旧响应被丢弃后条目永远停在 loading；
  // - 会话令牌 `sessionToken` 在换会话时立即 +1，旧会话的迟到响应不会写进新会话的缓存；
  // - 刷新后的重取失败时保留旧的有效值（只把代次推进，避免反复重试）。
  useEffect(() => {
    if (!evKey || !evidenceRange) return;
    const entry = evidence[evKey];
    if (entry && entry.gen >= dataGen) return;
    const flightKey = `${evKey}@${dataGen}`;
    if (inflight.current.has(flightKey)) return;
    inflight.current.add(flightKey);
    const generation = dataGen;
    const token = sessionToken.current;
    if (!entry || entry.value === "loading" || entry.value === "error") setEvidence(e => ({ ...e, [evKey]: { value: "loading", gen: entry?.gen ?? -1 } }));
    const settle = (value: SessionTraceEvidence | "error") => {
      inflight.current.delete(flightKey);
      if (token !== sessionToken.current || generation !== dataGenRef.current) return;
      setEvidence(e => {
        const previous = e[evKey]?.value;
        const keep = value === "error" && previous !== undefined && typeof previous === "object";
        return { ...e, [evKey]: { value: keep ? previous : value, gen: generation } };
      });
    };
    void readSessionTraceEvidence(sessionRef, evidenceRange[0], evidenceRange[1], includeCalls).then(settle).catch(() => settle("error"));
  }, [evKey, evidence, dataGen]); // eslint-disable-line react-hooks/exhaustive-deps
  const retryEvidence = () => { if (evKey) setEvidence(e => { const next = { ...e }; delete next[evKey]; return next; }); };
  const ev = evKey ? evidence[evKey]?.value : undefined;

  const go = (next: Mode, push = true) => {
    setNav(n => n + 1);
    if (push && mode) setHistory(h => [...h, { mode, cursor }].slice(-20));
    if (!push) setHistory([]);
    setMode(next);
    if (next.kind === "step" || next.kind === "failure") setCursor(next.step);
    if (next.kind === "diag" && insights) setCursor(insights.diagnostics[next.diag].steps.from);
  };
  const back = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setMode(prev.mode);
    setCursor(prev.cursor);
    setNav(n => n + 1);
    setHistory(history.slice(0, -1));
  };

  if (error) return <section className="session-detail-panel session-insights" aria-label={tx("ins.ariaDiag")}><div role="alert"><p>{tx("ins.unavailableErr", { error })}</p><button className="button button-secondary" onClick={() => setRetry(v => v + 1)}>{tx("ins.retry")}</button></div></section>;
  if (!insights) return <section className="session-detail-panel session-insights" aria-label={tx("ins.ariaDiag")}><p role="status">{tx("ins.analyzing")}</p></section>;

  const all = inputOf(insights.session);
  const diags = insights.diagnostics;
  const selectedDiag = mode?.kind === "diag" ? mode.diag : -1;
  const money = fmtMoney(insights.session.nominal_cost);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = Math.min(steps.length, Math.max(1, cursor + (e.key === "ArrowRight" ? 1 : -1)));
      go({ kind: "step", step: next }, false);
    } else if (e.key === "Escape" && diags.length) {
      // 详情浮层自己也用 Esc 关闭（SessionsPage.tsx）；图表的 Esc 是「回到当前诊断」，
      // 冒泡上去会在 SVG 有焦点时把浮层一起关掉，两个 Esc 语义打架。
      e.stopPropagation();
      go({ kind: "diag", diag: selectedDiag >= 0 ? selectedDiag : 0 }, false);
    }
  };

  return <section className="session-detail-panel session-insights" aria-label={tx("ins.ariaDiag")}>
    <div className="section-heading"><div><p className="eyebrow">{tx("ins.ariaDiag")}</p><h3>{tx("ins.heading")}</h3></div><span className="count-badge">{tx("ins.countBadge", { n: steps.length, unit: uN(unit, steps.length) })}</span></div>
    {refreshFailed && <p className="insights-refresh-failed" role="status">{tx("ins.refreshFailed")}<button type="button" className="link" onClick={() => setRetry(v => v + 1)}>{tx("ins.retry")}</button></p>}

    <dl className="insights-summary">
      <div><dt>{unit}</dt><dd className="num">{steps.length}</dd></div>
      <div><dt>{tx("ins.calls")}</dt><dd className="num">{insights.session.calls}</dd></div>
      <div><dt>{tx("ins.inOut")}</dt><dd className="num">{fmtTokens(all)} / {fmtTokens(insights.session.output)}</dd></div>
      <div><dt>{tx("ins.hitRate")}</dt><dd className="num">{all ? fmtPct(insights.session.input.cache_read / all) : "—"}</dd></div>
      <div><dt>{tx("ins.nominal")}</dt><dd>{money ? <><span className="num">{money}</span><small>{tx("ins.nominalNote")}</small></> : <><span className="muted">{tx("ins.noPricing")}</span><small>{insights.session.nominal_cost_reason === "no_pricing_snapshot" ? tx("ins.noSnapshot") : insights.session.nominal_cost_reason === "no_price_card" ? tx("ins.noPriceCard") : ""}</small></>}</dd></div>
      <div className="insights-safety"><dt>{tx("ins.safety")}</dt><dd>{insights.safety.count ? <button className="insights-safety-btn" type="button" onClick={() => go({ kind: "safety" })}><b className="num">{insights.safety.count}</b> {tx("ins.itemsView")}</button> : <span className="muted">{tx("ins.none")}</span>}</dd></div>
    </dl>

    <div className="insights-diags" role="list" aria-label={tx("ins.attention")}>
      {diags.length === 0 ? <div className="insights-empty">
        <b>{tx("ins.emptyTitle")}</b>
        <p>{tx("ins.checked")}{emptyNotes(insights, unit)}</p>
      </div> : <>
        <div className="insights-diags-head"><span>{tx("ins.attention")}</span><span>{tx("ins.diagHead", { n: diags.length })}</span></div>
        {diags.slice(0, 3).map((d, i) => <DiagRow key={i} d={d} i={i} unit={unit} open={selectedDiag === i} onSelect={() => go({ kind: "diag", diag: i }, false)} />)}
        {diags.length > 3 && <details className="insights-more"><summary>{tx("ins.moreItems", { n: diags.length - 3 })}</summary>{diags.slice(3).map((d, k) => <DiagRow key={k + 3} d={d} i={k + 3} unit={unit} open={selectedDiag === k + 3} onSelect={() => go({ kind: "diag", diag: k + 3 }, false)} />)}</details>}
      </>}
    </div>

    <div className="insights-work">
      <div className="insights-chart-card" ref={chartBox}>
        <Legend insights={insights} unit={unit} />
        {axisNote(insights) && <p className="insights-axis-note">{axisNote(insights)}</p>}
        {steps.length > maxVisible && <MiniMap steps={steps} diags={diags} view={view} width={width} maxVisible={maxVisible} onWindow={setUserWindow} unit={unit} onJump={dir => { if (!diags.length) return; const i = selectedDiag >= 0 ? (selectedDiag + dir + diags.length) % diags.length : 0; go({ kind: "diag", diag: i }, false); }} />}
        <Chart insights={insights} view={view} width={width} cursor={cursor} mode={mode} unit={unit}
          onStep={s => go({ kind: "step", step: s }, false)} onDiag={i => go({ kind: "diag", diag: i }, false)} onKey={onKey} />
        <p className="insights-hint">{tx("ins.hint")}</p>
        <details className="insights-sum"><summary>{tx("ins.textSummary")}</summary><ul>{summaryLines(insights, unit).map((t, i) => <li key={i}>{t}</li>)}</ul></details>
      </div>
      <aside className="insights-inspector" aria-live="polite" aria-label={tx("ins.details")}>
        {history.length > 0 && <div className="insights-inspector-bar"><button className="insights-back" type="button" onClick={back}>{tx("ins.back")}</button></div>}
        {mode && <Inspector insights={insights} mode={mode} unit={unit} ev={ev} go={go} retry={retryEvidence} />}
      </aside>
    </div>
  </section>;
}

function axisNote(insights: SessionInsights): string | null {
  const a = insights.axis;
  if (a.fallback === "few_turn_starts") return tx(a.turn_starts === 0 ? "ins.axisNoTurns" : "ins.axisOneTurn");
  if (a.fallback === "most_calls_before_first_turn") return tx("ins.axisMostBefore");
  if (a.leading_step) return tx("ins.axisLeading");
  return null;
}

function modeStillValid(mode: Mode, insights: SessionInsights): boolean {
  const n = insights.axis.steps.length;
  if (mode.kind === "diag") return mode.diag < insights.diagnostics.length;
  if (mode.kind === "calls") return mode.to <= n;
  if (mode.kind === "step" || mode.kind === "failure") return mode.step <= n;
  return true;
}

function emptyNotes(insights: SessionInsights, unit: string): string {
  const failed = insights.axis.steps.filter(s => s.outcome === "failed").length;
  const cancelled = insights.axis.steps.filter(s => s.outcome === "cancelled").length;
  const idle = insights.axis.steps.filter(s => s.notes.some(n => n.explanation === "possible_cache_expiry")).map(s => s.index);
  const bits: string[] = [];
  if (failed) bits.push(tx("ins.endedFailed", { n: failed, unit: uN(unit, failed) }));
  if (cancelled) bits.push(tx("ins.endedCancelled", { n: cancelled, unit: uN(unit, cancelled) }));
  if (idle.length) bits.push(tx("ins.idleBefore", { unit, list: idle.slice(0, 3).join(isEn() ? ", " : "、") + (idle.length > 3 ? (isEn() ? " and more" : " 等") : "") }));
  return bits.length ? tx("ins.emptyExtra", { bits: bits.join(isEn() ? "; " : "，") }) : "";
}

function summaryLines(insights: SessionInsights, unit: string): string[] {
  const all = inputOf(insights.session);
  const lines = [tx("ins.sumTotal", { n: insights.axis.steps.length, unit: uN(unit, insights.axis.steps.length), input: fmtTokens(all), rate: all ? fmtPct(insights.session.input.cache_read / all) : "—" })];
  insights.diagnostics.forEach((d, i) => { const t = diagText(d, unit); lines.push(tx("ins.sumDiag", { i: i + 1, range: stepRange(unit, d.steps.from, d.steps.to), title: t.title, fact: t.fact, why: t.why })); });
  for (const s of insights.axis.steps) for (const n of s.notes) lines.push(tx("ins.sumNote", { unit, index: s.index, calls: n.calls, note: noteText(n.explanation) ?? "" }));
  if (insights.lanes.tools.state === "unavailable") lines.push(tx("ins.sumTools", { reason: laneReason(insights.lanes.tools.reason) }));
  if (insights.quality.legacy_fingerprints) lines.push(tx("ins.sumLegacy", { n: insights.quality.legacy_fingerprints }));
  return lines.slice(0, 200);
}

function DiagRow({ d, i, unit, open, onSelect }: { d: InsightDiagnostic; i: number; unit: string; open: boolean; onSelect: () => void }) {
  const t = diagText(d, unit);
  const rm = remedyOf(d.remedy_id);
  return <div className={`insights-diag${open ? " on" : ""}`} role="listitem">
    <button type="button" className="insights-diag-sum" aria-expanded={open} onClick={onSelect}>
      <span className="insights-num">{i + 1}</span>
      <span className="insights-diag-title"><b>{t.title}</b><span className="num muted">{stepRange(unit, d.steps.from, d.steps.to)}</span><span className={`insights-chip ${t.chip[0]}`}>{t.chip[1]}</span></span>
      <span className="insights-chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
      <span className="insights-diag-fact">{t.fact}</span>
    </button>
    {open && <div className="insights-diag-more"><p><span className="lbl">{tx("ins.cause")}</span>{t.why}</p>{rm && <p><span className="lbl">{tx("ins.advice")}</span>{rm[0]} <span className="muted">{rm[1]}</span></p>}</div>}
  </div>;
}

function Legend({ insights, unit }: { insights: SessionInsights; unit: string }) {
  const writes = insights.session.input.cache_write > 0;
  return <div className="insights-legend">
    <span><i className="sw read" />{tx("ins.cacheRead")}</span>
    <span className={writes ? "" : "off"}><i className="sw write" />{tx(writes ? "ins.cacheWrite" : HARNESSES_WITHOUT_CACHE_WRITE.has(insights.harness) ? "ins.cacheWriteNoReport" : "ins.cacheWriteZero")}</span>
    <span><i className="sw unc" />{tx("ins.uncachedInput")}</span>
    <span><i className="sw line" />{tx("ins.peakInput")}</span>
    <span><i className="sw fail" />{tx("ins.toolFailed")}</span>
    <span>{tx("ins.legendIdle")}</span><span>{tx("ins.legendModel")}</span>
    <span className="muted">{tx("ins.axisLabel", { unit })}</span>
  </div>;
}

// ─────────────────────────── 悬浮提示 ───────────────────────────
// 图表的每个可交互元素（回合列、诊断带、空闲缝隙、说明图标、窗口外指示）都用
// 同一套悬浮提示：鼠标移上去看关键数字，点击才改变选择——「看」与「选」分开，
// 不用点开检查器也能扫一眼数据；键盘用户走已有的方向键 + 检查器路径，信息量
// 不比悬浮少，所以提示本身不需要单独可聚焦（纯指针增强）。

type TipContent = { title?: string; rows?: [string, string][]; lines?: string[] };

/// 悬浮提示定位用「图表自身坐标」（viewBox 单位）——SVG 是 1:1 铺满其容器宽度
/// 渲染的（`width` prop 就是容器实测宽度），所以坐标可以直接当 CSS px 用，不用
/// 另外换算；靠近右边界时翻到左侧，避免被容器裁掉。
/// 提示框可能的最大外宽：session-insights.css `.insights-tip` 的 max-width 260
/// + 左右内边距 20 + 边框 2。翻转判断要按它加上 12px 鼠标偏移算，否则宽内容
/// 贴右边界时会被容器裁掉。改 CSS 的 max-width 时同步改这里。
const TIP_MAX_WIDTH = 282;

function TooltipBox({ x, y, chartWidth, content }: { x: number; y: number; chartWidth: number; content: TipContent }) {
  const flip = x + 12 + TIP_MAX_WIDTH > chartWidth;
  const style: CSSProperties = { top: Math.max(0, y - 6), ...(flip ? { right: chartWidth - x + 12 } : { left: x + 12 }) };
  return <div className="insights-tip" style={style} role="tooltip">
    {content.title && <b>{content.title}</b>}
    {content.rows && <dl>{content.rows.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>}
    {content.lines?.map(l => <p key={l}>{l}</p>)}
  </div>;
}

/// 一个回合列的悬浮内容：把四条泳道（消耗/峰值/工具/说明）汇总成一份，不用
/// 逐条悬浮——一次看到这一列的关键数字。
function stepTip(st: InsightStep, unit: string): TipContent {
  const total = inputOf(st);
  const rows: [string, string][] = [
    [tx("ins.rowInputTotal"), fmtTokens(total)],
    [tx("ins.rowRead"), fmtTokens(st.input.cache_read)],
    [tx("ins.rowWrite"), fmtTokens(st.input.cache_write)],
    [tx("ins.rowUncached"), fmtTokens(st.input.uncached_input)],
    [tx("ins.rowHit"), st.hit_rate != null ? fmtPct(st.hit_rate) : "—"],
    [tx("ins.rowPeak"), fmtTokens(st.input_peak)],
    [tx("ins.calls"), String(st.calls)],
  ];
  if (st.tools.succeeded + st.tools.failed + st.tools.cancelled + st.tools.unknown > 0) {
    // 拆成三行短数值：合成一行「成功 31 · 失败 1 · 取消 0」在值列里 nowrap，
    // 比提示框 max-width 还宽，真机上整列数字被撑出框外（与缓存三桶拆行同理）
    rows.push([tx("ins.toolOk"), String(st.tools.succeeded)], [tx("ins.toolFailed"), String(st.tools.failed)], [tx("ins.toolCancelled"), String(st.tools.cancelled)]);
  }
  const lines: string[] = [];
  if (st.outcome === "failed") lines.push(tx("ins.turnFailed"));
  if (st.outcome === "cancelled") lines.push(tx("ins.turnCancelled"));
  for (const n of st.notes) lines.push(noteText(n.explanation) ?? "");
  return { title: `${unit} ${st.index}`, rows, lines };
}

/// 一条诊断的悬浮内容（窗口内的带、窗口外的单条、折叠摘要里的一行都用它）。
function bandTip(d: InsightDiagnostic, i: number, unit: string): TipContent {
  const t = diagText(d, unit);
  return { title: `${i + 1}. ${t.title}`, lines: [stepRange(unit, d.steps.from, d.steps.to), t.fact] };
}

function MiniMap({ steps, diags, view, width, maxVisible, onWindow, onJump, unit }: { steps: InsightStep[]; diags: InsightDiagnostic[]; view: [number, number]; width: number; maxVisible: number; onWindow: (w: [number, number]) => void; onJump: (dir: number) => void; unit: string }) {
  const plotW = width - PAD_L - PAD_R;
  const H = 34;
  const cols = useMemo(() => miniColumns(steps.map(s => ({ input: inputOf(s), miss: missOf(s) })), plotW), [steps, plotW]);
  const maxV = Math.max(1, ...cols.map(c => c.value));
  const px = plotW / steps.length;
  const drag = useRef(false);
  const svg = useRef<SVGSVGElement | null>(null);
  const at = (clientX: number) => {
    const r = svg.current?.getBoundingClientRect();
    if (!r) return;
    const x = (clientX - r.left) * width / r.width;
    const c = Math.round((x - PAD_L) / plotW * steps.length);
    const s = Math.max(1, Math.min(steps.length - maxVisible + 1, c - Math.floor(maxVisible / 2)));
    onWindow([s, s + maxVisible - 1]);
  };
  return <>
    <div className="insights-nav"><span>{tx("ins.showing", { unit, from: view[0], to: view[1], total: steps.length })}</span><span className="sp" />{diags.length > 0 && <><button type="button" className="button button-secondary" onClick={() => onJump(-1)}>{tx("ins.prevDiag")}</button><button type="button" className="button button-secondary" onClick={() => onJump(1)}>{tx("ins.nextDiag")}</button></>}</div>
    <svg ref={svg} className="insights-mini" viewBox={`0 0 ${width} ${H}`} role="slider" aria-label={tx("ins.miniAria")} aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={view[0]} tabIndex={0}
      onPointerDown={e => { drag.current = true; (e.target as Element).setPointerCapture?.(e.pointerId); at(e.clientX); }}
      onPointerMove={e => { if (drag.current) at(e.clientX); }} onPointerUp={() => { drag.current = false; }} onPointerCancel={() => { drag.current = false; }}
      onKeyDown={e => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); const d = e.key === "ArrowRight" ? Math.ceil(maxVisible / 2) : -Math.ceil(maxVisible / 2); const s = Math.max(1, Math.min(steps.length - maxVisible + 1, view[0] + d)); onWindow([s, s + maxVisible - 1]); } }}>
      <rect x={PAD_L} y={0} width={plotW} height={H - 8} rx={3} className="mini-bg" />
      {cols.map(c => { const h = c.value / maxV * (H - 12); return <rect key={c.x} x={PAD_L + c.x} y={H - 10 - h} width={1} height={h} className={c.warn ? "mini-warn" : "mini-col"} />; })}
      {diags.map((d, i) => <rect key={i} x={PAD_L + (d.steps.from - 1) * px} y={H - 6} width={Math.max(3, (d.steps.to - d.steps.from + 1) * px)} height={4} rx={2} className={`band-${d.kind}`} />)}
      <rect x={PAD_L + (view[0] - 1) * px} y={0.5} width={(view[1] - view[0] + 1) * px} height={H - 9} rx={2} className="mini-window" />
      <text x={PAD_L - 6} y={H / 2} textAnchor="end" className="tnum">{tx("ins.whole")}</text>
    </svg>
  </>;
}

function Chart({ insights, view, width, cursor, mode, unit, onStep, onDiag, onKey }: { insights: SessionInsights; view: [number, number]; width: number; cursor: number; mode: Mode | null; unit: string; onStep: (s: number) => void; onDiag: (i: number) => void; onKey: (e: KeyboardEvent) => void }) {
  const steps = insights.axis.steps;
  const diags = insights.diagnostics;
  const plotW = width - PAD_L - PAD_R;
  const layout = layoutSteps(steps, view, PAD_L, plotW);
  const yTop = 20, hBar = 150, bandRow = 11;
  const [tip, setTip] = useState<{ x: number; y: number; content: TipContent } | null>(null);
  const hoverTip = (e: ReactMouseEvent, content: TipContent) => {
    const target = e.currentTarget as unknown as SVGGraphicsElement;
    const svg = target.ownerSVGElement ?? (target as unknown as SVGSVGElement);
    const rect = svg.getBoundingClientRect();
    // viewBox 与实测宽度 1:1（见组件顶部说明），按比例把屏幕坐标换回 viewBox 坐标。
    const scale = width / rect.width;
    setTip({ x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale, content });
  };
  const hideTip = () => setTip(null);

  // 诊断带分三组（`groupBandVisibility`）：窗口内的用 `packBands` 按真实横坐标
  // 避免重叠；窗口外的没有真实横坐标（一律画在左右边界），`packBands` 的「不
  // 重叠就复用同一行」在这里会让互不相关的诊断叠在同一点——真机 444 回合的
  // 会话有 20+ 条窗口外诊断，原先全挤成一团数字（2026-09-29 反馈）。窗口外
  // 每侧 ≤4 条时各给一行单独编号；更多时折叠成一条「N 条 ›」摘要，悬浮看列表，
  // 点击跳到离窗口最近的一条——不丢数据，只是不逐条占用行。
  const bandOf = diags.map(d => bandFor(d.steps, view, layout));
  const { visible: visibleIdx, offLeft: offLeftIdx, offRight: offRightIdx } = groupBandVisibility(bandOf);
  const OFFSCREEN_INDIVIDUAL_MAX = 4;
  const visibleRows = packBands(visibleIdx.map(i => diags[i].steps), 10);
  const visibleRowCount = visibleIdx.length ? Math.max(...visibleRows) + 1 : 0;
  const offLeftIndividually = offLeftIdx.length > 0 && offLeftIdx.length <= OFFSCREEN_INDIVIDUAL_MAX;
  const offRightIndividually = offRightIdx.length > 0 && offRightIdx.length <= OFFSCREEN_INDIVIDUAL_MAX;
  const offLeftRows = offLeftIndividually ? offLeftIdx.length : (offLeftIdx.length > 0 ? 1 : 0);
  const offRightRows = offRightIndividually ? offRightIdx.length : (offRightIdx.length > 0 ? 1 : 0);
  const rowOf = new Map<number, number>();
  visibleIdx.forEach((gi, k) => rowOf.set(gi, visibleRows[k]));
  if (offLeftIndividually) offLeftIdx.forEach((gi, k) => rowOf.set(gi, visibleRowCount + k));
  if (offRightIndividually) offRightIdx.forEach((gi, k) => rowOf.set(gi, visibleRowCount + k));
  const totalRows = visibleRowCount + Math.max(offLeftRows, offRightRows);
  const bandsH = diags.length ? totalRows * bandRow + 10 : 6;
  const yBand = yTop + hBar + 8, yPeak = yBand + bandsH + 12, hPeak = 58, yTools = yPeak + hPeak + 16, hTools = 40, yAxis = yTools + hTools + 6, H = yAxis + 22;
  const maxT = niceCeil(Math.max(1, ...steps.map(inputOf)));
  const maxP = niceCeil(Math.max(1, ...steps.map(s => s.input_peak)));
  const yB = (v: number) => yTop + hBar - v / maxT * hBar;
  const yP = (v: number) => yPeak + hPeak - v / maxP * hPeak;
  const bw = Math.max(2, Math.min(layout.slot * 0.72, 26));
  const slotOf = (i: number) => layout.slots.find(s => s.index === i);
  const sel = mode?.kind === "diag" ? diags[mode.diag]?.steps : mode?.kind === "calls" ? { from: mode.from, to: mode.to } : null;
  const selBand = sel ? bandFor(sel, view, layout) : null;
  const cur = slotOf(cursor);
  const toolsOk = insights.lanes.tools.state !== "unavailable";
  const maxN = Math.max(1, ...steps.map(s => s.tools.succeeded + s.tools.failed + s.tools.cancelled + s.tools.unknown));
  const step = tickStep(layout.slot);
  // 没有调用的步没有测量：折线在那里断开，不跨缺口插值；长空闲也断开。
  let path = "";
  let broken = true;
  layout.slots.forEach(s => {
    const st = steps[s.index - 1];
    if (st.calls === 0) { broken = true; return; }
    const brk = broken || (st.idle_before_ms ?? 0) > 30 * 60_000;
    path += `${brk ? "M" : "L"}${(s.x + s.w / 2).toFixed(1)} ${yP(st.input_peak).toFixed(1)}`;
    broken = false;
  });
  // 每回合的点击/悬浮目标分成上下两段（柱状消耗 / 峰值+工具+横轴），中间让开诊断带
  // 那一条窄带——诊断带自己的点击面在下面单独画，两段满高的话会盖在诊断带上面，
  // 点上去选中的其实是回合而不是诊断（这条带一直没生效，只是有列表按钮兜底才没
  // 被发现；2026-09-29 设计交互时顺手修）。
  const gutterTop = yBand - 4, gutterBottom = yPeak - 10;

  return <div className="insights-chart-wrap">
    <svg className="insights-chart" viewBox={`0 0 ${width} ${H}`} tabIndex={0} role="img" onKeyDown={onKey}
      aria-label={tx("ins.chartAria", { unit, from: view[0], to: view[1], total: steps.length, units: uN(unit, steps.length) })}>
      <defs>
        <pattern id="ins-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" className="hatch-bg" /><line x1="0" y1="0" x2="0" y2="5" className="hatch-line" /></pattern>
        <pattern id="ins-off" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" className="off-bg" /><line x1="0" y1="0" x2="0" y2="7" className="off-line" /></pattern>
      </defs>
      {selBand?.kind === "visible" && <rect x={selBand.x} y={yTop - 8} width={selBand.w} height={yAxis - yTop + 8} className="sel" />}
      {cur && <rect x={cur.x} y={yTop - 8} width={cur.w} height={yAxis - yTop + 8} className={sel ? "cursor-outline" : "sel"} />}
      {[0, 0.5, 1].map(f => <g key={f}><line x1={PAD_L} x2={width - PAD_R} y1={yB(maxT * f)} y2={yB(maxT * f)} className="grid" /><text x={PAD_L - 6} y={yB(maxT * f) + 3.5} textAnchor="end" className="tnum">{f ? fmtTokens(maxT * f) : "0"}</text></g>)}
      <text x={PAD_L} y={yTop - 10} className="lane">{tx("ins.laneInput", { unit })}</text>
      {layout.slots.map(s => {
        const st = steps[s.index - 1];
        const x = s.x + (s.w - bw) / 2;
        let y = yTop + hBar;
        const segs: [number, string][] = [[st.input.cache_read, "read"], [st.input.cache_write, "write"], [st.input.uncached_input, "unc"]];
        return <g key={s.index}>
          {segs.map(([v, cls]) => { const h = v / maxT * hBar; if (h <= 0) return null; y -= h; return <rect key={cls} x={x} y={y} width={bw} height={h} className={`bar ${cls}`} />; })}
          {st.notes.map((n, j) => { const cx = s.x + s.w / 2, cy = yB(inputOf(st)) - 9 - j * 12; return n.explanation === "possible_cache_expiry"
            ? <g key={j} className="note-icon"><circle cx={cx} cy={cy} r={4.5} /><path d={`M${cx} ${cy - 2.4}V${cy}l1.8 1.2`} /></g>
            : <rect key={j} x={cx - 4} y={cy - 4} width={8} height={8} transform={`rotate(45 ${cx} ${cy})`} className="note-icon" />; })}
        </g>;
      })}
      {(() => { const showGapLabel = placeGapLabels(layout.gaps.map(g => g.x)); return layout.gaps.map((g, gi) => {
        const label = tx("ins.idleMin", { n: Math.round(g.idleMs / 60_000) });
        const content: TipContent = { lines: [label, tx("ins.beforeIndex", { unit, n: g.beforeIndex })] };
        return <g key={g.beforeIndex} className="gap" onMouseMove={e => hoverTip(e, content)} onMouseLeave={hideTip}>
          <rect className="hit" x={g.x} y={yTop - 4} width={GAP_WIDTH} height={yAxis - yTop + 4} />
          <path d={`M${g.x + 8} ${yTop}l3 5l-3 5l3 5M${g.x + 12} ${yTop}l3 5l-3 5l3 5`} />
          <line x1={g.x + 11} x2={g.x + 11} y1={yTop + 18} y2={yAxis} />
          {showGapLabel[gi] && <text x={g.x + 17} y={yTop + 8} className="tnum">{label}</text>}
        </g>;
      }); })()}
      {diags.length > 0 && <line x1={PAD_L} x2={width - PAD_R} y1={yBand - 3} y2={yBand - 3} className="axis" />}
      {visibleIdx.map(i => {
        const d = diags[i];
        const b = bandOf[i];
        if (b.kind !== "visible") return null;
        const y = yBand + (rowOf.get(i) ?? 0) * bandRow + 2;
        const on = mode?.kind === "diag" && mode.diag === i;
        const content = bandTip(d, i, unit);
        return <g key={i} className={`band band-${d.kind}${d.cause === "evidence" ? " solid" : " dashed"}${on ? " on" : ""}`}
          onClick={() => onDiag(i)} onMouseMove={e => hoverTip(e, content)} onMouseLeave={hideTip}>
          <rect x={b.x + 1} y={y} width={Math.max(3, b.w - 2)} height={6} rx={3} />
          <text x={b.x - 4} y={y + 6} textAnchor="end" className="tnum band-num">{i + 1}</text>
          <rect x={b.x} y={y - 3} width={b.w} height={12} className="hit" />
        </g>;
      })}
      {(["left", "right"] as const).map(side => {
        const idx = side === "left" ? offLeftIdx : offRightIdx;
        const individually = side === "left" ? offLeftIndividually : offRightIndividually;
        if (idx.length === 0) return null;
        const x = side === "left" ? PAD_L : width - PAD_R;
        const anchor = side === "left" ? "start" : "end";
        if (individually) {
          return idx.map(i => {
            const d = diags[i];
            const y = yBand + (rowOf.get(i) ?? 0) * bandRow + 2;
            const content = bandTip(d, i, unit);
            return <g key={i} onClick={() => onDiag(i)} onMouseMove={e => hoverTip(e, content)} onMouseLeave={hideTip} style={{ cursor: "pointer" }}>
              <rect className="hit" x={side === "left" ? x - 2 : x - 34} y={y - 3} width={36} height={12} />
              <text x={x} y={y + 6} textAnchor={anchor} className="tnum faint">{side === "left" ? `‹ ${i + 1}` : `${i + 1} ›`}</text>
            </g>;
          });
        }
        // 折叠摘要：悬浮看清单，点击跳到离当前窗口最近的一条（左侧取 to 最大的，
        // 右侧取 from 最小的）。
        const nearest = idx.reduce((best, i) => {
          const cmp = side === "left" ? diags[i].steps.to - diags[best].steps.to : diags[best].steps.from - diags[i].steps.from;
          return cmp > 0 ? i : best;
        }, idx[0]);
        const y = yBand + visibleRowCount * bandRow + 2;
        const content: TipContent = {
          title: tx("ins.outsideWindow", { n: idx.length }),
          lines: idx.slice(0, 12).map(i => { const t = diagText(diags[i], unit); return `${i + 1}. ${stepRange(unit, diags[i].steps.from, diags[i].steps.to)} · ${t.title}`; })
            .concat(idx.length > 12 ? [tx("ins.andMore", { n: idx.length - 12 })] : []),
        };
        return <g key={side} className="band-summary" onClick={() => onDiag(nearest)} onMouseMove={e => hoverTip(e, content)} onMouseLeave={hideTip}>
          <rect className="hit" x={side === "left" ? x - 2 : x - 40} y={y - 4} width={42} height={14} />
          <rect x={side === "left" ? x : x - 34} y={y - 3} width={34} height={12} rx={6} className="band-summary-pill" />
          <text x={side === "left" ? x + 17 : x - 17} y={y + 6} textAnchor="middle" className="tnum band-summary-text">{side === "left" ? `‹${idx.length}` : `${idx.length}›`}</text>
        </g>;
      })}
      <text x={PAD_L} y={yPeak - 4} className="lane">{tx("ins.peakInput")}</text>
      {[0, 1].map(f => <g key={f}><line x1={PAD_L} x2={width - PAD_R} y1={yP(maxP * f)} y2={yP(maxP * f)} className="grid" /><text x={width - PAD_R + 6} y={yP(maxP * f) + 3.5} className="tnum">{f ? fmtTokens(maxP) : "0"}</text></g>)}
      <path d={path} className="peak-line" />
      {cur && steps[cur.index - 1].calls > 0 && <circle cx={cur.x + cur.w / 2} cy={yP(steps[cur.index - 1].input_peak)} r={3.2} className="peak-dot" />}
      <text x={PAD_L} y={yTools - 4} className="lane">{tx("ins.toolResults")}</text>
      {!toolsOk ? <g><rect x={PAD_L} y={yTools} width={plotW} height={hTools} rx={3} fill="url(#ins-off)" /><text x={PAD_L + plotW / 2} y={yTools + hTools / 2 + 4} textAnchor="middle" className="muted-text">{tx("ins.notRecordedDot", { reason: laneReason(insights.lanes.tools.reason) })}</text></g>
        : layout.slots.map(s => {
          const t = steps[s.index - 1].tools;
          const x = s.x + (s.w - bw) / 2;
          let y = yTools + hTools;
          const segs: [number, string][] = [[t.succeeded, "tool-ok"], [t.unknown, "tool-unknown"], [t.cancelled, "tool-cancel"], [t.failed, "tool-fail"]];
          return <g key={s.index}>{segs.map(([n, cls]) => { if (!n) return null; const h = Math.max(cls === "tool-fail" ? 5 : 0, n / maxN * hTools); y -= h; return <rect key={cls} x={x} y={y} width={bw} height={h} className={cls} fill={cls === "tool-fail" ? "url(#ins-hatch)" : undefined} />; })}</g>;
        })}
      <line x1={PAD_L} x2={width - PAD_R} y1={yAxis} y2={yAxis} className="axis" />
      {layout.slots.map(s => {
        const st = steps[s.index - 1];
        const cx = s.x + s.w / 2;
        const content = stepTip(st, unit);
        return <g key={s.index}>
          {(s.index === 1 || s.index % step === 0) && <text x={cx} y={yAxis + 15} textAnchor="middle" className="tnum">{s.index}</text>}
          {(st.outcome === "failed" || st.outcome === "cancelled") && <circle cx={cx} cy={yAxis} r={3.2} className={`outcome-${st.outcome}`} />}
          <rect x={s.x} y={yTop - 8} width={s.w} height={gutterTop - (yTop - 8)} className="hit"
            onClick={() => onStep(s.index)} onMouseMove={e => hoverTip(e, content)} onMouseLeave={hideTip} />
          <rect x={s.x} y={gutterBottom} width={s.w} height={yAxis + 8 - gutterBottom} className="hit"
            onClick={() => onStep(s.index)} onMouseMove={e => hoverTip(e, content)} onMouseLeave={hideTip} />
        </g>;
      })}
    </svg>
    {tip && <TooltipBox x={tip.x} y={tip.y} chartWidth={width} content={tip.content} />}
  </div>;
}

function Buckets({ input, noWrite }: { input: { cache_read: number; cache_write: number; uncached_input: number }; noWrite: boolean }) {
  const a = Math.max(1, input.cache_read + input.cache_write + input.uncached_input);
  return <div className="insights-buckets">
    <div className="bar-track"><span className="read" style={{ width: `${input.cache_read / a * 100}%` }} /><span className="write" style={{ width: `${input.cache_write / a * 100}%` }} /><span className="unc" style={{ width: `${input.uncached_input / a * 100}%` }} /></div>
    <div className="brow"><i className="sw read" />{tx("ins.cacheRead")}<span className="num">{fmtTokens(input.cache_read)}</span></div>
    <div className="brow"><i className="sw write" />{tx("ins.cacheWrite")}<span className="num">{noWrite ? tx("ins.notRecorded") : fmtTokens(input.cache_write)}</span></div>
    <div className="brow"><i className="sw unc" />{tx("ins.uncachedInput")}<span className="num">{fmtTokens(input.uncached_input)}</span></div>
  </div>;
}

function LocalNote() {
  return <p className="insights-local">{tx("ins.localOnly")}</p>;
}

function Inspector({ insights, mode, unit, ev, go, retry }: { insights: SessionInsights; mode: Mode; unit: string; ev: SessionTraceEvidence | "loading" | "error" | undefined; go: (m: Mode, push?: boolean) => void; retry: () => void }) {
  const steps = insights.axis.steps;
  const all = inputOf(insights.session);
  const noWrite = insights.session.input.cache_write === 0;
  const loading = ev === "loading" || ev === undefined;
  const evErr = ev === "error";
  const evData = typeof ev === "object" ? ev : null;
  const retryButton = <button type="button" className="link" onClick={retry}>{tx("ins.retry")}</button>;

  if (mode.kind === "safety") {
    return <div className="insights-insp">
      <h4>{tx("ins.safety")}</h4><p className="muted">{tx("ins.safetyCount", { n: insights.safety.count })}</p>
      <ul className="insights-list">{insights.safety.rules.map(r => <li key={r.rule}><span className="num fail">{r.rule}</span> {tx("ins.itemsN", { n: r.count })}{r.steps.length ? <> · {r.steps.slice(0, 8).map(s => <button key={s} type="button" className="link" onClick={() => go({ kind: "step", step: s })}>{unit} {s}</button>)}</> : null}</li>)}</ul>
      {evData ? <ul className="insights-list">{evData.safety.slice(0, 50).map((s, i) => <li key={i}><span className="num fail">{s.rule}</span> <span className="num">{s.summary ?? "—"}</span>{s.step ? <button type="button" className="link" onClick={() => go({ kind: "step", step: s.step as number })}>{unit} {s.step}</button> : null}</li>)}</ul> : evErr ? <p className="muted">{tx("ins.cmdUnavailable")}{retryButton}</p> : <p className="muted">{tx("ins.readingCmd")}</p>}
      <LocalNote />
    </div>;
  }

  if (mode.kind === "calls") {
    return <div className="insights-insp">
      <h4>{tx("ins.perCall")} · {unit} {mode.from}{mode.to !== mode.from ? `–${mode.to}` : ""}</h4>
      {evData ? <CallsTable ev={evData} unit={unit} /> : evErr ? <p className="muted">{tx("ins.perCallUnavailable")}{retryButton}</p> : <p className="muted">{tx("ins.reading")}</p>}
    </div>;
  }

  if (mode.kind === "failure") {
    const f = evData?.failures.find(x => x.ts_ms === mode.ts && x.step === mode.step);
    return <div className="insights-insp">
      <h4>{f?.capability_id ?? tx("ins.tool")} {tx("ins.callFailed")}</h4><p className="muted num">{unit} {mode.step} · {clock(mode.ts)}</p>
      {f ? <><dl className="kv"><dt>{tx("ins.argsSummary")}</dt><dd className="num wrap">{f.args_excerpt ?? "—"}</dd></dl><div><p className="muted">{tx("ins.errorExcerpt")}</p><pre className="insights-excerpt">{f.error_excerpt ?? tx("ins.noErrorText")}</pre><LocalNote /></div></>
        : loading ? <p className="muted">{tx("ins.reading")}</p> : <p className="muted">{tx("ins.failEvidenceUnavailable")}{evErr ? retryButton : null}</p>}
      <p className="muted">{tx("ins.exitNote")}</p>
      <div className="insights-acts"><button type="button" className="button button-secondary" onClick={() => go({ kind: "step", step: mode.step })}>{tx("ins.viewThis", { unit })}</button></div>
    </div>;
  }

  if (mode.kind === "diag") {
    const d = insights.diagnostics[mode.diag];
    if (!d) return null;
    const t = diagText(d, unit);
    const rm = remedyOf(d.remedy_id);
    const L = steps.slice(d.steps.from - 1, d.steps.to);
    const rangeLabel = stepRange(unit, d.steps.from, d.steps.to);
    if (d.kind === "repeated_failure") {
      const fails = evData?.failures ?? [];
      const byKey = new Map<string, typeof fails>();
      // 没有分组键（旧日志的工具名级指纹已被服务端置空）就不能说「相同调用」：每次失败自成一组。
      for (const f of fails) { const k = f.invocation_key ?? `ts:${f.ts_ms}:${f.step}`; byKey.set(k, [...(byKey.get(k) ?? []), f]); }
      const top = [...byKey.values()].sort((a, b) => b.length - a.length)[0] ?? [];
      const first = top[0];
      return <div className="insights-insp">
        <h4>{t.title}</h4><p className="muted num">{rangeLabel}</p>
        <div className="insights-big num">{tx("ins.timesN", { n: typeof d.fact.failures === "number" ? d.fact.failures : 0 })}<small>{d.fact.same_invocation ? tx("ins.sameCallFailed") : tx("ins.callFailedShort")}</small></div>
        {loading && <p className="muted">{tx("ins.readingErr")}</p>}
        {evErr && <p className="muted">{tx("ins.errSummaryUnavailable")}{retryButton}</p>}
        {first && <><dl className="kv"><dt>{tx("ins.calls")}</dt><dd className="num wrap">{first.capability_id ?? tx("ins.tool")} · {first.args_excerpt ?? "—"}</dd></dl>
          <div><p className="muted">{top.length > 1 && first.invocation_key ? tx("ins.errSummaryN", { n: top.length }) : tx("ins.errSummaryOne")}</p><pre className="insights-excerpt">{(first.error_excerpt ?? tx("ins.noErrorText")).split("\n")[0]}</pre><LocalNote /></div>
          <div className="insights-acts"><button type="button" className="button button-primary" onClick={() => go({ kind: "failure", step: first.step ?? d.steps.from, ts: first.ts_ms })}>{tx("ins.viewOneFailure")}</button><button type="button" className="button button-secondary" onClick={() => go({ kind: "calls", from: d.steps.from, to: d.steps.to })}>{tx("ins.viewRelated")}</button></div>
          <ul className="insights-list">{fails.slice(0, 30).map((f, i) => <li key={i}><button type="button" className="row" onClick={() => go({ kind: "failure", step: f.step ?? d.steps.from, ts: f.ts_ms })}><span className="fail">✕</span><span>{unit} {f.step} · {f.capability_id ?? tx("ins.tool")}</span><span className="num muted">{clock(f.ts_ms)}</span></button></li>)}</ul></>}
        {rm && <div className="insights-note"><b>{tx("ins.advice")}</b> {rm[0]}<br /><span className="muted">{tx("ins.notAllSaved", { unit: uN(unit, d.steps.to - d.steps.from + 1), tokens: fmtTokens(d.impact.tokens) })}</span></div>}
        {d.failure_exposure && (
          <dl className="kv insights-exposure">
            <dt>{tx("ins.expInput")}</dt><dd className="num">{fmtTokens(d.failure_exposure.affected_input_tokens)} tokens</dd>
            {d.failure_exposure.nominal_amounts.length > 0 ? (
              <>
                <dt>{tx("ins.expEstimate")}</dt>
                <dd className="num">
                  {d.failure_exposure.nominal_amounts.map(a => `${a.currency === "USD" ? "$" : a.currency === "CNY" ? "¥" : `${a.currency} `}${(a.amount_minor / 100).toFixed(2)}`).join(" + ")}
                  {d.failure_exposure.coverage === "partial" && tx("ins.expPartial", { tokens: fmtTokens(d.failure_exposure.unpriced_tokens) })}
                </dd>
              </>
            ) : (
              <>
                <dt>{tx("ins.expCost")}</dt>
                <dd className="num">{d.failure_exposure.reason === "no_pricing_snapshot" ? tx("ins.noSnapshot") : tx("ins.noPriceCard")}</dd>
              </>
            )}
            <dd className="muted insights-disclaimer">{tx("ins.expDisclaimer")}</dd>
          </dl>
        )}
      </div>;
    }
    if (d.kind === "input_growth") {
      const topStep = L.reduce((m, s) => (s.input_peak > m.input_peak ? s : m), L[0]);
      return <div className="insights-insp">
        <h4>{t.title}</h4><p className="muted num">{rangeLabel}</p>
        <div className="insights-big num">{(typeof d.fact.ratio === "number" ? d.fact.ratio : 0).toFixed(1)}×<small>{tx("ins.peakInput")}</small></div>
        <dl className="kv"><dt>{tx("ins.from")}</dt><dd className="num">{fmtTokens(Number(d.fact.peak_from ?? 0))}（{unit} {d.steps.from}）</dd><dt>{tx("ins.to")}</dt><dd className="num">{fmtTokens(Number(d.fact.peak_to ?? 0))}（{unit} {d.steps.to}）</dd><dt>{tx("ins.rangeCalls")}</dt><dd className="num">{L.reduce((a, s) => a + s.calls, 0)}</dd><dt>{tx("ins.shareInput")}</dt><dd className="num">{fmtPct(d.impact.share_of_session_input)}</dd></dl>
        <Spark values={L.map(s => s.input_peak)} />
        <div className="insights-note"><b>{tx("ins.cause")}</b> {t.why}</div>
        <div className="insights-acts"><button type="button" className="button button-primary" onClick={() => go({ kind: "step", step: topStep.index })}>{tx("ins.viewPeak", { unit })}</button><button type="button" className="button button-secondary" onClick={() => go({ kind: "calls", from: d.steps.from, to: d.steps.to })}>{tx("ins.viewPerCall")}</button></div>
        {rm && <div className="insights-note"><b>{tx("ins.advice")}</b> {rm[0]}<br /><span className="muted">{rm[1]}</span></div>}
      </div>;
    }
    const rangeInput = L.reduce((a, s) => a + inputOf(s), 0);
    const rangeRead = L.reduce((a, s) => a + s.input.cache_read, 0);
    const restInput = all - rangeInput;
    return <div className="insights-insp">
      <h4>{t.title}</h4><p className="muted num">{rangeLabel}</p>
      <div className="insights-big num">{fmtTokens(Number(d.fact.uncached_tokens ?? 0))}<small>{tx("ins.uncachedTokens")}</small></div>
      <dl className="kv"><dt>{tx("ins.rangeHit")}</dt><dd className="num">{rangeInput ? fmtPct(rangeRead / rangeInput) : "—"}</dd><dt>{tx("ins.restOfSession")}</dt><dd className="num">{restInput > 0 ? fmtPct((insights.session.input.cache_read - rangeRead) / restInput) : "—"}</dd><dt>{tx("ins.shareInput")}</dt><dd className="num">{fmtPct(d.impact.share_of_session_input)}</dd></dl>
      <ul className="insights-list">{L.slice(0, 40).map(s => <li key={s.index}><button type="button" className="row" onClick={() => go({ kind: "step", step: s.index })}><span className="num">{unit} {s.index}</span><span className="muted">{s.idle_before_ms != null ? tx("ins.idleFor", { d: fmtDuration(s.idle_before_ms) }) : ""} · {s.model_ids.map((id) => modelLabel(id)).join("→")}</span><span className="num">{s.hit_rate != null ? fmtPct(s.hit_rate) : "—"}</span></button></li>)}</ul>
      <div className="insights-note"><b>{tx("ins.cause")}</b> {t.why}</div>
      <div className="insights-acts"><button type="button" className="button button-primary" onClick={() => go({ kind: "calls", from: d.steps.from, to: d.steps.to })}>{tx("ins.viewPerCall")}</button></div>
      {rm && <div className="insights-note"><b>{tx("ins.advice")}</b> {rm[0]}<br /><span className="muted">{rm[1]}</span></div>}
    </div>;
  }

  // 普通回合
  const s = steps[mode.step - 1];
  if (!s) return null;
  const a = inputOf(s);
  const cost = fmtMoney(s.nominal_cost);
  const fails = evData?.failures ?? [];
  return <div className="insights-insp">
    <h4>{unit} {s.index}</h4>
    <p className="muted num">{tx("ins.startedAt", { time: clock(s.started_at_ms) })}{s.ended_at_ms != null ? tx("ins.tookDur", { d: fmtDuration(Math.max(0, s.ended_at_ms - s.started_at_ms)) }) : tx("ins.notMeasured")}{s.idle_before_ms != null ? tx("ins.idleBeforeDur", { d: fmtDuration(s.idle_before_ms) }) : ""}</p>
    <dl className="kv">
      <dt>{tx("ins.inOut")}</dt><dd className="num">{fmtTokens(a)} / {fmtTokens(s.output)}</dd>
      <dt>{tx("ins.calls")}</dt><dd className="num">{s.calls}</dd>
      <dt>{tx("ins.peakInput")}</dt><dd className="num">{fmtTokens(s.input_peak)}</dd>
      <dt>{tx("ins.hitRate")}</dt><dd className="num">{s.hit_rate != null ? fmtPct(s.hit_rate) : "—"}</dd>
      <dt>{tx("ins.model")}</dt><dd className="wrap">{s.model_ids.map((id) => modelLabel(id)).join(" → ") || "—"}</dd>
      {s.outcome && <><dt>{tx("ins.outcome")}</dt><dd>{tx(({ succeeded: "ins.outSucceeded", failed: "ins.outFailed", cancelled: "ins.outCancelled", unknown: "ins.outUnknown" } as const)[s.outcome])}</dd></>}
      <dt>{tx("ins.nominal")}</dt><dd className="num">{cost ?? tx("ins.noPricing")}</dd>
    </dl>
    {cost && <p className="insights-local">{tx("ins.nominalNote2")}</p>}
    {s.notes.map((n, i) => <div key={i} className="insights-note warn">{tx("ins.callsHappened", { calls: n.calls, note: noteText(n.explanation) ?? "" })}</div>)}
    <Buckets input={s.input} noWrite={noWrite} />
    {insights.lanes.tools.state === "unavailable"
      ? <p className="muted">{tx("ins.sumTools", { reason: laneReason(insights.lanes.tools.reason) })}</p>
      : <dl className="kv"><dt>{tx("ins.toolOk")}</dt><dd className="num">{s.tools.succeeded}</dd><dt>{tx("ins.failedLabel")}</dt><dd className={`num${s.tools.failed ? " fail" : ""}`}>{s.tools.failed}</dd><dt>{tx("ins.cancelledLabel")}</dt><dd className="num">{s.tools.cancelled}</dd><dt>{tx("ins.resultUnknown")}</dt><dd className="num">{s.tools.unknown}</dd></dl>}
    {fails.length > 0 && <><ul className="insights-list">{fails.slice(0, 20).map((f, i) => <li key={i}><button type="button" className="row bad" onClick={() => go({ kind: "failure", step: s.index, ts: f.ts_ms })}><span className="fail">✕</span><span className="num">{f.capability_id ?? tx("ins.tool")}：{(f.error_excerpt ?? "").split("\n")[0].slice(0, 60) || tx("ins.outFailed")}</span><span>›</span></button></li>)}</ul><LocalNote /></>}
    <div className="insights-acts"><button type="button" className="button button-secondary" onClick={() => go({ kind: "calls", from: s.index, to: s.index })}>{tx("ins.viewPerCall")}</button></div>
  </div>;
}

function CallsTable({ ev, unit }: { ev: SessionTraceEvidence; unit: string }) {
  const failedAt = new Set(ev.failures.map(f => f.step));
  let prev = -1;
  let k = 0;
  return <>
    <div className="insights-calls-wrap"><table className="insights-calls"><thead><tr><th>{unit} · {tx("ins.calls")}</th><th>{tx("ins.model")}</th><th>{tx("ins.input")}</th><th>{tx("ins.hit")}</th><th>{tx("ins.output")}</th></tr></thead><tbody>
      {ev.calls.slice(0, 2000).map((c, i) => {
        if (c.step !== prev) { prev = c.step ?? -1; k = 0; }
        k += 1;
        const a = inputOf(c);
        const hit = a ? c.input.cache_read / a : 0;
        return <tr key={i} className={a >= 10_000 && hit < 0.5 ? "low" : ""}><td className="num">{c.step}·{k}{failedAt.has(c.step) && k === 1 ? " ✕" : ""}</td><td>{(c.model_id ?? "—").replace("claude-", "")}</td><td className="num">{fmtTokens(a)}</td><td className="num">{a ? fmtPct(hit) : "—"}</td><td className="num">{fmtTokens(c.output)}</td></tr>;
      })}
    </tbody></table></div>
    <p className="insights-local">{tx("ins.callsLegend", { unit })}</p>
  </>;
}

function Spark({ values }: { values: number[] }) {
  const W = 280, H = 46, mx = Math.max(1, ...values), n = values.length;
  const pts = values.map((v, k) => `${(k / Math.max(1, n - 1) * (W - 8) + 4).toFixed(1)},${(H - 4 - v / mx * (H - 10)).toFixed(1)}`).join(" ");
  return <svg className="insights-spark" viewBox={`0 0 ${W} ${H}`} aria-hidden="true"><polyline points={pts} /></svg>;
}
