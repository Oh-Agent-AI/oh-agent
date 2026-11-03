import { gameText, type GameLocale } from "./gameCopy";
import { presentBattleLegend, type LegendItem, type LegendSnapshot } from "./mecha/legendPresentation";
import "./mechaHudClarity.css";

export type MechaBattleLegendProps = {
  locale: GameLocale;
  /** Exactly the snapshot drawn by CityMechaWorld; null prediction is unknown. */
  view: LegendSnapshot;
};

function LegendSymbol({ id, deployment, blocked, reachOverlap }: { id: LegendItem["id"]; deployment?: boolean; blocked?: boolean; reachOverlap?: boolean }) {
  return <svg className={`mecha-battle-legend__symbol mecha-battle-legend__${id}`} viewBox="0 0 44 24" aria-hidden="true" focusable="false">
    {id === "declared" ? <>
      <path d="M1 10V6h3m3 0h4v4M1 14v4h3m3 0h4v-4" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M13 12h12m-5-4 5 4-5 4" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="28" y="3" width="15" height="18" fill="currentColor" fillOpacity=".18" stroke="currentColor" strokeWidth="2" />
      <path d="m28 11 8-8m-8 15 15-15m-11 18 11-11" stroke="currentColor" strokeWidth="2" />
    </> : id === "projected" ? <rect x="12" y="3" width="20" height="18" fill="currentColor" fillOpacity=".12" stroke="currentColor" strokeWidth="2" strokeDasharray="3 2" />
      : id === "movement" && deployment ? <rect x="12" y="3" width="20" height="18" fill="currentColor" fillOpacity=".5" stroke="currentColor" /> : id === "movement" && reachOverlap ? <><rect x="1" y="3" width="18" height="18" fill="currentColor" fillOpacity=".5" stroke="currentColor" /><rect x="24" y="3" width="19" height="18" fill="#ff7066" fillOpacity=".25" stroke="#ff7066" /><path d="m24 13 10-10m-9 17L42 3m-8 18 9-9" stroke="#ff7066" /><path d="m28 12 2-3 2 3-2 3Zm8 0 2-3 2 3-2 3Z" fill="#a4ffd0" stroke="#102b23" strokeWidth="1" /></> : id === "movement" ? <><rect x="1" y="3" width="18" height="18" fill="currentColor" fillOpacity=".5" stroke="currentColor" /><path d="M23 12h18m-6-5 6 5-6 5" fill="none" stroke="currentColor" strokeWidth="3" /></>
      : id === "landing" ? <path d="m22 3 10 9-10 9-10-9Z" fill="none" stroke="currentColor" strokeWidth="2" />
      : blocked ? <path d="M13 3h-3v5m24-5h3v5M10 16v5h3m21 0h3v-5m-22-9 15 10m0-10L15 17" fill="none" stroke="#ff7668" strokeWidth="2" />
      : <><path d="M2 12h25m-6-5 6 5-6 5" fill="none" stroke="currentColor" strokeWidth="3" /><path d="M31 3h-3v5m13-5h2v5M28 16v5h3m10 0h2v-5" fill="none" stroke="currentColor" strokeWidth="2" /></>}
  </svg>;
}

export function MechaBattleLegend({ locale, view }: MechaBattleLegendProps) {
  const t = (text: string) => gameText(text, locale);
  const legend = presentBattleLegend(view, locale);
  const rows = (items: LegendItem[]) => items.map(item => <div className="mecha-battle-legend__item" data-legend-item={item.id} key={item.id}>
    <LegendSymbol id={item.id} deployment={view.deployment} reachOverlap={legend.reachOverlap} blocked={item.id === "shove" && view.targetPreview?.shove?.blocked} /><span><strong>{item.label}</strong><small>{item.detail}</small></span>
  </div>);
  return <div className="mecha-battle-legend" role="group" aria-label={t("战场图例")} data-predicted-threat={legend.projected}>
    {legend.threats.length ? <div className="mecha-battle-legend__group" role="group" aria-label={locale === "en" ? "Threats" : "威胁预告"}>
      <h4>{locale === "en" ? "Threats" : "威胁预告"}</h4>{rows(legend.threats)}
      {legend.note ? <p className="mecha-battle-legend__note">{legend.note}</p> : null}
    </div> : null}
    {legend.actions.length ? <div className="mecha-battle-legend__group" role="group" aria-label={locale === "en" ? "Current operation" : "当前操作"}>
      <h4>{locale === "en" ? "Current operation" : "当前操作"}</h4>{rows(legend.actions)}
    </div> : null}
  </div>;
}
