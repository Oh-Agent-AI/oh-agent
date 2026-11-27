import "./agentConversation.css";
import { useState } from "react";
import { AgentDecisionCard } from "./AgentDecisionCard";
import { AgentSelector } from "./AgentSelector";
import type { AgentCommit } from "./agentApproval";
import type { AgentActivityItem } from "./useAgentActivity";
import { GoalBriefComposer } from "./GoalBriefComposer";
import { StudioTaskPanel } from "./StudioTaskPanel";
import type { StudioTaskController } from "./useStudioTasks";
import type { PreviewEntityReferenceStatus, StudioEntityTarget } from "../../contracts/previewContext";
import { workspaceAreaProps } from "../workspace/workspaceFocus";

export type AgentPreviewStatus = { context: object; status: "loading" | "ready" | "failed"; code?: string };

export function AgentWorkspace(props: Readonly<{
  project: Readonly<{ projectId: string; title?: string; revision: number }> | null;
  taskController: StudioTaskController;
  browserPreview: boolean;
  agentCommit: AgentCommit | null;
  agentActivity: readonly AgentActivityItem[];
  agentCityPreview: object | null;
  agentPreviewStatus: AgentPreviewStatus | null;
  busy: boolean;
  scopeTitle?: string;
  target?: string;
  targetReference?: StudioEntityTarget;
  targetReferenceStatus?: PreviewEntityReferenceStatus;
  onClearTarget?: () => void;
  onViewChanges?: () => void;
  goal: string;
  onGoalChange: (goal: string) => void;
  onResolve: (approve: boolean) => void;
  /** 确认前置检查（作用域/版本/未提交草稿）；null 表示可确认。 */
  commitBlockedReason?: string | null;
  /** 任务构件是否就绪（project 或 City scope 均可）；City 只读预览下 project 为空但仍可创作。 */
  scopeReady?: boolean;
  /** 窄屏（≤800px）Sessions 抽屉开关；按钮只在窄屏媒体查询里可见。 */
  onToggleSessions?: () => void;
}>) {
  const { project, taskController, browserPreview, agentCommit, agentActivity, agentCityPreview, agentPreviewStatus, busy, goal, onGoalChange, onResolve, commitBlockedReason, scopeReady, onToggleSessions } = props;
  const [demoAgent, setDemoAgent] = useState("Codex ACP");
  if (browserPreview) return <section className="agent-panel agent-workspace" {...workspaceAreaProps("agent", 1, "Agent 创作伙伴")}>
    <label className="agent-executor">选择 Agent（演示）
      <select aria-label="选择 Agent（演示）" value={demoAgent} onChange={event => setDemoAgent(event.target.value)}>
        {["Codex ACP", "Kimi Code", "DeepSeek Harness"].map(name => <option key={name}>{name}</option>)}
      </select>
    </label>
    <div className="agent-demo-intro"><strong>{props.scopeTitle ?? project?.title ?? "创作目标"}</strong>
      <p>写下你想修改的内容。在桌面 Studio 中可选择 Agent、发送任务和审阅修改。</p></div>
    {props.target && <p>{props.target} <button onClick={props.onClearTarget}>移除关联</button></p>}
    <GoalBriefComposer goal={goal} onGoalChange={onGoalChange} agentName={demoAgent} context={props.target} scope={props.scopeTitle ?? project?.title} />
  </section>;
  const scope = props.scopeTitle ?? (project ? project.title || "未命名作品" : "尚未选择作品");
  const selected = taskController.capabilities?.executors.find(item => item.id === taskController.executor);
  const connectionLabel = !taskController.capabilities ? "正在检查连接" : !taskController.capabilities.studioOnline ? "Studio 离线"
    : selected?.available && selected.modes.some(mode => mode.restricted) ? "可用于创作" : "请选择可用 Agent";
  return <section className="agent-panel agent-workspace" {...workspaceAreaProps("agent", 1, "Agent 面板")}>
    <AgentSelector controller={taskController} />
    <div className="agent-workspace-heading"><div><span className="section-title">当前作品</span><p className="muted">{scope}</p></div><span className="agent-connection">{connectionLabel}</span><button className="agent-sessions-toggle" type="button" onClick={props.onToggleSessions}>Sessions</button></div>
    <StudioTaskPanel target={props.target} targetReference={props.targetReference} targetReferenceStatus={props.targetReferenceStatus} onClearTarget={props.onClearTarget} onViewChanges={props.onViewChanges} controller={taskController} goal={goal} onGoalChange={onGoalChange} projectReady={(scopeReady ?? (!!project && !busy))} commitBlockedReason={commitBlockedReason} tools={<>
    <details className="agent-copy-brief"><summary>复制目标给外部 Agent</summary>
      <GoalBriefComposer goal={goal} onGoalChange={onGoalChange} scope={scope} context={props.target} />
    </details>
    {agentActivity.length > 0 && <details className="agent-evidence" aria-label="已有活动与证据">
      <summary className="section-title">已有活动与证据</summary>
      <p className="muted">这些是 Studio 已转发请求的真实记录；仅在有数据时展示，不表示 Agent 当前在线。</p>
      {agentActivity.length > 0 ? <div className="agent-activity">{agentActivity.map(item => <div key={item.at} className={`agent-card ${item.ok ? "" : "failed"}`}>
        <div className="agent-card-head"><span className="agent-label">{item.label}</span><span className="agent-time">{new Date(item.at).toLocaleTimeString()}</span></div>
        {item.summary && <p className="agent-summary">{item.summary}</p>}
        <p className="muted">{item.ok ? `已受理${item.revision !== undefined ? ` · revision ${item.revision}` : ""}` : "请求失败（错误码见状态区）"}</p>
      </div>)}</div> : <p className="muted">尚无 Host 转发活动或差异证据。</p>}
    </details>}

    </>}>
    {taskController.connectionError && <p className="agent-connection-note" role="alert">连接异常：{taskController.connectionError}。请检查连接后重试。</p>}
    {agentCommit && <AgentDecisionCard title="确认外部 Agent 修改">
        <p>{agentCommit.proposal.summary}</p>{agentCommit.proposal.details.length > 0 && <ul>{agentCommit.proposal.details.map((detail, index) => <li key={index}>{detail}</li>)}</ul>}<details><summary>查看真实差异与修改内容</summary><pre className="agent-proposal-content">{agentCommit.proposal.changes}</pre></details><p className="muted">项目 {agentCommit.projectId}。{agentCommit.proposal.requiresCityPreview ? !agentCityPreview ? "无法显示该城市修改：请打开对应项目、等待基准布局就绪，并将单个城市补丁单独预览。" : agentPreviewStatus?.context !== agentCityPreview || agentPreviewStatus.status === "loading" ? "正在准备三维临时预览。" : agentPreviewStatus.status === "failed" ? "预览失败或包含失效项，不能保存。" : "基准路网已匹配，三维临时预览已显示；确认后才会保存。" : "此修改尚未提供三维预览，确认后才会保存。"}</p>
        <div className="actions"><button disabled={busy || project?.projectId !== agentCommit.projectId || project.revision !== agentCommit.expectedRevision || (agentCommit.proposal.requiresCityPreview && (!agentCityPreview || agentPreviewStatus?.context !== agentCityPreview || agentPreviewStatus.status !== "ready"))} onClick={() => onResolve(true)}>确认保存</button><button className="secondary" disabled={busy} onClick={() => onResolve(false)}>取消</button></div>
    </AgentDecisionCard>}


    </StudioTaskPanel>
  </section>;
}
