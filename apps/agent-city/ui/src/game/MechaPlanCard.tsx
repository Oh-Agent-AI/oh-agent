import type { ReactNode } from "react";
import { gameText, type GameLocale } from "./gameCopy";
import { presentPlanRow } from "./mecha/planPresentation";
import type { Draft } from "./mecha/planning";
import type { MechId } from "./mecha/rules";
import "./mechaHudClarity.css";

export type MechaPlanCardProps = {
  id: MechId;
  /** Already localized for the active locale. */
  name: string;
  hp: number;
  selected: boolean;
  disabled: boolean;
  onSelect: (id: MechId) => void;
  draft: Draft | undefined;
  /** The controller's global openingSuggestion, not an individual row source. */
  openingSuggestion: boolean;
  /** Supply null when this exact draft's preview is unavailable. */
  hitDamage: number | null;
  locale: GameLocale;
  avatar?: ReactNode;
};

/** Render directly inside the existing mecha-pack list. */
export function MechaPlanCard({ id, name, hp, selected, disabled, onSelect, draft, openingSuggestion, hitDamage, locale, avatar }: MechaPlanCardProps) {
  const row = presentPlanRow({ draft, openingSuggestion, hitDamage, locale });
  const t = (text: string) => gameText(text, locale);
  const status = row.openingSuggestion ? (locale === "en" ? "Team suggestion" : "全队建议") : row.actionState === "unplanned" ? t("待规划")
    : row.actionState === "explicit-hold" ? (locale === "en" ? "Explicit hold" : "明确待机")
    : t("已规划");
  return (
    <li className={["mecha-plan-card", selected && "is-current", row.actionState === "unplanned" && "is-open", row.hitDamage !== null && row.hitDamage > 0 && "is-hit"].filter(Boolean).join(" ")}>
      <button type="button" className={`mecha-plan-card__select${selected ? " is-selected" : ""}`} aria-pressed={selected} disabled={disabled} onClick={() => onSelect(id)}>
        <span className="mecha-plan-card__avatar" aria-hidden="true">{avatar ?? id.slice(0, 1)}</span>
        <span className="mecha-plan-card__identity"><strong>{name}</strong><span>{hp} HP</span></span>
      </button>
      <details className="mecha-plan-card__plan">
        <summary><span className="mecha-plan-card__status">{status}</span>{row.hitDamage === null || row.hitDamage > 0 ? <span className="mecha-plan-card__risk">{row.hitDamage === null ? t("风险未知") : `${t("受击")} ${row.hitDamage}`}</span> : null}</summary>
        <span className="mecha-plan-card__meta"><span>{status}</span><span className="mecha-plan-card__risk">{row.hitDamage === null ? t("风险未知") : `${t("预计")} ${t("受击")} ${row.hitDamage}`}</span></span>
        <span className="mecha-plan-card__detail">{t("移动")}：{row.movement} · {row.action}{row.target !== null ? ` · ${t("目标")}：${row.target}` : ""}</span>
      </details>
    </li>
  );
}
