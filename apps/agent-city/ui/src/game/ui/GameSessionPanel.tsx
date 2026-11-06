import { useEffect, useRef, type ReactNode } from "react";
import { gameText, type GameLocale } from "../gameCopy";

export type GamePanelAction = Readonly<{ label: string; onAction: () => void; disabled?: boolean; tone?: "danger" | "primary" }>;
const FOCUSABLE_SELECTOR = "a[href], button:not(:disabled), input:not(:disabled):not([type='hidden']), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex='-1'])";

function visibleFocusables(root: HTMLElement | null): HTMLElement[] {
  return [...(root?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])]
    .filter((item) => !item.closest("[hidden], [inert]") && item.getClientRects().length > 0);
}

export function GameSessionPanel({ locale, title, description, children, actions, onKeyDown, labelledBy = "city-game-panel-title", role = "dialog" }: {
  locale: GameLocale; title: string; description?: ReactNode; children?: ReactNode;
  actions: readonly GamePanelAction[]; onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void; labelledBy?: string; role?: "dialog" | "alertdialog";
}) {
  const panel = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const t = (text: string) => gameText(text, locale);
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = panel.current;
    const first = visibleFocusables(dialog)[0];
    (first ?? dialog)?.focus({ preventScroll: true });
    return () => {
      const target = previousFocus.current;
      // Resume may explicitly focus the canvas before this panel unmounts.
      // Restore only abandoned/modal focus, never steal that new owner.
      const active = document.activeElement;
      if (target?.isConnected && (!active || active === document.body || dialog?.contains(active))) target.focus({ preventScroll: true });
    };
  }, []);
  return <div className="city-game-panel" onMouseDown={(event) => { if (event.target === event.currentTarget) event.preventDefault(); }}>
    <div ref={panel} role={role} aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.key !== "Tab") return;
        const items = visibleFocusables(panel.current);
        if (!items.length) { event.preventDefault(); panel.current?.focus(); return; }
        const first = items[0], last = items[items.length - 1];
        const activeIndex = items.indexOf(document.activeElement as HTMLElement);
        if (event.shiftKey && (activeIndex === 0 || activeIndex < 0)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (activeIndex === items.length - 1 || activeIndex < 0)) { event.preventDefault(); first.focus(); }
      }}>
      <h2 id={labelledBy}>{t(title)}</h2>
      {description && <p>{description}</p>}
      {children}
      <div className="city-game-actions">{actions.map((action) => <button key={action.label} type="button" disabled={action.disabled}
        className={action.tone === "danger" ? "city-game-danger" : undefined} onClick={action.onAction}>{t(action.label)}</button>)}</div>
    </div>
  </div>;
}
