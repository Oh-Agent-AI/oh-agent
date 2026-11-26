import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * T3 useTimelineFollow 的简化移植（列表有界 ≤30 行，不做虚拟化/手势合并）：
 * 向上滚动释放跟随、贴底重新跟随；跳底按钮显示防抖 150ms、隐藏立即；
 * 会话切换（followKey 变化）＝新一次访问，立即回到跟随并隐藏按钮。
 */
export type FollowMode = "following" | "released";
export const FOLLOW_RELEASE_DISTANCE = 32;
export const PILL_SHOW_DISTANCE = 96;
export const PILL_SHOW_DEBOUNCE_MS = 150;

export function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

export function followModeAfterScroll(mode: FollowMode, el: HTMLElement, previousTop: number): FollowMode {
  // 向上滚（且确实滚动了内容）释放跟随；距底足够近时无条件重新跟随。
  const scrolledUp = el.scrollTop < previousTop - 1 && el.scrollTop > 0;
  if (distanceFromBottom(el) <= FOLLOW_RELEASE_DISTANCE) return "following";
  return scrolledUp ? "released" : mode;
}

export function pillShouldShow(mode: FollowMode, el: HTMLElement | null): boolean {
  return el !== null && mode === "released" && distanceFromBottom(el) > PILL_SHOW_DISTANCE;
}

export function useTimelineFollow(containerRef: RefObject<HTMLElement | null>, followKey: unknown) {
  const [mode, setMode] = useState<FollowMode>("following");
  const [pillVisible, setPillVisible] = useState(false);
  const modeRef = useRef<FollowMode>("following");
  const lastTop = useRef(0);
  const showTimer = useRef<number | null>(null);
  const clearShowTimer = () => {
    if (showTimer.current !== null) { window.clearTimeout(showTimer.current); showTimer.current = null; }
  };
  // 新一次访问：立即贴底、隐藏按钮；旧访问的防抖计时器不允许串场（T3 per-visit keying）。
  useEffect(() => {
    clearShowTimer();
    modeRef.current = "following";
    setMode("following");
    setPillVisible(false);
    lastTop.current = Number.MAX_SAFE_INTEGER;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followKey]);
  // 跟随态下内容增长即贴底（读 modeRef，避免与用户上滚的状态提交竞态）。
  useEffect(() => {
    if (modeRef.current !== "following") return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });
  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const next = followModeAfterScroll(modeRef.current, el, lastTop.current);
    lastTop.current = el.scrollTop;
    if (next !== modeRef.current) { modeRef.current = next; setMode(next); }
    if (pillShouldShow(modeRef.current, el)) {
      if (showTimer.current === null) {
        showTimer.current = window.setTimeout(() => { showTimer.current = null; setPillVisible(true); }, PILL_SHOW_DEBOUNCE_MS);
      }
    } else { clearShowTimer(); setPillVisible(false); }
  }, [containerRef]);
  const jumpToEnd = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    clearShowTimer();
    modeRef.current = "following";
    setMode("following");
    setPillVisible(false);
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [containerRef]);
  useEffect(() => clearShowTimer, []);
  return { mode, pillVisible, onScroll, jumpToEnd };
}
