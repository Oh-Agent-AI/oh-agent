import type { HTMLAttributes, MouseEvent, ReactNode } from "react";
import { gameText, type GameLocale } from "./gameCopy";

/** Classic HUD battlefield visibility and camera controls. */
export function MechaBattlefieldControls({ locale, mapFocused, onToggleFocus, onResetCamera }: {
  locale: GameLocale; mapFocused: boolean; onToggleFocus: () => void; onResetCamera: () => void;
}) {
  const t = (text: string) => gameText(text, locale);
  return <>
    <button type="button" aria-pressed={mapFocused} aria-describedby="mecha-map-focus-help" onClick={onToggleFocus}>{mapFocused ? t("恢复面板") : t("查看战场")}</button>
    <span id="mecha-map-focus-help" className="mecha-sr-only">{t("收起面板以查看战场；选择棋盘格后恢复面板。")}</span>
    <button type="button" title={t("回到可看全棋盘的战术视角")} onClick={onResetCamera}>{t("重置视角")}</button>
  </>;
}

export function MechaBattleMenu({ locale, exitDisabled, onGuide, onExit }: {
  locale: GameLocale; exitDisabled: boolean; onGuide: (trigger: HTMLElement | null) => void; onExit: () => void;
}) {
  const t = (text: string) => gameText(text, locale);
  return <details className="mecha-battle-menu">
    <summary aria-label={t("战斗菜单")} title={t("战斗菜单")}>⋯</summary>
    <div className="mecha-battle-menu-items">
      <button type="button" data-mecha-guide-trigger onClick={event => {
        const menu = event.currentTarget.closest("details");
        const trigger = menu?.querySelector<HTMLElement>("summary") ?? null;
        menu?.removeAttribute("open"); onGuide(trigger);
      }}>{locale === "en" ? "Quick guide" : "战斗教学"}</button>
      <button type="button" disabled={exitDisabled} onClick={onExit}>{t("退出战斗")}</button>
    </div>
  </details>;
}

export function MechaSettingsPopover({ id, title, closeLabel, hidden, onClose, bodyClassName = "mecha-settings-body", children }: {
  id: string; title: string; closeLabel: string; hidden: boolean; onClose: () => void;
  bodyClassName?: string; children: ReactNode;
}) {
  return <section id={id} className="mecha-settings-popover" role="region" aria-labelledby={`${id}-title`} hidden={hidden}>
    <header className="mecha-settings-heading"><h3 id={`${id}-title`}>{title}</h3><button type="button" className="mecha-settings-close" aria-label={closeLabel} onClick={onClose}>×</button></header>
    <div className={bodyClassName}>{children}</div>
  </section>;
}

/** Classic objective card shared by HUD adapters. Values are already projected by the controller. */
export function MechaObjectiveCard({ round, heading, goal, resource, forecast, paused, children }: {
  round: ReactNode; heading: ReactNode; goal?: ReactNode; resource?: ReactNode;
  forecast?: ReactNode; paused?: ReactNode; children?: ReactNode;
}) {
  return <div className="mecha-objective-card">
    <div className="mecha-summary-heading"><h3 className="mecha-objective-round">{round}</h3>{heading}</div>
    {paused}
    {goal != null && <strong className="mecha-objective-goal">{goal}</strong>}
    {resource != null && <div className="mecha-quick-resource">{resource}</div>}
    {forecast != null && <div className="mecha-objective-forecast" role="status">{forecast}</div>}
    {children}
  </div>;
}

