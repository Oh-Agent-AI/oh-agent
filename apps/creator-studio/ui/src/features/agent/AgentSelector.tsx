import { useEffect, useMemo, useRef, useState } from "react";
import type { StudioExecutorStatus } from "../../contracts/studioTask";
import { directorySummary, groupByBrand, toExecutorEntry, type ExecutorEntry } from "./agentDirectory";
import type { StudioTaskController } from "./useStudioTasks";

export function executorBadge(status: StudioExecutorStatus) {
  if (!status.available) return { disabled: true, label: " · 不可用", title: status.detail ?? "连接不可用" };
  if (!status.modes.some(mode => mode.restricted)) return { disabled: true, label: " · 缺少受限模式", title: "此 Agent 未提供受限提案模式" };
  return { disabled: false, label: "", title: "可用于创作" };
}

const statusLabel: Record<ExecutorEntry["status"], string> = { usable: "可用于创作", "needs-setup": "需要配置", unavailable: "不可用" };

/**
 * Agent 选择器（R6-lite）：原生 select 换成 listbox 弹层——品牌去重、
 * 状态分组、每条连接的原因可见；键盘（方向键/Enter/Esc）与外部点击关闭
 * 齐备。数据仍来自 capabilities.executors，不改宿主 DTO。
 */
export function AgentSelector({ controller }: { controller: StudioTaskController }) {
  const { executor, setExecutor, capabilities, busy, task, sessionStatus } = controller;
  const items = useMemo(() => capabilities?.executors ?? [], [capabilities]);
  const groups = useMemo(() => groupByBrand(items), [items]);
  const entries = useMemo(() => items.map(toExecutorEntry), [items]);
  const selected = entries.find(entry => entry.id === executor) ?? null;
  const usableCount = entries.filter(entry => entry.status === "usable").length;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const triggerDisabled = busy || task?.phase === "executing" || (!usableCount && !!capabilities);
  const flat = useMemo(() => groups.flatMap(group => group.entries), [groups]);
  // 失效选择（连接掉线/宿主重启后不在目录里）：如实展示并允许保留，直到用户另选。
  const selectedMissing = !!executor && !entries.some(entry => entry.id === executor);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const startIndex = flat.findIndex(entry => entry.id === executor);
    setActiveIndex(startIndex >= 0 ? startIndex : flat.findIndex(entry => entry.status === "usable"));
    listRef.current?.focus();
  }, [open, flat, executor]);
  const choose = (entry: ExecutorEntry) => {
    if (entry.status !== "usable") return;
    setExecutor(entry.id);
    setOpen(false);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { setOpen(false); return; }
    if (event.key === "Tab") { setOpen(false); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (flat.length === 0) return;
      const offset = event.key === "ArrowDown" ? 1 : -1;
      let index = activeIndex;
      for (let step = 0; step < flat.length; step += 1) {
        index = (index + offset + flat.length) % flat.length;
        if (flat[index].status === "usable") break;
      }
      setActiveIndex(index);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const entry = flat[activeIndex];
      if (entry) choose(entry);
    }
  };
  const triggerText = !capabilities && sessionStatus === "loading" ? "正在检测本机 Agent…"
    : !capabilities ? "尚未检测连接"
    : selectedMissing ? `${executor} · 连接不可用`
    : selected ? selected.name
    : usableCount === 0 ? "暂无可用 Agent"
    : "选择 Agent";
  return <div className="agent-executor agent-dir" ref={rootRef}>
    <button type="button" className="agent-dir-trigger" aria-haspopup="listbox" aria-expanded={open}
      aria-label={`选择本机 Agent，当前 ${triggerText}`}
      disabled={triggerDisabled}
      onClick={() => setOpen(current => !current)}>
      <span className={`agent-dir-dot ${selected ? `is-${selected.status}` : ""}`} aria-hidden="true" />
      <span className="agent-dir-trigger-text">{triggerText}</span>
      <span className="agent-dir-caret" aria-hidden="true">▾</span>
    </button>
    {open && <ul className="agent-dir-list" role="listbox" aria-label="选择本机 Agent" ref={listRef} tabIndex={-1}
      aria-activedescendant={activeIndex >= 0 ? `agent-dir-option-${flat[activeIndex]?.id}` : undefined}
      onKeyDown={onKeyDown}>
      <li className="agent-dir-summary" aria-hidden="true">{directorySummary(groups)}</li>
      {groups.map(group => <li key={group.brand} className="agent-dir-brand" role="presentation">
        <span className="agent-dir-group" aria-hidden="true">{group.brand}<small>{group.usableCount > 0 ? ` · ${group.usableCount}/${group.entries.length} 可用` : " · 待连接"}</small></span>
        <ul role="presentation" className="agent-dir-connections">
          {group.entries.map(entry => {
            const isSelected = entry.id === executor;
            const isActive = flat[activeIndex]?.id === entry.id;
            return <li key={entry.id} id={`agent-dir-option-${entry.id}`} role="option" aria-selected={isSelected}
              aria-disabled={entry.status !== "usable"} title={entry.reason ?? undefined}
              className={`agent-dir-option is-${entry.status} ${isActive ? "is-active" : ""} ${isSelected ? "is-selected" : ""}`}
              onClick={() => choose(entry)}
              onPointerMove={() => setActiveIndex(flat.findIndex(item => item.id === entry.id))}>
              <span className={`agent-dir-dot is-${entry.status}`} aria-hidden="true" />
              <span className="agent-dir-option-body">
                <span>{entry.name}{group.entries.length > 1 ? `（${entry.id}）` : ""}</span>
                <small className="muted">{entry.reason ?? statusLabel[entry.status]}</small>
              </span>
              {isSelected && <span className="agent-dir-check" aria-hidden="true">✓</span>}
            </li>;
          })}
        </ul>
      </li>)}
    </ul>}
    <small className="agent-dir-hint muted">{triggerText === "选择 Agent" ? "受限提案模式下创作；连接状态由 Host 探测" : undefined}</small>
  </div>;
}
