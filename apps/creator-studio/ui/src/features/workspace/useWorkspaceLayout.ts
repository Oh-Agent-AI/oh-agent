import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import {
  clampWorkspaceWidths, defaultWorkspaceWidths, readWorkspaceLayout, rememberWorkspaceLayout,
  type WorkspaceFocus, type WorkspaceWidths,
} from "./workspaceLayout";

export type WorkspaceSplitterKind = "sessions" | "agent";

/**
 * 三栏宽度 + 布局模式的测量 / 拖动 / 记忆。宽度只写进 CSS 变量
 * （--studio-session-width / --studio-agent-width），窄屏折叠交给媒体查询——用内联
 * grid-template-columns 的话，媒体查询会被内联样式压过去，窄屏永远回不到单栏。
 */
export function useWorkspaceLayout(container: RefObject<HTMLDivElement | null>, projectKey: string) {
  const [widths, setWidths] = useState<WorkspaceWidths | null>(null);
  const [focus, setFocusState] = useState<WorkspaceFocus>("balanced");
  const [dragging, setDragging] = useState<WorkspaceSplitterKind | null>(null);
  const widthsRef = useRef<WorkspaceWidths | null>(null);
  const focusRef = useRef<WorkspaceFocus>("balanced");
  widthsRef.current = widths;
  focusRef.current = focus;
  const keyRef = useRef(projectKey);
  const initialized = useRef(false);
  const drag = useRef<Readonly<{ kind: WorkspaceSplitterKind; startX: number; start: WorkspaceWidths; total: number }> | null>(null);

  const persist = (next: WorkspaceWidths, nextFocus: WorkspaceFocus) => {
    rememberWorkspaceLayout(projectKey, { widths: next, focus: nextFocus });
  };

  useEffect(() => {
    const element = container.current;
    // 首帧也要读存档：只靠 key 变化判断的话，重新打开应用从来不恢复上次的布局。
    const switched = !initialized.current || keyRef.current !== projectKey;
    initialized.current = true;
    keyRef.current = projectKey;
    if (!element) return;
    const stored = switched ? readWorkspaceLayout(projectKey) : null;
    const total = element.clientWidth;
    if (stored) setFocusState(stored.focus);
    setWidths(current => clampWorkspaceWidths(stored?.widths ?? (switched || !current ? defaultWorkspaceWidths(total) : current), total));
    const observer = new ResizeObserver(() => {
      const width = element.clientWidth;
      setWidths(current => current ? clampWorkspaceWidths(current, width) : defaultWorkspaceWidths(width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [projectKey, container]);

  const startDrag = (kind: WorkspaceSplitterKind) => (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = container.current;
    const current = widthsRef.current;
    if (!element || !current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { kind, startX: event.clientX, start: current, total: element.clientWidth };
    setDragging(kind);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    const delta = event.clientX - state.startX;
    setWidths(clampWorkspaceWidths(state.kind === "sessions"
      ? { sessions: state.start.sessions + delta, agent: state.start.agent }
      : { sessions: state.start.sessions, agent: state.start.agent + delta }, state.total));
  };

  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(null);
    if (widthsRef.current) persist(widthsRef.current, focusRef.current);
  };

  const nudge = (kind: WorkspaceSplitterKind, delta: number) => {
    const element = container.current;
    const current = widthsRef.current;
    if (!element || !current) return;
    const next = clampWorkspaceWidths(kind === "sessions"
      ? { sessions: current.sessions + delta, agent: current.agent }
      : { sessions: current.sessions, agent: current.agent + delta }, element.clientWidth);
    if (next.sessions === current.sessions && next.agent === current.agent) return;
    setWidths(next);
    persist(next, focusRef.current);
  };

  /** 双击分隔条回到默认比例（并覆盖掉这个 Project 记下的宽度）。 */
  const reset = () => {
    const element = container.current;
    if (!element) return;
    const next = defaultWorkspaceWidths(element.clientWidth);
    setWidths(next);
    persist(next, focusRef.current);
  };

  const setFocus = (next: WorkspaceFocus) => {
    setFocusState(next);
    if (widthsRef.current) persist(widthsRef.current, next);
  };

  /** 预览全屏 / 返回三栏：切换即记到当前 Project。 */
  const toggleFocus = () => setFocus(focusRef.current === "preview" ? "balanced" : "preview");

  const style = widths ? ({
    "--studio-session-width": `${widths.sessions}px`,
    "--studio-agent-width": `${widths.agent}px`,
  } as CSSProperties) : undefined;
  return { widths, style, focus, setFocus, toggleFocus, dragging, startDrag, moveDrag, endDrag, nudge, reset };
}
