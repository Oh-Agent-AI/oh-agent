import { fizzleText, type GameLocale } from "./gameCopy";
import type { Action, BossSkill, Cell, HealthEffect, MatchState, MechId, Outcome, TurnEvent } from "./mecha/board";
import type { HealthTimeline } from "./mecha/healthTimeline";
import { buildTurnRecap } from "./mecha/turnRecap";
import { buildFailureRecap } from "./mecha/failureRecap";
import "./MechaLastResult.css";

type Translate = (text: string) => string;

type MechaLastResultProps = {
  /** The accepted turn's log, not the current plan's prediction. */
  lastLog: readonly TurnEvent[];
  /** The controller's validated timeline for that same log, when available. */
  healthTimeline?: HealthTimeline | null;
  finalState?: MatchState | null;
  mode?: "previous" | "replay";
  t: Translate;
  locale: GameLocale;
};

const MECH_NAMES: Record<MechId, string> = { Assault: "突击", Gunner: "射手", Support: "支援" };
const ACTION_NAMES: Record<Action["kind"], string> = {
  skip: "待机", melee: "近战", shoot: "射击", charge: "冲撞", pierce: "穿射", repair: "维修",
};
const SKILL_NAMES: Record<BossSkill, string> = { smash: "砸击", sweep: "横扫", skip: "跳过" };
const OUTCOME_NAMES: Record<Outcome, string> = {
  victory: "胜利", defeat_wipe: "全灭", defeat_timeout: "回合耗尽", defeat_buildings: "楼被拆光",
};

function unitName(id: string, t: Translate): string {
  switch (id) {
    case "Assault": case "Gunner": case "Support": return t(MECH_NAMES[id]);
    case "boss": return t("大怪");
    case "raider-w": return t("小怪西");
    case "raider-e": return t("小怪东");
    case "wall": return t("墙或障碍");
    default: return id; // Unknown IDs are not necessarily raiders (e.g. a PvP unit).
  }
}

function cellText(cell: Cell): string {
  return `${cell.x},${cell.y}`;
}

function eventText(event: TurnEvent, t: Translate, locale: GameLocale): string {
  switch (event.type) {
    case "move":
      return `${unitName(event.mechId, t)} · ${t("移动")} ${cellText(event.from)} → ${cellText(event.to)}`;
    case "act": {
      const fields = [unitName(event.mechId, t), t(ACTION_NAMES[event.action] ?? event.action)];
      if (event.target !== undefined) fields.push(`${t("目标")} ${unitName(event.target, t)}`);
      if (event.fizzled) fields.push(t("行动落空，不消耗冷却"), fizzleText(event.cause, locale));
      else if (event.action !== "repair" && event.action !== "skip") fields.push(`${t("直接伤害")} ${event.damage}`);
      return fields.join(" · ");
    }
    case "shove": {
      const fields = [unitName(event.unit, t), t(event.hit ? "推挤受阻" : "被推动"), `${t("方向")} (${cellText(event.dir)})`];
      if (event.hit) fields.push(`${t("碰撞")} ${event.hit.split(",").map((id) => unitName(id, t)).join("、")}`, `${t("被推单位碰撞伤害")} ${event.damage}`);
      return fields.join(" · ");
    }
    case "enemy": {
      const fields = [unitName(event.actor, t), t(SKILL_NAMES[event.skill] ?? event.skill)];
      if (event.cells.length) fields.push(`${t("作用格")} ${event.cells.map(cellText).join("、")}`);
      fields.push(`${t("直接伤害合计")} ${event.damage}`);
      return fields.join(" · ");
    }
    case "outcome": return `${t("结局")} · ${t(OUTCOME_NAMES[event.outcome] ?? event.outcome)}`;
    default: {
      // The union is exhaustive at compile time. Preserve an unrecognized runtime event
      // rather than silently classifying it as a known outcome.
      const unknown: never = event;
      return `${t("未知结算事件")} · ${JSON.stringify(unknown)}`;
    }
  }
}

function healthEffectText(effect: HealthEffect, t: Translate): string {
  const name = effect.kind === "building" ? `${t("建筑")} ${effect.id}` : unitName(effect.id, t);
  return `${name} · ${effect.before} → ${effect.after}`;
}

/** An actual fizzle takes precedence; the match outcome remains visible in the objective. */
function highlightEvent(log: readonly TurnEvent[]): TurnEvent | undefined {
  return log.find((event) => event.type === "act" && event.fizzled)
    ?? log.find((event) => event.type === "outcome")
    ?? log.find((event) => event.type === "shove" && event.hit);
}

