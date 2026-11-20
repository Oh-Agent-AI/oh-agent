import type { AgentCommit } from "./agentApproval";
import type { AgentActivityItem } from "./useAgentActivity";

export type AgentPreviewStatus = { context: object; status: "loading" | "ready" | "failed"; code?: string };

export function AgentPanel(props: Readonly<{
  agentCommit: AgentCommit | null;
  agentActivity: readonly AgentActivityItem[];
  agentCityPreview: object | null;
  agentPreviewStatus: AgentPreviewStatus | null;
  busy: boolean;
  onResolve: (approve: boolean) => void;
}>) {
  const { agentCommit, agentActivity, agentCityPreview, agentPreviewStatus, busy, onResolve } = props;
  return <section className="agent-panel" aria-label="City Agent">
    {agentCommit && <div className="agent-card" role="group" aria-label="等待确认的 Agent 修改"><div className="agent-card-head"><span className="agent-label">等待确认</span><span className="agent-time">版本 {agentCommit.expectedRevision}</span></div>
      <p>{agentCommit.proposal.summary}</p>{agentCommit.proposal.details.length > 0 && <ul>{agentCommit.proposal.details.map((detail, index) => <li key={index}>{detail}</li>)}</ul>}<details><summary>查看完整修改内容</summary><pre className="agent-proposal-content">{agentCommit.proposal.changes}</pre></details><p className="muted">项目 {agentCommit.projectId}。{agentCommit.proposal.requiresCityPreview ? !agentCityPreview ? "无法显示该城市修改：请打开对应项目、等待基准布局就绪，并将单个城市补丁单独预览。" : agentPreviewStatus?.context !== agentCityPreview || agentPreviewStatus.status === "loading" ? "正在准备三维临时预览。" : agentPreviewStatus.status === "failed" ? "预览失败或包含失效项，不能保存。" : "基准路网已匹配，三维临时预览已显示；确认后才会保存。" : "此修改尚未提供三维预览，确认后才会保存。"}</p>
      <div className="actions"><button disabled={busy || (agentCommit.proposal.requiresCityPreview && (!agentCityPreview || agentPreviewStatus?.context !== agentCityPreview || agentPreviewStatus.status !== "ready"))} onClick={() => onResolve(true)}>确认保存</button><button className="secondary" disabled={busy} onClick={() => onResolve(false)}>取消</button></div></div>}
    {agentActivity.length > 0 ? <div className="agent-activity">{agentActivity.map(item => <div key={item.at} className={`agent-card ${item.ok ? "" : "failed"}`}>
      <div className="agent-card-head"><span className="agent-label">{item.label}</span><span className="agent-time">{new Date(item.at).toLocaleTimeString()}</span></div>
      {item.summary && <p className="agent-summary">{item.summary}</p>}
      <p className="muted">{item.ok ? `已受理${item.revision !== undefined ? ` · revision ${item.revision}` : ""}` : "请求失败（错误码见状态区）"}</p>
    </div>)}</div>
      : <div className="agent-empty">
        <div className="agent-empty-icon" aria-hidden="true">✦</div><strong>等待 Agent 操作</strong><p>通过外部 Agent 连接 Studio 后，项目操作会显示在这里。</p>
      </div>}
  </section>;
}
