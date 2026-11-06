/** Opt-in development surface for the local v1.5 authority; not the release entry. */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { CityEngine } from "../engine/CityEngine";
import { CityMechaWorld, type CityMechaView } from "./CityMechaWorld";
import { gameText, type GameLocale } from "./gameCopy";
import { BOARD, eq, mech, moveBudget, occupant, pathDistance, type Action, type Cell, type MechId } from "./mecha/board";
import { legalActions } from "./mecha/combat";
import { cuesFromLog } from "./mecha/controller";
import { declaredEnemyIntents } from "./mecha/enemyIntentPresentation";
import { matchFromSite } from "./mecha/matchFromSite";
import { sequentialPresentation } from "./mecha/sequentialPresentation";
import { sequentialTargets } from "./mecha/sequentialTargets";
import { projectMechPositions } from "./mecha/presentation/mechPositions";
import { SequentialController, type CommandInput } from "./mecha/sequentialController";
import type { MatchState } from "./mecha/board";
import type { SequentialRecord } from "./mecha/sequentialTurn";
import type { DeployPlacement } from "./mecha/deployment";
import { createSequentialReplayBundle, statusDeploymentFromSite, type StatusMonsterId } from "./mecha/sequentialReplayBundle";
import { restoreSequentialReplayBundle } from "./mecha/sequentialReplayBundle";
import { checkpointBackend, checkpointStore, clearSequentialCheckpoint, writeSequentialCheckpoint, type CheckpointBackend } from "./mecha/sequentialCheckpoint";
import { deleteSequentialReplay, listSequentialReplays, loadSequentialReplay, saveSequentialReplay, type SequentialReplayEntry } from "./mecha/sequentialReplayRepository";
import type { CityMechaSite } from "./mecha/citySite";
import { unitMaxHp } from "./mecha/unitHealth";
import { statusBlocks } from "./mecha/statusEffects";
import { describeStatusBadges } from "./mecha/statusDisplay";
import { projectStatusForecastState, statusForecast } from "./mecha/statusForecast";
import "./sequentialMecha.css";

const NAMES: Record<MechId, string> = { Assault: "突击", Gunner: "射手", Support: "支援" };
const ACTIONS: Record<Action["kind"], string> = { melee: "近战", charge: "突击", shoot: "射击", pierce: "穿甲", repair: "维修", skip: "待机" };
const STATUS_SPECIES: Record<StatusMonsterId, [string, string]> = { spore_leaper: ["孢群体", "Spore leaper"], flux_lancer: ["流环体", "Flux lancer"], prism_warden: ["晶簇体", "Prism warden"], gravity_core: ["引力核", "Gravity core"] };
const cellKey = (cell: Cell) => `${cell.x},${cell.y}`;

