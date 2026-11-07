/** Local PvE v1.5 match surface. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CityEngine } from "../engine/CityEngine";
import { CityMechaWorld, type CityMechaView, type CityMechaWorldHandle } from "./CityMechaWorld";
import { MechaHud } from "./MechaHudLayout";
import { MechaDeploymentActionsView, MechaDeploymentView } from "./MechaDeploymentPanel";
import { MechaBattlefieldControls, MechaBattleMenu, MechaCommandDeck, MechaCommandPanel, MechaObjectiveCard, MechaObjectivePanel, MechaObjectiveToggle, MechaSettingsPopover, MechaTargetOptions, MechaTeamPanel, MechaTeamTurnControls, MechaThreatSourceList, MechaTurnOrder } from "./MechaHudPanels";
import { MechaQuickGuide } from "./MechaQuickGuide";
import { MechaBattleLegend } from "./MechaBattleLegend";
import { MechaCellInspector } from "./MechaCellInspector";
import { useMechaSettings } from "./useMechaSettings";
import { MechaRoster } from "./MechaPlanCard";
import { MechaActionCard } from "./MechaActionCard";
import { MechaMoveList } from "./MechaMoveList";
import { MechaActionIcon } from "./MechaActionIcon";
import { MechaUnitAvatar, MechaUnitPortrait } from "./MechaUnitAvatar";
import { gameText, type GameLocale } from "./gameCopy";
import { BOARD, MAX_TURNS, STATS, eq, mech, moveBudget, occupant, pathDistance, stakeBuildings, type Action, type Cell, type MechId } from "./mecha/board";
import { legalActions } from "./mecha/combat";
import { cuesFromLog } from "./mecha/controller";
import { declaredEnemyIntents } from "./mecha/enemyIntentPresentation";
import { previewEnemyPhase } from "./mecha/enemyPhasePreview";
import { matchFromSite } from "./mecha/matchFromSite";
import { sequentialPresentation } from "./mecha/sequentialPresentation";
import { sequentialTargets } from "./mecha/actionTargets";
import { inspectCell, inspectionSegments } from "./mecha/cellInspection";
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
import { buildSequentialHud } from "./mecha/hud/adapters";
import type { MechaHudActions, MechaHudModel, MechaHudProjection } from "./mecha/hud/model";

const NAMES: Record<MechId, string> = { Assault: "突击", Gunner: "射手", Support: "支援" };
const STATUS_SPECIES: Record<StatusMonsterId, [string, string]> = { spore_leaper: ["孢群体", "Spore leaper"], flux_lancer: ["流环体", "Flux lancer"], prism_warden: ["晶簇体", "Prism warden"], gravity_core: ["引力核", "Gravity core"] };
const cellKey = (cell: Cell) => `${cell.x},${cell.y}`;

export function SequentialMechaMatch({ engine, site, locale, onClose, requestCloseRef, statusSpecies, connectedAssault }: { engine: CityEngine; site: CityMechaSite; locale: GameLocale; onClose: () => void; requestCloseRef: React.RefObject<(() => void) | null>; statusSpecies?: StatusMonsterId | null; connectedAssault: boolean }) {
  const t = (zh: string, en: string) => locale === "en" ? en : zh;
  const [controller] = useState(() => new SequentialController(statusSpecies ? statusDeploymentFromSite(site, statusSpecies) : matchFromSite(site, { ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "siege", deployment: true })));
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [choice, setChoice] = useState("");
  const [actionSelection, setActionSelection] = useState<{ actor: MechId; revision: number; index: number } | null>(null);
  const [targetingKind, setTargetingKind] = useState<Action["kind"] | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const [mapFocused, setMapFocused] = useState(false);
  const [inspectedCell, setInspectedCell] = useState<Cell | null>(null);
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
  const cellInfo = inspectedCell && !presentation && !replayAnimation
    ? inspectCell(state.placements ? { ...display, mechs: projectMechPositions(display, state.placements) } : display, inspectedCell)
    : null;
  const defendedBuildings = stakeBuildings(display);
  const selected = mech(state.match, state.selected);
  const restrictions = (id: MechId) => state.match.statusEncounter ? statusBlocks(state.match.statusEncounter.statuses, id) ?? { move: true, action: true } : { move: false, action: false };
  const canAct = (id: MechId) => Boolean(state.rights?.[id].action && !restrictions(id).action);
  const locked = Boolean(presentation || state.match.outcome || viewError || archiveBusy || replay || !recovery || recovery.pending || recoveryError || state.persistence === "saving" || state.persistence === "unconfirmed");
  const attackOrderPreview = useMemo(() => {
    if (!showOrder || locked || state.placements) return null;
    try { return previewEnemyPhase(state.match); }
    catch { return { ok: false as const, reason: "enemy_phase_preview_failed" }; }
  }, [showOrder, locked, state.placements, state.match]);
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
  const actionIndex = actionSelection?.actor === state.selected && actionSelection.revision === state.match.revision ? String(actionSelection.index) : "";
  const setActionIndex = (index: string) => setActionSelection(index === "" ? null : {
    actor: state.selected, revision: state.match.revision, index: Number(index),
  });
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
    enemyOrder: showOrder && attackOrderPreview?.ok ? attackOrderPreview.steps.map(step => ({ actor: step.actor, cells: step.cells, position: step.position ?? undefined, order: step.order, cancel: step.cancel })) : [],
    deployment: !replay && Boolean(state.placements), focus: [], reach: available, move: null,
    targets: !locked ? targetOptions.flatMap(option => option.cells) : [], targetIds: !locked ? targetOptions.map(option => option.id) : [],
    targetPreview: !locked && selectedTarget?.cells[0] ? { target: selectedTarget.cells[0] } : undefined, obstacles: display.obstacles,
    missionTarget: display.mission?.target ?? null,
    inspectedCell: cellInfo?.cell,
    inspectionSegments: inspectionSegments(cellInfo?.attack ?? null, null),
    combat: currentPresentation && verified?.ok ? { id: currentPresentation.after.revision, actions: cuesFromLog(currentPresentation.events), healthTimeline: verified.health, presentationChanges: verified.changes } : undefined,
  };
  const performCell = (cell: Cell) => {
    if (locked) return;
    const clickedTarget = targetOptions.find(option => option.cells.some(position => eq(position, cell)));
    if (clickedTarget) { setActionIndex(String(clickedTarget.actionIndex)); return; }
    if (!state.placements) {
      const clickedMech = state.match.mechs.find(unit => unit.hp > 0 && eq(unit.pos, cell));
      if (clickedMech) { select(clickedMech.id); return; }
    }
    if (!available.some(item => eq(item, cell))) { setInspectedCell(cell); return; }
    setInspectedCell(null);
    if (state.placements) controller.place(state.selected, cell);
    else hudActions.moveTo(cell);
    setChoice(""); setTargetingKind(null); setActionIndex(""); setConfirmEnd(false);
  };
  const select = (id: MechId) => { controller.select(id); setInspectedCell(null); setChoice(""); setTargetingKind(null); setActionIndex(""); setConfirmEnd(false); };
  const rosterRows = (replay ? display.mechs : state.match.mechs).map(unit => {
    const badges = describeStatusBadges(display.statusEncounter?.statuses ?? [], unit.id, locale);
    const placement = (replay ? replay.placements : state.openingPlacements)?.find(item => item.mechId === unit.id);
    const moved = state.activity?.moved.includes(unit.id), acted = state.activity?.acted.includes(unit.id);
    const moveLabel = moved ? t("已移动", "Moved") : restrictions(unit.id).move ? t("移动受限", "Movement blocked")
      : acted ? t("未移动", "Did not move") : t("可移动", "Can move");
    const actLabel = acted ? t("已行动", "Acted") : restrictions(unit.id).action ? t("行动受限", "Action blocked") : t("可行动", "Can act");
    const phase = replay ? t("回放", "Replay") : unit.hp <= 0 ? t("已失去战斗能力", "Disabled")
      : state.match.outcome ? t("对局已结束", "Match finished") : `${moveLabel} · ${actLabel}`;
    return { id: unit.id, name: gameText(NAMES[unit.id], locale), hp: unit.hp, selected: !replay && unit.id === state.selected,
      disabled: locked || unit.hp <= 0, stateLabel: phase + (badges.text ? " · " + badges.text : ""),
      placementLabel: placement ? `${t("部署点", "Deployed at")} ${placement.pos.x}, ${placement.pos.y}` : undefined,
      avatar: <MechaUnitAvatar mechId={unit.id} locale={locale} /> };
  });
  const supportedKinds: Action["kind"][] = selected && selected.hp > 0 ? ["skip",
    ...(STATS[state.selected].melee ? ["melee" as const] : []),
    ...(STATS[state.selected].shoot > 0 ? ["shoot" as const] : []),
    state.selected === "Assault" ? "charge" : state.selected === "Gunner" ? "pierce" : "repair"] : [];
  const availableKinds = [...new Set(actions.map(entry => entry.kind))];
  const actionKinds = [...availableKinds, ...supportedKinds.filter(kind => !availableKinds.includes(kind))];
  const actionRows = actionKinds.map(kind => {
    const available = availableKinds.includes(kind);
    const cooldown = (kind === "charge" || kind === "pierce" || kind === "repair") && Boolean(selected?.cd);
    const unavailableReason = state.placements ? t("部署后开放", "Available after deployment")
      : locked ? t("暂不可用", "Temporarily unavailable")
      : !state.rights?.[state.selected].action ? t("本回合已行动", "Already acted this turn")
      : restrictions(state.selected).action ? t("当前状态不能行动", "Status prevents acting")
      : cooldown ? t("技能冷却中", "Ability on cooldown") : t("无合法目标", "No legal target");
    return { key: kind, label: planActionLabel(kind, locale), icon: <MechaActionIcon kind={kind} />,
      selected: targetingKind === kind || action?.kind === kind, disabled: !available,
      status: available ? t("准备就绪", "Ready") : unavailableReason, title: available ? undefined : unavailableReason };
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
  const undoMechName = state.undoMech ? gameText(NAMES[state.undoMech], locale) : null;
  const undoHint = undoMechName && !state.canUndo
    ? t(`请选择${undoMechName}，撤销它最近一次移动。`, `Select ${undoMechName} to undo its latest move.`)
    : t("撤销当前机甲的移动。", "Undo movement for the selected mech.");
  const selectedMoved = state.activity?.moved.includes(state.selected);
  const selectedActed = state.activity?.acted.includes(state.selected);
  const hudStatusNote = state.placements || replay || state.match.outcome || !selected ? undefined
    : restrictions(state.selected).action ? t("眩晕：不能主动移动或行动。", "Stunned: cannot move or act voluntarily.")
    : restrictions(state.selected).move ? t("冻结：不能主动移动，仍可行动。", "Frozen: cannot move voluntarily, but can act.")
    : selectedActed ? t("本回合已行动，不能再移动或行动。", "Already acted this turn. Movement and actions are finished.")
    : selectedMoved
      ? state.canUndo
        ? t("本回合已移动；仍可撤销当前机甲的移动，再重新选位。", "Movement is used this turn. You can still undo this mech's move and choose a new cell.")
        : undoMechName
          ? undoHint
        : state.resetUsed
          ? t("本回合已移动；本局唯一一次重置回合也已使用。", "Already moved this turn; the match's only turn reset has also been used.")
          : t("本回合已移动。点击“重置回合”可恢复本回合的移动和行动机会。", "Already moved this turn. Reset the turn to restore this turn's movement and action rights.")
    : !locked && movement.length === 0
      ? t("当前没有可达格子，请检查路径阻挡或选择其他机甲。", "No reachable cells. Check for blocked paths or select another mech.") : undefined;
  const replayLabel = (record: SequentialRecord) => record.causalEvent?.kind === "undo_move" ? t("撤销移动", "Undo move")
    : record.causalEvent?.kind === "reset_turn" ? t("重置回合", "Reset turn")
    : record.command.kind === "move" ? t("移动", "Move") : record.command.kind === "act" ? t("行动", "Action") : t("结束回合", "End turn");
  const issue = (command: CommandInput) => {
    const current = controller.getState();
    if ("mech" in command && (command.mech !== current.selected || state.match.revision !== current.match.revision)) return;
    void controller.executeDurable(command);
  };
  const clearCommandSelection = () => { setTargetingKind(null); setActionIndex(""); setChoice(""); setConfirmEnd(false); };
  const hudActions: MechaHudActions = {
    select,
    moveTo: cell => { if (!locked && !state.placements) issue({ kind: "move", mech: state.selected, to: cell }); clearCommandSelection(); },
    chooseAction: kind => {
      if (kind === "skip") { setTargetingKind(null); setActionIndex(String(actions.findIndex(entry => entry.kind === kind))); }
      else { setTargetingKind(kind); setActionIndex(""); }
    },
    pickTarget: index => { const target = targetOptions[index]; if (target) setActionIndex(String(target.actionIndex)); },
    confirmAction: () => { if (action && !locked) issue({ kind: "act", mech: state.selected, action }); clearCommandSelection(); },
    undoMove: () => { if (!locked && state.canUndo) { issue({ kind: "undo", mech: state.selected }); clearCommandSelection(); } },
    resetTurn: () => {
      if (locked || state.resetUsed || !window.confirm(t("重置本回合？每局只能使用一次。", "Reset this turn? This can be used once per match."))) return;
      issue({ kind: "reset" }); clearCommandSelection();
    },
    endTurn: () => {
      if (locked) return;
      if (state.match.mechs.some(unit => unit.hp > 0 && canAct(unit.id))) setConfirmEnd(true);
      else { issue({ kind: "end", confirmUnused: false }); clearCommandSelection(); }
    },
    confirmEndTurn: unused => { if (!locked) issue({ kind: "end", confirmUnused: unused }); clearCommandSelection(); },
  };
  const hudProjection: MechaHudProjection = {
    label: t("机甲战棋 1.5", "Mecha tactics 1.5"),
    sourcePhase: state.match.phase,
    objective: {
      goal: display.mission ? t("任一存活机甲抵达救援点", "Reach the rescue point with a surviving mech")
        : defendedBuildings.length ? t("消灭所有敌人 · 至少保住一栋防守建筑", "Defeat all enemies and protect at least one building") : t("消灭所有敌人", "Defeat all enemies"),
      buildings: display.buildings.map(building => ({ id: building.id, hp: building.hp, maxHp: building.maxHp })),
      forecast: projectedHp === null ? null : `${projectedHp}/${defendedMax}`,
    },
    threats: intents.map(intent => ({ actor: intent.actor, cells: intent.targets })),
    roster: state.match.mechs.map(unit => ({
      id: unit.id,
      maxHp: unitMaxHp(unit.id, display),
      statuses: (display.statusEncounter?.statuses ?? []).filter(status => status.target === unit.id).map(status => ({
        icon: ({ poison: "☠️", burn: "🔥", freeze: "🧊", stun: "💫" } as const)[status.kind],
        label: `${status.kind} · ${status.remainingTurns}`,
      })),
      rights: { move: Boolean(state.rights?.[unit.id].move && !restrictions(unit.id).move), action: canAct(unit.id) },
    })),
    actions: actionRows.map(row => ({ kind: row.key as Action["kind"], label: row.label, enabled: !row.disabled })),
    targets: targetOptions.map(option => ({ id: String(option.actionIndex), label: option.id, cells: option.cells })),
    preview: action ? { status: preview?.ok ? "ready" : preview ? "invalid" : "unavailable", damage: hudDamage } : null,
    replay: replay ? { step: replay.index, total: replay.records.length } : null,
    notices: [
      ...(viewError ? [{ kind: "error" as const, text: viewError }] : []),
      ...(state.error ? [{ kind: "error" as const, text: state.error }] : []),
      ...(archiveMessage ? [{ kind: "status" as const, text: archiveMessage }] : []),
    ],
  };
  const hudModel: MechaHudModel = buildSequentialHud(state, hudProjection);
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
  return <MechaHud className="mecha-overlay is-city has-match is-reference-hud mecha-v15" model={hudModel} actions={hudActions} mapFocus={mapFocused} dataMechaV15>
    <CityMechaWorld ref={worldRef} engine={engine} site={site} locale={locale} view={view} performance={performance} paused={false} connectedAssault={connectedAssault} onPerformanceComplete={finishPresentation} onCell={(x, y) => {
      const cell = { x, y };
      setMapFocused(false);
      if (mapFocused || locked) {
        if (!presentation && !replayAnimation) setInspectedCell(cell);
      } else performCell(cell);
    }} onHoverEnemy={setHoveredEnemy} onUnavailable={reason => setViewError(reason ?? "mode")} />
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
          {attackOrderPreview?.ok ? <ol className="mecha-attack-order">{attackOrderPreview.steps.map(step => {
            const actorLabel = step.actor === "boss" ? t("大怪", "Boss") : step.actor === "status" ? t("环境与状态", "Environment and status") : step.actor;
            const cancelLabel = step.cancel === "dead" ? t("已消灭，跳过", "Defeated; skipped") : step.cancel === "frozen" ? t("冻结，无法行动", "Frozen; cannot act") : step.cancel === "stunned" ? t("眩晕，无法行动", "Stunned; cannot act") : step.cancel === "battle_over" ? t("对局结束，后续跳过", "Match ended; skipped") : step.cancel === "no_target" ? t("没有可结算目标", "No valid target") : "";
            const changes = [...Object.entries(step.outcome.hp).map(([id, delta]) => `${gameText(NAMES[id as MechId], locale)} ${delta > 0 ? "+" : ""}${delta} HP`), ...Object.entries(step.outcome.buildings).map(([id, delta]) => `${t("建筑", "Building")} ${id} ${delta > 0 ? "+" : ""}${delta} HP`)];
            const skill = step.skill === "status_tick" ? t("毒/燃烧结算", "Poison/burn tick") : step.skill === "environment_tick" ? t("环境结算", "Environment tick") : step.skill;
            return <li key={`${step.order}-${step.actor}`} data-attack-order-step data-order={step.order} data-cancel={step.cancel || undefined}>
              <span>{step.order}. {actorLabel} · {skill}{cancelLabel ? ` · ${cancelLabel}` : ""}</span>
              <small>{changes.length ? changes.join(" · ") : cancelLabel || t("未造成生命值变化", "No HP change")}</small>
            </li>;
          })}</ol> : <p role="status">{attackOrderPreview ? t("敌方顺序预测不可用。", "Enemy order preview is unavailable.") : t("当前无法预测敌方行动。", "Enemy actions cannot be previewed now.")}</p>}
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
          <button type="button" className="mecha-submit-primary" disabled={locked || Boolean(state.match.outcome)} onClick={hudActions.endTurn}>{t("结束回合", "End turn")}</button>
          <button type="button" className="mecha-reset-turn" disabled={locked || state.resetUsed} onClick={hudActions.resetTurn}>{t("重置回合", "Reset turn")} ({state.resetUsed ? 0 : 1}/1)</button>
        </div>}
      </MechaTeamTurnControls>
      <MechaRoster className="mecha-v15-roster" label={t("选择机甲", "Select mech")} rows={rosterRows.map(row => ({ ...row, onSelect: select, draft: undefined, openingSuggestion: false, hitDamage: null, locale }))} />
      </>}
      </MechaTeamPanel>
      {state.placements && !replay ? <MechaDeploymentActionsView locale={locale} selected={state.selected} cells={state.deployable} disabled={locked} onPlace={(id, cell) => controller.place(id, cell)} /> : <MechaCommandPanel
        label={t("当前机甲行动", "Selected mech actions")}
        heading={<h3 tabIndex={-1}><span>{t("操作机甲", "Selected mech") + " · " + gameText(NAMES[state.selected], locale)}</span><span className="mecha-selected-hp">{selected?.hp ?? 0} / {unitMaxHp(state.selected, display) ?? "?"} HP</span></h3>}
        instruction={<>{hudStatusNote && <p className="mecha-v15-note" role="status">{hudStatusNote}</p>}{targetOptions.length > 0 && <p className="mecha-target-instruction">{t("点击高亮目标切换预览，再确认行动。", "Click a highlighted target to preview it, then confirm the action.")}</p>}</>}
        deck={<MechaCommandDeck portrait={<MechaUnitPortrait unitId={state.selected} locale={locale} size={64} className="mecha-selected-portrait" decorative={false} />} columns={actionRows.length}>
          {actionRows.map((row, index) => <MechaActionCard key={row.key} type="button"
            className={row.disabled ? "is-unavailable" : row.selected ? "is-selected" : ""} title={row.title}
            aria-pressed={row.selected} disabled={row.disabled || locked || Boolean(state.placements) || Boolean(replay)}
            onClick={() => { const kind = actionKinds[index]; if (kind) hudActions.chooseAction(kind); }}
            label={row.label} icon={row.icon} status={row.status ?? t("选择行动", "Select action")} />)}
        </MechaCommandDeck>}
        utilities={<div className="mecha-actions mecha-action-utilities">
          <button type="button" className="mecha-submit-primary" disabled={!action || !preview?.ok || locked || Boolean(state.placements) || Boolean(replay)} onClick={hudActions.confirmAction}>{t("确认行动", "Confirm action")}</button>
          <button type="button" title={undoHint} disabled={!state.canUndo || locked || Boolean(state.placements) || Boolean(replay)} onClick={hudActions.undoMove}>{t("撤销移动", "Undo move")}</button>
        </div>}
        target={<>
          {targetingKind && <div className="mecha-target-preview" aria-label={t("目标试算", "Target preview")}>
            <p>{t("选择目标后确认行动。", "Choose a target, then confirm the action.")}</p>
            <MechaTargetOptions options={targetOptions.map(option => ({ key: String(option.actionIndex), selected: actionIndex === String(option.actionIndex),
              label: <>{option.id in NAMES ? gameText(NAMES[option.id as MechId], locale) : option.id === "boss" ? t("大怪", "Boss") : t("小怪", "Enemy")} · {option.cells.map(cell => `${cell.x},${cell.y}`).join("、")}</> }))}
              disabled={locked} empty={t("无合法目标", "No legal target")} onSelect={key => hudActions.pickTarget(targetOptions.findIndex(option => String(option.actionIndex) === key))} />
          </div>}
          {action && <div className="mecha-v15-preview" aria-live="polite"><strong>{t("行动预览", "Action preview")}</strong>
            {previewEvidence?.ok ? previewEvidence.health.steps.length === 0 && <p>{t("生命值无变化。", "No health change.")}</p> : <p>{t("预览证据不足，无法显示伤害。", "Preview evidence is incomplete; damage is unavailable.")}</p>}
            {hudDamage.length > 0 && <ul>{hudDamage.map((item, index) => <li key={`${item.target}:${index}`}>{item.target}: {item.before} → {item.after}</li>)}</ul>}
            {hudDisplacement.map((message, index) => <p key={`${message}:${index}`}>{message}</p>)}
          </div>}
        </>}
        movement={<MechaMoveList id="v15-cell" summary={t("通过列表移动", "Move using a list")}
          label={state.placements ? t("部署坐标", "Deployment cell") : t("移动坐标", "Move to")}
          placeholder={t("选择坐标", "Select cell")} applyText={state.placements ? t("放置", "Place") : t("移动", "Move")}
          options={available.map(cell => ({ value: cellKey(cell), label: `${cell.x}, ${cell.y}` }))}
          value={choice} disabled={locked || available.length === 0} onChange={setChoice}
          onApply={() => { const cell = available.find(item => cellKey(item) === choice); if (cell) performCell(cell); }} />}
        >
        {confirmEnd && <div role="alert" className="mecha-v15-confirm"><p>{t("仍可行动", "Still able to act")}: {state.match.mechs.filter(unit => unit.hp > 0 && canAct(unit.id)).map(unit => gameText(NAMES[unit.id], locale)).join("、")}。 {t("结束回合将放弃这些机会。", "Ending the turn forfeits those actions.")}</p><div className="mecha-v15-row"><button type="button" onClick={() => hudActions.confirmEndTurn(true)}>{t("确认结束", "End turn")}</button><button type="button" onClick={() => setConfirmEnd(false)}>{t("继续行动", "Continue")}</button></div></div>}
        {selectedStatuses.length > 0 && <details className="mecha-v15-status"><summary>{t("当前状态", "Current statuses")}</summary><ul>{selectedStatuses.map(status => { const name = locale === "en" ? { poison: "Poison", burn: "Burn", freeze: "Freeze", stun: "Stun" }[status.kind] : { poison: "中毒", burn: "燃烧", freeze: "冻结", stun: "眩晕" }[status.kind]; const effect = status.kind === "poison" || status.kind === "burn" ? t("回合结束伤害", "End-of-turn damage") + " " + status.magnitude : status.kind === "freeze" ? t("不能主动移动", "Cannot move voluntarily") : t("不能主动移动或行动", "Cannot move or act voluntarily"); return <li key={status.target + ":" + status.kind + ":" + status.source}>{name} · {effect} · {t("剩余回合", "Turns remaining")} {status.remainingTurns} · {t("来源", "Source")}: {status.source === "boss" ? t("大怪", "Boss") : t("敌人", "Enemy")}</li>; })}</ul></details>}
        {replay && <div className="mecha-v15-replay-controls"><p>{t("逐步播放已验证的行动；重置直接显示恢复后的棋盘。", "Step through verified actions; reset shows the restored board immediately.")} · {replay.index ? replayLabel(replay.records[replay.index - 1]!) : t("部署完成", "Deployment complete")}</p><div className="mecha-v15-row"><button type="button" disabled={Boolean(replayAnimation) || replay.index === 0} onClick={() => setReplay({ ...replay, index: replay.index - 1 })}>{t("上一步", "Previous")}</button><button type="button" disabled={Boolean(replayAnimation) || replay.index === replay.records.length} onClick={() => { const record = replay.records[replay.index]!; const before = replay.index === 0 ? replay.initial : replay.records[replay.index - 1]!.snapshot.match; setReplay({ ...replay, index: replay.index + 1 }); if (record.events.length) setReplayAnimation({ before, after: record.snapshot.match, record }); }}>{t("下一步", "Next")}</button><button type="button" onClick={() => { setReplayAnimation(null); setReplay(null); }}>{t("返回对局", "Return to match")}</button></div>{replayAnimation && verified?.ok && performance && <button type="button" onClick={finishPresentation}>{t("跳过演出", "Skip animation")}</button>}{replay.index === replay.records.length && !display.outcome && <button type="button" disabled={Boolean(replayAnimation) || archiveBusy || recoveryError || !recovery || recovery.pending} onClick={() => void resumeSaved()}>{t("继续此对局", "Resume this match")}</button>}</div>}
      </MechaCommandPanel>}
      {cellInfo && <MechaCellInspector key={cellKey(cellInfo.cell)} info={cellInfo} locale={locale} onClose={() => setInspectedCell(null)} sequential />}
      {!replay && <details className="mecha-v15-replays"><summary>{t("本地回放", "Local replays")}</summary><p className="mecha-v15-note">{t("仅能在相同城市战场重建；保存后会重新校验。", "Rebuilds only on the same city battlefield; saves are rechecked.")}</p><button type="button" disabled={archiveBusy || Boolean(presentation) || state.persistence !== "ready" || !controller.hasReplayEvidence()} onClick={() => void save()}>{t("保存当前回放", "Save current replay")}</button><label htmlFor="v15-replay-choice">{t("选择回放", "Select replay")}</label><select id="v15-replay-choice" value={archiveChoice} disabled={archiveBusy || !archiveEntries.length} onChange={event => setArchiveChoice(event.currentTarget.value)}><option value="">{t("选择回放", "Select replay")}</option>{archiveEntries.map(entry => <option key={entry.key} value={entry.key}>{entry.damaged ? t("损坏的记录", "Damaged record") : entry.savedAt}</option>)}</select><div className="mecha-v15-row"><button type="button" disabled={archiveBusy || Boolean(presentation) || state.persistence === "saving" || state.persistence === "unconfirmed" || !archiveChoice || archiveEntries.find(entry => entry.key === archiveChoice)?.damaged} onClick={() => void load()}>{t("查看回放", "View replay")}</button><button type="button" disabled={archiveBusy || !archiveChoice} onClick={() => void remove()}>{t("删除回放", "Delete replay")}</button></div></details>}
      {presentation && verified?.ok && performance && <button className="mecha-v15-skip" type="button" onClick={finishPresentation}>{t("跳过演出", "Skip animation")}</button>}
    </div>
    {showGuide && <MechaQuickGuide locale={locale} mode="sequential" returnFocusRef={guideTrigger} onClose={() => setShowGuide(false)} />}
  </MechaHud>;
}