export function MechaObjectiveToggle({ locale, expanded, locked, onToggle }: {
  locale: GameLocale; expanded: boolean; locked?: boolean; onToggle: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const t = (text: string) => gameText(text, locale);
  const label = t(locked ? "远程期间面板保持展开" : expanded ? "精简面板" : "展开面板");
  return <button type="button" className="mecha-summary-toggle" aria-expanded={expanded} aria-disabled={locked || undefined}
    aria-describedby={locked ? "mecha-remote-lock-status" : undefined} aria-label={label} title={label} onClick={onToggle}>
    <span className="mecha-objective-heading">{t("本局目标")}</span><span className="mecha-summary-chevron" aria-hidden="true">{expanded ? "▴" : "▾"}</span>
  </button>;
}

export function MechaTurnOrder({ label, stageLabel, stages, children }: {
  label: string; stageLabel: string; stages: string[]; children?: ReactNode;
}) {
  return <div id="mecha-order-panel" className="mecha-order" role="region" aria-label={label}>
    <ol className="mecha-order-stages" role="list" aria-label={stageLabel}>{stages.map(stage => <li key={stage}>{stage}</li>)}</ol>
    {children}
  </div>;
}

/** Presentation-only HUD regions shared by classic 1.4 and sequential 1.5. */
export function MechaObjectivePanel({ className = "", label, children, ...attributes }: HTMLAttributes<HTMLElement> & {
  className?: string;
  label: string;
  children: ReactNode;
}) {
  return <section {...attributes} className={`mecha-turn-summary${className ? ` ${className}` : ""}`} aria-label={label}>{children}</section>;
}

export function MechaTeamPanel({ label, children, ...attributes }: HTMLAttributes<HTMLElement> & { label: string; children: ReactNode }) {
  return <section {...attributes} className="mecha-team-planning" aria-label={label}>{children}</section>;
}

/** Shared classic team and turn controls; decisions and commands come from the adapter. */
export function MechaTeamTurnControls({ heading, status, help, children, submitRef }: {
  heading: ReactNode; status: ReactNode; help?: ReactNode; children?: ReactNode;
  submitRef?: (node: HTMLDivElement | null) => void;
}) {
  return <div className="mecha-submit" ref={submitRef}>
    <div className="mecha-planning-heading"><h3>{heading}</h3></div>
    <div className="mecha-planning-status">{status}</div>
    {help}
    {children}
  </div>;
}

/** Classic portrait and action-card deck, shared across rulesets. */
export function MechaCommandDeck({ portrait, columns, children }: { portrait?: ReactNode; columns: number; children: ReactNode }) {
  return <div className="mecha-command-deck">{portrait}
    <div className="mecha-action-cards" style={{ gridTemplateColumns: `repeat(${Math.max(1, columns)}, minmax(0, 1fr))` }}>{children}</div>
  </div>;
}

/** Target choices use the same classic HUD markup; adapters own validation and preview. */
export function MechaTargetOptions({ options, disabled, empty, after, onSelect }: {
  options: Array<{ key: string; label: ReactNode; selected: boolean }>;
  disabled: boolean; empty: ReactNode; after?: ReactNode;
  onSelect: (key: string, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return <div className="mecha-actions">
    {options.length ? options.map(option => <button type="button" key={option.key} aria-pressed={option.selected}
      disabled={disabled} onClick={event => onSelect(option.key, event)}>{option.label}</button>) : <span>{empty}</span>}
    {after}
  </div>;
}

/** Shared list of declared or projected enemy threats. */
export function MechaThreatSourceList({ label, sources, empty, onSelect }: {
  label: string; sources: Array<{ id: string; selected: boolean; content: ReactNode }>;
  empty: ReactNode; onSelect: (id: string) => void;
}) {
  return <div className="mecha-threat-sources" aria-label={label}>
    {sources.length ? sources.map(source => <button key={source.id} type="button" aria-pressed={source.selected}
      onClick={() => onSelect(source.id)}>{source.content}</button>) : <span>{empty}</span>}
  </div>;
}

export function MechaSelectedActionsPanel({ className = "", label, children, ...attributes }: HTMLAttributes<HTMLElement> & {
  className?: string;
  label: string;
  children: ReactNode;
}) {
  return <section {...attributes} className={`mecha-selected-actions${className ? ` ${className}` : ""}`} aria-label={label}>{children}</section>;
}

/** The classic command-panel layout; adapters provide state and callbacks for its slots. */
export function MechaCommandPanel({ label, className, heading, instruction, deck, utilities, target, unavailable, movement, children }: {
  label: string; className?: string; heading: ReactNode; instruction?: ReactNode; deck: ReactNode;
  utilities?: ReactNode; target?: ReactNode; unavailable?: ReactNode; movement?: ReactNode; children?: ReactNode;
}) {
  return <MechaSelectedActionsPanel label={label} className={className}>
    {heading}{instruction}{deck}{utilities}{target}{unavailable}{movement}{children}
  </MechaSelectedActionsPanel>;
}
