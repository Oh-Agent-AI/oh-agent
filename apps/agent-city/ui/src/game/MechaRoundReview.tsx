import type { GameLocale } from "./gameCopy";
import type { RoundReview } from "./mecha/roundReview";
import "./MechaRoundReview.css";

export type MechaRoundReviewProps = {
  review: RoundReview | null | undefined;
  locale: GameLocale;
};

/** Standalone, read-only presentation. The caller builds and owns the review. */
export function MechaRoundReview({ review, locale }: MechaRoundReviewProps) {
  const en = locale === "en";
  return <section className="mecha-round-review" aria-label={en ? "Round review" : "逐回合复盘"} lang={en ? "en" : "zh-Hans"} data-mecha-round-review>
    <h3 className="mecha-round-review__title">{en ? "Round review" : "逐回合复盘"}</h3>
    {!review || review.status !== "verified" || !review.rounds.length
      ? <p className="mecha-round-review__unknown">{en ? "Unknown: the full recording is missing or could not be verified." : "未知：整局记录缺失或无法核对。"}</p>
      : <>
        <p className="mecha-round-review__note">{en ? "Verified settled events · Damage is gross HP lost, including damage later repaired." : "已核对的结算事件 · 伤害为累计生命损失，不扣除后续修复。"}</p>
        <ol className="mecha-round-review__list">
          {review.rounds.map(round => <li className="mecha-round-review__round" key={round.turn}>
            <details>
              <summary><span>{en ? `Round ${round.turn}` : `第 ${round.turn} 回合`}</span><span className="mecha-round-review__disclosure" aria-hidden="true" /></summary>
              <dl className="mecha-round-review__facts">
                <div><dt>{en ? "Enemy damage taken" : "敌方受到伤害"}</dt><dd>{round.enemyDamage}</dd></div>
                <div><dt>{en ? "Mech damage taken" : "机甲受到伤害"}</dt><dd>{round.mechDamage}</dd></div>
                <div><dt>{en ? "Building damage taken" : "建筑受到伤害"}</dt><dd>{round.buildingDamage}</dd></div>
                <div><dt>{en ? "Enemies down" : "敌方被击毁"}</dt><dd>{round.enemiesDown}</dd></div>
                <div><dt>{en ? "Fizzled actions" : "行动落空"}</dt><dd>{round.fizzledActions}</dd></div>
              </dl>
            </details>
          </li>)}
        </ol>
        <p className="mecha-round-review__note">{en ? "Facts only; these do not establish why the match was lost." : "仅列出事实，不推断失败原因。"}</p>
      </>}
  </section>;
}
