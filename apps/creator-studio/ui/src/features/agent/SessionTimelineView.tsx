import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { turnOutcomeLabel, type SessionTimelineRow } from "./sessionTimeline";
import { findApplyQuery, findCounter, findInitialState, findMove, highlightRanges, type FindState, type FindableRow } from "./threadFind";
import { useTimelineFollow } from "./useTimelineFollow";

const rowElementId = (rowId: string) => `find-row-${rowId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

/**
 * 会话时间线：历史回合（用户请求 + 结果徽标）oldest-first 排布，活动任务的
 * 决策卡由 renderActive 槽注入；settle 行表达「仍在收尾」；跳底按钮遵循
 * useTimelineFollow 的防抖与减少动态效果约定。⌘F/Ctrl+F 打开查找条——
 * 搜索范围是行模型可见文本（回合请求与 settle 行）；活动块的富内容不参与
 * 高亮，如实限定（T3 find-in-thread 的领域化简化）。
 */
export function SessionTimeline({ rows, followKey, renderActive, header, emptyHint }: Readonly<{
  rows: readonly SessionTimelineRow[];
  followKey: unknown;
  renderActive?: () => ReactNode;
  header?: ReactNode;
  emptyHint?: ReactNode;
}>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { pillVisible, onScroll, jumpToEnd } = useTimelineFollow(containerRef, followKey);
  const hasContent = rows.some(row => row.kind !== "truncated");
  const [findOpen, setFindOpen] = useState(false);
  const [findState, setFindState] = useState<FindState>(findInitialState);
  const findInputRef = useRef<HTMLInputElement>(null);
  const searchable = useMemo(() => rows.flatMap<FindableRow>(row => {
    if (row.kind === "turn") return [{ rowId: `turn-${row.taskId}`, text: row.humanRequest }];
    if (row.kind === "settle") return [{ rowId: row.id, text: row.detail ? `${row.label} · ${row.detail}` : row.label }];
    return [];
  }), [rows]);
  // 新回合/settle 行到来时按当前查询重算命中，保持计数与定位同步。
  useEffect(() => {
    setFindState(state => state.query ? findApplyQuery(state, state.query, searchable) : state);
  }, [searchable]);
  useEffect(() => {
    if (!findOpen) return;
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, [findOpen]);
  // ⌘F / Ctrl+F 打开（webview 应用接管浏览器默认查找）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const closeFind = () => { setFindOpen(false); setFindState(findInitialState()); };
  const moveFind = (direction: 1 | -1) => setFindState(state => findMove(state, direction));
  // 当前命中滚动定位；回合行内的高亮由渲染层按查询切分。
  useEffect(() => {
    const hit = findState.hits[findState.index];
    if (!hit || !findOpen) return;
    const target = containerRef.current?.querySelector(`#${CSS.escape(rowElementId(hit.rowId))}`);
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    target?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  }, [findState, findOpen]);
  const segmentsFor = (text: string) => highlightRanges(text, findOpen ? findState.query : "");
  const findBar = findOpen && <div className="agent-findbar" role="search" aria-label="在会话时间线中查找">
    <input ref={findInputRef} aria-label="查找内容" value={findState.query} placeholder="查找会话内容…"
      onChange={event => setFindState(state => findApplyQuery(state, event.target.value, searchable))}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); closeFind(); }
        if (event.key === "Enter") { event.preventDefault(); moveFind(event.shiftKey ? -1 : 1); }
      }} />
    <span className="agent-findbar-count" role="status">{findCounter(findState)}</span>
    <button type="button" aria-label="上一个命中" disabled={findState.hits.length === 0} onClick={() => moveFind(-1)}>↑</button>
    <button type="button" aria-label="下一个命中" disabled={findState.hits.length === 0} onClick={() => moveFind(1)}>↓</button>
    <button type="button" aria-label="关闭查找" onClick={closeFind}>×</button>
  </div>;
  return <div className="agent-timeline-wrap">
    {findBar}
    <div className="agent-timeline" ref={containerRef} onScroll={onScroll} aria-label="会话时间线">
      {header}
      {!hasContent && emptyHint}
      {rows.map(row => {
        if (row.kind === "truncated") {
          return <p key="history-truncated" id={rowElementId("history-truncated")} className="muted agent-history-boundary">更早的任务已由宿主归档，仅保留最近 30 条。</p>;
        }
        if (row.kind === "turn") {
          return <article key={row.taskId} id={rowElementId(`turn-${row.taskId}`)} data-find-row={`turn-${row.taskId}`} className="agent-turn">
            <div className="agent-user-message">{segmentsFor(row.humanRequest).map((segment, index) => segment.hit
              ? <mark key={index} className="agent-find-mark">{segment.text}</mark>
              : <span key={index}>{segment.text}</span>)}</div>
            <span className={`agent-turn-outcome is-${row.outcome.state}`}>{turnOutcomeLabel[row.outcome.state]}</span>
          </article>;
        }
        if (row.kind === "active") {
          return <div key={`active-${row.taskId}`} className="agent-active-block">{renderActive?.()}</div>;
        }
        return <p key={row.id} id={rowElementId(row.id)} className={`agent-settle is-${row.tone}`} role="status">
          <span className="agent-settle-dot" aria-hidden="true" />{row.label}
          {row.detail && <span className="muted"> · {row.detail}</span>}
        </p>;
      })}
    </div>
    {pillVisible && <button type="button" className="agent-jump-bottom" onClick={jumpToEnd}>回到最新 ↓</button>}
  </div>;
}