/**
 * Render separately from the scrollable threat panel so the result remains discoverable.
 * The parent should only mount this after playback has ended or been skipped.
 */
export function MechaLastResult({ lastLog, healthTimeline, finalState, mode = "previous", t, locale }: MechaLastResultProps) {
  const highlight = highlightEvent(lastLog);
  const recap = buildTurnRecap(lastLog, healthTimeline);
  const failure = buildFailureRecap(finalState, lastLog, healthTimeline);
  const decisive = failure?.decisive;
  const source = decisive?.event.type === "enemy"
    ? `${unitName(decisive.event.actor, t)} · ${t(SKILL_NAMES[decisive.event.skill] ?? decisive.event.skill)}`
    : decisive?.event.type === "act" ? `${unitName(decisive.event.mechId, t)} · ${t(ACTION_NAMES[decisive.event.action])}`
    : decisive?.event.type === "shove" ? t("推挤碰撞") : null;
  return <section className="mecha-last-result" aria-label={t(mode === "replay" ? "本回合摘要" : "上一回合摘要")} aria-describedby="mecha-last-result-scroll-help" tabIndex={0}>
    <span id="mecha-last-result-scroll-help" className="mecha-sr-only">{t("内容较多时可滚动")}</span>
    {failure ? <div className="mecha-failure-recap" data-failure-recap>
      <strong>{t("失败复盘")} · {t("最终回合")} {failure.turn}</strong>
      <p>{t(failure.outcome === "defeat_wipe" ? "机甲全部失守。" : failure.outcome === "defeat_buildings" ? "防守建筑全部失守。" : "回合耗尽，未完成目标。")}</p>
      {failure.outcome !== "defeat_timeout" ? <p data-failure-decisive>{decisive
        ? <>{t("最后失守")} · {decisive.effect.kind === "building" ? `${locale === "en" ? "Building" : t("建筑")} ${decisive.effect.id}` : unitName(decisive.effect.id, t)}{source ? ` · ${source}` : ""}</>
        : t("无法从最后一回合的记录确认最后失守对象。")}</p> : null}
    </div> : null}
    <div className="mecha-last-result-heading">{t(mode === "replay" ? "本回合摘要" : "上一回合摘要")}</div>
    {mode === "replay" ? <p className="mecha-recap-help">{t("完整记录可能包含尚未播出的事件。")}</p> : null}
    <div className="mecha-last-result-highlights">
      {highlight ? <p data-result-highlight>{eventText(highlight, t, locale)}</p> : null}
      {lastLog.length ? <>
        <dl className="mecha-recap-stats" aria-describedby="mecha-recap-stats-help" data-turn-recap>
          <div><dt>{t("敌方倒下")}</dt><dd>{recap.health?.enemiesDown ?? "—"}</dd></div>
          <div><dt>{t("行动落空")}</dt><dd>{recap.fizzledActions}</dd></div>
          <div><dt>{t("机甲受损")}</dt><dd>{recap.health?.mechDamage ?? "—"}</dd></div>
          <div><dt>{t("建筑受损")}</dt><dd>{recap.health?.buildingDamage ?? "—"}</dd></div>
        </dl>
        <span id="mecha-recap-stats-help" className="mecha-sr-only">{t("受损为本回合累计扣血，不抵消治疗。")}</span>
        {!recap.health ? <p>{t("生命值变化明细不可用。")}</p> : null}
      </> : <p>{t("暂无可回看的结算事件。")}</p>}
    </div>
    <details>
      <summary>{t(mode === "replay" ? "查看详细事件" : "上一回合结果")}</summary>
      <p>{t("以下为实际结算事件，不是本回合预测。")}</p>
      <p className="mecha-recap-help">{t("受损为本回合累计扣血，不抵消治疗。")}</p>
      {lastLog.length ? <ol>{lastLog.map((event, index) => <li key={index}>{eventText(event, t, locale)}</li>)}</ol>
        : <p>{t("暂无可回看的结算事件。")}</p>}
      <p>{t("生命值变化（实际顺序）")}</p>
      {healthTimeline?.ok ? healthTimeline.steps.length ? <ol>{healthTimeline.steps.map(({ effect }, index) => <li key={index}>
        {healthEffectText(effect, t)}
      </li>)}</ol> : <p>{t("没有生命值变化。")}</p> : <p>{t("生命值变化明细不可用。")}</p>}
    </details>
  </section>;
}
