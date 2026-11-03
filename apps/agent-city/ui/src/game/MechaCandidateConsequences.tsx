import { fizzleText, gameText, type GameLocale } from "./gameCopy";
import { compareEnemyForecasts } from "./mecha/enemyForecastComparison";
import { forecastFizzles } from "./mecha/fizzleForecast";
import { repairEnemyStage, repairEnemyStageComparison, type RepairEnemyStage } from "./mecha/repairForecast";
import type { MechaPreview } from "./mecha/controller";
import type { CandidateResult } from "./mecha/candidateResult";
import type { Cell } from "./mecha/rules";
import "./mechaCandidateConsequences.css";

/** The compact primary result is action-local; the separate footer is whole-turn. */
export function MechaCandidateConsequences({ result, baseline, candidate, locale, unitName }: {
  result: CandidateResult; baseline: MechaPreview; candidate: MechaPreview; locale: GameLocale; unitName: (id: string) => string;
}) {
  const en = locale === "en", t = (text: string) => gameText(text, locale);
  const at = (cell: Cell | null) => cell ? `${cell.x},${cell.y}` : "?";
  const skillName = (skill: "smash" | "sweep" | "skip") => skill === "sweep" ? t("横扫") : skill === "smash" ? t("砸击") : t("跳过");
  const comparison = compareEnemyForecasts(baseline, candidate);
  const action = result.action;
  const repairStage = action?.action === "repair" && !action.fizzled && action.target ? repairEnemyStage(candidate, action.target) : null;
  const repairComparison = action?.action === "repair" && !action.fizzled && action.target ? repairEnemyStageComparison(baseline, candidate, action.target) : null;
  const repairStageText = (stage: RepairEnemyStage) => {
    if (stage.status === "unknown") return en ? "result unknown" : "结果未知";
    if (stage.status === "ended") return en ? "battle ends before enemy phase" : "敌方阶段前战斗已结束";
    if (stage.status === "already-destroyed") return en ? "destroyed before enemy phase" : "敌方阶段前已被击毁";
    const label = stage.after <= 0 ? (en ? "destroyed in enemy phase" : "敌方阶段被击毁")
      : stage.after < stage.before ? (en ? "survives enemy phase" : "敌方阶段后存活")
      : stage.after === stage.before ? (en ? "no HP loss in enemy phase" : "敌方阶段未损失 HP")
      : (en ? "enemy phase HP" : "敌方阶段 HP");
    return `${label} · HP ${stage.before} → ${stage.after}`;
  };
  const otherFizzles = candidate.ok && action ? forecastFizzles(candidate.log).filter(event => event.mechId !== action.mechId) : [];
  if (!action) return <p>{t("行动未执行，结果未知。")}</p>;
  const hpChanges = (changes: NonNullable<typeof action.effects>, collision = false) => changes.map(effect => {
    const delta = effect.after - effect.before;
    return <p key={`${effect.kind}-${effect.id}-${effect.order}`} className={delta > 0 ? "is-healing" : collision ? "is-collision" : undefined}>
      {effect.kind === "building" ? `${en ? "Building" : "建筑"} ${effect.id}` : unitName(effect.id)} HP {effect.before} → {effect.after} <span>({delta > 0 ? "+" : ""}{delta})</span>
    </p>;
  });
  const changeLabel = (kind: "stopped" | "started" | "changed") => kind === "stopped" ? (en ? "no longer attacks" : "不再出手") : kind === "started" ? (en ? "new attack" : "新增出手") : (en ? "attack changed" : "出手变化");
  const summary = comparison.status === "unknown" ? (en ? "comparison unknown" : "对比未知") : comparison.changes.length === 0
    ? (en ? "attack count, skills and cells unchanged" : "出手次数、技能及攻击格未变")
    : comparison.changes.slice(0, 2).map(change => `${unitName(change.actor)} ${changeLabel(change.kind)}`).join(en ? "; " : "；") + (comparison.changes.length > 2 ? (en ? `; +${comparison.changes.length - 2} more` : `；另有 ${comparison.changes.length - 2} 项`) : "");
  return <div className="mecha-consequences">
    {otherFizzles.length ? <div className="mecha-consequences__fizzle" data-candidate-fizzles role="status"><strong>{en ? "This candidate: other actions forecast to fizzle" : "此目标试算：其他机甲预计落空"}</strong>{otherFizzles.map(event => <p key={event.mechId}>{unitName(event.mechId)} · {fizzleText(event.cause, locale)} · {t("行动落空，不消耗冷却")}</p>)}</div> : null}
    <p className="mecha-consequences__summary" data-forecast-summary><strong>{en ? "Whole-turn vs. draft" : "整回合对比草稿"}</strong> · {summary}</p>
    <section className="mecha-consequences__action" aria-label={en ? "This action" : "本次行动"}>
      {action.fizzled ? <p className="is-collision">{t("行动落空，不消耗冷却")} · {fizzleText(action.cause, locale)}</p> : <>
        <p className="mecha-consequences__primary">{t("行动造成的变化")} · <strong>{action.action === "repair" ? `${en ? "Actual repair" : "实际修理"} +${result.healing}` : `${t("直接伤害")} ${action.damage}`}</strong></p>
        {action.effects?.length ? hpChanges(action.effects) : <p>{action.action === "repair" ? (en ? "HP is already full; no healing applied." : "生命已满，本次未恢复生命。") : t("没有生命变化")}</p>}
        {result.shoves.map(({ event, from, to }, index) => <div key={index} className="mecha-consequences__push" data-push-result={event.hit ? "blocked" : "moved"}>
          <p><strong>{event.hit ? (en ? "Push blocked · stays in place" : "推挤受阻 · 留在原位") : (en ? "Push landing" : "推挤落点")}</strong> · {unitName(event.unit)} {at(from)} → {at(to)}</p>
          {event.hit ? <p className="is-collision">{t("碰撞")} · {event.hit.split(",").map(unitName).join(en ? ", " : "、")}</p> : null}
          {event.effects?.length ? hpChanges(event.effects, true) : null}
        </div>)}
        {result.kills.map(kill => <p key={`${kill.kind}-${kill.id}`} className="is-collision" data-candidate-kill={kill.id}>
          {kill.source === "collision" ? (en ? "Collision destroyed" : "碰撞击毁") : (en ? "This action destroyed" : "本次行动击毁")} · {unitName(kill.id)}
        </p>)}
      </>}
      <p>{en ? "Target HP after this action" : "本次行动后目标 HP"} <strong>{result.actionHp ?? "?"}</strong></p>
      {repairStage ? <div className="mecha-consequences__repair" data-repair-forecast={repairStage.status}>
        <p><strong>{en ? "Repair candidate" : "修理候选"}</strong> · {repairStageText(repairStage)}</p>
        <p>{en ? "Repair uses this mech's action; it cannot also attack this turn." : "修理占用本机甲本回合行动，不能同时攻击。"}</p>
        <p>{en ? "Current draft" : "当前草稿"} · {repairComparison?.status === "ready" ? repairStageText(repairComparison.baseline) : (en ? "comparison unknown" : "对比未知")}</p>
        <small>{en ? "Whole-turn forecasts; other actions and early outcomes may also change the result." : "整回合预测；其他行动及提前结束也可能影响结果。"}</small>
      </div> : null}
    </section>
    <section className="mecha-consequences__turn" aria-label={en ? "Whole turn" : "整回合结果"}>
      <p><strong>{t("整包结束目标 HP")} {result.endHp ?? "?"}</strong></p>
      <small>{en ? `Whole-turn forecast · ${result.enemyAttacks} enemy attacks` : `整回合预测 · 敌方出手 ${result.enemyAttacks} 次`}</small>
      <div className="mecha-consequences__comparison" data-forecast-comparison={comparison.status}>
        <p><strong>{en ? "Compared with current draft" : "相对当前草稿"}</strong></p>
        <small>{en ? "Whole-turn forecast; other actions and early victory or defeat may also affect it." : "整回合预测，可能包含其他行动及胜负提前结束的连锁影响。"}</small>
        {comparison.status === "unknown" ? <p>{en ? "Comparison unavailable; changes are unknown." : "无法对比，变化未知。"}</p>
          : comparison.changes.length === 0 ? <p>{en ? "Attack counts, skills and cells unchanged; damage and order not compared." : "出手次数、技能及攻击格未变化；未比较伤害和顺序。"}</p>
          : comparison.changes.map(change => <p key={change.actor} data-forecast-actor={change.actor} data-forecast-change={change.kind}>
            <strong>{unitName(change.actor)} · {change.kind === "stopped" ? (en ? "No longer attacks" : "不再出手") : change.kind === "started" ? (en ? "New attack" : "新增出手") : (en ? "Attack changed" : "出手变化")}</strong><br />
            {en ? "Attacks" : "出手"} {change.beforeCount} → {change.afterCount}{change.beforeSkills.join(",") !== change.afterSkills.join(",") ? <> · {en ? "Skills" : "技能"} {change.beforeSkills.map(skillName).join(" / ") || "—"} → {change.afterSkills.map(skillName).join(" / ") || "—"}</> : null} · {en ? "Cells" : "攻击格"} {change.beforeCells.map(at).join(" / ") || "—"} → {change.afterCells.map(at).join(" / ") || "—"}
          </p>)}
      </div>
      {result.buildings.length ? <details><summary>{en ? "Building consequences" : "建筑后果"} · {result.buildings.length}</summary>
        {result.buildings.map(building => <p key={building.id}>{en ? "Building" : "建筑"} {building.id} ({building.cells.map(cell => `${cell.x},${cell.y}`).join(" / ")}) HP {building.startHp} → {building.endHp}{building.endHp === 0 ? (en ? " · destroyed" : " · 摧毁") : ""}</p>)}
      </details> : null}
    </section>
  </div>;
}
