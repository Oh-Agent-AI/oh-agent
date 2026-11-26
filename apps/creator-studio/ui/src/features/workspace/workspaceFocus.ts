import { useEffect } from "react";

/**
 * T3 workspaceFocus 移植：`data-workspace-area` 命名工作区 + F6/Shift+F6 循环
 * 焦点。区域按 `data-workspace-order` 排序；隐藏区域跳过；每个区域记忆最后
 * 焦点过的控件，回到该区域时优先恢复它（否则落到区域容器，tabIndex=-1）。
 */
export function workspaceAreaProps(area: string, order: number, label: string) {
  return {
    "data-workspace-area": area,
    "data-workspace-order": order,
    role: "region",
    "aria-label": label,
    tabIndex: -1,
  } as const;
}

const lastFocusByArea = new WeakMap<HTMLElement, HTMLElement>();

function focusable(target: HTMLElement): boolean {
  if (target.matches(":disabled, [aria-disabled='true']")) return false;
  return target.checkVisibility?.() ?? target.offsetParent !== null;
}

function orderedAreas(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-workspace-area]"))
    .filter(area => focusable(area) || area.contains(document.activeElement))
    .sort((a, b) => Number(a.dataset.workspaceOrder) - Number(b.dataset.workspaceOrder));
}

function focusArea(area: HTMLElement) {
  const remembered = lastFocusByArea.get(area);
  if (remembered && area.contains(remembered) && focusable(remembered)) { remembered.focus(); return; }
  area.focus();
}

function handleFocusIn(event: FocusEvent) {
  const area = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-workspace-area]");
  if (area && event.target instanceof HTMLElement && event.target !== area) lastFocusByArea.set(area, event.target);
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key !== "F6" || event.ctrlKey || event.altKey || event.metaKey) return;
  const areas = orderedAreas();
  if (areas.length === 0) return;
  const activeArea = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-workspace-area]");
  const currentIndex = activeArea ? areas.indexOf(activeArea) : -1;
  const offset = event.shiftKey ? -1 : 1;
  const next = areas[(currentIndex + offset + areas.length) % areas.length];
  event.preventDefault();
  focusArea(next);
}

/** 挂载全局 F6 循环；返回清理函数。 */
export function useWorkspaceFocusCycling() {
  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("focusin", handleFocusIn);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("focusin", handleFocusIn);
    };
  }, []);
}
