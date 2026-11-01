import { gameText, type GameLocale } from "./gameCopy";
import { projectedThreatState } from "./mecha/planPresentation";
import type { Cell } from "./mecha/rules";
import "./mechaHudClarity.css";

export type MechaBattleLegendProps = {
  locale: GameLocale;
  /** Pass the same current snapshot used by CityMechaWorld; null is unknown. */
  projectedThreats: readonly Cell[] | null;
  /** True only while the board is actually drawing a verified shove. */
  verifiedShove: boolean;
};

export function MechaBattleLegend({ locale, projectedThreats, verifiedShove }: MechaBattleLegendProps) {
  const t = (text: string) => gameText(text, locale);
  const projected = projectedThreatState(projectedThreats);
  return (
    <div className="mecha-battle-legend" role="group" aria-label={t("战场图例")}>
      <span className="mecha-battle-legend__item"><span className="mecha-battle-legend__symbol mecha-battle-legend__reach" aria-hidden="true">✣</span>{t("可移动")}</span>
      <span className="mecha-battle-legend__item"><span className="mecha-battle-legend__symbol mecha-battle-legend__move" aria-hidden="true">◇</span>{t("计划落点")}</span>
      <span className="mecha-battle-legend__item"><span className="mecha-battle-legend__symbol mecha-battle-legend__declared" aria-hidden="true">!</span>{t("当前宣告威胁")}</span>
      <span className="mecha-battle-legend__item"><span className="mecha-battle-legend__symbol mecha-battle-legend__projected" aria-hidden="true">P</span>{locale === "en" ? "Projected threats" : "草稿试算威胁"}{projected === "unknown" ? (locale === "en" ? " · unknown" : " · 未知") : projected === "none" ? (locale === "en" ? " · none" : " · 无") : null}</span>
      <span className="mecha-battle-legend__item"><span className="mecha-battle-legend__symbol mecha-battle-legend__combined" aria-hidden="true">!P</span>{locale === "en" ? "Both threats" : "两种威胁重叠"}</span>
      <span className="mecha-battle-legend__item"><span className="mecha-battle-legend__symbol mecha-battle-legend__target" aria-hidden="true">⌜⌟</span>{t("可选目标")}</span>
      <span className="mecha-battle-legend__item"><span className="mecha-battle-legend__symbol mecha-battle-legend__selected-target" aria-hidden="true">□</span>{locale === "en" ? "Selected target" : "已选目标"}</span>
      {verifiedShove ? <span className="mecha-battle-legend__item"><span className="mecha-battle-legend__symbol mecha-battle-legend__shove" aria-hidden="true">➜</span>{t("推挤")}</span> : null}
    </div>
  );
}
