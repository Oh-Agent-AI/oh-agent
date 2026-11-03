import { useState } from "react";
import { gameText } from "./gameCopy";
import { MechaUnitAvatar, MechaUnitPortrait } from "./MechaUnitAvatar";
import type { MechaController, MechaControllerState } from "./mecha/controller";
import { STATS } from "./mecha/board";
const NAMES = { Assault: "突击", Gunner: "射手", Support: "支援" };

export function MechaDeploymentPanel({ controller, state, disabled, submitRef }: { controller: MechaController; state: MechaControllerState; disabled: boolean; submitRef: (node: HTMLDivElement | null) => void }) {
  const d = state.deployment!;
  const t = (text: string) => gameText(text, state.locale);
  return <>
    <div className="mecha-submit" ref={submitRef}>
      <div className="mecha-planning-heading"><h3>{t("开局部署")}</h3></div>
      <div className="mecha-planning-status" role="status"><strong>{t("已部署")} {d.placements.length}/3</strong><span id="mecha-deploy-help">{t("选择机甲，再点击绿色格子。已放置的机甲可交换位置。")}</span></div>
      {d.error ? <p className="mecha-deploy-error" role="alert">{d.error}</p> : null}
      <div className="mecha-planning-controls"><button type="button" className="mecha-submit-primary" aria-describedby="mecha-deploy-help" disabled={disabled || !d.canConfirm} onClick={() => controller.confirmDeployment()}>{t("确认部署")}</button></div>
      <div className="mecha-planning-controls"><button type="button" disabled={disabled || !d.canUndo} onClick={() => controller.undoDeployment()}>{t("撤销放置")}</button><button type="button" disabled={disabled || !d.canReset} onClick={() => controller.resetDeployment()}>{t("重置部署")}</button></div>
    </div>
    <ul className="mecha-pack mecha-deploy-roster" aria-label={t("部署队伍")}>
      {state.match.mechs.map(m => {
        const placement = d.placements.find(p => p.mechId === m.id);
        return <li className={m.id === state.selected ? "mecha-plan-card is-current" : "mecha-plan-card"} data-mech-id={m.id} key={m.id}><button type="button" className="mecha-plan-card__select" aria-pressed={m.id === state.selected} disabled={disabled || !d.interactive} onClick={() => controller.selectMech(m.id)}>
          <MechaUnitAvatar mechId={m.id} locale={state.locale} /><span><strong>{t(NAMES[m.id])}</strong><small>{placement ? `${t("已放置")} · ${placement.pos.x}, ${placement.pos.y}` : t("未放置")}</small></span>
        </button></li>;
      })}
    </ul>
  </>;
}

export function MechaDeploymentActions({ controller, state, disabled }: { controller: MechaController; state: MechaControllerState; disabled: boolean }) {
  const [choice, setChoice] = useState("");
  const t = (text: string) => gameText(text, state.locale);
  const cells = state.deployment!.cells;
  const id = state.selected;
  const stats = STATS[id];
  return <section className="mecha-selected-actions mecha-deploy-actions" aria-label={t("部署操作")}>
    <h3>{t("放置机甲")} · {t(NAMES[id])}</h3>
    <div className="mecha-deploy-unit"><MechaUnitPortrait unitId={id} locale={state.locale} size={88} /><div><strong>{t(NAMES[id])}</strong><p>HP {stats.maxHp} · {t("移动")} {stats.move}</p><p>{t("部署确认后才生成首回合敌意。")}</p></div></div>
    <details className="mecha-deploy-list"><summary>{t("通过列表部署")}</summary>
      <label htmlFor="mecha-deploy-choice">{t("选择部署坐标")}</label>
      <div className="mecha-move-controls"><select id="mecha-deploy-choice" value={choice} disabled={disabled} onChange={e => setChoice(e.currentTarget.value)}><option value="" disabled>{t("选择坐标")}</option>{cells.map(c => <option key={`${c.x},${c.y}`} value={`${c.x},${c.y}`}>{c.x}, {c.y}</option>)}</select><button type="button" disabled={disabled || !cells.some(c => `${c.x},${c.y}` === choice)} onClick={() => { const [x, y] = choice.split(",").map(Number); controller.placeMech(id, { x, y }); }}>{t("放置机甲")}</button></div>
    </details>
  </section>;
}
