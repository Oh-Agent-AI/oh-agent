import { useLayoutEffect, useRef, useState } from "react";
import { gameText, type GameLocale } from "./gameCopy";
import { MAX_TURNS, living, stakeBuildings, type MatchState } from "./mecha/rules";
import type { MatchRecap } from "./mecha/matchRecap";
import { buildRoundReview, type RoundReview, type RoundReviewRecord } from "./mecha/roundReview";
import { buildMissionAchievements, type MissionAchievements } from "./mecha/missionAchievements";
import { MechaRoundReview } from "./MechaRoundReview";
import { MechaMissionAchievements } from "./MechaMissionAchievements";
import "./MechaMatchResult.css";

type Props = {
  state: MatchState;
  locale: GameLocale;
  matchRecap?: MatchRecap | null;
  getReviewRounds?: () => readonly RoundReviewRecord[] | null | undefined;
  onView: () => void;
  onReplay?: () => void;
  archiveBusy?: boolean;
  archiveMessage?: string | null;
  onRestart: () => void;
  onExit: () => void;
};

/** Mount only after the accepted local result's presentation has completed. */
export function MechaBattleResult({ state, locale, matchRecap, getReviewRounds, onView, onReplay, archiveBusy, archiveMessage, onRestart, onExit }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [reviewData, setReviewData] = useState<{ review: RoundReview; achievements: MissionAchievements | null } | null>(null);
  const t = (text: string) => gameText(text, locale);
  const victory = state.outcome === "victory";
  const buildings = stakeBuildings(state);
  const cause = victory ? (state.mission ? "救援点已抵达。" : "所有敌人已被消灭。")
    : state.outcome === "defeat_wipe" ? "机甲全部失守。"
    : state.outcome === "defeat_buildings" ? "防守建筑全部失守。"
    : "回合耗尽，未完成目标。";
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => { if (element.open) element.close(); };
  }, []);
  return <dialog ref={dialog} className={`mecha-match-result ${victory ? "is-victory" : "is-defeat"}`} data-mecha-result-dialog aria-labelledby="mecha-match-result-title" aria-describedby="mecha-match-result-cause" onCancel={(event) => { event.preventDefault(); onView(); }}>
    <div className="mecha-match-result__body">
      <div className="mecha-match-result__eyebrow">{t("任务结算")}</div>
      <h2 id="mecha-match-result-title">{t(victory ? "战斗胜利" : "战斗失败")}</h2>
      <p id="mecha-match-result-cause" className="mecha-match-result__cause">{t(cause)}</p>
      <dl className="mecha-match-result__stats">
        <div><dt>{t("最终回合")}</dt><dd>{Math.min(state.turn, MAX_TURNS)} <small>/ {MAX_TURNS}</small></dd></div>
        <div><dt>{t("存活机甲")}</dt><dd>{living(state).length} <small>/ {state.mechs.length}</small></dd></div>
        <div><dt>{t("防守建筑")}</dt><dd>{buildings.length ? <>{buildings.filter((building) => building.hp > 0).length} <small>/ {buildings.length}</small></> : "—"}</dd></div>
      </dl>
      {!victory && matchRecap ? <section className="mecha-match-result__review" aria-label={t("整局关键事件")} data-match-recap>
        <strong>{t("整局关键事件")}</strong>
        {matchRecap.status === "unavailable" ? <p>{t("整局记录不完整，无法确认关键事件。")}</p>
          : matchRecap.losses.length ? <ul tabIndex={0} aria-label={t("整局关键事件")}>{matchRecap.losses.map((loss) => <li key={`${loss.kind}:${loss.id}`}>
            {t("回合")} {loss.turn} · {t("首次失守")} · {loss.kind === "building" ? `${locale === "en" ? "Building" : t("建筑")} ${loss.id}` : t(({ Assault: "突击", Gunner: "射手", Support: "支援" } as Record<string, string>)[loss.id] ?? loss.id)}
          </li>)}</ul> : <p>{t("整局未记录机甲或防守建筑失守。")}</p>}
        <p className="mecha-match-result__review-note">{t("仅列出已结算事件，不代表失败原因。")}</p>
      </section> : null}
      {archiveMessage ? <p className={`mecha-match-result__archive-status ${/失败|无法|不可用|已满|损坏|未能/.test(archiveMessage) ? "is-error" : ""}`} role="status" aria-live="polite">{t(archiveMessage)}</p> : null}
      <div className="mecha-match-result__actions">
        <button type="button" className="mecha-match-result__primary" data-result-replay disabled={!onReplay || archiveBusy} autoFocus={Boolean(onReplay)} onClick={onReplay}>{t("重播")}</button>
        <button type="button" data-result-restart disabled={archiveBusy} autoFocus={!onReplay} onClick={onRestart}>{t("再开一局")}</button>
        <button type="button" data-result-exit disabled={archiveBusy} onClick={onExit}>{locale === "en" ? "Exit Battle" : t("退出战斗")}</button>
      </div>
      {getReviewRounds ? <details className="mecha-match-result__details" data-result-review onToggle={event => {
        if (!event.currentTarget.open || reviewData) return;
        let rounds: readonly RoundReviewRecord[] | null | undefined;
        try { rounds = getReviewRounds(); } catch { rounds = null; }
        const review = buildRoundReview(state, rounds);
        // Achievement claims require the stronger full rules-and-log verification too.
        const achievements = buildMissionAchievements({ scope: "local-pve", final: state, rounds: review.status === "verified" ? rounds : null });
        setReviewData({ review, achievements });
      }}>
        <summary>{locale === "en" ? "Match review and objectives" : "对局复盘与目标评价"}</summary>
        {reviewData ? <>
          <MechaMissionAchievements achievements={reviewData.achievements} locale={locale} />
          <MechaRoundReview review={reviewData.review} locale={locale} />
        </> : null}
      </details> : null}
    </div>
  </dialog>;
}
