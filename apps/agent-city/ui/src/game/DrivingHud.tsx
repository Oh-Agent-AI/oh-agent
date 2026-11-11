import { useState } from "react";
import { gameText, type GameLocale } from "./gameCopy";
import { METERS_PER_UNIT } from "../engine/worldScale";
import { GameHudShell } from "./ui/GameHudShell";
import { GameControlsHelp, type GameControlRow } from "./ui/GameControlsHelp";
import { GameSessionPanel } from "./ui/GameSessionPanel";
import { GameSoundPanel } from "./ui/GameSoundPanel";
import { TelemetryChip } from "./ui/TelemetryChip";
import type { GameSoundCapabilities } from "./ui/GameSoundPanel";
import type { RuntimeDiagnosticSnapshot } from "./runtime/RuntimeDiagnostics";
import type { PreparationProgress } from "./runtime/Preparation";
import type { RoadValidationReport } from "./roadValidation";
import type { DrivingEvent } from "./runtime/DrivingEventLog";
import type { CheckpointRaceSnapshotV1 } from "./activity/checkpointRace";
import "./game.css";

export type DrivingHudModel = Readonly<{
  active: boolean;
  choosingVehicle?: boolean; vtol?: boolean;
  activityKind?: "race" | "collect" | "creator" | null; activityTitle?: string | null;
  creatorGames?: readonly Readonly<{ releaseId: string; mountId: string; title: string }>[];
  race?: CheckpointRaceSnapshotV1 | null; raceEntryError?: string | null;
  entryError: string | null;
  initialPaused: boolean;
  preparationProgress: PreparationProgress | null;
  events: readonly DrivingEvent[];
  hud: Readonly<{
    phase: "idle" | "preparing" | "paused" | "running" | "error";
    reason: string | null; speed: number; blocked: boolean; coverage: string | null;
    gear: "D" | "R" | "B" | "N" | "FLY";
    altitude: number | null; boost: number | null;
  }>;
  diagnostics: RuntimeDiagnosticSnapshot | null;
  roadCheck?: RoadValidationReport | null;
}>;
export type DrivingHudActions = Readonly<{
  selectVehicle(vtol: boolean): void; startRace(): void; startCollect(): void; startCreatorGame(releaseId: string, mountId: string): void;
  clearEntryError(): void; exit(): void; pause(): void; resume(): void; openUiContext(): void;
}>;

const DRIVING_CONTROLS: readonly GameControlRow[] = [
  { keys: "W / ↑", description: "加速" }, { keys: "S / ↓", description: "刹车；停车后倒车" },
  { keys: "A / D / ← / →", description: "左右转向" }, { keys: "Esc", description: "暂停 / 继续" },
  { keys: "拖动 / 滚轮", description: "环绕汽车 / 拉近拉远（双击复位）" },
];

function spawnReadyText(report: RoadValidationReport | null | undefined, t: (text: string) => string, locale: GameLocale): string {
  const spawn = t("出生点已通过本地支撑与净空检查。");
  if (report?.verdict !== "failed" || !report.primary) return spawn;
  const detail = locale === "en" ? report.primary.text.en : report.primary.text.zh;
  return `${spawn} ${detail} ${t("已标在小地图上。")}`;
}
function roadCheckChip(report: RoadValidationReport | null | undefined, t: (text: string) => string) {
  if (!report) return null;
  if (report.verdict === "passed") return <div className="city-game-chip" aria-label={t("道路体检通过")}>{t("道路体检通过")}</div>;
  const label = `${t("道路体检未通过")} · ${report.blocked} ${t("处阻断")}`;
  const detail = report.primary ? `${report.primary.text.zh} / ${report.primary.text.en}` : label;
  return <div className="city-game-chip city-game-status" data-tone="warn" aria-label={label} title={detail}>{label}</div>;
}

