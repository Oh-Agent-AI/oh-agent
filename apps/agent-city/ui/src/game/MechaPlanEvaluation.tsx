import { useEffect, useState } from "react";
import { gameText, type GameLocale } from "./gameCopy";
import { evaluatePlan, type DoctrineId, type PlanEvaluation } from "./mecha/ai";
import { draftPlan, type DraftMap } from "./mecha/planning";
import type { MatchState } from "./mecha/rules";

type Result = { match: MatchState; draft: DraftMap; doctrine: DoctrineId; evaluation: PlanEvaluation };

/** On-demand current-draft evaluation, not an assertion about where the draft came from. */
export function MechaPlanEvaluation({ match, draft, doctrine, locale }: {
  match: MatchState; draft: DraftMap; doctrine: DoctrineId; locale: GameLocale;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const t = (text: string) => gameText(text, locale);
  useEffect(() => {
    let evaluation: PlanEvaluation;
    try { evaluation = evaluatePlan(match, draftPlan(match, draft), doctrine); }
    catch { evaluation = { ok: false, reason: "unavailable" }; }
    setResult({ match, draft, doctrine, evaluation });
  }, [match, draft, doctrine]);
  const current = result && result.match === match && result.draft === draft && result.doctrine === doctrine ? result.evaluation : null;
  if (!current) return <p role="status">{t("正在试算当前草稿…")}</p>;
  if (!current.ok) return <p role="status" data-plan-evaluation="unavailable">{t("评分试算不可用，请检查草稿或稍后重试。")}</p>;
  const number = (value: number) => Number(value.toFixed(2)).toString();
  const signed = (value: number) => `${value > 0 ? "+" : ""}${number(value)}`;
  const factors = current.factors;
  return <div className="mecha-plan-evaluation" data-plan-evaluation="ready" aria-live="polite">
    <p><strong>{t("当前草稿评分")}: {number(current.score)}</strong> · {t(doctrine === "peel" ? "守楼" : "攻坚")}</p>
    <dl>
      <div><dt>{t("大怪累计受损得分")}</dt><dd>{signed(factors.boss)}</dd></div>
      <div><dt>{t("小怪累计受损得分")}</dt><dd>{signed(factors.raiders)}</dd></div>
      <div><dt>{t("机甲剩余生命得分")}</dt><dd>{signed(factors.mechs)}</dd></div>
      <div><dt>{t("机甲位置扣分")}</dt><dd>{signed(factors.position)}</dd></div>
      <div><dt>{t("建筑剩余生命得分")}</dt><dd>{signed(factors.buildings)}</dd></div>
      <div><dt>{t("胜负修正")}</dt><dd>{signed(factors.outcome)}</dd></div>
    </dl>
    <p>{t("数值是玩家行动及可能的敌方结算后的加权评分项，不等于本回合伤害或收益；建筑包括非目标建筑，位置按结算后焦点计算。分数仅供同打法、同局面比较。")}</p>
    <p>{t("这只是对当前草稿的评分，不证明行动原因或全局最优；搜索还会筛选候选。数值最多显示两位小数。")}</p>
  </div>;
}
