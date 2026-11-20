import type { AgentCommit } from "./agentApproval";
import type { AgentActivityItem } from "./useAgentActivity";
import { GoalBriefComposer } from "./GoalBriefComposer";

export type AgentPreviewStatus = { context: object; status: "loading" | "ready" | "failed"; code?: string };

export function AgentWorkspace(props: Readonly<{
  project: Readonly<{ projectId: string; title?: string; revision: number }> | null;
  agentCommit: AgentCommit | null;
  agentActivity: readonly AgentActivityItem[];
  agentCityPreview: object | null;
  agentPreviewStatus: AgentPreviewStatus | null;
  busy: boolean;
  onResolve: (approve: boolean) => void;
}>) {
  const { project, agentCommit, agentActivity, agentCityPreview, agentPreviewStatus, busy, onResolve } = props;
  const scope = project ? `${project.title ?? project.projectId}（${project.projectId}，revision ${project.revision}）` : "尚未选择 Creator Project";
  return <section className="agent-panel agent-workspace" aria-label="Agent Workspace">
    <div className="agent-workspace-heading"><div><span className="section-title">Agent Workspace</span><p className="muted">目标与范围：{scope}</p></div><span className="agent-connection">未连接 Agent Task Bridge</span></div>
    <p className="agent-connection-note">当前仅可复制任务说明，不能创建或执行 Agent Task。已有 Host 活动不代表 Agent 在线，也不用于推断连接状态。</p>
    <GoalBriefComposer scope={scope} />

    <section className="agent-decisions" aria-label="需要人工的决策">
      <div className="section-title">需要人工的决策</div>
      {agentCommit ? <div className="agent-card" role="group" aria-label="等待确认的 Agent 修改"><div className="agent-card-head"><span className="agent-label">等待确认</span><span className="agent-time">版本 {agentCommit.expectedRevision}</span></div>
        <p>{agentCommit.proposal.summary}</p>{agentCommit.proposal.details.length > 0 && <ul>{agentCommit.proposal.details.map((detail, index) => <li key={index}>{detail}</li>)}</ul>}<details><summary>查看真实差异与修改内容</summary><pre className="agent-proposal-content">{agentCommit.proposal.changes}</pre></details><p className="muted">项目 {agentCommit.projectId}。{agentCommit.proposal.requiresCityPreview ? !agentCityPreview ? "无法显示该城市修改：请打开对应项目、等待基准布局就绪，并将单个城市补丁单独预览。" : agentPreviewStatus?.context !== agentCityPreview || agentPreviewStatus.status === "loading" ? "正在准备三维临时预览。" : agentPreviewStatus.status === "failed" ? "预览失败或包含失效项，不能保存。" : "基准路网已匹配，三维临时预览已显示；确认后才会保存。" : "此修改尚未提供三维预览，确认后才会保存。"}</p>
        <div className="actions"><button disabled={busy || (agentCommit.proposal.requiresCityPreview && (!agentCityPreview || agentPreviewStatus?.context !== agentCityPreview || agentPreviewStatus.status !== "ready"))} onClick={() => onResolve(true)}>确认保存</button><button className="secondary" disabled={busy} onClick={() => onResolve(false)}>取消</button></div></div>
        : <p className="muted">当前没有等待人工确认的修改。</p>}
    </section>

    <section className="agent-evidence" aria-label="已有活动与证据">
      <div className="section-title">已有 Host 活动</div>
      <p className="muted">这些是 Studio 已转发请求的真实记录；仅在有数据时展示，不表示 Agent 当前在线。</p>
      {agentActivity.length > 0 ? <div className="agent-activity">{agentActivity.map(item => <div key={item.at} className={`agent-card ${item.ok ? "" : "failed"}`}>
        <div className="agent-card-head"><span className="agent-label">{item.label}</span><span className="agent-time">{new Date(item.at).toLocaleTimeString()}</span></div>
        {item.summary && <p className="agent-summary">{item.summary}</p>}
        <p className="muted">{item.ok ? `已受理${item.revision !== undefined ? ` · revision ${item.revision}` : ""}` : "请求失败（错误码见状态区）"}</p>
      </div>)}</div> : <p className="muted">尚无 Host 转发活动或差异证据。</p>}
    </section>
  </section>;
}
