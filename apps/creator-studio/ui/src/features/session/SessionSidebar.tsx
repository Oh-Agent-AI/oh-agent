import { useEffect, useState } from "react";
import { resolveSessionStatus } from "../../contracts/studioTask";
import { workspaceAreaProps } from "../workspace/workspaceFocus";
import type { StudioSessionSummary } from "./studioSessions";

const phaseLabel = (phase: string) => ({
  planning: "规划中", "awaiting-plan-approval": "待批准计划", ready: "待执行", executing: "执行中", validating: "校验中",
  repairing: "修复中", "awaiting-review": "待确认", accepted: "已保存", rejected: "已退回", failed: "失败", cancelled: "已取消",
} as Record<string, string>)[phase] ?? "无任务";

export function SessionSidebar(props: Readonly<{
  scopeTitle: string;
  projectRevision: number | null;
  worldRevision: string | null;
  sessions: readonly StudioSessionSummary[];
  activeSessionId: string | null;
  loading: boolean;
  creating: boolean;
  saving: boolean;
  error: string;
  previewLocked: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  onRename: (sessionId: string, label: string) => Promise<boolean>;
  onArchive: (sessionId: string) => void;
  onRestore: (sessionId: string) => void;
}>) {
  const [editing, setEditing] = useState<Readonly<{ sessionId: string; value: string }> | null>(null);
  // 归档不可撤销地占掉一个名额，所以第一下只"上膛"，第二下才真的关。
  const [armedArchive, setArmedArchive] = useState<string | null>(null);
  // T3 侧栏语义：失败点持续到该行被看过；当前激活会话的失败视为已读。
  const [seenFailures, setSeenFailures] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!props.activeSessionId) return;
    setSeenFailures(current => current.has(props.activeSessionId!) ? current : new Set([...current, props.activeSessionId!]));
  }, [props.activeSessionId]);
  const submitRename = async () => {
    if (!editing) return;
    if (await props.onRename(editing.sessionId, editing.value)) setEditing(null);
  };
  return <aside className="session-sidebar" {...workspaceAreaProps("sessions", 0, "创作 Sessions")}>
    <div className="session-sidebar-heading"><div><span>OH AGENT STUDIO</span><h2>Sessions</h2></div>
      <button type="button" aria-label="新建 Session" disabled={props.creating} onClick={props.onCreate}>＋</button></div>
    <div className="session-project-scope"><strong>{props.scopeTitle}</strong><span>当前 Project 的创作会话</span>
      {props.projectRevision !== null && <small>Project revision {props.projectRevision}</small>}
      {props.worldRevision && <code title={props.worldRevision}>World {props.worldRevision}</code>}
    </div>
    <button type="button" className="secondary session-create" disabled={props.creating} onClick={props.onCreate}>{props.creating ? "正在创建…" : "新建 Session"}</button>
    <label className="session-search"><span>搜索 Sessions</span>
      <input type="search" value={props.query} placeholder="按名称或最近需求搜索" onChange={event => props.onQueryChange(event.target.value)} />
    </label>
    {props.previewLocked && <p className="session-preview-lock">Preview 已锁定；其他 Session 不会自动替换画面。</p>}
    {props.saving && <p className="session-saving" role="status">正在保存会话档案…</p>}
    {props.error && <p className="library-error" role="alert">{props.error}</p>}
    <div className="session-list" aria-label="当前 Project 的 Sessions">
      {props.loading && <p className="muted">正在读取 Sessions…</p>}
      {!props.loading && props.sessions.length === 0 && <p className="muted">{props.query.trim() ? "没有匹配的 Session。" : "还没有创作会话。"}</p>}
      {props.sessions.map(session => {
        const active = session.sessionId === props.activeSessionId;
        const editingThis = editing?.sessionId === session.sessionId;
        // 执行中/校验中的任务还在往这个会话写证据，归档会把它从当前视图里摘掉。
        const live = session.latestTask?.phase === "executing" || session.latestTask?.phase === "validating";
        // 状态点优先级：待确认 > 失败（未看过）> 进行中；纯视觉提示，文字标签仍可读。
        const status = resolveSessionStatus(session.latestTask);
        const failedUnseen = status === "failed" && !seenFailures.has(session.sessionId);
        const dot = session.state === "open" && (status === "awaiting-confirmation" || status === "working" || failedUnseen)
          ? status : "";
        return <div key={session.sessionId} className={`session-row ${active ? "active" : ""} ${session.state === "closed" ? "closed" : ""}`}>
          {editingThis ? <div className="session-rename">
            <input aria-label="Session 名称" autoFocus maxLength={80} value={editing.value}
              onChange={event => setEditing({ sessionId: session.sessionId, value: event.target.value })}
              onKeyDown={event => { if (event.key === "Enter") void submitRename(); if (event.key === "Escape") setEditing(null); }} />
            <button type="button" className="secondary" onClick={() => void submitRename()}>保存名称</button>
            <button type="button" className="secondary" onClick={() => setEditing(null)}>取消</button>
          </div> : <button type="button" className="session-row-main" aria-pressed={active} onClick={() => props.onSelect(session.sessionId)}>
            <span className="session-row-heading"><strong>{session.label}</strong>
              {dot && <span className={`session-dot is-${dot}`} aria-hidden="true" data-title={dot} />}
              <small>{phaseLabel(session.latestTask?.phase ?? "")}</small></span>
            <span className="session-row-summary">{session.latestTask?.humanRequest ?? "开始一个新的创作任务"}</span>
            <span className="session-row-meta">{session.state === "closed" ? "历史会话 · " : ""}{session.latestTask?.expectedRevision !== null && session.latestTask?.expectedRevision !== undefined
              ? `基于 revision ${session.latestTask.expectedRevision} · ` : ""}{new Date(session.updatedAtMs).toLocaleDateString()}</span>
          </button>}
          <span className="session-row-actions">
            {session.state === "open" ? <>
              <button type="button" className="secondary" onClick={() => { setArmedArchive(null); setEditing({ sessionId: session.sessionId, value: session.label }); }}>重命名</button>
              <button type="button" className={armedArchive === session.sessionId ? "secondary danger" : "secondary"} disabled={live}
                title={live ? "任务执行中，暂不能归档" : "归档后可在历史会话里恢复"}
                onBlur={() => setArmedArchive(current => current === session.sessionId ? null : current)}
                onClick={() => { if (armedArchive === session.sessionId) { setArmedArchive(null); props.onArchive(session.sessionId); } else setArmedArchive(session.sessionId); }}>
                {armedArchive === session.sessionId ? "确认归档" : "归档"}
              </button>
            </> : <button type="button" className="secondary" onClick={() => props.onRestore(session.sessionId)}>恢复</button>}
          </span>
        </div>;
      })}
    </div>
  </aside>;
}
