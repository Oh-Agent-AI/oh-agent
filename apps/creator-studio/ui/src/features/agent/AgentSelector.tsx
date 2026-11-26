import type { StudioExecutorStatus } from "../../contracts/studioTask";
import type { StudioTaskController } from "./useStudioTasks";

export function executorBadge(status: StudioExecutorStatus) {
  if (!status.available) return { disabled: true, label: " · 不可用", title: status.detail ?? "连接不可用" };
  if (!status.modes.some(mode => mode.restricted)) return { disabled: true, label: " · 缺少受限模式", title: "此 Agent 未提供受限提案模式" };
  return { disabled: false, label: "", title: "可用于创作" };
}

export function AgentSelector({ controller }: { controller: StudioTaskController }) {
  const { executor, setExecutor, capabilities, busy, task, sessionStatus } = controller;
  const items = capabilities?.executors ?? [];
  const usable = items.filter(item => !executorBadge(item).disabled);
  const unavailable = items.filter(item => executorBadge(item).disabled);
  return <label className="agent-executor">选择本机 Agent
    <select aria-label="选择本机 Agent" value={executor} disabled={busy || task?.phase === "executing" || !usable.length}
      onChange={event => setExecutor(event.target.value)}>
      {!executor && <option value="">{!capabilities && sessionStatus === "loading" ? "正在检测本机 Agent…" : "暂无可用 Agent"}</option>}
      {executor && !items.some(item => item.id === executor) && <option disabled value={executor}>{executor} · 不可用</option>}
      {usable.length > 0 && <optgroup label="可用于创作">{usable.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>}
      {unavailable.length > 0 && <optgroup label="需要配置">{unavailable.map(item => <option key={item.id} value={item.id} disabled>{item.name}{executorBadge(item).label}</option>)}</optgroup>}
    </select>
  </label>;
}
