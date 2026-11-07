/** Local PvE v1.5 match surface. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CityEngine } from "../engine/CityEngine";
import { CityMechaWorld, type CityMechaView, type CityMechaWorldHandle } from "./CityMechaWorld";
import { MechaHudLayout } from "./MechaHudLayout";
import { MechaDeploymentActionsView, MechaDeploymentView } from "./MechaDeploymentPanel";
import { MechaBattlefieldControls, MechaBattleMenu, MechaObjectiveCard, MechaObjectivePanel, MechaObjectiveToggle, MechaSettingsPopover, MechaTargetOptions, MechaTeamPanel, MechaTeamTurnControls, MechaThreatSourceList, MechaTurnOrder } from "./MechaHudPanels";
import { MechaQuickGuide } from "./MechaQuickGuide";
import { MechaBattleLegend } from "./MechaBattleLegend";
import { useMechaSettings } from "./useMechaSettings";
import { SequentialMechaCommandPanel, type SequentialHudAction, type SequentialRosterRow } from "./SequentialMechaHud";
import { MechaRoster } from "./MechaPlanCard";
import { MechaActionIcon } from "./MechaActionIcon";
import { MechaUnitAvatar, MechaUnitPortrait } from "./MechaUnitAvatar";
import { gameText, type GameLocale } from "./gameCopy";
import { BOARD, MAX_TURNS, STATS, eq, mech, moveBudget, occupant, pathDistance, stakeBuildings, type Action, type Cell, type MechId } from "./mecha/board";
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
import { planActionLabel } from "./mecha/planPresentation";
import "./sequentialMecha.css";

const NAMES: Record<MechId, string> = { Assault: "突击", Gunner: "射手", Support: "支援" };
const STATUS_SPECIES: Record<StatusMonsterId, [string, string]> = { spore_leaper: ["孢群体", "Spore leaper"], flux_lancer: ["流环体", "Flux lancer"], prism_warden: ["晶簇体", "Prism warden"], gravity_core: ["引力核", "Gravity core"] };
const cellKey = (cell: Cell) => `${cell.x},${cell.y}`;

export function SequentialMechaMatch({ engine, site, locale, onClose, requestCloseRef, statusSpecies }: { engine: CityEngine; site: CityMechaSite; locale: GameLocale; onClose: () => void; requestCloseRef: React.RefObject<(() => void) | null>; statusSpecies?: StatusMonsterId | null }) {
  const t = (zh: string, en: string) => locale === "en" ? en : zh;
  const [controller] = useState(() => new SequentialController(statusSpecies ? statusDeploymentFromSite(site, statusSpecies) : matchFromSite(site, { ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "siege", deployment: true })));
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [choice, setChoice] = useState("");
  const [actionIndex, setActionIndex] = useState("");
  const [targetingKind, setTargetingKind] = useState<Action["kind"] | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const [mapFocused, setMapFocused] = useState(false);
  const { settingsPanel, setSettingsPanel, closeSettings, toggleSettings } = useMechaSettings(() => setMapFocused(false));
  const [showOrder, setShowOrder] = useState(false);
  const [compactSummary, setCompactSummary] = useState(true);
  const [showGuide, setShowGuide] = useState(false);
  const guideTrigger = useRef<HTMLElement | null>(null);
  const [hoveredEnemy, setHoveredEnemy] = useState<string | null>(null);
  const [selectedEnemy, setSelectedEnemy] = useState<string | null>(null);
  const worldRef = useRef<CityMechaWorldHandle>(null);
  const panelRef = useRef<HTMLDivElement>(null);
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
  const requestClose = () => { if (!archiveBusy && state.persistence !== "saving" && window.confirm(t("退出当前对局？", "Exit the current match?"))) onClose(); };
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
  const defendedBuildings = stakeBuildings(display);
  const selected = mech(state.match, state.selected);
  const restrictions = (id: MechId) => state.match.statusEncounter ? statusBlocks(state.match.statusEncounter.statuses, id) ?? { move: true, action: true } : { move: false, action: false };
  const canAct = (id: MechId) => Boolean(state.rights?.[id].action && !restrictions(id).action);
  const locked = Boolean(presentation || state.match.outcome || viewError || archiveBusy || replay || !recovery || recovery.pending || recoveryError || state.persistence === "saving" || state.persistence === "unconfirmed");
  const immediateEnd = useMemo(() => {
    if (locked || state.placements) return null;
    try {
      const result = controller.preview({ kind: "end", confirmUnused: true });
      return result?.ok ? result.snapshot.match : null;
    } catch { return null; }
  }, [controller, locked, state]);
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
  const targetOptions = targetingKind ? sequentialTargets(state.match, actions, targetingKind, state.selected) : [];
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
  const focusedThreat = intents.find(intent => intent.actor === (hoveredEnemy ?? selectedEnemy))?.targets ?? [];
  const defendedHp = defendedBuildings.reduce((sum, building) => sum + building.hp, 0);
  const defendedMax = defendedBuildings.reduce((sum, building) => sum + building.maxHp, 0);
  const projectedHp = immediateEnd ? stakeBuildings(immediateEnd).reduce((sum, building) => sum + building.hp, 0) : null;
  const view: CityMechaView = {
    figures: projectMechPositions(display, replay ? null : state.placements).map(unit => ({ id: unit.id, x: unit.pos.x, y: unit.pos.y, alive: unit.hp > 0, hp: unit.hp, maxHp: unitMaxHp(unit.id, display) ?? undefined, selected: !replay && unit.id === state.selected })),
    statuses: display.statusEncounter?.statuses.map(({ target, source, kind, remainingTurns }) => ({ target, source, kind, remainingTurns })),
    boss: { x: display.boss.anchor.x, y: display.boss.anchor.y, alive: display.boss.hp > 0, hp: display.boss.hp, maxHp: unitMaxHp("boss", display) ?? undefined },
    bossSpeciesId: display.monsterContent?.speciesId,
    raiders: display.raiders.map(unit => ({ id: unit.id, x: unit.pos.x, y: unit.pos.y, alive: unit.hp > 0, hp: unit.hp, maxHp: unitMaxHp(unit.id, display) ?? undefined })),
    buildings: display.buildings.map(building => ({ id: building.id, cells: building.cells, hp: building.hp, maxHp: building.maxHp })),
    declaredTelegraph: threats, declaredIntents: intents, projectedTelegraph: null, telegraph: threats, focusedTelegraph: focusedThreat,
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
      if (clickedMech) { controller.select(clickedMech.id); setChoice(""); setTargetingKind(null); setActionIndex(""); setConfirmEnd(false); return; }
    }
    if (!available.some(item => eq(item, cell))) return;
    if (state.placements) controller.place(state.selected, cell);
    else void controller.executeDurable({ kind: "move", mech: state.selected, to: cell });
    setChoice(""); setTargetingKind(null); setActionIndex(""); setConfirmEnd(false);
  };
  const select = (id: MechId) => { controller.select(id); setChoice(""); setTargetingKind(null); setActionIndex(""); setConfirmEnd(false); };
  const rosterRows: SequentialRosterRow[] = (replay ? display.mechs : state.match.mechs).map(unit => {
    const badges = describeStatusBadges(display.statusEncounter?.statuses ?? [], unit.id, locale);
    const phase = replay ? t("回放", "Replay") : state.placements
      ? state.placements.some(p => p.mechId === unit.id) ? t("已部署", "Deployed") : t("未部署", "Not deployed")
      : t("移动", "Move") + " " + (state.rights?.[unit.id].move && !restrictions(unit.id).move ? "✓" : "—") + " · " + t("行动", "Act") + " " + (canAct(unit.id) ? "✓" : "—");
    return { id: unit.id, name: gameText(NAMES[unit.id], locale), hp: unit.hp, selected: !replay && unit.id === state.selected,
      disabled: locked || unit.hp <= 0, stateLabel: phase + (badges.text ? " · " + badges.text : ""),
      avatar: <MechaUnitAvatar mechId={unit.id} locale={locale} /> };
  });
  const supportedKinds: Action["kind"][] = selected && selected.hp > 0 ? ["skip",
    ...(STATS[state.selected].melee ? ["melee" as const] : []),
    ...(STATS[state.selected].shoot > 0 ? ["shoot" as const] : []),
    state.selected === "Assault" ? "charge" : state.selected === "Gunner" ? "pierce" : "repair"] : [];
  const availableKinds = [...new Set(actions.map(entry => entry.kind))];
  const actionKinds = [...availableKinds, ...supportedKinds.filter(kind => !availableKinds.includes(kind))];
  const actionRows: SequentialHudAction[] = actionKinds.map(kind => {
    const available = availableKinds.includes(kind);
    const cooldown = (kind === "charge" || kind === "pierce" || kind === "repair") && Boolean(selected?.cd);
    return { key: kind, label: planActionLabel(kind, locale), icon: <MechaActionIcon kind={kind} />,
      selected: targetingKind === kind || action?.kind === kind, disabled: !available,
      status: available ? t("准备就绪", "Ready") : t("不可用", "Unavailable"),
      title: available ? undefined : !canAct(state.selected) ? t("本回合无法行动。", "Cannot act this turn.") : cooldown ? t("技能冷却中。", "Ability is on cooldown.") : t("当前没有合法目标。", "No legal target is available.") };
  });
  const hudDamage = previewEvidence?.ok ? previewEvidence.health.steps.map(step => {
    const effect = step.effect;
    const targetName = effect.kind === "boss" ? t("大怪", "Boss") : effect.kind === "building"
      ? t("建筑", "Building") + " " + (state.match.buildings.findIndex(building => building.id === effect.id) + 1)
      : effect.id in NAMES ? gameText(NAMES[effect.id as MechId], locale) : t("小怪", "Enemy");
    return { target: targetName, before: effect.before, after: effect.after };
  }) : [];
  const hudDisplacement = preview?.ok ? preview.events.flatMap(event => event.type === "shove"
    ? [`${event.unit === "boss" ? t("大怪", "Boss") : gameText(NAMES[event.unit], locale)} · ${event.hit ? t("位移受阻", "Push blocked") : t("受到推移", "Pushed")}`] : []) : [];
  const selectedStatuses = display.statusEncounter?.statuses.filter(status => status.target === state.selected) ?? [];
  const hudStatusNote = restrictions(state.selected).action ? t("眩晕：不能主动移动或行动。", "Stunned: cannot move or act voluntarily.")
    : restrictions(state.selected).move ? t("冻结：不能主动移动，仍可行动。", "Frozen: cannot move voluntarily, but can act.") : undefined;
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
    if (!controller.canRestore(evidence)) { setArchiveMessage(t("检查点属于其他遭遇，请切换回对应战场。", "This checkpoint belongs to a different encounter; reopen its battlefield.")); return; }
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
      setSettingsPanel(null); setTargetingKind(null); setActionIndex(""); setChoice(""); setConfirmEnd(false);
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
    if (!controller.canRestore(evidence)) { setArchiveMessage(t("该回放属于其他遭遇，请切换回对应战场。", "This replay belongs to a different encounter; reopen its battlefield.")); return; }
    if (!window.confirm(t("继续此回放将替换当前对局，是否继续？", "Continue this replay and replace the current match?"))) return;
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
  return <MechaHudLayout className="mecha-overlay is-city has-match is-reference-hud mecha-v15" phase={state.placements ? "deployment" : state.match.outcome ? "finished" : "planning"} mapFocus={mapFocused} ariaLabel={t("机甲战棋 1.5", "Mecha tactics 1.5")} dataMechaV15>
    <CityMechaWorld ref={worldRef} engine={engine} site={site} locale={locale} view={view} performance={performance} paused={false} onPerformanceComplete={finishPresentation} onCell={(x, y) => { setMapFocused(false); performCell({ x, y }); }} onHoverEnemy={setHoveredEnemy} onUnavailable={reason => setViewError(reason ?? "mode")} />
    <header className="mecha-battle-bar mecha-v15-bar"><div className="mecha-battle-controls"><MechaBattlefieldControls locale={locale} mapFocused={mapFocused} onToggleFocus={() => setMapFocused(value => !value)} onResetCamera={() => worldRef.current?.resetCamera()} /><button type="button" disabled={Boolean(state.placements) || Boolean(replay)} aria-label={t("结算顺序", "Turn order")} aria-expanded={showOrder} aria-controls={showOrder ? "mecha-order-panel" : undefined} onClick={() => { if (!showOrder) { setMapFocused(false); setCompactSummary(false); } else panelRef.current?.querySelector<HTMLElement>(".mecha-turn-summary")?.scrollTo({ top: 0 }); setShowOrder(value => !value); }}>{t("顺序", "Order")}</button><button type="button" data-mecha-settings-trigger="battlefield" aria-expanded={settingsPanel === "battlefield"} aria-controls="mecha-battlefield-settings" onClick={event => toggleSettings("battlefield", event.currentTarget)}>{gameText("战场设置", locale)}</button><MechaBattleMenu locale={locale} exitDisabled={archiveBusy || state.persistence === "saving"} onGuide={trigger => { guideTrigger.current = trigger; setSettingsPanel(null); setMapFocused(false); setShowGuide(true); }} onExit={requestClose} /></div></header>
    <div className="mecha-panel mecha-v15-panel" ref={panelRef} aria-label={t("逐台行动", "Sequential actions")}>
      <details className="mecha-tactical-legend"><summary><span aria-hidden="true">↗</span> {gameText("战场图例", locale)}</summary><MechaBattleLegend locale={locale} view={view} /></details>
      <MechaObjectivePanel className={compactSummary ? "is-compact" : ""} label={t("战斗目标与威胁", "Battle objective and threats")}>
        <MechaObjectiveCard round={state.placements && !replay ? t("开局部署", "Initial deployment") : `${t("回合", "Turn")} ${Math.min(display.turn, MAX_TURNS)}/${MAX_TURNS}`}
          heading={<MechaObjectiveToggle locale={locale} expanded={!compactSummary} onToggle={event => { event.currentTarget.closest<HTMLElement>(".mecha-turn-summary")?.scrollTo({ top: 0 }); setCompactSummary(value => !value); }} />}
          goal={display.mission ? t("任一存活机甲抵达救援点", "Reach the rescue point with a surviving mech") : defendedBuildings.length ? t("消灭所有敌人 · 至少保住一栋防守建筑", "Defeat all enemies and protect at least one building") : t("消灭所有敌人", "Defeat all enemies")}
          resource={<><div className="mecha-building-current"><span>{t("防守建筑", "Defended buildings")}</span><strong>{defendedBuildings.length ? `${defendedHp}/${defendedMax}` : t("本局无守楼目标", "No defended buildings")}</strong></div>{projectedHp !== null && defendedBuildings.length > 0 && <span>→ {t("若立即结束，预计", "If ended now, forecast")} {projectedHp}/{defendedMax}</span>}</>}
          forecast={!replay && !state.placements && !display.outcome ? presentation ? t("演出中，不显示预测。", "Forecast unavailable during playback.") : projectedHp === null ? t("立即结束回合的预测不可用。", "Forecast for ending now is unavailable.") : defendedBuildings.length ? `${t("若立即结束，预计建筑净损失", "If ended now, forecast net building loss")} ${defendedHp - projectedHp}` : t("本局无守楼目标", "No defended buildings") : undefined} />
        <p className="mecha-sr-only" role="status" aria-live="polite">{replay ? t("回放步骤", "Replay step") + " " + replay.index + "/" + replay.records.length : state.match.outcome ? state.match.outcome : state.placements ? t("选择机甲并点击绿色格部署。", "Select a mech and click a green cell to deploy.") : t("回合", "Turn") + " " + display.turn + (presentation ? t(" · 正在结算", " · resolving") : "")}</p>
        {showForecast && <details className="mecha-threat-details"><summary>{t("威胁来源与格子", "Threat sources and cells")}</summary>
          <p>{t("当前宣告的攻击格可能因后续行动改变。", "Declared attack cells may change after subsequent actions.")}</p>
          <MechaThreatSourceList label={t("当前宣告威胁来源", "Declared threat sources")}
            sources={intents.map(intent => ({ id: intent.actor, selected: selectedEnemy === intent.actor,
              content: <>{intent.actor === "boss" ? t("大怪", "Boss") : t("小怪", "Enemy")} · {intent.targets.map(cellKey).join("、")}</> }))}
            empty={t("当前没有宣告威胁格。", "No declared threat cells.")} onSelect={actor => setSelectedEnemy(current => current === actor ? null : actor)} />
        </details>}
        {showOrder && <MechaTurnOrder label={t("结算顺序", "Turn order")} stageLabel={t("回合阶段", "Turn phases")}
          stages={[t("机甲逐台行动", "Individual mech actions"), t("敌方行动", "Enemy actions"), t("下一回合", "Next turn")]}>
          <p>{t("每次移动和行动确认后立即结算；结束回合后敌方行动。", "Each confirmed move or action resolves immediately; enemies act after the turn ends.")}</p>
          <p>{t("立即结束回合的预测会假设放弃剩余行动。", "The end-turn forecast assumes remaining actions are forfeited.")}</p>
        </MechaTurnOrder>}
        {statusSpecies && <p className="mecha-v15-note">{t("状态挑战", "Status challenge")}: {t(...STATUS_SPECIES[statusSpecies])}</p>}
        {showForecast && forecast && <details className="mecha-v15-forecast" role="region" aria-label={t("敌方状态预告", "Enemy status forecast")}><summary>{t("敌方状态预告", "Enemy status forecast")}</summary>
          <p>{forecast.skill === "spore_leap" ? t("孢子弹跳：存活的命中机甲中毒 2 回合，每回合结束受到 1 点伤害。", "Spore leap: surviving mechs hit are poisoned for 2 turns, taking 1 damage at each turn end.") : forecast.skill === "ring_pierce" ? t("环轨穿刺：存活的命中机甲燃烧 2 回合，每回合结束受到 1 点伤害。", "Ring pierce: surviving mechs hit burn for 2 turns, taking 1 damage at each turn end.") : forecast.skill === "prism_frost" ? t("棱晶寒束：命中射线上首个机甲；若其存活则冻结 1 回合，不能主动移动。", "Prism frost: hits the first mech on the ray; if it survives, it is frozen for 1 turn and cannot move voluntarily.") : t("引力井：牵引撞上单位、建筑或障碍的机甲眩晕 1 回合，不能主动移动或行动。", "Gravity well: a mech pulled into a unit, building or obstacle is stunned for 1 turn and cannot move or act voluntarily.")}</p>
          <p>{t("预告格", "Forecast cells")}: {forecast.cells.length ? forecast.cells.map(cellKey).join(" · ") : t("无", "None")}</p>
          {forecast.skill === "gravity_well" && (forecast.pulls === null ? <p>{t("牵引结果未知。", "Pull outcome unknown.")}</p> : forecast.pulls.map(pull => <p key={pull.mech}>{gameText(NAMES[pull.mech], locale)}: {cellKey(pull.from)} → {pull.to ? cellKey(pull.to) : pull.collision ? t("可能撞击", "Possible collision") + " " + cellKey(pull.collision) : t("无可证实的位移或撞击", "No confirmed movement or collision")}</p>))}
          <p>{t("实际命中后才施加状态；移动、击杀或阻挡会改变预测。", "Statuses apply only after confirmed hits; movement, defeat or obstruction can change this forecast.")}</p>
        </details>}
        {showForecast && display.statusEncounter && !forecastState && <p role="status">{t("敌方预告暂不可用。", "Enemy forecast is unavailable.")}</p>}
        {archiveMessage && settingsPanel !== "battlefield" && <p className="mecha-v15-summary-message" role="status" aria-live="polite">{archiveMessage}</p>}
      </MechaObjectivePanel>
      {(viewError || state.error || recoveryError || state.persistence === "unconfirmed" || (currentPresentation && !verified?.ok)) && <div className="mecha-v15-alert" role="alert"><p>{viewError ? t("三维战场不可用，请退出后重试。", "The 3D battlefield is unavailable. Exit and try again.") : state.error ? t("操作未执行", "Command rejected") + ": " + state.error : recoveryError || state.persistence === "unconfirmed" ? t("自动检查点状态未确认，行动已锁定。", "Checkpoint status is unconfirmed; actions are locked.") : t("演出证据不足；可跳过演出并查看权威结果。", "Animation evidence is incomplete; skip to the authoritative result.")}</p>{recoveryError || state.persistence === "unconfirmed" ? <button type="button" disabled={archiveBusy} onClick={() => { setReplay(null); void readRecovery(); }}>{t("重新读取恢复", "Reload recovery")}</button> : null}{currentPresentation && !verified?.ok ? <button type="button" onClick={finishPresentation}>{t("查看结果", "Show result")}</button> : null}</div>}
      {recovery?.pending && !recoveryError && !replay && <div className="mecha-v15-recovery"><p>{recovery.restored ? recovery.restored.session.snapshot().match.outcome ? t("自动检查点已结束，可以查看结果。", "The automatic checkpoint is finished; you can review it.") : t("发现未完成的自动检查点。", "An unfinished automatic checkpoint was found.") : t("自动检查点损坏或与当前战场不兼容。", "The checkpoint is damaged or incompatible with this battlefield.")}</p><div className="mecha-v15-row">{recovery.restored?.session.snapshot().match.outcome ? <button type="button" disabled={archiveBusy} onClick={() => { const restored = recovery.restored!; const records = restored.session.records(); setReplay({ initial: restored.initial, placements: restored.placements, records, index: records.length }); }}>{t("查看已结束对局", "Review finished match")}</button> : <button type="button" disabled={archiveBusy || !recovery.restored} onClick={recover}>{t("恢复对局", "Recover match")}</button>}<button type="button" disabled={archiveBusy} onClick={() => void discardRecovery()}>{t("删除并新开", "Discard and start")}</button></div></div>}
      {!recovery && !recoveryError && <p className="mecha-v15-alert" role="status">{t("正在读取自动检查点…", "Reading automatic checkpoint…")}</p>}
      <MechaTeamPanel label={t("回合与队伍规划", "Turn and squad planning")}>
      {state.placements && !replay ? <MechaDeploymentView locale={locale} units={state.match.mechs.map(unit => unit.id)} selected={state.selected}
        placements={state.placements} disabled={locked} canConfirm={state.canConfirmDeployment} canUndo={state.canUndoPlacement}
        canReset={state.placements.length > 0} error={state.error} onSelect={select} onConfirm={() => void deploy()}
        onUndo={() => controller.undoPlacement()} onReset={() => controller.resetPlacement()} /> : <>
      <MechaTeamTurnControls heading={t("队伍规划", "Squad planning")}
        status={<><strong>{t("逐台回合", "Sequential turn")}</strong><span>{state.persistence === "unconfirmed" ? t("行动锁定：检查点未确认。", "Locked: checkpoint unconfirmed.") : t("每台机甲可移动和行动一次。", "Each mech may move and act once.")}</span></>}>
        {!replay && <div className="mecha-planning-controls">
          <button type="button" className="mecha-submit-primary" disabled={locked || Boolean(state.match.outcome)} onClick={() => { if (state.match.mechs.some(unit => unit.hp > 0 && canAct(unit.id))) setConfirmEnd(true); else { issue({ kind: "end", confirmUnused: false }); setTargetingKind(null); setActionIndex(""); setChoice(""); } }}>{t("结束回合", "End turn")}</button>
          <button type="button" className="mecha-reset-turn" disabled={locked || state.resetUsed} onClick={() => { if (window.confirm(t("重置本回合？每局只能使用一次。", "Reset this turn? This can be used once per match."))) { issue({ kind: "reset" }); setTargetingKind(null); setActionIndex(""); setChoice(""); setConfirmEnd(false); } }}>{t("重置回合", "Reset turn")} ({state.resetUsed ? 0 : 1}/1)</button>
        </div>}
      </MechaTeamTurnControls>
      <MechaRoster className="mecha-v15-roster" label={t("选择机甲", "Select mech")} rows={rosterRows.map(row => ({ ...row, onSelect: select, draft: undefined, openingSuggestion: false, hitDamage: null, locale }))} />
      </>}
      </MechaTeamPanel>
      {state.placements && !replay ? <MechaDeploymentActionsView locale={locale} selected={state.selected} cells={state.deployable} disabled={locked} onPlace={(id, cell) => controller.place(id, cell)} /> : <SequentialMechaCommandPanel
        label={t("当前机甲行动", "Selected mech actions")}
        selectedName={t("操作机甲", "Selected mech") + " · " + gameText(NAMES[state.selected], locale)}
        hp={selected?.hp ?? 0} maxHp={unitMaxHp(state.selected, display) ?? "?"}
        portrait={<MechaUnitPortrait unitId={state.selected} locale={locale} size={64} className="mecha-selected-portrait" decorative={false} />}
        movementLabel={state.placements ? t("部署坐标", "Deployment cell") : t("移动坐标", "Move to")}
        moveListSummary={t("通过列表移动", "Move using a list")} movePlaceholder={t("选择坐标", "Select cell")}
        moveOptions={available.map(cell => ({ key: cellKey(cell), label: `${cell.x}, ${cell.y}` }))}
        moveChoice={choice} moveDisabled={locked || available.length === 0}
        moveActionLabel={state.placements ? t("放置", "Place") : t("移动", "Move")}
        onMoveChoice={setChoice}
        onMoveApply={() => { const cell = available.find(item => cellKey(item) === choice); if (cell) performCell(cell); }}
        statusNote={hudStatusNote} actions={actionRows} actionColumns={actionRows.length}
        targetInstruction={targetOptions.length ? t("点击高亮目标切换预览，再确认行动。", "Click a highlighted target to preview it, then confirm the action.") : undefined}
        targetPicker={targetingKind && <div className="mecha-target-preview" aria-label={t("目标试算", "Target preview")}>
          <p>{t("选择目标后确认行动。", "Choose a target, then confirm the action.")}</p>
          <MechaTargetOptions options={targetOptions.map(option => ({ key: String(option.actionIndex), selected: actionIndex === String(option.actionIndex),
            label: <>{option.id in NAMES ? gameText(NAMES[option.id as MechId], locale) : option.id === "boss" ? t("大怪", "Boss") : t("小怪", "Enemy")} · {option.cells.map(cell => `${cell.x},${cell.y}`).join("、")}</> }))}
            disabled={locked} empty={t("无合法目标", "No legal target")} onSelect={key => setActionIndex(key)} />
        </div>}
        previewTitle={action ? t("行动预览", "Action preview") : undefined}
        previewMessage={action ? previewEvidence?.ok ? previewEvidence.health.steps.length ? undefined : t("生命值无变化。", "No health change.") : t("预览证据不足，无法显示伤害。", "Preview evidence is incomplete; damage is unavailable.") : undefined}
        damage={hudDamage} displacement={hudDisplacement} actionDisabled={locked || Boolean(state.placements) || Boolean(replay)}
        confirmActionDisabled={!action || !preview?.ok}
        onSelectAction={index => {
          const kind = actionKinds[index];
          if (!kind) return;
          if (kind === "skip") { setTargetingKind(null); setActionIndex(String(actions.findIndex(entry => entry.kind === kind))); }
          else { setTargetingKind(kind); setActionIndex(""); }
        }}
        onConfirmAction={() => { if (action) issue({ kind: "act", mech: state.selected, action }); setTargetingKind(null); setActionIndex(""); setConfirmEnd(false); }}
        onUndo={() => { issue({ kind: "undo" }); setTargetingKind(null); setActionIndex(""); setChoice(""); setConfirmEnd(false); }}
        actionText={t("选择行动", "Select action")} confirmText={t("确认行动", "Confirm action")} undoText={t("撤销移动", "Undo move")}
      >
        {confirmEnd && <div role="alert" className="mecha-v15-confirm"><p>{t("仍可行动", "Still able to act")}: {state.match.mechs.filter(unit => unit.hp > 0 && canAct(unit.id)).map(unit => gameText(NAMES[unit.id], locale)).join("、")}。 {t("结束回合将放弃这些机会。", "Ending the turn forfeits those actions.")}</p><div className="mecha-v15-row"><button type="button" onClick={() => { issue({ kind: "end", confirmUnused: true }); setTargetingKind(null); setActionIndex(""); setChoice(""); setConfirmEnd(false); }}>{t("确认结束", "End turn")}</button><button type="button" onClick={() => setConfirmEnd(false)}>{t("继续行动", "Continue")}</button></div></div>}
        {selectedStatuses.length > 0 && <details className="mecha-v15-status"><summary>{t("当前状态", "Current statuses")}</summary><ul>{selectedStatuses.map(status => { const name = locale === "en" ? { poison: "Poison", burn: "Burn", freeze: "Freeze", stun: "Stun" }[status.kind] : { poison: "中毒", burn: "燃烧", freeze: "冻结", stun: "眩晕" }[status.kind]; const effect = status.kind === "poison" || status.kind === "burn" ? t("回合结束伤害", "End-of-turn damage") + " " + status.magnitude : status.kind === "freeze" ? t("不能主动移动", "Cannot move voluntarily") : t("不能主动移动或行动", "Cannot move or act voluntarily"); return <li key={status.target + ":" + status.kind + ":" + status.source}>{name} · {effect} · {t("剩余回合", "Turns remaining")} {status.remainingTurns} · {t("来源", "Source")}: {status.source === "boss" ? t("大怪", "Boss") : t("敌人", "Enemy")}</li>; })}</ul></details>}
        {replay && <div className="mecha-v15-replay-controls"><p>{t("逐步播放已验证的行动；重置直接显示恢复后的棋盘。", "Step through verified actions; reset shows the restored board immediately.")} · {replay.index ? replayLabel(replay.records[replay.index - 1]!) : t("部署完成", "Deployment complete")}</p><div className="mecha-v15-row"><button type="button" disabled={Boolean(replayAnimation) || replay.index === 0} onClick={() => setReplay({ ...replay, index: replay.index - 1 })}>{t("上一步", "Previous")}</button><button type="button" disabled={Boolean(replayAnimation) || replay.index === replay.records.length} onClick={() => { const record = replay.records[replay.index]!; const before = replay.index === 0 ? replay.initial : replay.records[replay.index - 1]!.snapshot.match; setReplay({ ...replay, index: replay.index + 1 }); if (record.events.length) setReplayAnimation({ before, after: record.snapshot.match, record }); }}>{t("下一步", "Next")}</button><button type="button" onClick={() => { setReplayAnimation(null); setReplay(null); }}>{t("返回对局", "Return to match")}</button></div>{replayAnimation && verified?.ok && performance && <button type="button" onClick={finishPresentation}>{t("跳过演出", "Skip animation")}</button>}{replay.index === replay.records.length && !display.outcome && <button type="button" disabled={Boolean(replayAnimation) || archiveBusy || recoveryError || !recovery || recovery.pending} onClick={() => void resumeSaved()}>{t("继续此对局", "Resume this match")}</button>}</div>}
      </SequentialMechaCommandPanel>}
      {!replay && <details className="mecha-v15-replays"><summary>{t("本地回放", "Local replays")}</summary><p className="mecha-v15-note">{t("仅能在相同城市战场重建；保存后会重新校验。", "Rebuilds only on the same city battlefield; saves are rechecked.")}</p><button type="button" disabled={archiveBusy || Boolean(presentation) || state.persistence !== "ready" || !controller.hasReplayEvidence()} onClick={() => void save()}>{t("保存当前回放", "Save current replay")}</button><label htmlFor="v15-replay-choice">{t("选择回放", "Select replay")}</label><select id="v15-replay-choice" value={archiveChoice} disabled={archiveBusy || !archiveEntries.length} onChange={event => setArchiveChoice(event.currentTarget.value)}><option value="">{t("选择回放", "Select replay")}</option>{archiveEntries.map(entry => <option key={entry.key} value={entry.key}>{entry.damaged ? t("损坏的记录", "Damaged record") : entry.savedAt}</option>)}</select><div className="mecha-v15-row"><button type="button" disabled={archiveBusy || Boolean(presentation) || state.persistence === "saving" || state.persistence === "unconfirmed" || !archiveChoice || archiveEntries.find(entry => entry.key === archiveChoice)?.damaged} onClick={() => void load()}>{t("查看回放", "View replay")}</button><button type="button" disabled={archiveBusy || !archiveChoice} onClick={() => void remove()}>{t("删除回放", "Delete replay")}</button></div></details>}
      {presentation && verified?.ok && performance && <button className="mecha-v15-skip" type="button" onClick={finishPresentation}>{t("跳过演出", "Skip animation")}</button>}
    </div>
    {showGuide && <MechaQuickGuide locale={locale} mode="sequential" returnFocusRef={guideTrigger} onClose={() => setShowGuide(false)} />}
  </MechaHudLayout>;
}
