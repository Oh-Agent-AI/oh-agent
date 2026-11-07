import { useState } from "react";
import { gameText, type GameLocale } from "./gameCopy";
import { MechaUnitAvatar, MechaUnitPortrait } from "./MechaUnitAvatar";
import type { MechaController, MechaControllerState } from "./mecha/controller";
import { STATS, type Cell, type MechId } from "./mecha/board";
import type { DeployPlacement } from "./mecha/deployment";
const NAMES = { Assault: "突击", Gunner: "射手", Support: "支援" };

export function MechaDeploymentPanel({ controller, state, disabled, submitRef }: { controller: MechaController; state: MechaControllerState; disabled: boolean; submitRef: (node: HTMLDivElement | null) => void }) {
  const d = state.deployment!;
  return <MechaDeploymentView locale={state.locale} units={state.match.mechs.map(m => m.id)} selected={state.selected}
    placements={d.placements} disabled={disabled || !d.interactive} canConfirm={d.canConfirm} canUndo={d.canUndo} canReset={d.canReset}
    error={d.error} submitRef={submitRef} onSelect={id => controller.selectMech(id)} onConfirm={() => controller.confirmDeployment()}
    onUndo={() => controller.undoDeployment()} onReset={() => controller.resetDeployment()} />;
}

/** Classic deployment HUD, independent of the active rules controller. */
export function MechaDeploymentView({ locale, units, selected, placements, disabled, canConfirm, canUndo, canReset, error, submitRef, onSelect, onConfirm, onUndo, onReset }: {
  locale: GameLocale; units: MechId[]; selected: MechId; placements: DeployPlacement[]; disabled: boolean;
  canConfirm: boolean; canUndo: boolean; canReset: boolean; error: string | null;
  submitRef?: (node: HTMLDivElement | null) => void; onSelect: (id: MechId) => void;
  onConfirm: () => void; onUndo: () => void; onReset: () => void;
}) {
  const t = (text: string) => gameText(text, locale);
  return <>
    <div className="mecha-submit" ref={submitRef}>
      <div className="mecha-planning-heading"><h3>{t("开局部署")}</h3></div>
      <div className="mecha-planning-status" role="status"><strong>{t("已部署")} {placements.length}/3</strong><span id="mecha-deploy-help">{t("选择机甲，再点击绿色格子。已放置的机甲可交换位置。")}</span></div>
      {error ? <p className="mecha-deploy-error" role="alert">{error}</p> : null}
      <div className="mecha-planning-controls"><button type="button" className="mecha-submit-primary" aria-describedby="mecha-deploy-help" disabled={disabled || !canConfirm} onClick={onConfirm}>{t("确认部署")}</button></div>
      <div className="mecha-planning-controls"><button type="button" disabled={disabled || !canUndo} onClick={onUndo}>{t("撤销放置")}</button><button type="button" disabled={disabled || !canReset} onClick={onReset}>{t("重置部署")}</button></div>
    </div>
    <ul className="mecha-pack mecha-deploy-roster" aria-label={t("部署队伍")}>
      {units.map(id => {
        const placement = placements.find(p => p.mechId === id);
        return <li className={id === selected ? "mecha-plan-card is-current" : "mecha-plan-card"} data-mech-id={id} key={id}><button type="button" className="mecha-plan-card__select" aria-pressed={id === selected} disabled={disabled} onClick={() => onSelect(id)}>
          <MechaUnitAvatar mechId={id} locale={locale} /><span><strong>{t(NAMES[id])}</strong><small>{placement ? `${t("已放置")} · ${placement.pos.x}, ${placement.pos.y}` : t("未放置")}</small></span>
        </button></li>;
      })}
    </ul>
  </>;
}

export function MechaDeploymentActions({ controller, state, disabled }: { controller: MechaController; state: MechaControllerState; disabled: boolean }) {
  return <MechaDeploymentActionsView locale={state.locale} selected={state.selected} cells={state.deployment!.cells}
    disabled={disabled} onPlace={(id, cell) => controller.placeMech(id, cell)} />;
}

/** Shared classic deployment controls; placement remains the controller's responsibility. */
export function MechaDeploymentActionsView({ locale, selected, cells, disabled, onPlace }: {
  locale: GameLocale; selected: MechId; cells: Cell[]; disabled: boolean; onPlace: (id: MechId, cell: Cell) => void;
}) {
  const [choice, setChoice] = useState("");
  const t = (text: string) => gameText(text, locale);
  const id = selected;
  const stats = STATS[id];
  return <section className="mecha-selected-actions mecha-deploy-actions" aria-label={t("部署操作")}>
    <h3>{t("放置机甲")} · {t(NAMES[id])}</h3>
    <div className="mecha-deploy-unit"><MechaUnitPortrait unitId={id} locale={locale} size={88} /><div><strong>{t(NAMES[id])}</strong><p>HP {stats.maxHp} · {t("移动")} {stats.move}</p></div></div>
    <p className="mecha-deploy-next-step">{t("部署确认后才生成首回合敌意。完成 3/3 并确认后，即可操作机甲、移动和攻击。")}</p>
    <details className="mecha-deploy-list"><summary>{t("通过列表部署")}</summary>
      <label htmlFor="mecha-deploy-choice">{t("选择部署坐标")}</label>
      <div className="mecha-move-controls"><select id="mecha-deploy-choice" value={choice} disabled={disabled} onChange={e => setChoice(e.currentTarget.value)}><option value="" disabled>{t("选择坐标")}</option>{cells.map(c => <option key={`${c.x},${c.y}`} value={`${c.x},${c.y}`}>{c.x}, {c.y}</option>)}</select><button type="button" disabled={disabled || !cells.some(c => `${c.x},${c.y}` === choice)} onClick={() => { const [x, y] = choice.split(",").map(Number); onPlace(id, { x, y }); }}>{t("放置机甲")}</button></div>
    </details>
  </section>;
}