export function SequentialMechaMatch({ engine, site, locale, onClose, requestCloseRef, statusSpecies }: { engine: CityEngine; site: CityMechaSite; locale: GameLocale; onClose: () => void; requestCloseRef: React.RefObject<(() => void) | null>; statusSpecies?: StatusMonsterId | null }) {
  const t = (zh: string, en: string) => locale === "en" ? en : zh;
  const [controller] = useState(() => new SequentialController(statusSpecies ? statusDeploymentFromSite(site, statusSpecies) : matchFromSite(site, { ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "siege", deployment: true })));
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [choice, setChoice] = useState("");
  const [actionIndex, setActionIndex] = useState("");
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveMessage, setArchiveMessage] = useState<string | null>(null);
  const [archiveEntries, setArchiveEntries] = useState<SequentialReplayEntry[]>([]);
  const [archiveChoice, setArchiveChoice] = useState("");
  const [replay, setReplay] = useState<{ initial: MatchState; placements: DeployPlacement[]; records: SequentialRecord[]; index: number } | null>(null);
  const [replayAnimation, setReplayAnimation] = useState<{ before: MatchState; after: MatchState; record: SequentialRecord } | null>(null);
  const [reduceMotion, setReduceMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduceMotion(media.matches);
    media.addEventListener("change", update); return () => media.removeEventListener("change", update);
  }, []);
  const [recovery, setRecovery] = useState<{ backend: CheckpointBackend; version: number; pending: boolean; restored: Awaited<ReturnType<typeof restoreSequentialReplayBundle>> | null } | null>(null);
  const [recoveryError, setRecoveryError] = useState(false);
  const requestClose = () => { if (!archiveBusy && state.persistence !== "saving" && window.confirm(t("退出当前测试对局？", "Exit the current test match?"))) onClose(); };
  useEffect(() => { requestCloseRef.current = requestClose; return () => { requestCloseRef.current = null; }; }, [requestCloseRef, onClose, locale, archiveBusy, state.persistence]);
  useEffect(() => {
    let active = true;
    void listSequentialReplays().then(entries => { if (active) setArchiveEntries(entries); }).catch(() => { if (active) setArchiveMessage(t("本地回放列表不可用。", "Local replay list is unavailable.")); });
    return () => { active = false; };
  }, []);
  const readRecovery = async () => {
    setRecoveryError(false); setRecovery(null);
    try {
      const backend = await checkpointBackend(), checkpoint = await backend.read();
      let restored: Awaited<ReturnType<typeof restoreSequentialReplayBundle>> | null = null;
      if (checkpoint.raw) {
        try { restored = await restoreSequentialReplayBundle(site, JSON.parse(checkpoint.raw).archive); } catch { /* Keep the incompatible checkpoint until explicitly discarded. */ }
      }
      setRecovery({ backend, version: checkpoint.revision, pending: checkpoint.raw !== null, restored });
    } catch { setRecoveryError(true); }
  };
  useEffect(() => { void readRecovery(); }, []);
  const presentation = state.presentation;
  const display = replayAnimation?.before ?? (replay ? replay.index === 0 ? replay.initial : replay.records[replay.index - 1]!.snapshot.match : presentation?.before ?? state.match);
  const selected = mech(state.match, state.selected);
  const restrictions = (id: MechId) => state.match.statusEncounter ? statusBlocks(state.match.statusEncounter.statuses, id) ?? { move: true, action: true } : { move: false, action: false };
  const canAct = (id: MechId) => Boolean(state.rights?.[id].action && !restrictions(id).action);
  const locked = Boolean(presentation || state.match.outcome || viewError || archiveBusy || replay || !recovery || recovery.pending || recoveryError || state.persistence === "saving" || state.persistence === "unconfirmed");
  const movement = useMemo(() => {
    if (!selected || !state.rights?.[state.selected].move || restrictions(state.selected).move || locked) return [];
    const cells: Cell[] = [];
    for (let y = 0; y < BOARD; y++) for (let x = 0; x < BOARD; x++) {
      const cell = { x, y };
      if (eq(selected.pos, cell) || occupant(state.match, cell) !== "empty") continue;
      const distance = pathDistance(state.match, selected.pos, cell, selected.id, { alliesPass: true });
      if (distance !== null && distance <= moveBudget(selected.id)) cells.push(cell);
    }
    return cells;
  }, [state, selected, locked]);
  const available = replay ? [] : state.placements ? state.deployable : movement;
  const actions = !locked && !state.placements && canAct(state.selected) ? legalActions(state.match, state.selected) : [];
  const action = actionIndex === "" ? null : actions[Number(actionIndex)] ?? null;
  const targetOptions = action ? sequentialTargets(state.match, actions, action.kind, state.selected) : [];
  const selectedTarget = targetOptions.find(option => option.actionIndex === Number(actionIndex));
  const preview = action ? controller.preview({ kind: "act", mech: state.selected, action }) : null;
  const previewEvidence = preview?.ok ? sequentialPresentation(state.match, preview.snapshot.match, preview.events, preview.presentationStages) : null;
  const currentPresentation = replayAnimation ? { before: replayAnimation.before, after: replayAnimation.after, events: replayAnimation.record.events, stages: replayAnimation.record.presentationStages }
    : presentation ? { before: presentation.before, after: state.match, events: presentation.events, stages: presentation.stages } : null;
  const verified = useMemo(() => currentPresentation ? sequentialPresentation(currentPresentation.before, currentPresentation.after, currentPresentation.events, currentPresentation.stages) : null, [presentation, state.match, replayAnimation]);
  const performance = useMemo(() => !reduceMotion && verified?.ok && verified.events.length ? { events: verified.events } : null, [verified, reduceMotion]);
  const finishPresentation = () => { if (replayAnimation) setReplayAnimation(null); else controller.finishPresentation(); };
  useEffect(() => {
    // Empty, fully verified presentations have no player to acknowledge them.
    if (currentPresentation && verified?.ok && !performance) finishPresentation();
  }, [controller, presentation, replayAnimation, verified, performance]);
  const showForecast = !currentPresentation && !(!replay && state.placements) && !display.outcome;
  const forecastState = useMemo(() => showForecast && display.statusEncounter ? projectStatusForecastState(display) : display, [display, showForecast]);
  const intents = showForecast && forecastState ? declaredEnemyIntents(forecastState) : [];
  const forecast = showForecast && forecastState ? statusForecast(forecastState) : null;
  const threats = intents.flatMap(intent => intent.targets);
  const view: CityMechaView = {
    figures: projectMechPositions(display, replay ? null : state.placements).map(unit => ({ id: unit.id, x: unit.pos.x, y: unit.pos.y, alive: unit.hp > 0, hp: unit.hp, maxHp: unitMaxHp(unit.id, display) ?? undefined, selected: !replay && unit.id === state.selected })),
    statuses: display.statusEncounter?.statuses.map(({ target, source, kind, remainingTurns }) => ({ target, source, kind, remainingTurns })),
    boss: { x: display.boss.anchor.x, y: display.boss.anchor.y, alive: display.boss.hp > 0, hp: display.boss.hp, maxHp: unitMaxHp("boss", display) ?? undefined },
    bossSpeciesId: display.monsterContent?.speciesId,
    raiders: display.raiders.map(unit => ({ id: unit.id, x: unit.pos.x, y: unit.pos.y, alive: unit.hp > 0, hp: unit.hp, maxHp: unitMaxHp(unit.id, display) ?? undefined })),
    buildings: display.buildings.map(building => ({ id: building.id, cells: building.cells, hp: building.hp, maxHp: building.maxHp })),
    declaredTelegraph: threats, declaredIntents: intents, projectedTelegraph: null, telegraph: threats, focusedTelegraph: [],
    deployment: !replay && Boolean(state.placements), focus: [], reach: available, move: null,
    targets: !locked ? targetOptions.flatMap(option => option.cells) : [], targetIds: !locked ? targetOptions.map(option => option.id) : [],
    targetPreview: !locked && selectedTarget?.cells[0] ? { target: selectedTarget.cells[0] } : undefined, obstacles: display.obstacles,
    missionTarget: display.mission?.target ?? null,
    combat: currentPresentation && verified?.ok ? { id: currentPresentation.after.revision, actions: cuesFromLog(currentPresentation.events), healthTimeline: verified.health, presentationChanges: verified.changes } : undefined,
  };
  const performCell = (cell: Cell) => {
    if (locked) return;
    const clickedTarget = targetOptions.find(option => option.cells.some(position => eq(position, cell)));
    if (clickedTarget) { setActionIndex(String(clickedTarget.actionIndex)); return; }
    if (!state.placements) {
      const clickedMech = state.match.mechs.find(unit => unit.hp > 0 && eq(unit.pos, cell));
      if (clickedMech) { controller.select(clickedMech.id); setChoice(""); setActionIndex(""); setConfirmEnd(false); return; }
    }
    if (!available.some(item => eq(item, cell))) return;
    if (state.placements) controller.place(state.selected, cell);
    else void controller.executeDurable({ kind: "move", mech: state.selected, to: cell });
    setChoice(""); setActionIndex(""); setConfirmEnd(false);
  };
  const select = (id: MechId) => { controller.select(id); setChoice(""); setActionIndex(""); setConfirmEnd(false); };
  const target = (entry: Action) => "target" in entry && entry.target ? entry.target === "boss" ? t("大怪", "Boss") : entry.target in NAMES ? gameText(NAMES[entry.target as MechId], locale) : entry.target : "";
  const replayLabel = (record: SequentialRecord) => record.causalEvent?.kind === "undo_move" ? t("撤销移动", "Undo move")
    : record.causalEvent?.kind === "reset_turn" ? t("重置回合", "Reset turn")
    : record.command.kind === "move" ? t("移动", "Move") : record.command.kind === "act" ? t("行动", "Action") : t("结束回合", "End turn");
  const issue = (command: CommandInput) => { void controller.executeDurable(command); };
  const deploy = async () => {
    if (!recovery || recovery.pending || locked || !state.canConfirmDeployment) return;
    setArchiveBusy(true);
    try {
      controller.confirmDeployment();
      const evidence = controller.replayEvidence();
      if (!evidence) throw new Error("deployment_unavailable");
      const version = await writeSequentialCheckpoint(site, evidence, recovery.backend, recovery.version);
      if (!controller.attachDurable(checkpointStore(site, evidence, recovery.backend, version, evidence.initial.revision))) throw new Error("durability_unavailable");
      setRecovery({ ...recovery, version });
    } catch { setRecoveryError(true); setArchiveMessage(t("无法确认检查点；请重新读取恢复。", "Checkpoint could not be confirmed; reload recovery.")); }
    finally { setArchiveBusy(false); }
  };
  const recover = () => {
    if (!recovery?.restored || recovery.restored.session.snapshot().match.outcome) return;
    const evidence = { ...recovery.restored, records: recovery.restored.session.records() };
    if (!controller.canRestore(evidence)) { setArchiveMessage(t("检查点属于其他遭遇，请切换回对应测试入口。", "This checkpoint belongs to a different encounter; reopen its test entry.")); return; }
    if (!controller.restore(evidence) || !controller.attachDurable(checkpointStore(site, evidence, recovery.backend, recovery.version, evidence.session.snapshot().match.revision))) {
      setRecoveryError(true); return;
    }
    setRecovery({ ...recovery, pending: false }); setRecoveryError(false);
    setArchiveMessage(t("已恢复自动检查点。", "Automatic checkpoint restored."));
  };
  const discardRecovery = async () => {
    if (!recovery || !window.confirm(t("删除自动检查点并开始新对局？", "Delete the automatic checkpoint and start a new match?"))) return;
    setArchiveBusy(true);
    try { const version = await clearSequentialCheckpoint(recovery.backend, recovery.version); if (!controller.restartDeployment()) throw new Error("restart_unavailable"); setRecovery({ ...recovery, version, pending: false, restored: null }); setRecoveryError(false); setReplay(null); }
    catch { setRecoveryError(true); }
    finally { setArchiveBusy(false); }
  };
  const save = async () => {
    const evidence = controller.replayEvidence();
    if (!evidence || !evidence.records.length || presentation || replay || archiveBusy || state.persistence !== "ready") return;
    setArchiveBusy(true); setArchiveMessage(null);
    try {
      const bundle = await createSequentialReplayBundle(site, evidence);
      const key = await saveSequentialReplay(site, bundle);
      setArchiveEntries(await listSequentialReplays()); setArchiveChoice(key);
      setArchiveMessage(t("回放已保存并核对。", "Replay saved and verified."));
    } catch { setArchiveMessage(t("保存失败；本局仍在，请重试。", "Save failed; the match remains available.")); }
    finally { setArchiveBusy(false); }
  };
  const load = async () => {
    if (!archiveChoice || presentation || archiveBusy || state.persistence === "saving" || state.persistence === "unconfirmed") return;
    setArchiveBusy(true); setArchiveMessage(null);
    try {
      const restored = await loadSequentialReplay(site, archiveChoice);
      setReplay({ initial: restored.initial, placements: restored.placements, records: restored.session.records(), index: 0 });
      setActionIndex(""); setChoice(""); setConfirmEnd(false);
    } catch { setArchiveMessage(t("回放损坏或与当前战场不兼容。", "Replay is damaged or incompatible with this battlefield.")); }
    finally { setArchiveBusy(false); }
  };
  const remove = async () => {
    if (!archiveChoice || archiveBusy || !window.confirm(t("删除选中的本地回放？", "Delete the selected local replay?"))) return;
    setArchiveBusy(true); setArchiveMessage(null);
    try { await deleteSequentialReplay(archiveChoice); setArchiveEntries(await listSequentialReplays()); setArchiveChoice(""); setArchiveMessage(t("回放已删除。", "Replay deleted.")); }
    catch { setArchiveMessage(t("删除失败，请重试。", "Delete failed. Please try again.")); }
    finally { setArchiveBusy(false); }
  };
  const resumeSaved = async () => {
    if (!replay || !recovery || replayAnimation || archiveBusy || state.persistence === "saving" || recovery.pending || recoveryError) return;
    const evidence = { initial: replay.initial, placements: replay.placements, records: replay.records };
    if (!controller.canRestore(evidence)) { setArchiveMessage(t("该回放属于其他遭遇，请切换回对应测试入口。", "This replay belongs to a different encounter; reopen its test entry.")); return; }
    if (!window.confirm(t("继续此回放将替换当前测试对局，是否继续？", "Continue this replay and replace the current test match?"))) return;
    setArchiveBusy(true);
    try {
      const current = await recovery.backend.read();
      const version = await writeSequentialCheckpoint(site, evidence, recovery.backend, current.revision);
      if (!controller.restore(evidence) || !controller.attachDurable(checkpointStore(site, evidence, recovery.backend, version, evidence.records.at(-1)?.revision ?? evidence.initial.revision))) throw new Error("resume_unavailable");
      setRecovery({ ...recovery, version, pending: false, restored: null });
      setReplay(null); setArchiveMessage(t("已恢复对局，可以继续行动。", "Match restored. You can continue playing."));
    } catch { setRecoveryError(true); setArchiveMessage(t("无法确认恢复，请重新读取自动检查点。", "Resume could not be confirmed; reload the automatic checkpoint.")); }
    finally { setArchiveBusy(false); }
  };
  return <section className="mecha-overlay is-city mecha-v15-test" role="dialog" aria-label={t("机甲战棋 1.5 测试", "Mecha tactics 1.5 test")} data-mecha-v15>
    <CityMechaWorld engine={engine} site={site} locale={locale} view={view} performance={performance} paused={false} onPerformanceComplete={finishPresentation} onCell={(x, y) => performCell({ x, y })} onUnavailable={reason => setViewError(reason ?? "mode")} />
    <header className="mecha-v15-bar"><strong>{t("机甲战棋 1.5 · 开发测试", "Mecha tactics 1.5 · development test")}</strong><button type="button" disabled={archiveBusy || state.persistence === "saving"} onClick={requestClose}>{t("退出", "Exit")}</button></header>
    <aside className="mecha-v15-panel" aria-label={t("逐台行动", "Sequential actions")}>
      <p className="mecha-v15-note">{t("仅供本地测试；远程与挑战码暂不可用。", "Local test only; remote play and challenge codes are unavailable.")}</p>
      {statusSpecies && <p className="mecha-v15-note">{t("状态效果怪物测试", "Status encounter test")}: {t(...STATUS_SPECIES[statusSpecies])}</p>}
      {showForecast && display.statusEncounter && !forecastState && <p role="status">{t("敌方预告暂不可用。", "Enemy forecast is unavailable.")}</p>}
      {forecast && <section className="mecha-v15-note" aria-label={t("敌方状态预告", "Enemy status forecast")}>
        <strong>{t("敌方状态预告", "Enemy status forecast")}</strong>
        <p>{forecast.skill === "spore_leap" ? t("孢子弹跳：存活的命中机甲中毒 2 回合，每回合结束受到 1 点伤害。", "Spore leap: surviving mechs hit are poisoned for 2 turns, taking 1 damage at each turn end.") :
          forecast.skill === "ring_pierce" ? t("环轨穿刺：存活的命中机甲燃烧 2 回合，每回合结束受到 1 点伤害。", "Ring pierce: surviving mechs hit burn for 2 turns, taking 1 damage at each turn end.") :
          forecast.skill === "prism_frost" ? t("棱晶寒束：命中射线上首个机甲；若其存活则冻结 1 回合，不能主动移动。", "Prism frost: hits the first mech on the ray; if it survives, it is frozen for 1 turn and cannot move voluntarily.") :
          t("引力井：牵引撞上单位、建筑或障碍的机甲眩晕 1 回合，不能主动移动或行动。", "Gravity well: a mech pulled into a unit, building or obstacle is stunned for 1 turn and cannot move or act voluntarily.")}</p>
        <p>{t("当前预告格", "Forecast cells")}: {forecast.cells.length ? forecast.cells.map(cellKey).join(" · ") : t("无", "None")}</p>
        {forecast.skill === "gravity_well" && (forecast.pulls === null ? <p>{t("牵引结果未知。", "Pull outcome unknown.")}</p> : forecast.pulls.map(pull => <p key={pull.mech}>{gameText(NAMES[pull.mech], locale)}: {cellKey(pull.from)} → {pull.to ? cellKey(pull.to) : pull.collision ? `${t("可能撞击", "Possible collision")} ${cellKey(pull.collision)}` : t("无可证实的位移或撞击", "No confirmed movement or collision")}</p>))}
        <p>{t("这是当前棋盘的预测，移动、击杀或阻挡可能改变结果；实际命中后才施加状态。", "This forecasts the current board. Movement, defeat or obstruction may change the outcome; statuses apply only on a confirmed hit.")}</p>
      </section>}
      {!recovery && !recoveryError && <p role="status">{t("正在读取自动检查点…", "Reading automatic checkpoint…")}</p>}
      {state.persistence === "saving" && <p role="status">{t("正在保存行动…", "Saving action…")}</p>}
      {(recoveryError || state.persistence === "unconfirmed") && <div role="alert"><p>{t("自动检查点状态未确认，行动已锁定。", "Checkpoint status is unconfirmed; actions are locked.")}</p><button type="button" disabled={archiveBusy} onClick={() => { setReplay(null); void readRecovery(); }}>{t("重新读取恢复", "Reload recovery")}</button></div>}
      {recovery?.pending && !recoveryError && !replay && <div className="mecha-v15-confirm"><p>{recovery.restored ? recovery.restored.session.snapshot().match.outcome ? t("自动检查点已结束，可以查看结果。", "The automatic checkpoint is finished; you can review it.") : t("发现未完成的自动检查点。", "An unfinished automatic checkpoint was found.") : t("自动检查点损坏或与当前战场不兼容。", "The checkpoint is damaged or incompatible with this battlefield.")}</p><div className="mecha-v15-row">{recovery.restored?.session.snapshot().match.outcome ? <button type="button" disabled={archiveBusy} onClick={() => {
        const restored = recovery.restored!; const records = restored.session.records();
        setReplay({ initial: restored.initial, placements: restored.placements, records, index: records.length });
      }}>{t("查看已结束对局", "Review finished match")}</button> : <button type="button" disabled={archiveBusy || !recovery.restored} onClick={recover}>{t("恢复对局", "Recover match")}</button>}<button type="button" disabled={archiveBusy} onClick={() => void discardRecovery()}>{t("删除并新开", "Discard and start")}</button></div></div>}
      <p role="status" aria-live="polite">{replay ? `${t("回放步骤", "Replay step")} ${replay.index}/${replay.records.length}` : state.match.outcome ? `${t("战斗结束", "Battle ended")}: ${state.match.outcome}` : state.placements ? t("部署阶段：选择机甲和绿色格子。", "Deployment: select a mech and a green cell.") : `${t("回合", "Turn")} ${display.turn}${presentation ? t(" · 正在结算", " · resolving") : ""}`}</p>
      {viewError ? <p role="alert">{t("三维战场不可用，请退出后重试。", "The 3D battlefield is unavailable. Exit and try again.")}</p> : null}
      {state.error ? <p role="alert">{t("操作未执行", "Command rejected")}: {state.error}</p> : null}
      {currentPresentation && !verified?.ok ? <div role="alert"><p>{t("演出证据不足；可跳过演出并查看权威结果。", "Animation evidence is incomplete; skip to the authoritative result.")}</p><button type="button" onClick={finishPresentation}>{t("查看结果", "Show result")}</button></div> : null}
      {presentation && verified?.ok && performance && <button type="button" onClick={finishPresentation}>{t("跳过演出", "Skip animation")}</button>}
      <div className="mecha-v15-roster" role="group" aria-label={t("选择机甲", "Select mech")}>
        {(replay ? display.mechs : state.match.mechs).map(unit => { const status = describeStatusBadges(display.statusEncounter?.statuses ?? [], unit.id, locale); return <button type="button" key={unit.id} disabled={locked || unit.hp <= 0} aria-pressed={!replay && unit.id === state.selected} onClick={() => select(unit.id)}><strong>{gameText(NAMES[unit.id], locale)}</strong><span>HP {unit.hp}/{unitMaxHp(unit.id, display)}</span><span>{replay ? t("回放", "Replay") : state.placements ? (state.placements.some(p => p.mechId === unit.id) ? t("已部署", "Deployed") : t("未部署", "Not deployed")) : `${t("移动", "Move")} ${state.rights?.[unit.id].move && !restrictions(unit.id).move ? "✓" : "—"} · ${t("行动", "Act")} ${canAct(unit.id) ? "✓" : "—"}`}</span>{status.accessible && <span>{status.accessible}</span>}</button>; })}
      </div>
      {display.statusEncounter?.statuses.some(status => status.target === state.selected) && <div className="mecha-v15-note" aria-live="polite"><strong>{t("当前状态", "Current statuses")}</strong><ul>{display.statusEncounter.statuses.filter(status => status.target === state.selected).map(status => {
        const name = locale === "en" ? { poison: "Poison", burn: "Burn", freeze: "Freeze", stun: "Stun" }[status.kind] : { poison: "中毒", burn: "燃烧", freeze: "冻结", stun: "眩晕" }[status.kind];
        const effect = status.kind === "poison" || status.kind === "burn" ? `${t("回合结束伤害", "End-of-turn damage")} ${status.magnitude}` : status.kind === "freeze" ? t("不能主动移动", "Cannot move voluntarily") : t("不能主动移动或行动", "Cannot move or act voluntarily");
        return <li key={`${status.target}:${status.kind}:${status.source}`}>{name} · {effect} · {t("剩余回合", "Turns remaining")} {status.remainingTurns} · {t("来源", "Source")}: {status.source === "boss" ? t("大怪", "Boss") : t("敌人", "Enemy")}</li>;
      })}</ul></div>}
      {replay && <div className="mecha-v15-confirm"><p>{t("逐步播放已验证的行动；重置直接显示恢复后的棋盘。", "Step through verified actions; reset shows the restored board immediately.")}</p><p>{replay.index ? replayLabel(replay.records[replay.index - 1]!) : t("部署完成", "Deployment complete")}</p><div className="mecha-v15-row"><button type="button" disabled={Boolean(replayAnimation) || replay.index === 0} onClick={() => setReplay({ ...replay, index: replay.index - 1 })}>{t("上一步", "Previous")}</button><button type="button" disabled={Boolean(replayAnimation) || replay.index === replay.records.length} onClick={() => {
        const record = replay.records[replay.index]!;
        const before = replay.index === 0 ? replay.initial : replay.records[replay.index - 1]!.snapshot.match;
        setReplay({ ...replay, index: replay.index + 1 });
        if (record.events.length) setReplayAnimation({ before, after: record.snapshot.match, record });
      }}>{t("下一步", "Next")}</button><button type="button" onClick={() => { setReplayAnimation(null); setReplay(null); }}>{t("返回对局", "Return to match")}</button></div>{replayAnimation && verified?.ok && performance && <button type="button" onClick={finishPresentation}>{t("跳过演出", "Skip animation")}</button>}
        {replay.index === replay.records.length && !display.outcome && <button type="button" disabled={Boolean(replayAnimation) || archiveBusy || recoveryError || !recovery || recovery.pending} onClick={() => void resumeSaved()}>{t("继续此对局", "Resume this match")}</button>}
      </div>}
      {!replay && !state.match.outcome && <>
        <label htmlFor="v15-cell">{state.placements ? t("部署坐标", "Deployment cell") : t("移动坐标", "Move to")}</label>
        <div className="mecha-v15-row"><select id="v15-cell" value={choice} disabled={locked || !available.length} onChange={event => setChoice(event.currentTarget.value)}><option value="">{t("选择格子", "Select cell")}</option>{available.map(cell => <option key={cellKey(cell)} value={cellKey(cell)}>{cell.x}, {cell.y}</option>)}</select><button type="button" disabled={locked || !available.some(cell => cellKey(cell) === choice)} onClick={() => { const cell = available.find(item => cellKey(item) === choice); if (cell) performCell(cell); }}>{state.placements ? t("放置", "Place") : t("移动", "Move")}</button></div>
        {state.placements ? <div className="mecha-v15-row"><button type="button" disabled={locked} onClick={() => controller.undoPlacement()}>{t("撤销放置", "Undo placement")}</button><button type="button" disabled={locked || !state.canConfirmDeployment} onClick={() => void deploy()}>{t("确认部署", "Confirm deployment")}</button></div> : <>
          {(restrictions(state.selected).move || restrictions(state.selected).action) && <p className="mecha-v15-note" role="status">{restrictions(state.selected).action ? t("眩晕：不能主动移动或行动。", "Stunned: cannot move or act voluntarily.") : t("冻结：不能主动移动，仍可行动。", "Frozen: cannot move voluntarily, but can act.")}</p>}
          <label htmlFor="v15-action">{t("行动与目标", "Action and target")}</label><select id="v15-action" value={actionIndex} disabled={locked || !actions.length} onChange={event => setActionIndex(event.currentTarget.value)}><option value="">{t("选择行动", "Select action")}</option>{actions.map((entry, index) => {
            const option = sequentialTargets(state.match, actions, entry.kind, state.selected).find(item => item.actionIndex === index);
            const label = target(entry) || (option?.id === "boss" ? t("大怪", "Boss") : option?.id ? t("小怪", "Enemy") : "");
            return <option key={`${entry.kind}-${label}-${index}`} value={index}>{gameText(ACTIONS[entry.kind], locale)} {label}</option>;
          })}</select>
          {targetOptions.length > 0 && <p className="mecha-v15-note">{t("点击高亮目标切换预览，再确认行动。", "Click a highlighted target to preview it, then confirm the action.")}</p>}
          {action && <div className="mecha-v15-note" aria-live="polite"><strong>{t("行动预览", "Action preview")}</strong>{previewEvidence?.ok ? previewEvidence.health.steps.length ? <ul>{previewEvidence.health.steps.map((step, index) => {
            const effect = step.effect;
            const label = effect.kind === "boss" ? t("大怪", "Boss") : effect.kind === "building" ? `${t("建筑", "Building")} ${state.match.buildings.findIndex(building => building.id === effect.id) + 1}` : effect.id in NAMES ? gameText(NAMES[effect.id as MechId], locale) : t("小怪", "Enemy");
            return <li key={index}>{label}: {effect.before} → {effect.after}</li>;
          })}</ul> : <p>{t("生命值无变化。", "No health change.")}</p> : <p>{t("预览证据不足，无法显示伤害。", "Preview evidence is incomplete; damage is unavailable.")}</p>}
            {previewEvidence?.ok && preview?.ok && preview.events.filter(event => event.type === "shove").map((event, index) => event.type === "shove" ? <p key={index}>{event.unit === "boss" ? t("大怪", "Boss") : gameText(NAMES[event.unit], locale)} · {event.hit ? t("位移受阻", "Push blocked") : t("受到推移", "Pushed")}</p> : null)}
          </div>}
          <div className="mecha-v15-row"><button type="button" disabled={locked || !action || !preview?.ok} onClick={() => { if (action) issue({ kind: "act", mech: state.selected, action }); setActionIndex(""); setConfirmEnd(false); }}>{t("确认行动", "Confirm action")}</button><button type="button" disabled={locked || !state.canUndo} onClick={() => { issue({ kind: "undo" }); setActionIndex(""); setChoice(""); setConfirmEnd(false); }}>{t("撤销移动", "Undo move")}</button></div>
          <div className="mecha-v15-row"><button type="button" disabled={locked || state.resetUsed} onClick={() => { if (window.confirm(t("重置本回合？每局只能使用一次。", "Reset this turn? This can be used once per match."))) { issue({ kind: "reset" }); setActionIndex(""); setChoice(""); setConfirmEnd(false); } }}>{t("重置回合", "Reset turn")} ({state.resetUsed ? 0 : 1}/1)</button><button type="button" disabled={locked} onClick={() => { if (state.match.mechs.some(unit => unit.hp > 0 && canAct(unit.id))) setConfirmEnd(true); else { issue({ kind: "end", confirmUnused: false }); setActionIndex(""); setChoice(""); } }}>{t("结束回合", "End turn")}</button></div>
          {confirmEnd && <div role="alert" className="mecha-v15-confirm"><p>{t("仍可行动", "Still able to act")}: {state.match.mechs.filter(unit => unit.hp > 0 && canAct(unit.id)).map(unit => gameText(NAMES[unit.id], locale)).join("、")}。 {t("结束回合将放弃这些机会。", "Ending the turn forfeits those actions.")}</p><div className="mecha-v15-row"><button type="button" onClick={() => { issue({ kind: "end", confirmUnused: true }); setActionIndex(""); setChoice(""); setConfirmEnd(false); }}>{t("确认结束", "End turn")}</button><button type="button" onClick={() => setConfirmEnd(false)}>{t("继续行动", "Continue")}</button></div></div>}
        </>}
      </>}
      {!replay && <details className="mecha-v15-replays"><summary>{t("本地回放", "Local replays")}</summary>
        <p className="mecha-v15-note">{t("仅能在相同城市战场重建；保存后会重新校验。", "Rebuilds only on the same city battlefield; saves are rechecked.")}</p>
        <button type="button" disabled={archiveBusy || Boolean(presentation) || state.persistence !== "ready" || !controller.hasReplayEvidence()} onClick={() => void save()}>{t("保存当前回放", "Save current replay")}</button>
        <label htmlFor="v15-replay-choice">{t("选择回放", "Select replay")}</label><select id="v15-replay-choice" value={archiveChoice} disabled={archiveBusy || !archiveEntries.length} onChange={event => setArchiveChoice(event.currentTarget.value)}><option value="">{t("选择回放", "Select replay")}</option>{archiveEntries.map(entry => <option key={entry.key} value={entry.key}>{entry.damaged ? t("损坏的记录", "Damaged record") : entry.savedAt}</option>)}</select>
        <div className="mecha-v15-row"><button type="button" disabled={archiveBusy || Boolean(presentation) || state.persistence === "saving" || state.persistence === "unconfirmed" || !archiveChoice || archiveEntries.find(entry => entry.key === archiveChoice)?.damaged} onClick={() => void load()}>{t("查看回放", "View replay")}</button><button type="button" disabled={archiveBusy || !archiveChoice} onClick={() => void remove()}>{t("删除回放", "Delete replay")}</button></div>
      </details>}
      {archiveMessage && <p role="status">{archiveMessage}</p>}
    </aside>
  </section>;
}
