/** Flight activity content on the shared vehicle HUD shell. */
import { useState } from "react";
import { gameText, type GameLocale } from "./gameCopy";
import type { GameSessionSnapshot } from "./GameSession";
import { cityView } from "../i18n";
import { GameHudShell } from "./ui/GameHudShell";
import { GameControlsHelp, type GameControlRow } from "./ui/GameControlsHelp";
import { GameSessionPanel } from "./ui/GameSessionPanel";
import { GameSoundPanel } from "./ui/GameSoundPanel";
import { TelemetryChip } from "./ui/TelemetryChip";
import "./game.css";

export type GameHudActions = {
  onResume: () => void; onRestart: () => void; onExit: () => void; onRetryPrepare: () => void; onNewCourse: () => void;
  onSoundVolume: (volume: number) => void; onToggleSfx: () => void; onToggleMusic: () => void;
  onPause?: () => void;
};

const clock = (ms: number) => {
  const seconds = Math.max(0, ms) / 1000;
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}.${Math.floor((seconds * 10) % 10)}`;
};
const FLIGHT_CONTROLS: readonly GameControlRow[] = [
  { keys: "W / S", description: "按住加速 / 减速；松开回到巡航" }, { keys: "A / D", description: "左右转向" },
  { keys: "↑ / ↓", description: "爬升 / 下降" }, { keys: "拖动 / 滚轮", description: "环绕飞机 / 拉近拉远（双击复位）" },
  { keys: "Esc", description: "暂停 / 继续" },
];

export function GameHud({ snapshot, actions, locale, persist }: { snapshot: GameSessionSnapshot; actions: GameHudActions; locale: GameLocale; persist?: { tier: "native" | "local" | "memory" | null; saveFailed: boolean } }) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [soundOpen, setSoundOpen] = useState(false);
  const t = (text: string) => gameText(text, locale);
  const { controller, telemetry, softOutside, mission, best } = snapshot;
  const phase = controller.phase;
  const paused = controller.paused;
  const error = controller.error;
  const racing = controller.selection?.mode === "race";
  const countdown = phase === "countdown" && mission ? Math.ceil(mission.countdownRemainingMs / 1000) : null;
  const uiPanelOpen = () => actions.onPause?.();
  if (phase === "data" || phase === "exiting") return null;

  let panel = null;
  if (phase === "preparing") panel = <GameSessionPanel locale={locale} title="正在准备飞行场地…"
    description={t(racing ? "穿过高亮圆环，顺序错误不计数。" : "自由飞行，没有任务与计时。")}
    actions={[{ label: "取消准备", tone: "danger", onAction: actions.onExit}]} />;
  else if (error) panel = <GameSessionPanel locale={locale} title="出错了" description={t(error.message)} role="alertdialog"
    actions={[{ label: "重试准备", onAction: actions.onRetryPrepare }, { label: "回到数据视角", tone: "danger", onAction: actions.onExit}]} />;
  else if (paused && phase !== "result" && !helpOpen && !soundOpen) panel = <GameSessionPanel locale={locale} title="已暂停"
    description={paused.reason === "camera-safety" ? t("相机安全检查无法确认，飞行已暂停。") : undefined}
    children={<><GameControlsHelp locale={locale} rows={FLIGHT_CONTROLS} className="city-game-panel-help" />
      <GameSoundPanel locale={locale} sound={{ volume: snapshot.soundVolume, onVolume: actions.onSoundVolume,
        sfx: { enabled: snapshot.sfxEnabled, onToggle: actions.onToggleSfx }, music: { enabled: snapshot.musicEnabled, onToggle: actions.onToggleMusic } }} />
    </>}
    actions={[{ label: "继续", onAction: actions.onResume }, { label: "重新开始", onAction: actions.onRestart }, { label: "退出游戏", tone: "danger", onAction: actions.onExit}]} />;
  else if (phase === "result" && mission?.result) panel = <GameSessionPanel locale={locale} title={mission.result.finished ? "完成！" : "超时"}
    children={<dl className="city-game-result-list"><dt>{t("用时")}</dt><dd>{clock(mission.result.finalMs)}</dd>
      {mission.result.penaltyMs > 0 && <><dt>{t("罚时")}</dt><dd>+{(mission.result.penaltyMs / 1000).toFixed(0)}s</dd></>}
      <dt>{t("碰撞")}</dt><dd>{mission.result.collisions}</dd>
      {best && <><dt>{t("最佳")}</dt><dd>{clock(best.finalMs)}{mission.result.finished && mission.result.finalMs <= best.finalMs && mission.result.collisions <= best.collisions ? ` · ${t("新纪录")}` : ""}</dd></>}
      {(persist?.saveFailed || persist?.tier === "memory") && mission.result.finished && <dd role="status">{t(persist?.tier === "memory" ? "成绩仅本次保留" : "本次成绩尚未保存")}</dd>}
    </dl>}
    actions={[{ label: "重试", onAction: actions.onRestart }, { label: "换一条路线", onAction: actions.onNewCourse }, { label: "退出游戏", tone: "danger", onAction: actions.onExit}]} />;

  return cityView(<GameHudShell
    title={<div className="city-game-chip"><strong>{t(racing ? "穿环挑战" : "自由练习")}</strong></div>}
    status={softOutside && !paused && !error ? <div className="city-game-chip city-game-warn" role="status">{t("已越过软边界，请返航")}</div> : undefined}
    telemetry={telemetry && phase !== "preparing" ? <TelemetryChip label={t("飞行遥测")}>
      <span>{t("速度")}</span><strong>{Math.round(telemetry.speed)}</strong><span>{t("高度")}</span><strong>{Math.round(telemetry.altitude)}</strong>
    </TelemetryChip> : undefined}
    sound={(!paused || soundOpen) && !error && phase !== "result" && phase !== "preparing" ? <GameSoundPanel locale={locale} sound={{ volume: snapshot.soundVolume,
      onVolume: actions.onSoundVolume, sfx: { enabled: snapshot.sfxEnabled, onToggle: actions.onToggleSfx },
      music: { enabled: snapshot.musicEnabled, onToggle: actions.onToggleMusic } }} onOpenChange={(open) => { setSoundOpen(open); if (open) uiPanelOpen(); }} /> : undefined}
    help={(!paused || helpOpen) && !error && phase !== "result" && phase !== "preparing" ? <GameControlsHelp locale={locale} rows={FLIGHT_CONTROLS}
      onOpenChange={(open) => { setHelpOpen(open); if (open) uiPanelOpen(); }} /> : undefined}
    panel={<>{countdown !== null && countdown > 0 && <div className="city-game-countdown" role="status" aria-live="assertive">{countdown}</div>}{panel}</>}
  />, locale === "en" ? "en" : "zh-Hans");
}
