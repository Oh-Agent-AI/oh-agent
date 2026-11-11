import type { GameLocale } from "./gameCopy";
import type { MechaControllerState } from "./mecha/controller";

export function MechaPrismShieldStatus({ locale, controllerState, sequenceWaiting }: {
  locale: GameLocale;
  controllerState: Pick<MechaControllerState, "match" | "performance" | "replay">;
  sequenceWaiting: boolean;
}) {
  const { match, performance, replay } = controllerState;
  // Replay snapshots are separate from the live match; do not mix their statuses.
  if (replay) return null;
  return <MechaPrismShieldView locale={locale} match={match} pending={Boolean(performance || sequenceWaiting)} />;
}

export function MechaPrismShieldView({ locale, match, pending }: {
  locale: GameLocale;
  match: MechaControllerState["match"];
  pending: boolean;
}) {
  if (match.monsterContent?.speciesId !== "prism_warden") return null;
  const en = locale === "en";
  if (pending) return <span role="status" data-prism-shield-status="pending">
    {en ? "Prism shield: awaiting the end of the battle sequence." : "棱镜护盾：演出结束后确认状态。"}
  </span>;
  const hits = match.boss.shield?.hits ?? 0;
  return <span role="status" data-prism-shield-status={hits ? "active" : "absent"} data-prism-shield-hits={hits}>
    {en ? `Prism shield: ${hits ? "active" : "absent"} (${hits} hit${hits === 1 ? "" : "s"} remaining)`
      : `棱镜护盾：${hits ? "存在" : "无"}（剩余 ${hits} 次）`}
  </span>;
}
