import type { ReactNode } from "react";
import { fizzleText, gameText, type GameLocale } from "./gameCopy";
import { presentPlanRow } from "./mecha/planPresentation";
import type { Draft } from "./mecha/planning";
import type { MechId } from "./mecha/rules";
import type { FizzledAction } from "./mecha/fizzleForecast";
import "./mechaHudClarity.css";

export type MechaPlanCardProps = {
  id: MechId;
  /** Already localized for the active locale. */
  name: string;
  hp: number;
  finished?: boolean;
  selected: boolean;
  disabled: boolean;
  onSelect: (id: MechId) => void;
  draft: Draft | undefined;
  /** The controller's global openingSuggestion, not an individual row source. */
  openingSuggestion: boolean;
  /** Supply null when this exact draft's preview is unavailable. */
  hitDamage: number | null;
  /** A fizzle in this exact draft preview; null means no known fizzle. */
  fizzle?: FizzledAction | null;
  locale: GameLocale;
  avatar?: ReactNode;
  /** Optional authoritative state label for sequential v1.5 matches. */
  stateLabel?: string;
};

/** Classic HUD roster, populated by either rules adapter. */
export function MechaRoster({ rows, label, className = "", help, helpId }: {
  rows: MechaPlanCardProps[]; label: string; className?: string; help?: string; helpId?: string;
}) {
  return <ul className={`mecha-pack${className ? ` ${className}` : ""}`} tabIndex={0} aria-label={label} aria-describedby={help ? helpId : undefined}>
    {help && <li className="mecha-roster-scroll-help" id={helpId}>{help}</li>}
    {rows.map(row => <MechaPlanCard key={row.id} {...row} />)}
  </ul>;
}

/** Render directly inside the existing mecha-pack list. */
export function MechaPlanCard({ id, name, hp, finished, selected, disabled, onSelect, draft, openingSuggestion, hitDamage, fizzle, locale, avatar, stateLabel }: MechaPlanCardProps) {
  const row = presentPlanRow({ draft, openingSuggestion, hitDamage, locale });
  const t = (text: string) => gameText(text, locale);
  const status = row.openingSuggestion ? (locale === "en" ? "Team suggestion" : "全队建议") : row.actionState === "unplanned" ? t("待规划")
    : row.actionState === "explicit-hold" ? (locale === "en" ? "Explicit hold" : "明确待机")
    : t("已规划");
  return (
    <li className={["mecha-plan-card", selected && "is-current", !finished && row.actionState === "unplanned" && "is-open", row.hitDamage !== null && row.hitDamage > 0 && "is-hit"].filter(Boolean).join(" ")}>
      <button type="button" className={`mecha-plan-card__select${selected ? " is-selected" : ""}`} aria-pressed={selected} disabled={disabled} onClick={() => onSelect(id)}>
        <span className="mecha-plan-card__avatar" aria-hidden="true">{avatar ?? id.slice(0, 1)}</span>
        <span className="mecha-plan-card__identity"><strong>{name}</strong><span>{hp} HP</span></span>
      </button>
      {finished ? <span className="mecha-plan-card__status">{t("对局已结束。")}</span> : stateLabel ? <span className="mecha-plan-card__status mecha-v15-unit-state">{stateLabel}</span> : <details className="mecha-plan-card__plan">
        <summary><span className="mecha-plan-card__status">{status}{fizzle ? <span className="mecha-plan-card__fizzle"> · {locale === "en" ? "Forecast: fizzles" : "预计落空"}</span> : null}</span>{row.hitDamage === null || row.hitDamage > 0 ? <span className="mecha-plan-card__risk">{row.hitDamage === null ? t("风险未知") : `${t("受击")} ${row.hitDamage}`}</span> : null}</summary>
        <span className="mecha-plan-card__meta"><span>{status}</span><span className="mecha-plan-card__risk">{row.hitDamage === null ? t("风险未知") : `${t("预计")} ${t("受击")} ${row.hitDamage}`}</span></span>
        {fizzle ? <span className="mecha-plan-card__detail mecha-plan-card__fizzle">{t("行动落空，不消耗冷却")} · {fizzleText(fizzle.cause, locale)}</span> : null}
        <span className="mecha-plan-card__detail">{t("移动")}：{row.movement} · {row.action}{row.target !== null ? ` · ${t("目标")}：${row.target}` : ""}</span>
      </details>}
    </li>
  );
}
