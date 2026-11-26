import { useRef, type ReactNode } from "react";
import { turnOutcomeLabel, type SessionTimelineRow } from "./sessionTimeline";
import { useTimelineFollow } from "./useTimelineFollow";

/**
 * 会话时间线：历史回合（用户请求 + 结果徽标）oldest-first 排布，活动任务的
 * 决策卡由 renderActive 槽注入；settle 行表达「仍在收尾」；跳底按钮遵循
 * useTimelineFollow 的防抖与减少动态效果约定。
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
  return <div className="agent-timeline-wrap">
    <div className="agent-timeline" ref={containerRef} onScroll={onScroll} aria-label="会话时间线">
      {header}
      {!hasContent && emptyHint}
      {rows.map(row => {
        if (row.kind === "truncated") {
          return <p key="history-truncated" className="muted agent-history-boundary">更早的任务已由宿主归档，仅保留最近 30 条。</p>;
        }
        if (row.kind === "turn") {
          return <article key={row.taskId} className="agent-turn">
            <div className="agent-user-message">{row.humanRequest}</div>
            <span className={`agent-turn-outcome is-${row.outcome.state}`}>{turnOutcomeLabel[row.outcome.state]}</span>
          </article>;
        }
        if (row.kind === "active") {
          return <div key={`active-${row.taskId}`} className="agent-active-block">{renderActive?.()}</div>;
        }
        return <p key={row.id} className={`agent-settle is-${row.tone}`} role="status">
          <span className="agent-settle-dot" aria-hidden="true" />{row.label}
          {row.detail && <span className="muted"> · {row.detail}</span>}
        </p>;
      })}
    </div>
    {pillVisible && <button type="button" className="agent-jump-bottom" onClick={jumpToEnd}>回到最新 ↓</button>}
  </div>;
}
