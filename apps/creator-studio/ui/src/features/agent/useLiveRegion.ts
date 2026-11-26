import { useCallback, useEffect, useRef } from "react";

/**
 * T3 useLiveRegion 移植：aria-live 区域直接写 DOM（不触发 React 渲染）；
 * 每次播报 7s 后清除——NVDA 会在焦点从对话框返回时重读 polite 区域的残留文本；
 * 重复文本加尾随不换行空格，读屏才会视为新内容。不用 role="status"：
 * Orca 会把它映射成 Chromium 状态栏并丢弃更新（T3 ThreadActivityAnnouncer 注释）。
 */
const CLEAR_AFTER_MS = 7_000;

export function useLiveRegion() {
  const clearTimer = useRef<number | null>(null);
  const lastText = useRef("");
  const regionRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const region = document.createElement("div");
    region.setAttribute("aria-live", "polite");
    region.setAttribute("aria-atomic", "true");
    region.className = "visually-hidden";
    document.body.appendChild(region);
    regionRef.current = region;
    return () => {
      region.remove();
      regionRef.current = null;
      if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
    };
  }, []);
  const announce = useCallback((text: string) => {
    const region = regionRef.current;
    if (!region || !text) return;
    if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
    const payload = text === lastText.current ? `${text}\u00A0` : text;
    lastText.current = text;
    region.textContent = payload;
    clearTimer.current = window.setTimeout(() => { region.textContent = ""; }, CLEAR_AFTER_MS);
  }, []);
  return { announce };
}
