import { useCallback, useEffect, useRef, useState } from "react";

/**
 * T3 useStopPhase 移植（取消任务按钮的相位机）：点击 → pending → 宿主确认后
 * landed（500ms 点击防抖，双击不会误触下一动作）；10s 未确认自动 timedOut，
 * 按钮恢复可点以便重试。转移逻辑为纯函数，单测覆盖。
 */
export type StopPhase = "idle" | "pending" | "timedOut" | "landed";
export type StopPhaseState = Readonly<{ phase: StopPhase; at: number | null }>;
export type StopEvent =
  | Readonly<{ type: "request"; now: number }>
  | Readonly<{ type: "ack"; now: number }>
  | Readonly<{ type: "timeout"; now: number }>
  | Readonly<{ type: "guard-elapsed"; now: number }>;
export const STOP_TIMEOUT_MS = 10_000;
export const STOP_LANDED_GUARD_MS = 500;

export function stopTransition(state: StopPhaseState, event: StopEvent): StopPhaseState {
  switch (event.type) {
    case "request":
      return state.phase === "pending" ? state : { phase: "pending", at: event.now };
    case "ack":
      return state.phase === "pending" ? { phase: "landed", at: event.now } : state;
    case "timeout":
      // 只有 pending 超时才有意义；ack/timeout 竞态时以后到者为准（ack 先落则保持 landed）。
      return state.phase === "pending" && event.now - (state.at ?? event.now) >= STOP_TIMEOUT_MS ? { phase: "timedOut", at: null } : state;
    case "guard-elapsed":
      return state.phase === "landed" && event.now - (state.at ?? event.now) >= STOP_LANDED_GUARD_MS ? { phase: "idle", at: null } : state;
  }
}

export function useStopPhase() {
  const [state, setState] = useState<StopPhaseState>({ phase: "idle", at: null });
  const stateRef = useRef(state);
  stateRef.current = state;
  const timers = useRef<{ timeout: number | null; guard: number | null }>({ timeout: null, guard: null });
  const clearTimers = () => {
    if (timers.current.timeout !== null) { window.clearTimeout(timers.current.timeout); timers.current.timeout = null; }
    if (timers.current.guard !== null) { window.clearTimeout(timers.current.guard); timers.current.guard = null; }
  };
  const requestStop = useCallback((action: () => Promise<void>) => {
    if (stateRef.current.phase === "pending") return;
    clearTimers();
    const now = Date.now();
    setState(stopTransition(stateRef.current, { type: "request", now }));
    timers.current.timeout = window.setTimeout(() => setState(current => stopTransition(current, { type: "timeout", now: Date.now() })), STOP_TIMEOUT_MS);
    void (async () => {
      try { await action(); }
      finally {
        if (timers.current.timeout !== null) { window.clearTimeout(timers.current.timeout); timers.current.timeout = null; }
        setState(current => stopTransition(current, { type: "ack", now: Date.now() }));
        timers.current.guard = window.setTimeout(() => setState(current => stopTransition(current, { type: "guard-elapsed", now: Date.now() })), STOP_LANDED_GUARD_MS);
      }
    })();
  }, []);
  useEffect(() => clearTimers, []);
  return { stopPhase: state.phase, requestStop };
}
