import { gameText, type GameLocale } from "../gameCopy";
import type { SpawnConfirmationSnapshot } from "../driving/SpawnConfirmation";
import { GameSessionPanel } from "./GameSessionPanel";

/** Shared formal-entry prompt. UAT never mounts it and cannot create confirmation state. */
export function DrivingSpawnConfirmationPanel({ snapshot, locale, onSelectCandidate, onConfirm, onEnter, onCancel }: {
  snapshot: SpawnConfirmationSnapshot;
  locale: GameLocale;
  onSelectCandidate: (spawnId: string) => void;
  onConfirm: (spawnId: string) => void;
  onEnter: () => void;
  onCancel: () => void;
}) {
  const t = (text: string) => gameText(text, locale);
  const children = snapshot.status === "derived" ? <div className="city-game-spawn-candidates" role="group" aria-label={t("可用出生点候选")}>
    {snapshot.candidates.map((candidate, index) => <button key={candidate.id} type="button" className="city-game-spawn-candidate"
      onClick={() => onSelectCandidate(candidate.id)}>{t("候选")} {index + 1}<small>{candidate.sourceUnitId}</small></button>)}
  </div> : snapshot.status === "validated" || snapshot.status === "confirmed" ? <p className="city-game-spawn-selection">
    {t("已选择候选")} · {snapshot.selectedSpawnId}
  </p> : undefined;
  const description = snapshot.status === "unavailable" ? t(snapshot.reason === "released-graph-unavailable"
    ? "正式道路图尚不可用，暂不能开始驾驶。" : "当前没有通过验证的驾驶出生点。")
    : snapshot.status === "invalidated" ? t("场景或车辆配置已变化，请重新选择出生点。")
      : snapshot.status === "confirmed" ? t("出生点已确认；确认只适用于当前场景和车辆配置。")
        : snapshot.status === "validated" ? t("此候选已通过当前场景校验。确认后才可开始驾驶。")
          : t("选择一个已派生的候选；每个候选仍须通过当前场景和车辆校验。");
  const actions = snapshot.status === "validated"
    ? [{ label: "确认出生点", onAction: () => onConfirm(snapshot.selectedSpawnId), tone: "primary" as const }, { label: "取消", onAction: onCancel, tone: "danger" as const }]
    : snapshot.status === "confirmed"
      ? [{ label: "开始驾驶", onAction: onEnter, tone: "primary" as const }, { label: "取消", onAction: onCancel, tone: "danger" as const }]
      : [{ label: "关闭", onAction: onCancel }];
  return <GameSessionPanel locale={locale} title="正式驾驶出生点" description={description} children={children} actions={actions} role="dialog" />;
}