export function DrivingHud({ model, actions, locale, sound }: {
  model: DrivingHudModel; actions: DrivingHudActions; locale: GameLocale; sound?: GameSoundCapabilities;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [soundOpen, setSoundOpen] = useState(false);
  const { hud } = model;
  const controls: readonly GameControlRow[] = [...DRIVING_CONTROLS, { keys: "Space", description: model.vtol ? "（飞行车模式）长按喷升起空 · 松开下坠；助推耗尽后落地行驶即回充" : "暂停 / 继续" }];
  const t = (text: string) => gameText(text, locale);
  const openUi = () => actions.openUiContext();
  if (model.choosingVehicle) return <GameSessionPanel locale={locale} title="选择驾驶模式"
    description={<>{t("普通汽车沿道路驾驶；喷气飞车可长按空格升空，松开后下降。")}{model.raceEntryError && <span role="alert"> {t(model.raceEntryError)}</span>}</>}
    onKeyDown={(event) => { if (event.code === "Escape") { event.preventDefault(); actions.exit(); } }}
    actions={[{ label: "普通汽车", onAction: () => actions.selectVehicle(false) },
      { label: "喷气飞车", onAction: () => actions.selectVehicle(true) }, { label: "检查点竞速", onAction: actions.startRace },
      { label: "区域寻宝", onAction: actions.startCollect },
      ...(model.creatorGames ?? []).map(game => ({ label: `创作者游戏 · ${game.title}`, onAction: () => actions.startCreatorGame(game.releaseId, game.mountId) })),
      { label: "取消", tone: "danger", onAction: actions.exit }]} />;
  const closeError = !model.active && model.entryError;
  if (!model.active && !closeError) return null;
  const entryDescription = model.entryError?.startsWith("暂不能开始驾驶：") && locale === "en"
    ? `${t("暂不能开始驾驶")} · ${model.entryError.slice("暂不能开始驾驶：".length)}`
    : t(model.entryError ?? "入口错误");
  const speedKmh = (Math.abs(hud.speed) * METERS_PER_UNIT * 3.6).toFixed(1);
  const gearLabel = hud.gear === "R" ? t("倒车") : hud.gear === "B" ? t("制动") : hud.gear === "D" ? t("前进") : hud.gear === "FLY" ? t("飞行") : t("静止");
  const vtolTelemetry = hud.boost !== null
    ? <><span aria-hidden="true">·</span><span>{t("高度")}</span><strong>{(hud.altitude ?? 0).toFixed(1)}</strong><small>m</small>
        <span aria-hidden="true">·</span><span>{t("助推")}</span><strong>{Math.round(hud.boost * 100)}</strong><small>%</small></>
    : null;
  const runtimeDiagnostics = model.diagnostics;
  const sceneError = hud.reason && ["stale-game-world", "stale-car-world", "world-invalidated", "world-revision-mismatch"].includes(hud.reason)
    ? "场景已更新，请重新进入" : hud.reason ?? "场景已更新，请重新进入";
  let panel = null;
  if (closeError) panel = <GameSessionPanel locale={locale} title="暂不能开始驾驶" description={entryDescription} role="alertdialog"
    actions={[{ label: "关闭", onAction: actions.clearEntryError }]} />;
  else if (hud.phase === "preparing") {
    const progress = model.preparationProgress;
    const stageLabels: Record<PreparationProgress["stage"], string> = {
      "world-capture": "读取城市场景", "world-read": "冻结道路与场景数据", "surface-index": "建立路面索引",
      "surface-regions": "分析道路连通区域", "static-solids": "整理建筑与障碍物", "collision-world": "准备碰撞世界", "diagnostic-spawn": "寻找安全出生点",
    };
    const detail = progress?.stage === "diagnostic-spawn" && progress.completedCandidates !== undefined
      ? `已检查 ${progress.completedCandidates} / ${progress.candidateLimit ?? 512} 个候选位置` : t("正在寻找支撑有效、前后通畅的道路位置");
    panel = <GameSessionPanel locale={locale} title={progress ? `${stageLabels[progress.stage]}…` : "正在准备驾驶场景…"}
      description={detail} children={<div className="city-preparation-track" role="progressbar" aria-label={t(progress ? stageLabels[progress.stage] : "正在准备驾驶场景")}><span /></div>}
      actions={[{ label: "取消准备", tone: "danger", onAction: actions.exit }]} />;
  }
  else if (hud.phase === "error") panel = <GameSessionPanel locale={locale} title="场景已失效" description={t(sceneError)} role="alertdialog"
    actions={[{ label: "退出驾驶", tone: "danger", onAction: actions.exit}]} />;
  else if (hud.phase === "paused") panel = <GameSessionPanel locale={locale}
    title={model.race?.status === "success" ? (model.activityKind === "collect" ? "寻宝完成" : model.activityKind === "creator" ? `${model.activityTitle ?? "小游戏"} · 完成` : "竞速完成") : model.race?.status === "failure" ? (model.activityKind === "creator" ? `${model.activityTitle ?? "小游戏"} · 未完成` : "时间到") : model.race?.status === "error" ? "小游戏运行出错" : hud.reason === "camera-safety" ? "相机安全检查已暂停驾驶" : hud.reason === "long-frame" ? "帧间隔过长，已暂停" : model.initialPaused ? (model.race ? (model.activityKind === "collect" ? "寻宝准备就绪" : model.activityKind === "creator" ? `${model.activityTitle ?? "小游戏"} · 准备就绪` : "竞速准备就绪") : "准备就绪") : "已暂停"}
    description={model.race?.status === "success" ? (locale === "en" ? `Completed ${model.race.completed}/${model.race.total} in ${model.race.elapsedSeconds}s` : `${model.race.completed} / ${model.race.total} 个目标 · ${model.race.elapsedSeconds} 秒`) : model.race?.status === "failure" ? (locale === "en" ? `Reached ${model.race.completed}/${model.race.total}` : `通过 ${model.race.completed} / ${model.race.total}`) : model.race?.status === "error" ? t(model.race.reason ?? "小游戏运行出错") : hud.reason === "camera-safety" ? t("相机安全检查无法确认，驾驶已暂停。") : model.initialPaused ? (model.race ? (model.activityKind === "collect" ? "驾驶穿过三个区域，收集全部目标即可完成。" : model.activityKind === "creator" ? "按游戏目标完成已发布小游戏。" : "沿路线通过三个检查点，时间限制为 45 秒。") : spawnReadyText(model.roadCheck, t, locale)) : hud.reason === "long-frame" ? t("帧间隔恢复后，可显式继续驾驶") : undefined}
    children={<><GameControlsHelp locale={locale} rows={controls} className="city-game-panel-help" />
      {sound && <GameSoundPanel locale={locale} sound={sound} />}</>}
    actions={model.race?.status === "success" || model.race?.status === "failure" || model.race?.status === "error"
      ? [{ label: model.activityKind === "creator" ? "退出游戏" : "退出竞速", tone: "danger", onAction: actions.exit }]
      : [{ label: model.race?.status === "ready" ? "开始竞速" : model.initialPaused ? "开始驾驶" : "继续", onAction: actions.resume }, { label: "退出驾驶", tone: "danger", onAction: actions.exit}]} />;

  const title = <>
    <div className="city-game-chip"><strong>{t(model.vtol ? "喷气飞车" : "自由驾驶")}</strong></div>
    {model.race && <div className="city-game-chip" role="status"><strong>{model.activityKind === "collect" ? "寻宝" : model.activityKind === "creator" ? model.activityTitle ?? "小游戏" : t("竞速")}</strong> · {model.race.completed}/{model.race.total} · {model.race.elapsedSeconds}s</div>}
    {roadCheckChip(model.roadCheck, t)}
    {hud.phase === "running" && <button className="city-game-compact-action" type="button" onClick={() => { openUi(); actions.pause(); }}>{t("暂停")}</button>}
  </>;
  const blocked = hud.blocked ? t("前方有障碍") : hud.reason === "long-frame" ? t("帧间隔过长，已自动暂停") : undefined;
  // Keep an opened disclosure mounted when opening it pauses the car. Otherwise
  // the native <details> vanishes with the running HUD while the modal is hidden.
  const help = hud.phase === "running" || helpOpen ? <GameControlsHelp locale={locale} rows={controls}
    onOpenChange={(open) => { setHelpOpen(open); if (open) openUi(); }} /> : undefined;
  const soundDisclosure = (hud.phase === "running" || soundOpen) && sound?.sfx ? <GameSoundPanel locale={locale} sound={sound}
    onOpenChange={(open) => { setSoundOpen(open); if (open) openUi(); }} /> : undefined;
  return <GameHudShell title={title}
    status={blocked ? <div className="city-game-chip city-game-status" data-tone="warn">{blocked}</div> : undefined}
    telemetry={<TelemetryChip label={t("当前速度")} value={`${speedKmh} km/h, ${gearLabel}`} className="city-game-car-telemetry">
      <><span>{t("速度")}</span><strong>{speedKmh}</strong><small>km/h</small><span aria-hidden="true">·</span><strong>{gearLabel}</strong>{vtolTelemetry}</>
    </TelemetryChip>}
    sound={soundDisclosure}
    help={help} panel={hud.phase === "paused" && (helpOpen || soundOpen) ? null : panel}
    diagnostic={<details className="city-game-chip city-game-diagnostics">
      <summary>{t("驾驶诊断")}</summary>
      {hud.coverage && <p><strong>{t("碰撞覆盖")}</strong> · {hud.coverage}</p>}
      {hud.reason && <p><strong>{t("内部原因")}</strong> · {hud.reason}</p>}
      {runtimeDiagnostics && <dl><dt>{t("样本")}</dt><dd>{runtimeDiagnostics.samples}</dd>
        <dt>{t("帧时 P95")}</dt><dd>{runtimeDiagnostics.frameMs.p95.toFixed(1)} ms</dd>
        <dt>{t("Tick CPU P95")}</dt><dd>{runtimeDiagnostics.tickCpuMs.p95.toFixed(1)} ms</dd>
        <dt>{t("Present CPU P95")}</dt><dd>{runtimeDiagnostics.presentCpuMs.p95.toFixed(1)} ms</dd>
        <dt>{t("最大补步")}</dt><dd>{runtimeDiagnostics.maxSteps}</dd>
        <dt>{t("长帧超限")}</dt><dd>{runtimeDiagnostics.limits["frame-gap"] + runtimeDiagnostics.limits["catch-up-budget"]}</dd>
        <dt>{t("相机贴身保持")}</dt><dd>{runtimeDiagnostics.camera.holds} · {t("相机收缩")} {runtimeDiagnostics.camera.shrinks}</dd>
      </dl>}
      {runtimeDiagnostics?.preparationMs && <dl aria-label={t("准备阶段耗时")}>
        {Object.entries(runtimeDiagnostics.preparationMs).map(([stage, duration]) => <div key={stage}><dt>{stage}</dt><dd>{duration?.toFixed(1)} ms</dd></div>)}
      </dl>}
      <details className="city-driving-local-audit" aria-label={t("本地故障记录")}>
        <summary>{t("本地故障记录")} · {model.events.length}</summary>
        <p>{t("仅保存在当前驾驶会话内存，不写入磁盘或上传。")}</p>
        {model.events.length === 0 ? <p>{t("暂无碰撞或运行故障。")}</p> : <ol>
          {[...model.events].reverse().map((event) => <li key={event.id}>
            <strong>{t(event.kind)}</strong> · {event.reason ?? t("未提供原因")}<br />
            <small>XYZ ({event.x.toFixed(1)}, {event.y.toFixed(1)}, {event.z.toFixed(1)})
              {event.obstacleIds.length ? ` · ${t("障碍物")} ${event.obstacleIds.join(", ")}` : ""}</small>
          </li>)}
        </ol>}
      </details>
    </details>}
  />;
}
