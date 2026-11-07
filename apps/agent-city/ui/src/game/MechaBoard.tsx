import { MechaPlanEvaluation } from "./MechaPlanEvaluation";
import { MechaCandidateConsequences } from "./MechaCandidateConsequences";
import { forecastFizzles } from "./mecha/fizzleForecast";
import { ACTION_DESCRIPTIONS, shotCheckLabel } from "./mecha/actionDescriptions";
import { MechaDeploymentPanel, MechaDeploymentActions } from "./MechaDeploymentPanel";
import { SequentialMechaMatch } from "./SequentialMechaMatch";
import { MechaHud } from "./MechaHudLayout";
import { useMechaSettings } from "./useMechaSettings";
import { MechaMoveList } from "./MechaMoveList";
import { MechaBattlefieldControls, MechaBattleMenu, MechaCommandDeck, MechaCommandPanel, MechaObjectiveCard, MechaObjectivePanel, MechaObjectiveToggle, MechaSelectedActionsPanel, MechaSettingsPopover, MechaTargetOptions, MechaTeamPanel, MechaTeamTurnControls, MechaThreatSourceList, MechaTurnOrder } from "./MechaHudPanels";
import type { StatusMonsterId } from "./mecha/sequentialReplayBundle";
/** City test surface for GDD v1.3. Rules live in `mecha/rules.ts`.
 *
 *  The battlefield search is not a render side effect. The board shell paints
 *  first, the city adapter samples every point the search can query into a
 *  transferable snapshot, and the search itself runs in a worker (or a sliced
 *  main-thread fallback). A successful catalog is cached per layout+model so
 *  reopening is instant; a city revision that lands mid-search aborts the old
 *  run instead of letting a stale catalog reach the board.
 *
 *  The fight only exists on the city apron. An empty catalog, a failed search,
 *  a missing city, or a 3D view owned by another mode stays on this overlay
 *  and does not open a playable match. A missing apron used to fall through
 *  into a separate modal board; sparse cities always took that path.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CityEngine } from "../engine/CityEngine";
import { doctrineFocusLine, fizzleText, gameText, previewFaultText, type GameLocale } from "./gameCopy";
import { CityMechaWorld, type CityMechaView, type CityMechaWorldHandle } from "./CityMechaWorld";
import { MechaCellInspector } from "./MechaCellInspector";
import { inspectCell, declaredAttack, inspectionSegments } from "./mecha/cellInspection";
import { declaredEnemyIntents } from "./mecha/enemyIntentPresentation";
import { previewEnemyPhase } from "./mecha/enemyPhasePreview";
import { draftPlan } from "./mecha/planning";
import { MechaActionIcon } from "./MechaActionIcon";
import { MechaActionCard } from "./MechaActionCard";
import { unitMaxHp } from "./mecha/unitHealth";
import { projectMechPositions, projectPlannedMoves } from "./mecha/presentation/mechPositions";
import { MechaBattleLegend } from "./MechaBattleLegend";
import { MechaRoster } from "./MechaPlanCard";
import { MechaUnitAvatar, MechaUnitPortrait } from "./MechaUnitAvatar";
import { getUnitPortrait } from "./mecha/unitPortraits";
import { terrainSurfaceHeight } from "../engine/surface/terrainSampling";
import { sampleAssaultTerrainSafety } from "./mecha/assaultTerrainSafety";
import { MechaLastResult } from "./MechaLastResult";
import { MechaBattleResult } from "./MechaMatchResult";
import { MechaQuickGuide } from "./MechaQuickGuide";
import { MechaMonsterPractice, MechaPrismShieldStatus } from "./MechaMonsterPractice";
import { MechaCorrodeSummary, MechaMonsterIntent } from "./MechaMonsterIntent";
import { monsterSkillName } from "./mecha/skillNames";
import type { PlannedMonsterSpeciesId } from "./mecha/monsters/contracts";
import { monsterCatalogEntry, practiceSpecies } from "./mecha/monsters/catalog";
import { P2_SCENARIOS, resolveP2Scenario } from "./mecha/p2Scenarios";
import { candidateResult } from "./mecha/candidateResult";
import { assaultSequenceWaiting } from "./mecha/assaultTurnPlayer";
import type { DoctrineId } from "./mecha/ai";
import { createMechaController, type MechaController } from "./mecha/controller";
import { buildClassicHud } from "./mecha/hud/adapters";
import type { MechaHudActions, MechaHudModel, MechaHudProjection } from "./mecha/hud/model";
import { readMechaRuntime } from "./MechaModeRuntime";
import type { ReleaseChoice } from "./mecha/mode";
import { anchorsFromCity, prepareFightTerrainAsync, type FightCatalog, type FightShape } from "./mecha/citySite";
import { startPreparedSearch } from "./mecha/fightSearchRunner";
import { cacheCatalog, cachedCatalog, encounterIsCurrent, forgetCatalog, type MonsterEncounter } from "./mecha/monsterEncounters";
import type { RemoteMechaStatus } from "./mecha/remoteRequest";
import {
  FLAT_SPAWN_MAX_DELTA, MAX_TURNS, living, stakeBuildings,
  type Action, type BossScriptId, type Cell, type MechId,
} from "./mecha/rules";
import "./game.css";
import "./mechaReferenceHud.css";

const SCRIPTS: Array<{ id: BossScriptId; label: string }> = [
  { id: "cadence_ssw", label: "砸砸扫" },
  { id: "stationary_smash", label: "站桩砸击" },
  { id: "siege", label: "大怪与小怪" },
];
const DOCTRINES: Array<{ id: DoctrineId; label: string }> = [
  { id: "tunnel", label: "攻坚" },
  { id: "peel", label: "守楼" },
];
const SHAPES: Array<{ id: FightShape; label: string }> = [
  { id: "flat", label: "平地" },
  { id: "shore", label: "靠岸" },
  { id: "ridge", label: "翻山" },
  { id: "alley", label: "巷战" },
];
const NAMES: Record<MechId, string> = { Assault: "突击", Gunner: "射手", Support: "支援" };

/** Closed details can still report geometry for their unpainted descendants. */
function inClosedDetails(node: Node, panel: HTMLElement): boolean {
  for (let element = node instanceof Element ? node : node.parentElement; element && element !== panel; element = element.parentElement) {
    if (element instanceof HTMLDetailsElement && !element.open && !element.querySelector(":scope > summary")?.contains(node)) return true;
  }
  return false;
}

/** Fit the initial scrollport edge between rendered lines/controls rather than
 * through one. Offscreen content remains in the same keyboard-scrollable DOM. */
function wholeLineHeight(panel: HTMLElement, limit: number): number {
  const bounds = panel.getBoundingClientRect();
  const border = parseFloat(getComputedStyle(panel).borderBottomWidth) || 0;
  const boxes: Array<{ top: number; bottom: number }> = [];
  const collect = (rect: DOMRect) => boxes.push({ top: rect.top - bounds.top, bottom: rect.bottom - bounds.top });
  const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent?.trim() || node.parentElement?.closest(".mecha-sr-only") || inClosedDetails(node, panel)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) if (rect.width && rect.height) collect(rect);
  }
  for (const control of panel.querySelectorAll<HTMLElement>("button, summary, select, input")) {
    const rect = control.getBoundingClientRect();
    if (rect.width && rect.height && !inClosedDetails(control, panel)) collect(rect);
  }
  // A control can contain wrapped text. Cutting before one crossing box may
  // bisect a different line, so re-evaluate the new edge until it is clear.
  let cut = Math.floor(limit - border);
  for (let pass = 0; pass < boxes.length; pass += 1) {
    const crossing = boxes.filter((rect) => rect.top < cut && rect.bottom > cut && rect.top > 24);
    if (!crossing.length) break;
    const next = Math.floor(Math.min(...crossing.map((rect) => rect.top)) - 2);
    if (next >= cut) break;
    cut = next;
  }
  return Math.min(limit, cut + border);
}

function catalogPlayable(catalog: FightCatalog | null): catalog is FightCatalog {
  return Boolean(catalog && SHAPES.some((item) => catalog[item.id]));
}

export type MechaAvailability = "searching" | "ready" | "empty" | "error";

type SearchPhase = "loading" | "ready" | "error";

function CityGate({ locale, onClose, title, body, busy, extra, onRetry, closeDisabled, recovery }: {
  locale: GameLocale;
  onClose: () => void;
  title: string;
  body: string;
  busy?: boolean;
  extra?: string | null;
  onRetry?: () => void;
  closeDisabled?: boolean;
  recovery?: React.ReactNode;
}) {
  const t = (text: string) => gameText(text, locale);
  return (
    <section className="mecha-overlay is-city" role="dialog" aria-label={t("机甲战棋")} aria-busy={busy || undefined}>
      <header className="mecha-battle-bar">
        <div><strong>{t("机甲战棋")}</strong></div>
        <div className="mecha-battle-controls"><button type="button" disabled={closeDisabled} onClick={onClose}>{t("退出战斗")}</button></div>
      </header>
      <div className="mecha-panel">
        <div className="mecha-city-gate">
          <p role={busy ? "status" : "alert"}>{t(title)}</p>
          <p className="mecha-help">{t(body)}</p>
          {extra ? <p className="mecha-help">{extra}</p> : null}
          {recovery}
          <div className="mecha-actions">
            {onRetry ? <button type="button" onClick={onRetry}>{t("重试")}</button> : null}
            <button type="button" disabled={closeDisabled} onClick={onClose}>{busy ? t("取消") : t("关闭")}</button>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Loads (or reuses) the four-shape catalog, then mounts a match keyed by it. */
export function MechaBoard({ locale, onClose, engine, onAvailability, encounter }: {
  locale: GameLocale;
  onClose: () => void;
  engine: CityEngine | null;
  onAvailability?: (next: MechaAvailability) => void;
  encounter?: MonsterEncounter | null;
}) {
  const t = (text: string) => gameText(text, locale);
  const [catalog, setCatalog] = useState<FightCatalog | null>(() => cachedCatalog(engine?.currentLayout ?? null, engine?.currentModel ?? null));
  const [phase, setPhase] = useState<SearchPhase>(() => {
    if (!engine) return "ready";
    const layout = engine.currentLayout;
    const model = engine.currentModel;
    if (!layout || !model) return "ready";
    return cachedCatalog(layout, model) ? "ready" : "loading";
  });
  const [checked, setChecked] = useState(0);
  const [sampled, setSampled] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [retry, setRetry] = useState(0);
  const [runId, setRunId] = useState(0);
  const [remoteStatus, setRemoteStatus] = useState<RemoteMechaStatus>("idle");
  const [releaseMode, setReleaseMode] = useState<ReleaseChoice>("");
  const [releaseStatus, setReleaseStatus] = useState<StatusMonsterId | null>(null);
  const [releaseMonster, setReleaseMonster] = useState<PlannedMonsterSpeciesId | null>(null);
  const remoteLocked = useRef(false);
  const changeRemoteStatus = (next: RemoteMechaStatus) => {
    remoteLocked.current = next !== "idle";
    setRemoteStatus(next);
  };
  const requestMatchClose = useRef<(() => void) | null>(null);
  const searchSeq = useRef(0);
  const playable = phase === "ready" && Boolean(engine) && catalogPlayable(catalog);
  const runtime = readMechaRuntime({ remoteStatus, releaseChoice: releaseMode, releaseStatus, releaseMonster, encounterActive: Boolean(encounter) });

  useEffect(() => {
    if (!onAvailability) return;
    if (phase === "loading") onAvailability("searching");
    else if (phase === "error") onAvailability("error");
    else onAvailability(playable ? "ready" : "empty");
  }, [onAvailability, phase, playable]);

  useEffect(() => {
    if (!engine) {
      setCatalog(null);
      setPhase("ready");
      return undefined;
    }
    const layout = engine.currentLayout;
    const model = engine.currentModel;
    if (!layout || !model) {
      // 城市还没建模完：拒绝开战。以前这里会把 phase 设成 ready，然后用另一套棋盘把对局开起来。
      setCatalog(null);
      setPhase("ready");
      return undefined;
    }
    const cached = cachedCatalog(layout, model);
    if (cached) {
      setCatalog(cached);
      setPhase("ready");
      return undefined;
    }
    const controller = new AbortController();
    let alive = true;
    let cancelSearch: (() => void) | null = null;
    setPhase("loading");
    setChecked(0);
    setSampled({ done: 0, total: 0 });
    void (async () => {
      try {
        const anchors = anchorsFromCity(layout, model);
        const snapshot = await prepareFightTerrainAsync(layout.terrain, anchors, {
          signal: controller.signal,
          sliceMs: 8,
          onProgress: (done, total) => { if (alive) setSampled({ done, total }); },
        });
        if (!alive) return;
        snapshot.revision = ++searchSeq.current;
        cancelSearch = startPreparedSearch(snapshot, layout.roadEdges, {
          onProgress: (evaluated) => { if (alive) setChecked(evaluated); },
          onResult: (next) => {
            if (!alive) return;
            cacheCatalog(layout, model, next);
            setCatalog(next);
            setRunId((value) => value + 1);
            setPhase("ready");
          },
          onError: (reason) => {
            if (!alive) return;
            console.warn("mecha city site failed", reason);
            setPhase("error");
          },
        }, controller.signal).cancel;
      } catch (reason) {
        if (!alive || (reason as { name?: string } | null)?.name === "AbortError") return;
        console.warn("mecha city site failed", reason);
        setPhase("error");
      }
    })();
    return () => {
      alive = false;
      controller.abort();
      cancelSearch?.();
    };
  }, [engine, engine?.currentLayout, engine?.currentModel, retry]);

  // Escape closes the board before the settings/cinema handlers see it. A focused
  // select keeps its own Escape (closing the menu, not the match).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Native dialogs consume Escape via their cancel handlers; do not close the match.
      if (document.querySelector("[data-mecha-quick-guide][open]")) return;
      // The native result dialog handles Escape via onCancel; it has no view button.
      if (document.querySelector("[data-mecha-result-dialog][open]")) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("select, input, textarea")) return;
      const settingsClose = document.querySelector<HTMLButtonElement>(".mecha-settings-popover:not([hidden]) .mecha-settings-close");
      if (settingsClose) { event.preventDefault(); event.stopPropagation(); settingsClose.click(); return; }
      if (remoteLocked.current) { event.preventDefault(); event.stopPropagation(); return; }
      event.preventDefault();
      if (requestMatchClose.current) requestMatchClose.current(); else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const retrySearch = () => {
    forgetCatalog(engine?.currentLayout ?? null);
    setCatalog(null);
    setPhase("loading");
    setRetry((value) => value + 1);
  };

  if (encounter && !encounterIsCurrent(encounter, engine?.currentLayout ?? null, engine?.currentModel ?? null)) {
    return <CityGate locale={locale} onClose={onClose} title="遭遇点已失效" body="城市布局已变化，请返回小地图重新选择怪兽。" />;
  }

  if (phase === "loading") {
    const progress = sampled.total > 0 && sampled.done < sampled.total
      ? `${t("正在读取城市地形")} ${sampled.done}/${sampled.total}`
      : checked > 0 ? `${t("正在检查")} ${checked} ${t("个候选")}` : null;
    return (
      <CityGate locale={locale} onClose={onClose} busy title="正在选择战场…" body="正在这座城市的地面上找机坪。" extra={progress} />
    );
  }

  if (phase === "error") {
    return (
      <CityGate locale={locale} onClose={onClose} onRetry={retrySearch} title="战场选择失败" body="城市地形暂时无法生成战场，可以重试或关掉战棋。" />
    );
  }

  if (!engine || !catalogPlayable(catalog)) {
    const noCity = !engine || !engine.currentLayout || !engine.currentModel;
    return noCity
      ? <CityGate locale={locale} onClose={onClose} title="这座城还没准备好，不能开战。" body="等城市准备好再试，或关掉战棋。" />
      : <CityGate locale={locale} onClose={onClose} onRetry={retrySearch} title="这座城暂时没有可用机坪。" body="当前城市中未找到符合地形和占位条件的战场。可以重试，或关掉战棋。" />;
  }

  const sequentialSite = encounter?.site ?? SHAPES.map(shape => catalog[shape.id]).find(Boolean) ?? null;
  switch (runtime.mode.kind) {
    case "picker":
      return <CityGate locale={locale} onClose={onClose} title={t("选择战斗规则")} body={t("机甲战棋 1.5 使用逐台行动与即时结算。")} recovery={<div className="mecha-actions">
        <button type="button" onClick={() => setReleaseMode("sequential")}>{t("机甲战棋 1.5 · 本地 PvE")}</button>
        <button type="button" onClick={() => { setReleaseStatus(null); setReleaseMode("status"); }}>{t("状态效果挑战")}</button>
        <button type="button" onClick={() => { setReleaseMonster(null); setReleaseMode("practice"); }}>{t("怪物练习 · 1.5")}</button>
      </div>} />;
    case "closed": {
      const title = runtime.mode.reason === "invalid_status_species" ? t("状态挑战参数无效")
        : runtime.mode.reason === "status_challenge_encounter" ? t("状态挑战不能使用城市遭遇点")
          : t("战斗模式暂不可用");
      const body = runtime.mode.reason === "status_challenge_encounter" ? t("请返回并单独选择状态效果挑战。")
        : runtime.mode.reason === "invalid_status_species" ? t("请选择受支持的本地状态挑战。")
          : t("当前构建或模式参数无效，请返回后重试。");
      return <CityGate locale={locale} onClose={onClose} title={title} body={body} />;
    }
    case "practice": {
      if (!runtime.mode.species) return <CityGate locale={locale} onClose={onClose} title={t("选择怪物练习")} body={t("用 v1.5 逐台行动规则试玩已接入的怪物。")} recovery={<div className="mecha-actions">
        {practiceSpecies().map(speciesId => <button key={speciesId} type="button" onClick={() => setReleaseMonster(speciesId)}>{locale === "en" ? monsterCatalogEntry(speciesId)?.nameEn ?? speciesId : t(monsterCatalogEntry(speciesId)?.name ?? speciesId)} · 1.5</button>)}
        <button type="button" onClick={() => { setReleaseMode(""); setReleaseMonster(null); }}>{t("返回")}</button>
      </div>} />;
      if (!sequentialSite) return <CityGate locale={locale} onClose={onClose} title={t("这座城暂时没有可用机坪。")} body={t("当前城市中未找到符合地形和占位条件的战场。可以重试，或关掉战棋。")} />;
      return <SequentialMechaMatch key={`${runId}-${runtime.mode.species}`} engine={engine} site={sequentialSite} locale={locale} onClose={onClose} requestCloseRef={requestMatchClose} monsterSpecies={runtime.mode.species} connectedAssault={runtime.connectedAssault} />;
    }
    case "status":
      if (!runtime.mode.species) return <CityGate locale={locale} onClose={onClose} title={t("选择状态效果挑战")} body={t("使用当前城市战场，挑战带有一种特殊状态技能的怪物。")} recovery={<div className="mecha-actions">
        {([["spore_leaper", "孢群体 · 中毒"], ["flux_lancer", "流环体 · 燃烧"], ["prism_warden", "晶簇体 · 冻结"], ["gravity_core", "引力核 · 眩晕"]] as const).map(([id, label]) => <button key={id} type="button" onClick={() => setReleaseStatus(id)}>{t(label)}</button>)}
        <button type="button" onClick={() => { setReleaseMode(""); setReleaseStatus(null); }}>{t("返回")}</button>
      </div>} />;
      if (!sequentialSite) return <CityGate locale={locale} onClose={onClose} title={t("这座城暂时没有可用机坪。")} body={t("当前城市中未找到符合地形和占位条件的战场。可以重试，或关掉战棋。")} />;
      return <SequentialMechaMatch key={runId} engine={engine} site={sequentialSite} locale={locale} onClose={onClose} requestCloseRef={requestMatchClose} statusSpecies={runtime.mode.species} connectedAssault={runtime.connectedAssault} />;
    case "sequential":
      if (!sequentialSite) return <CityGate locale={locale} onClose={onClose} title={t("这座城暂时没有可用机坪。")} body={t("当前城市中未找到符合地形和占位条件的战场。可以重试，或关掉战棋。")} />;
      return <SequentialMechaMatch key={runId} engine={engine} site={sequentialSite} locale={locale} onClose={onClose} requestCloseRef={requestMatchClose} connectedAssault={runtime.connectedAssault} />;
  }
}

function enemyName(id: string): string {
  if (id === "boss") return "大怪";
  if (id === "raider-w") return "小怪西";
  if (id === "raider-e") return "小怪东";
  return "小怪";
}


function actionLabel(kind: Action["kind"]): string {
  if (kind === "melee") return "近战";
  if (kind === "shoot") return "射击";
  if (kind === "charge") return "冲撞";
  if (kind === "pierce") return "穿射";
  if (kind === "repair") return "维修";
  return "待机";
}


/** 薄视图：状态、草稿、预检、结算、自动对战都在 controller 里，这里只订阅与渲染。
 *  没有城市战场时父级不会挂这个组件。 */
function MechaMatch({ locale, onClose, requestCloseRef, engine, catalog, initialShape, remoteStatus, remoteLocked, onRemoteStatusChange, connectedAssault, assaultSequenceTrial }: {
  locale: GameLocale;
  onClose: () => void;
  requestCloseRef: React.RefObject<(() => void) | null>;
  engine: CityEngine;
  catalog: FightCatalog;
  initialShape?: FightShape;
  remoteStatus: RemoteMechaStatus;
  remoteLocked: React.RefObject<boolean>;
  onRemoteStatusChange: (status: RemoteMechaStatus) => void;
  connectedAssault: boolean;
  assaultSequenceTrial: boolean;
}) {
  const t = (text: string) => gameText(text, locale);
  const safeCatalog = useMemo<FightCatalog>(() => {
    if (!connectedAssault) return catalog;
    const layout = engine.currentLayout;
    const result: FightCatalog = { flat: null, shore: null, ridge: null, alley: null };
    if (!layout) return result;
    for (const { id } of SHAPES) {
      const candidate = catalog[id];
      if (!candidate) continue;
      try {
        const safety = sampleAssaultTerrainSafety(candidate, (x, z) => terrainSurfaceHeight(layout, x, z), 2, .5, .25);
        const spawn = candidate.mechs.find((mech) => mech.id === "Assault")?.pos;
        if (!spawn || safety.unsafeCells.some((cell) => cell.x === spawn.x && cell.y === spawn.y)) continue;
        result[id] = { ...candidate, assaultTerrainSafety: safety };
      } catch (error) {
        console.warn("Assault terrain safety failed", id, error);
      }
    }
    return result;
  }, [catalog, connectedAssault, engine, engine.currentLayout]);
  const [shape, setShape] = useState<FightShape>(initialShape ?? "flat");
  const shapeId: FightShape = safeCatalog[shape] || initialShape && shape === initialShape ? shape : (SHAPES.find((item) => safeCatalog[item.id])?.id ?? "flat");
  const site = safeCatalog[shapeId] ?? null;
  const [viewFailed, setViewFailed] = useState<"mode" | "preview" | "asset" | null>(null);
  const [previewLoading, setPreviewLoading] = useState(() => connectedAssault);
  const remoteActive = remoteStatus !== "idle";
  const [showOrder, setShowOrder] = useState(false);
  const [showQuickGuide, setShowQuickGuide] = useState(false);
  const [scenarioId, setScenarioId] = useState("");
  const [confirmScenario, setConfirmScenario] = useState(false);
  const [scenarioNotice, setScenarioNotice] = useState<string | null>(null);
  const [practiceNotice, setPracticeNotice] = useState<string | null>(null);
  const guideTrigger = useRef<HTMLElement | null>(null);
  const [compactSummary, setCompactSummary] = useState(true);
  const [mapFocused, setMapFocused] = useState(false);
  const { settingsPanel, setSettingsPanel, closeSettings, toggleSettings } = useMechaSettings(() => setMapFocused(false));
  const [showPlanEvaluation, setShowPlanEvaluation] = useState(false);
  const [focusedBuilding, setFocusedBuilding] = useState<string | null>(null);
  const [inspectedAction, setInspectedAction] = useState<Action["kind"] | null>(null);
  const [moveChoice, setMoveChoice] = useState("");
  const [inspectedCell, setInspectedCell] = useState<Cell | null>(null);
  const [inspectedUnitId, setInspectedUnitId] = useState<string | null>(null);
  const candidateRef = useRef<HTMLDivElement | null>(null);
  const candidateScrollPanel = useRef<HTMLElement | null>(null);
  const candidateKeyboardTrigger = useRef<HTMLButtonElement | null>(null);
  const targetFocusReturn = useRef<{ trigger: HTMLButtonElement; kind: Action["kind"] } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!showOrder) return;
    const summary = panelRef.current?.querySelector<HTMLElement>(".mecha-turn-summary");
    const order = summary?.querySelector<HTMLElement>("#mecha-order-panel");
    if (!summary || !order) return;
    summary.scrollTop += order.getBoundingClientRect().top - summary.getBoundingClientRect().top - summary.clientTop;
  }, [showOrder]);
  const [submitTarget, setSubmitTarget] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (remoteActive) {
      const summary = panelRef.current?.querySelector<HTMLElement>(".mecha-turn-summary");
      if (summary) summary.scrollTop = 0;
    }
  }, [remoteActive]);
  const inspectTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const worldRef = useRef<CityMechaWorldHandle>(null);
  const [sequenceStatus] = useState<{ id: number; state: "done" | "fault" } | null>(null);

  const controllerRef = useRef<MechaController | null>(null);
  if (!controllerRef.current && site) {
    controllerRef.current = createMechaController({ animate: true, locale, site, preset: "covers_sparse_mid", script: "siege", stake: shapeId === "alley" ? "frontage" : "all" });
  }
  const controller = controllerRef.current;
  const s = useSyncExternalStore(
    controller ? controller.subscribe : () => () => {},
    controller ? controller.getState : () => null,
  );
  useEffect(() => { if (settingsPanel !== "battlefield") controller?.cancelDoctrineSuggestion(); }, [controller, settingsPanel]);
  const resolvedState = s?.match ?? null;
  const performance = s?.performance ?? null;
  const draft = s?.draft;
  const deployment = s?.replay ? null : s?.deployment ?? null;
  const selected = s?.selected;
  const targeting = s?.targeting ?? null;
  const auto = s?.auto ?? false;
  const paused = s?.paused ?? false;
  const doctrine = s?.doctrine ?? "tunnel";

  const state = performance?.before ?? resolvedState;
  const [showMatchResult, setShowMatchResult] = useState(false);
  const matchRuntime = useRef({ site, safeCatalog, viewFailed, previewLoading });
  matchRuntime.current = { site, safeCatalog, viewFailed, previewLoading };
  const requestDestructiveAction = (run: () => void) => { if (!remoteLocked.current) run(); };
  const requestClose = () => requestDestructiveAction(onClose);
  useLayoutEffect(() => {
    requestCloseRef.current = requestClose;
    return () => { requestCloseRef.current = null; };
  });
  const resultShown = useRef(false);
  const resultTrigger = useRef<HTMLButtonElement | null>(null);
  const resultReady = Boolean(state?.outcome && !performance && !remoteActive && !viewFailed);
  useEffect(() => {
    if (!resolvedState?.outcome) { resultShown.current = false; setShowMatchResult(false); return; }
    if (resultReady && !resultShown.current) {
      resultShown.current = true;
      setShowMatchResult(true);
      setShowQuickGuide(false);
      setSettingsPanel(null);
      setMapFocused(false);
    }
  }, [resolvedState?.outcome, resultReady]);
  const viewResultField = () => {
    setShowMatchResult(false);
    requestAnimationFrame(() => resultTrigger.current?.focus());
  };
  const finishPerformance = () => controller?.finishPerformance();
  useEffect(() => { setInspectedCell(null); setInspectedUnitId(null); }, [controller, site, state?.turn, performance, resolvedState]);

  const sequenceTrial = assaultSequenceTrial;
  const sequenceActive = sequenceTrial && Boolean(site && !viewFailed) && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sequenceWaiting = assaultSequenceWaiting(sequenceActive, s?.combat ?? { id: 0, actions: [] }, sequenceStatus);
  const sequenceFault = sequenceWaiting && sequenceStatus?.id === s?.combat.id && sequenceStatus?.state === "fault";

  // Settings are scrollable, but must not cover the controls that remain
  // usable while they are open. Their available height changes when, e.g.,
  // the hold confirmation expands or the selected action panel changes.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return undefined;
    const update = () => {
      const panelRect = panel.getBoundingClientRect();
      if (!panelRect.width || !panelRect.height) return;
      const pack = panel.querySelector<HTMLElement>(":scope > .mecha-team-planning .mecha-pack");
      const summary = panel.querySelector<HTMLElement>(":scope > .mecha-turn-summary");
      const team = panel.querySelector<HTMLElement>(":scope > .mecha-team-planning");
      const recap = panel.querySelector<HTMLElement>(":scope > .mecha-last-result");
      const submit = panel.querySelector<HTMLElement>(":scope > .mecha-team-planning .mecha-submit");
      const bar = panel.parentElement?.querySelector<HTMLElement>(":scope > .mecha-battle-bar");
      const barRect = bar?.getBoundingClientRect();
      const set = (name: string, value: string) => {
        if (panel.style.getPropertyValue(name) !== value) panel.style.setProperty(name, value);
      };
      const sideLayout = window.matchMedia("(min-width: 601px) and (min-height: 420px)").matches;
      const legendTop = barRect?.height ? Math.ceil(barRect.bottom - panelRect.top + 8) : 64;
      set("--mecha-legend-top", `${legendTop}px`);
      // Apply the bar height before measuring the rails: their top can move
      // without a resize event when the controls wrap during a performance.
      set("--mecha-hud-top", `${legendTop}px`);
      const packRect = pack?.getBoundingClientRect();
      const summaryRect = summary?.getBoundingClientRect();
      const teamRect = team?.getBoundingClientRect();
      const submitRect = submit?.getBoundingClientRect();
      const rosterTop = 8 + (submitRect?.height ?? 80);
      if (submit) set("--mecha-submit-height", `${Math.ceil(submit.getBoundingClientRect().height)}px`);
      if (summaryRect?.height) {
        const recapTop = Math.ceil(summaryRect.bottom - panelRect.top + 8);
        set("--mecha-recap-top", `${recapTop}px`);
        const recapHeight = recap?.getBoundingClientRect().height ?? 0;
        set("--mecha-settings-top", `${Math.ceil(recapTop + (recapHeight ? recapHeight + 8 : 0))}px`);
      }
      if (packRect?.height && summaryRect?.height) {
        // Derive the side rail's position as well as its height: moving an
        // element does not itself cause ResizeObserver to fire.
        const bottom = sideLayout ? 12 : Math.ceil(panelRect.bottom - packRect.top + 8);
        const clearance = sideLayout ? teamRect?.bottom ?? panelRect.top + rosterTop + packRect.height : summaryRect.bottom;
        const available = Math.max(40, Math.floor(panelRect.bottom - clearance - bottom - 8));
        set("--mecha-pack-bottom", `${bottom}px`);
        set("--mecha-actions-available", `${available}px`);
      }

    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(panel);
    const team = panel.querySelector<HTMLElement>(":scope > .mecha-team-planning");
    const bar = panel.parentElement?.querySelector<HTMLElement>(":scope > .mecha-battle-bar");
    if (team) observer?.observe(team);
    for (const card of panel.querySelectorAll<HTMLElement>(":scope > .mecha-turn-summary, :scope > .mecha-last-result, :scope > .mecha-selected-actions")) observer?.observe(card);
    if (bar) observer?.observe(bar);
    const legend = panel.querySelector<HTMLElement>(":scope > .mecha-tactical-legend");
    if (legend) observer?.observe(legend);
    window.addEventListener("resize", update);
    return () => { observer?.disconnect(); window.removeEventListener("resize", update); };
  }, [locale, s, viewFailed, mapFocused, remoteStatus]);

  // Content can change without the scrollport resizing (opening details,
  // changing order, or scrolling into a long result). Fit the bottom on each
  // change and settle the top after scrolling, without intercepting input.
  useLayoutEffect(() => {
    const root = panelRef.current;
    if (!root) return undefined;
    const summary = root.querySelector<HTMLElement>(":scope > .mecha-turn-summary");
    const actions = root.querySelector<HTMLElement>(":scope > .mecha-selected-actions");
    const pack = root.querySelector<HTMLElement>(":scope > .mecha-team-planning .mecha-pack");
    const result = root.querySelector<HTMLElement>(":scope > .mecha-candidate-panel");
    const inspection = root.querySelector<HTMLElement>(":scope > .mecha-cell-inspector");
    const panels = [summary, actions, pack, result, inspection].filter((panel): panel is HTMLElement => Boolean(panel));
    const sideLayout = () => window.matchMedia("(min-width: 601px) and (min-height: 420px)").matches;
    const phoneCandidate = (panel: HTMLElement) => panel === result && panel.dataset.candidateSource === "selection" && window.matchMedia("(max-width: 600px) and (min-height: 420px)").matches;
    const narrow = () => window.matchMedia("(min-width: 601px) and (max-width: 760px) and (min-height: 420px) and (max-height: 600px)").matches;
    const timers = new Map<HTMLElement, number>();
    let keyboardMode = false;
    const onKeyInput = () => { keyboardMode = true; };
    const onPointerInput = () => { keyboardMode = false; };
    const fit = (panel: HTMLElement) => {
      const name = panel === inspection ? "--mecha-inspector-fit-height" : panel === result ? "--mecha-candidate-fit-height" : panel === pack ? "--mecha-roster-fit-height" : panel === summary ? "--mecha-summary-fit-height" : "--mecha-actions-fit-height";
      if (!sideLayout()) {
        if (phoneCandidate(panel)) {
          const limit = Math.min(240, window.innerHeight * 0.3);
          let height = wholeLineHeight(panel, limit);
          const active = document.activeElement;
          if (keyboardMode && active instanceof HTMLElement && active !== panel && panel.contains(active)) {
            const rect = active.getBoundingClientRect(), edge = panel.getBoundingClientRect().top + height;
            if (rect.top < edge && rect.bottom > edge) height = limit;
          }
          const value = `${height}px`;
          if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
        } else root.style.removeProperty(name);
        return;
      }
      // The roster may grow without resizing the action panel (for example,
      // a wrapped action and an incoming-hit row). Recompute from its actual
      // edge rather than keeping a stale --mecha-actions-fit-height.
      const available = sideLayout() && pack?.getBoundingClientRect().height
        ? Math.max(40, Math.floor(root.getBoundingClientRect().bottom - pack.getBoundingClientRect().bottom - 20))
        : parseFloat(root.style.getPropertyValue("--mecha-actions-available")) || window.innerHeight * 0.3;
      const objective = panel === summary && narrow() && panel.classList.contains("is-compact") && !panel.querySelector("details[open]")
        ? panel.querySelector<HTMLElement>(".mecha-objective-card") : null;
      // Fit the compact rail to its primary card, not to whichever detail
      // happens to be partially visible below it. Card height is independent
      // of scroll position, so scrolling does not make the rail jump.
      const objectiveHeight = objective ? (() => {
        const style = getComputedStyle(panel);
        return Math.ceil(objective.offsetHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth));
      })() : Infinity;
      const rosterRoom = pack ? root.getBoundingClientRect().bottom - pack.getBoundingClientRect().top - 20 - 160 : Infinity;
      const limit = panel === inspection ? Math.min(window.innerHeight * 0.32, 260) : panel === result ? Math.min(window.innerHeight * 0.36, 280) : panel === pack ? Math.max(80, Math.min(rosterRoom, window.innerHeight * (window.innerHeight > 600 ? 0.5 : 0.43), window.innerHeight > 600 ? 360 : 320)) : panel === summary
        ? Math.min(result ? window.innerHeight * 0.38 : panel.querySelector("details[open], #mecha-order-panel") ? window.innerHeight * 0.64 : window.innerHeight * 0.38, 384, objectiveHeight)
        : available;
      // Keep every settled scrollport edge between whole lines/controls,
      // including long candidate results. The ceiling remains independent of
      // scroll position; the fit trims only a partially painted bottom row.
      // Bottom-anchored movement, deployment, and reason lists must keep a stable
      // scrollport while native scrollIntoView brings controls into view.
      // Resizing on each scroll can clip the button being revealed.
      const editingPosition = panel === actions && Boolean(panel.querySelector(".mecha-move-list[open], .mecha-deploy-list[open], .mecha-unavailable-actions[open]"));
      // The order explanation is longer than the rail. Keep its scrollport
      // fixed while the user reads it; fitting against the currently visible
      // lines on every scroll otherwise changes the height and clips content.
      const readingOrder = panel === summary && Boolean(panel.querySelector("#mecha-order-panel"));
      let height = editingPosition || readingOrder ? limit : wholeLineHeight(panel, limit);
      const active = document.activeElement;
      if (keyboardMode && active instanceof HTMLElement && active !== panel && panel.contains(active)) {
        const rect = active.getBoundingClientRect();
        const edge = panel.getBoundingClientRect().top + height;
        // A fit must not cut off the control the keyboard user is operating.
        if (rect.top < edge && rect.bottom > edge) height = limit;
      }
      const value = `${height}px`;
      if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
    };
    const settle = (panel: HTMLElement) => {
      if (!sideLayout() && !phoneCandidate(panel)) return;
      // Native pointer and keyboard scrolling must remain authoritative while
      // a position form or the unavailable-action list is open. Snapping a partially visible line at
      // the top can scroll a just-revealed select or button offscreen.
      if (panel === actions && panel.querySelector(".mecha-move-list[open], .mecha-deploy-list[open], .mecha-unavailable-actions[open]")) return;
      // Native scrolling must also be authoritative while reading the order.
      if (panel === summary && panel.querySelector("#mecha-order-panel")) return;
      // Do not snap a keyboard user's scroll or move their focused control out
      // of view. Snap again after focus leaves the scrollport.
      if (keyboardMode && panel.contains(document.activeElement)) return;
      // Align a partially visible top line/control to the nearest edge. Large
      // controls remain scrollable rather than trapping the viewport.
      for (let i = 0; i < 12; i += 1) {
        // Fitting a bottom-anchored panel moves its top; measure and snap
        // after each fit rather than fitting once more after the final snap.
        fit(panel);
        const top = panel.getBoundingClientRect().top + panel.clientTop;
        const boxes: DOMRect[] = [];
        const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.textContent?.trim() || node.parentElement?.closest(".mecha-sr-only") || inClosedDetails(node, panel)) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          boxes.push(...Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0));
        }
        for (const control of panel.querySelectorAll<HTMLElement>("button, summary, select, input")) {
          const rect = control.getBoundingClientRect();
          if (rect.width && rect.height && rect.height < panel.clientHeight && !inClosedDetails(control, panel)) boxes.push(rect);
        }
        const crossed = boxes.filter((rect) => rect.top < top - 0.5 && rect.bottom > top + 0.5);
        if (!crossed.length) break;
        const before = Math.min(...crossed.map((rect) => rect.top)) - top - 1;
        const after = Math.max(...crossed.map((rect) => rect.bottom)) - top + 1;
        const active = document.activeElement?.getBoundingClientRect();
        const focused = panel.contains(document.activeElement) && active && active.top < top && active.bottom > top;
        const previous = panel.scrollTop;
        const preferBefore = focused || Math.abs(before) <= after;
        panel.scrollTop += preferBefore ? before : after;
        // At the scroll limit the nearer edge may be unreachable. Try the
        // other side instead of leaving the topmost line partly clipped.
        if (Math.abs(panel.scrollTop - previous) < 0.5) panel.scrollTop += preferBefore ? after : before;
        if (Math.abs(panel.scrollTop - previous) < 0.5) break;
      }
    };
    const scheduleSettle = (panel: HTMLElement) => {
      window.clearTimeout(timers.get(panel));
      timers.set(panel, window.setTimeout(() => { timers.delete(panel); settle(panel); }, 140));
    };
    const onScroll = (event: Event) => {
      const panel = event.currentTarget as HTMLElement;
      fit(panel);
      scheduleSettle(panel);
    };
    const onFocusOut = (event: FocusEvent) => scheduleSettle(event.currentTarget as HTMLElement);
    const update = () => { for (const panel of panels) { fit(panel); scheduleSettle(panel); } };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    for (const panel of panels) { observer?.observe(panel); panel.addEventListener("scroll", onScroll, { passive: true }); panel.addEventListener("focusout", onFocusOut); }
    observer?.observe(root);
    if (pack) observer?.observe(pack);
    const mutations = new MutationObserver(update);
    for (const panel of panels) mutations.observe(panel, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["open", "class", "aria-expanded"] });
    root.addEventListener("toggle", update, true);
    window.addEventListener("keydown", onKeyInput, true);
    window.addEventListener("pointerdown", onPointerInput, true);
    window.addEventListener("resize", update);
    update();
    return () => {
      observer?.disconnect(); mutations.disconnect();
      for (const panel of panels) { panel.removeEventListener("scroll", onScroll); panel.removeEventListener("focusout", onFocusOut); }
      for (const timer of timers.values()) window.clearTimeout(timer);
      root.removeEventListener("toggle", update, true);
      window.removeEventListener("keydown", onKeyInput, true);
      window.removeEventListener("pointerdown", onPointerInput, true);
      window.removeEventListener("resize", update);
      root.style.removeProperty("--mecha-summary-fit-height");
      root.style.removeProperty("--mecha-actions-fit-height");
      root.style.removeProperty("--mecha-roster-fit-height");
      root.style.removeProperty("--mecha-candidate-fit-height");
      root.style.removeProperty("--mecha-inspector-fit-height");
    };
  }, [controller, Boolean(s), locale, viewFailed, mapFocused, remoteStatus, s?.candidate?.source, s?.candidate?.target, inspectedCell, inspectedUnitId]);

  useEffect(() => { controller?.setLocale(locale); }, [controller, locale]);
  // The details element unmounts when prediction is unavailable or during
  // playback, so its onToggle handler cannot clear the old selection. Clear it
  // before paint as well, otherwise a closed, recovered panel revives a marker.
  useLayoutEffect(() => {
    if (performance || !s?.preview.ok) setFocusedBuilding(null);
  }, [performance, s?.preview.ok]);
  useEffect(() => () => { if (inspectTimer.current !== null) window.clearTimeout(inspectTimer.current); }, []);
  useEffect(() => { setInspectedAction(null); }, [selected]);
  useEffect(() => { setMoveChoice(""); }, [selected, resolvedState]);
  useLayoutEffect(() => {
    if (s?.candidate?.source !== "selection") {
      // Closing the result returns to the command heading, including after
      // a keyboard user has scrolled through other available targets.
      const panel = candidateScrollPanel.current;
      if (panel?.isConnected) {
        panel.scrollTop = 0;
      }
      candidateScrollPanel.current = null;
      return;
    }
    const result = candidateRef.current;
    const panel = panelRef.current?.querySelector<HTMLElement>(".mecha-selected-actions");
    if (!result || !panel) return;
    candidateScrollPanel.current = panel;
    panel.scrollTop = 0;
    result.scrollTop = 0;
    const trigger = candidateKeyboardTrigger.current;
    candidateKeyboardTrigger.current = null;
    if (trigger && document.activeElement === trigger) {
      result.querySelector<HTMLButtonElement>(".mecha-candidate-actions button:not(:disabled)")?.focus({ preventScroll: true });
    }
  }, [s?.candidate?.source, s?.candidate?.target, s?.candidate?.preview]);

  // Confirmation and cancellation remove their buttons. Restore focus only
  // for keyboard/assistive activation and only if the user has not moved it
  // elsewhere in the meantime. Pointer activation does not take focus away.
  useLayoutEffect(() => {
    const pending = targetFocusReturn.current;
    if (!pending || targeting) return;
    targetFocusReturn.current = null;
    if (document.activeElement !== pending.trigger && document.activeElement !== document.body) return;
    const panel = panelRef.current?.querySelector<HTMLElement>(".mecha-selected-actions");
    if (!panel?.getClientRects().length) return;
    const action = Array.from(panel.querySelectorAll<HTMLButtonElement>("button[data-mecha-action]"))
      .find((button) => button.dataset.mechaAction === pending.kind && !button.disabled);
    panel.scrollTop = 0;
    (action ?? panel.querySelector<HTMLElement>("h3"))?.focus({ preventScroll: true });
  }, [targeting]);

  useEffect(() => {
    if (viewFailed) controller?.stopAuto();
  }, [controller, viewFailed]);

  // 自动对战的节拍：每拍一次 tick（展示 → 结算 → 下一回合）。状态一变就重排，暂停即停。
  useEffect(() => {
    if (viewFailed || previewLoading || remoteActive || !auto || paused || performance || !controller) return undefined;
    const timer = window.setTimeout(() => { if (!remoteLocked.current) controller.tick(); }, 700);
    return () => window.clearTimeout(timer);
  }, [controller, auto, paused, s, sequenceWaiting, viewFailed, performance, remoteActive, previewLoading]);

  const reach = deployment?.cells ?? s?.reach ?? [];
  // Presentation-only placements: unplaced mechs have no board occupancy.
  const inspectionState = useMemo(() => state ? { ...state, mechs: projectMechPositions(state, deployment?.placements ?? null) } : state, [state, deployment]);
  const targetOptions = s?.targetOptions ?? [];
  const hudActions: MechaHudActions = {
    select: id => controller?.selectMech(id),
    moveTo: cell => { if (selected) controller?.setMove(selected, cell); },
    chooseAction: kind => {
      if (!selected) return;
      if (kind === "skip") { controller?.setTargeting(null); controller?.setAction(selected, { kind }); }
      else controller?.setTargeting(controller?.getState().targeting === kind ? null : kind);
    },
    pickTarget: index => { const target = targetOptions[index]; if (target) controller?.previewTarget(target.id, "selection"); },
    confirmAction: () => controller?.confirmTarget(),
    undoMove: () => controller?.undoMove(),
    resetTurn: () => controller?.resetTurn(),
    endTurn: () => controller?.submit(),
    confirmEndTurn: unused => { if (unused) controller?.confirmHold(); else controller?.submit(); },
  };
  const clickCell = (x: number, y: number, input: "mouse" | "touch") => {
    // The map-only view exposes cells otherwise hidden behind the HUD. Restore
    // the controls after a board pick, including an invalid pick or touch preview.
    if (mapFocused) setMapFocused(false);
    if (!state || performance || previewLoading) return;
    const info = inspectCell(inspectionState!, { x, y }, performance || deployment ? {} : draft);
    setInspectedCell(info?.cell ?? null);
    setInspectedUnitId(info?.unit?.id ?? null);
    controller?.setSelectedEnemy(info?.unit?.side === "enemy" ? info.unit.id : null);
    if (sequenceWaiting || performance || remoteLocked.current) return;
    if (deployment) {
      controller?.clickCell(x, y, input);
      // A successful placement changes an empty inspected tile into a unit.
      // Read the new presentation draft, not the authority's placeholder position.
      const placed = controller?.getState().deployment?.placements.find(p => p.pos.x === x && p.pos.y === y);
      if (placed) setInspectedUnitId(placed.mechId);
      return;
    }
    // Actual models stay on committed cells; destination markers are not units.
    if (!targeting && info?.unit?.side === "mech") hudActions.select(info.unit.id as MechId);
    else controller?.clickCell(x, y, input);
  };
  const inspectEnemy = (actor: string | null) => {
    const attack = state && declaredAttack(state, actor);
    setInspectedCell(attack?.origin ?? null);
    setInspectedUnitId(actor);
    controller?.setSelectedEnemy(actor);
  };
  const inspectedMech = inspectionState?.mechs.find(m => m.id === inspectedUnitId && m.hp > 0);
  const inspectionPosition = inspectedMech ? inspectedMech.pos : inspectedCell;
  const cellInfo = inspectionState && inspectionPosition ? inspectCell(inspectionState, inspectionPosition, performance || deployment ? {} : draft, inspectedUnitId) : null;
  const closeInspection = () => { setInspectedCell(null); setInspectedUnitId(null); controller?.setSelectedEnemy(null); };

  const hoverCell = (cell: { x: number; y: number } | null) => {
    if (remoteActive || previewLoading) return;
    const target = cell && targetOptions.find((option) => option.cells.some((c) => c.x === cell.x && c.y === cell.y));
    controller?.previewTarget(target?.id ?? null, "hover");
  };

  const activeMechs = state ? living(state) : [];
  const plannedCount = s?.plannedCount ?? 0;
  const pendingNames = (s?.pendingIds ?? []).map((id) => t(NAMES[id]));
  const packReady = s?.packReady ?? false;
  const attackOrderPreview = useMemo(() => {
    if (!showOrder || performance || deployment || remoteActive || !state || !draft || state.outcome) return null;
    try { return previewEnemyPhase(state, draftPlan(state, draft)); }
    catch { return { ok: false as const, reason: "enemy_phase_preview_failed" }; }
  }, [showOrder, performance, deployment, remoteActive, state, draft]);
  const cityView = useMemo<CityMechaView & { declaredTelegraph: Cell[]; projectedTelegraph: Cell[] | null; predictionSource: "draft" | "candidate" }>(() => {
    // A candidate identifies a unit, not the particular cell clicked. For the
    // multi-cell boss the first option cell is its rules anchor, not a claim
    // that only one of its four cells was selected.
    const candidate = s?.candidate;
    const selectedCandidate = !performance && !sequenceWaiting && !remoteActive && s?.targeting && candidate?.source === "selection" ? candidate : null;
    const candidateCurrent = selectedCandidate && s && selectedCandidate.preview.revision === s.preview.revision && selectedCandidate.preview.draftVersion === s.preview.draftVersion;
    const projected = selectedCandidate ? (candidateCurrent && selectedCandidate.preview.ok ? { cells: selectedCandidate.preview.telegraphAfter, byActor: selectedCandidate.preview.telegraphByActor } : null) : s?.projectedThreats ?? null;
    const focusActor = s?.selectedEnemy ?? s?.hoveredEnemy;
    let targetPreview: { target: Cell; shove?: { from: Cell; to: Cell; blocked?: boolean } } | undefined;
    if (!performance && !sequenceWaiting && !remoteActive && s?.interactive && candidateCurrent && s.targeting && selected && candidate?.source === "selection" && candidate.preview.ok) {
      const target = s.targetOptions.find((option) => option.id === candidate.target)?.cells[0];
      const result = candidateResult(candidate.preview, selected, candidate.target);
      if (target && result.action?.target === candidate.target && result.action.action === s.targeting && !result.action.fizzled) {
        // A prior action may have moved the target before this shove. Until
        // the scene labels turn stages, draw an arrow only from the selected
        // target's displayed position; the full result remains in the text.
        const shove = result.shoves.find(({ event, from, to }) => event.unit === candidate.target && from && to && from.x === target.x && from.y === target.y);
        targetPreview = { target: { ...target }, ...(shove?.from && shove.to ? { shove: { from: { ...shove.from }, to: { ...shove.to }, blocked: Boolean(shove.event.hit) } } : {}) };
      }
    }
    const selectedMech = inspectionState?.mechs.find(m => m.id === selected);
    const selectedRoute = !deployment && selectedMech && inspectionState
      ? inspectCell(inspectionState, selectedMech.pos, draft, selected)?.movePath : null;
    return {
      // Returning from replay must not trigger the final turn's combat cues a second time.
      combat: s?.replay?.combat ?? (s?.match.outcome && !performance ? { ...s.combat, actions: [] } : s?.combat),
      paused,
      deployment: Boolean(deployment),
      figures: (inspectionState?.mechs ?? []).map((m) => {
        return { id: m.id, x: m.pos.x, y: m.pos.y, alive: m.hp > 0, hp: m.hp, maxHp: unitMaxHp(m.id, state) ?? undefined, selected: !s?.replay && m.id === selected };
      }),
      plannedMoves: !performance && !deployment && state ? projectPlannedMoves(state, draft) : [],
      boss: { x: state?.boss.anchor.x ?? 0, y: state?.boss.anchor.y ?? 0, alive: (state?.boss.hp ?? 0) > 0, hp: state?.boss.hp ?? 0, maxHp: unitMaxHp("boss", state) ?? undefined },
      bossSpeciesId: state?.monsterContent?.contentVersion === 1 ? state.monsterContent.speciesId : undefined,
      raiders: (state?.raiders ?? []).map((raider) => ({ id: raider.id, x: raider.pos.x, y: raider.pos.y, alive: raider.hp > 0, hp: raider.hp, maxHp: unitMaxHp(raider.id, state) ?? undefined })),
      buildings: (state?.buildings ?? []).map((building) => ({ id: building.id, cells: building.cells, hp: building.hp, maxHp: building.maxHp })),
      focusedBuilding: performance || !s?.preview.ok ? null : focusedBuilding,
      telegraph: performance ? [] : (projected ?? s?.declaredThreats)?.cells ?? [],
      declaredTelegraph: performance ? [] : (s?.declaredThreats.cells ?? []),
      declaredIntents: performance || !state ? [] : declaredEnemyIntents(state),
      projectedTelegraph: performance ? null : (projected?.cells ?? null),
      predictionSource: selectedCandidate ? "candidate" : "draft",
      focusedTelegraph: performance || !focusActor ? [] : (projected ?? s?.declaredThreats)?.byActor[focusActor] ?? [],
      hoveredEnemy: s?.replay ? null : s?.selectedEnemy ?? s?.hoveredEnemy ?? null,
      enemyOrder: showOrder && !performance && attackOrderPreview?.ok ? attackOrderPreview.steps.map(step => ({ actor: step.actor, cells: step.cells, position: step.position ?? undefined, order: step.order, cancel: step.cancel })) : [],
      focus: performance ? [] : (s?.focusCells ?? []),
      reach: performance ? [] : reach,
      move: performance || !selected ? null : draft?.[selected]?.moveTo ?? null,
      targets: performance ? [] : targetOptions.flatMap((option) => option.cells),
      targetIds: performance ? [] : targetOptions.map((option) => option.id),
      targetPreview,
      obstacles: state?.obstacles,
      inspectedCell: cellInfo?.cell ?? null,
      missionTarget: state?.mission?.target ?? null,
      corrodeFields: state?.corrode?.fields.map(field => ({ id: field.id, cell: field.cell })),
      // A clicked actor wins over transient hover; current declarations are
      // independent of whether the friendly draft predicts this actor's death.
      inspectionSegments: performance || !state ? [] : inspectionSegments(
        declaredAttack(state, s?.selectedEnemy ?? (cellInfo?.unit?.side === "mech" ? null : s?.hoveredEnemy ?? null)), cellInfo?.movePath ?? selectedRoute ?? null),
      inspectedThreats: performance || !state ? [] : declaredAttack(state, s?.selectedEnemy ?? s?.hoveredEnemy ?? null)?.targets ?? [],
    };
  }, [s, state, inspectionState, deployment, draft, selected, reach, targetOptions, paused, performance, sequenceWaiting, focusedBuilding, showOrder, remoteActive, cellInfo, attackOrderPreview]);

  if (!controller || !s || !state || !site) {
    return <><CityGate locale={locale} onClose={requestClose} title={t("没有安全的 Assault 出生点。")} body={t("地形采样失败或可用出生点过陡，请退出战斗并尝试其他城市。")} /></>;
  }

  if (viewFailed) {
    return <>
      <CityGate locale={locale} onClose={requestClose} closeDisabled={remoteActive} onRetry={viewFailed === "asset" ? undefined : () => setViewFailed(null)}
        title={viewFailed === "asset" ? "Assault 模型加载失败。" : viewFailed === "preview" ? "Assault 战斗演出不可用。" : "三维视角被其他模式占用。"}
        body={viewFailed === "asset" ? "Assault 模型未能加载或实例化；退出战斗后检查资源。" : viewFailed === "preview" ? "战斗动画播放失败；可以重试，或退出战斗。" : "先退出影院、驾驶或飞行，再开战。"} recovery={null} />

    </>;
  }

  const changeMonsterPractice = (selection: PlannedMonsterSpeciesId | "reset" | null) => {
    const before = controller.getState().match;
    const expectedSite = site;
    const expectedCatalog = safeCatalog;
    setPracticeNotice(null);
    requestDestructiveAction(() => {
      if (remoteLocked.current || controller.getState().match !== before || matchRuntime.current.site !== expectedSite || matchRuntime.current.safeCatalog !== expectedCatalog || matchRuntime.current.viewFailed || matchRuntime.current.previewLoading) {
        setPracticeNotice(locale === "en" ? "The match or battlefield changed; please try again." : "对局或战场已变化，请重试。");
        return;
      }
      const content = selection === "reset" ? before.monsterContent ?? null : selection === null ? null : { speciesId: selection, contentVersion: 1 as const };
      if (!controller.restart({ mission: null, monsterContent: content })) {
        setPracticeNotice(locale === "en" ? "This monster practice is unavailable; the current match was kept." : "该怪物演练暂不可用，当前对局未改变。");
        return;
      }
      setFocusedBuilding(null); setInspectedCell(null); setInspectedUnitId(null); setShowMatchResult(false);
    });
  };

  const selectedMech = activeMechs.find((m) => m.id === selected);
  const skill = state.boss.intent?.skillId;
  const skillLabel = monsterSkillName(skill ?? null, locale);
  const outcome = state.boss.hp <= 0 && state.outcome === "defeat_buildings" ? t("大怪已倒，楼先没了")
    : state.boss.hp <= 0 && state.outcome === "defeat_timeout" ? t("大怪已倒，回合用尽")
    : state.outcome === "victory" ? t(state.mission ? "救援成功" : "歼灭")
    : state.outcome === "defeat_wipe" ? t("全灭")
    : state.outcome === "defeat_timeout" ? t("回合耗尽")
    : state.outcome === "defeat_buildings" ? t("楼被拆光")
    : null;
  const raiderHp = state.raiders.map((raider) => `${t(enemyName(raider.id))} ${raider.hp}`).join(" ");
  const focus = s.focus;
  const focusLine = doctrineFocusLine(doctrine, gameText(enemyName(focus.id), locale), focus.building ? `${focus.building.x},${focus.building.y}` : null, locale);
  const planning = s.interactive && !sequenceWaiting && !remoteActive && !previewLoading;
  // The visible board during playback is the pre-turn state; never mix it with
  // the already-advanced controller's next-turn prediction.
  const preview = !performance && s.preview.ok ? s.preview : null;
  const hitLine = preview ? activeMechs.map((m) => `${t(NAMES[m.id])} ${preview.hitsAfter[m.id]}`).join(" · ") : "";
  const predictedFizzles = preview && !state.outcome && !remoteActive ? forecastFizzles(preview.log) : [];
  const hasProjectedThreats = Boolean(preview && s.projectedThreats);
  const currentThreats = hasProjectedThreats ? s.projectedThreats : s.declaredThreats;
  const staked = stakeBuildings(state);
  const stakedHp = staked.reduce((total, building) => total + building.hp, 0);
  const stakedMax = staked.reduce((total, building) => total + building.maxHp, 0);
  const predictedBuildings = preview?.buildings.filter((building) => building.staked) ?? [];
  const predictedHp = predictedBuildings.reduce((total, building) => total + building.endHp, 0);
  const buildingDelta = predictedHp - stakedHp;
  const candidate = s.candidate;
  const candidateIsCurrent = !!candidate && candidate.preview.revision === s.preview.revision && candidate.preview.draftVersion === s.preview.draftVersion;
  const candidateEffects = candidateIsCurrent && candidate?.preview.ok && selected ? candidateResult(candidate.preview, selected, candidate.target) : null;
  const unitName = (id: string) => id === "wall" ? t("墙或障碍") : id in NAMES ? t(NAMES[id as MechId]) : t(enemyName(id));
  const finishTarget = (event: React.MouseEvent<HTMLButtonElement>, confirm: boolean) => {
    if (event.detail === 0 && document.activeElement === event.currentTarget && targeting) {
      targetFocusReturn.current = { trigger: event.currentTarget, kind: targeting };
    }
    if (confirm) hudActions.confirmAction();
    else controller.setTargeting(null);
    // Validation or a concurrent lock may keep targeting active.
    if (controller.getState().targeting) targetFocusReturn.current = null;
  };
  const predictedOutcome = preview?.outcome === "victory" ? t("预计胜利")
    : preview?.outcome === "defeat_buildings" ? t("预计防守建筑全毁")
    : preview?.outcome === "defeat_wipe" ? t("预计机甲全灭")
    : preview?.outcome === "defeat_timeout" ? t("预计回合耗尽") : null;
  const quickResource = <>
    {state.mission ? <div className="mecha-building-current" data-rescue-target><span>{t("救援点 · 棋盘紫色十字")}</span><strong>{state.mission.target.x}, {state.mission.target.y}</strong></div> : <>
      <div className="mecha-building-current"><span>{t("防守建筑")}</span><strong>{staked.length ? `${stakedHp}/${stakedMax}` : t("本局无守楼目标")}</strong></div>
      {!performance && !state.outcome && preview && staked.length ? <span>→ {t("预计")} {predictedHp}/{stakedMax}</span> : null}
    </>}
    {preview && !s.projectedThreats ? <span>{t("草稿威胁未知")}</span> : null}
    {remoteActive ? <span>{t("远程战棋期间本地规划已锁定。")}</span> : null}
  </>;
  const statusIcons = { poison: "☠️", burn: "🔥", freeze: "🧊", stun: "💫" } as const;
  const statusNames = { poison: "中毒", burn: "燃烧", freeze: "冻结", stun: "眩晕" } as const;
  const hudProjection: MechaHudProjection = {
    label: t("机甲战棋"),
    displayMatch: state,
    selected: selected ?? s.selected,
    round: state.turn,
    deployment: Boolean(deployment),
    sourcePhase: state.phase,
    objective: {
      goal: state.mission ? t("任一存活机甲抵达救援点 · 全灭或回合耗尽则失败")
        : staked.length ? t("消灭所有敌人 · 至少保住一栋防守建筑") : t("消灭所有敌人"),
      buildings: state.buildings.map(building => ({ id: building.id, hp: building.hp, maxHp: building.maxHp })),
      forecast: preview ? predictedOutcome ?? `${predictedHp}/${stakedMax}` : null,
    },
    threats: Object.entries(currentThreats?.byActor ?? {}).map(([actor, cells]) => ({ actor, cells })),
    roster: state.mechs.map(unit => ({
      id: unit.id,
      maxHp: unitMaxHp(unit.id, state),
      statuses: (state.statusEncounter?.statuses ?? []).filter(status => status.target === unit.id).map(status => ({
        icon: statusIcons[status.kind], label: `${t(statusNames[status.kind])} · ${status.remainingTurns}`,
      })),
      rights: { move: unit.hp > 0 && planning, action: unit.hp > 0 && planning },
    })),
    actions: [...s.actions.map(entry => ({ kind: entry.kind, enabled: true })), ...s.unavailableActions.map(entry => ({ kind: entry.kind, enabled: false }))]
      .map(entry => ({ ...entry, label: t(actionLabel(entry.kind)) })),
    targets: s.targetOptions.map(option => ({ id: option.id, label: unitName(option.id), cells: option.cells })),
    preview: { status: s.preview.status, damage: [] },
    replay: null,
    notices: [
      ...(s.notice ? [{ kind: s.fault ? "error" as const : "status" as const, text: s.notice }] : []),
      ...(practiceNotice ? [{ kind: "status" as const, text: practiceNotice }] : []),
      ...(scenarioNotice ? [{ kind: "status" as const, text: scenarioNotice }] : []),
    ],
  };
  const hudModel: MechaHudModel = buildClassicHud(s, hudProjection);

  return (
    <MechaHud className="mecha-overlay is-city has-match is-reference-hud" model={hudModel} actions={hudActions} mapFocus={mapFocused} remoteActive={remoteActive}>
      <CityMechaWorld ref={worldRef} engine={engine} site={site} locale={locale} view={cityView} performance={performance} paused={paused} connectedAssault={connectedAssault} performanceSpeed={1} onPerformanceComplete={finishPerformance} onCell={clickCell} onHoverCell={hoverCell} onHoverEnemy={(id) => controller.setHoveredEnemy(id)} onUnavailable={(reason) => setViewFailed(reason ?? "mode")} onPreviewLoading={setPreviewLoading} />
      <header className="mecha-battle-bar">
        {previewLoading && <span role="status">{t("正在加载 Assault 模型…")}</span>}
        <div className="mecha-battle-controls">
          {s.match.monsterContent ? <span data-monster-practice-active data-species-id={s.match.monsterContent.speciesId}>{locale === "en" ? "Local monster practice" : "怪物本地演练"}</span> : null}
          <MechaBattlefieldControls locale={locale} mapFocused={mapFocused} onToggleFocus={() => setMapFocused(value => !value)} onResetCamera={() => worldRef.current?.resetCamera()} />
          <button type="button" disabled={Boolean(deployment)} aria-label={t("结算顺序")} aria-expanded={showOrder} aria-controls={showOrder ? "mecha-order-panel" : undefined} aria-describedby={showOrder && planning && preview ? "mecha-order-help" : undefined} onClick={() => { if (!showOrder) { setMapFocused(false); setCompactSummary(false); } else { panelRef.current?.querySelector<HTMLElement>(".mecha-turn-summary")?.scrollTo({ top: 0 }); } setShowOrder((value) => !value); }}>{t("顺序")}</button>
          <button type="button" data-mecha-settings-trigger="battlefield" aria-expanded={settingsPanel === "battlefield"} aria-controls="mecha-battlefield-settings" onClick={(event) => toggleSettings("battlefield", event.currentTarget)}>{t("战场设置")}</button>
          <button type="button" data-mecha-settings-trigger="remote" aria-expanded={settingsPanel === "remote"} aria-controls="mecha-remote-settings" onClick={(event) => toggleSettings("remote", event.currentTarget)}>{t("远程战棋")}</button>
          {auto ? <button type="button" disabled={remoteActive} onClick={() => controller.stopAuto()}>{t("停止自动")}</button> : null}
          {performance || (paused && !state.outcome) ? <button type="button" disabled={remoteActive} onClick={() => controller.togglePause()}>{paused ? t("继续演出") : t("暂停演出")}</button> : null}
          {performance ? <button type="button" onClick={finishPerformance}>{t("跳过演出")}</button> : null}
          <MechaBattleMenu locale={locale} exitDisabled={remoteActive} onGuide={trigger => { guideTrigger.current = trigger; setSettingsPanel(null); setShowQuickGuide(true); }} onExit={requestClose} />
        </div>
      </header>
      <div className="mecha-panel" ref={panelRef}>
        {sequenceFault ? <p role="alert">{t("Assault 演出数据不完整或不一致，自动对战已等待；可重新开始一局。")}</p> : null}
        {!(state.outcome && !performance && !remoteActive) ? <details className="mecha-tactical-legend"><summary><span aria-hidden="true">↗</span> {t("战场图例")}{!deployment && cityView.projectedTelegraph === null ? ` · ${t("风险未知")}` : ""}</summary><MechaBattleLegend locale={locale} view={cityView} /></details> : null}
        <MechaObjectivePanel className={compactSummary && !remoteActive ? "is-compact" : ""} label={t("战斗目标与威胁")} aria-describedby="mecha-summary-scroll-help" tabIndex={0} onKeyDown={(event) => {
          const element = event.currentTarget;
          if (event.target !== element || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || element.scrollHeight <= element.clientHeight) return;
          const step = Math.max(40, Math.floor(element.clientHeight * 0.9));
          if (event.key === "ArrowDown") element.scrollTop += 40;
          else if (event.key === "ArrowUp") element.scrollTop -= 40;
          else if (event.key === "PageDown") element.scrollTop += step;
          else if (event.key === "PageUp") element.scrollTop -= step;
          else if (event.key === "Home") element.scrollTop = 0;
          else if (event.key === "End") element.scrollTop = element.scrollHeight;
          else return;
          event.preventDefault();
        }}>
          <span id="mecha-summary-scroll-help" className="mecha-sr-only">{t("这里包含战斗目标、威胁和结算顺序；如有隐藏内容，使用上下方向键滚动查看。")}</span>
          {remoteActive ? <p id="mecha-remote-lock-status" className="mecha-resource" role="status">{t(remoteStatus === "starting" ? "正在启动远程战棋，本地规划已锁定。" : remoteStatus === "stopping" ? "正在停止远程战棋，本地规划仍锁定。" : remoteStatus === "unknown" ? "远程状态无法确认：请在远程战棋设置中停止并重试，本地规划保持锁定。" : "远程战棋已启动：桌面显示本地局面，不会同步远程战况。本地规划已锁定；停止远程将重开本地局。")}</p> : null}
          <MechaObjectiveCard round={deployment ? t("开局部署") : <>{t("回合")} {Math.min(state.turn, MAX_TURNS)}/{MAX_TURNS}</>}
            heading={<MechaObjectiveToggle locale={locale} expanded={remoteActive || !compactSummary} locked={remoteActive} onToggle={event => { if (remoteActive) return; event.currentTarget.closest<HTMLElement>(".mecha-turn-summary")?.scrollTo({ top: 0 }); setCompactSummary(value => !value); }} />}
            paused={paused && !state.outcome ? <span className="mecha-objective-paused" role="status">{t("已暂停")}</span> : null}
            goal={!remoteActive ? t(state.mission ? "任一存活机甲抵达救援点 · 全灭或回合耗尽则失败" : staked.length ? "消灭所有敌人 · 至少保住一栋防守建筑" : "消灭所有敌人") : null}
            resource={<><MechaPrismShieldStatus locale={locale} controllerState={s} sequenceWaiting={sequenceWaiting} />{quickResource}</>}
            forecast={<>
              {deployment ? t("部署确认后才生成首回合敌意。") : state.outcome ? outcome : performance ? t("演出中，不显示预测") : !preview ? t("本回合预测未知") : state.mission ? t("移动结算结束时抵达即胜利；本局不以守楼或消灭敌人为胜负条件。") : !staked.length ? t("本局无守楼目标") : buildingDelta > 0 ? `${t("本回合预计建筑净恢复")} +${buildingDelta}` : `${t("本回合预计建筑净损失")} ${-buildingDelta}`}
              {!state.outcome && preview?.assumed.length ? <span> · {t("假设待机")}</span> : null}
              {!state.outcome && predictedOutcome ? <span className="mecha-objective-outcome">{predictedOutcome}</span> : null}
            </>}>
            {resultReady ? <button type="button" ref={resultTrigger} className="mecha-result-reopen" onClick={() => setShowMatchResult(true)}>{t("查看结算")}</button> : null}
            <span className="mecha-scroll-hint" aria-hidden="true">↕ {t("内容较多时可滚动")}</span>
          </MechaObjectiveCard>
          {!deployment && !performance && !preview && !state.outcome ? <p className="mecha-preview-after mecha-forecast-status" role="status">{s.preview.status === "invalid" ? `${t("风险未知")} · ${previewFaultText(s.preview.fault, locale)}` : t("预览暂不可用，风险未知；提交仍会重新校验。")} {t("当前敌意不是草稿预测。")}</p> : null}
          {preview ? <details className="mecha-resource mecha-risk-details" onToggle={(event) => { if (!event.currentTarget.open) setFocusedBuilding(null); }}>
            <summary>{t("风险详情")}</summary>
            <p>{t("整包预计机甲受击")} {hitLine}</p>
            {preview.assumed.length ? <p>{t("假设待机")}：{preview.assumed.map((id) => t(NAMES[id])).join("、")} · {t("已规划移动会保留；提交前须明确选择行动。")}</p> : null}
            <p>{t("选择建筑，高亮对应楼顶标记。")}</p><ul>{preview.buildings.map((building) => <li key={building.id}><button type="button" aria-pressed={focusedBuilding === building.id} onClick={() => setFocusedBuilding((id) => id === building.id ? null : building.id)}>{building.id} ({building.cells.map((cell) => `${cell.x},${cell.y}`).join("、")}) · {t(building.staked ? "防守建筑" : "非防守建筑，不计入败北条")} · {building.startHp} → {building.endHp}/{building.maxHp}{building.endHp <= 0 ? ` · ${t("预计毁灭")}` : ""}</button></li>)}</ul>
            {preview.log.filter((event) => event.type === "act" && event.fizzled).map((event) => event.type === "act" ? <p key={event.mechId}>{t(NAMES[event.mechId])} · {t("行动落空，不消耗冷却")} · {fizzleText(event.cause, locale)}</p> : null)}
          </details> : null}
          {!deployment && !performance ? <MechaCorrodeSummary locale={locale} state={state} /> : null}
          {!deployment && !performance ? <details className="mecha-threat-details">
            <summary>{t("威胁来源与格子")}</summary>
            <p>{t("大怪当前宣告")}：{skillLabel}</p>
            <MechaMonsterIntent locale={locale} state={state} preview={preview} />
            <p>{t("红框与斜纹：敌方当前攻击格；敌人脚下红框与箭头连接攻击方向（不是移动路线）。蓝色虚线框：执行草稿后的攻击格。叠加表示同一格仍有危险。")}</p>
            <p>{t("当前宣告威胁")}: {s.declaredThreats.cells.length ? s.declaredThreats.cells.map((cell) => `${cell.x},${cell.y}`).join("、") : t("当前没有宣告威胁格。")}</p>
            {preview && s.projectedThreats ? <>
              <p>{t("草稿试算威胁")}: {s.projectedThreats.cells.length ? s.projectedThreats.cells.map((cell) => `${cell.x},${cell.y}`).join("、") : t("本次试算没有威胁格。")}</p>
              <p>{t("列表显示草稿预测；点击敌人查看当前宣告与攻击方向。")}</p>
            </> : <p>{t("草稿试算未知；列表显示当前宣告，不能视为安全。")}</p>}
            <MechaThreatSourceList label={t(hasProjectedThreats ? "草稿试算威胁来源" : "当前宣告威胁来源")}
              sources={currentThreats ? Object.entries(currentThreats.byActor).map(([actor, cells]) => ({ id: actor, selected: s.selectedEnemy === actor,
                content: <>{getUnitPortrait(actor) ? <MechaUnitPortrait unitId={actor} locale={locale} size={22} className="mecha-inline-portrait" /> : null}{t(enemyName(actor))}{hasProjectedThreats && preview?.enemyOrder.find(event => event.actor === actor) ? ` · ${monsterSkillName(preview.enemyOrder.find(event => event.actor === actor)!.skill, locale)}` : ""} · {cells.map(cell => `${cell.x},${cell.y}`).join("、")}</> })) : []}
              empty={t(hasProjectedThreats ? "本次预测没有敌方攻击。" : "当前没有宣告威胁格。")} onSelect={actor => inspectEnemy(s.selectedEnemy === actor ? null : actor)} />
          </details> : null}
          {showOrder ? <MechaTurnOrder label={t("结算顺序")} stageLabel={t("回合阶段")} stages={["全队移动", "我方行动", "敌方行动", "下一回合"].map(stage => t(stage))}>
            <p>{t("移动完成后，突击、射手、支援按顺序行动。")}</p>
            <details className="mecha-order-rules">
              <summary>{t("落空与即时结算")}</summary>
              <p>{t("伤害、击退及损毁在行动中即时结算；目标位移或消失可能导致落空，落空不消耗冷却。")}</p>
              <p>{t("战斗结束则跳过后续阶段；否则准备下一回合敌意。")}</p>
            </details>
            {performance ? <p>{t("演出期间不显示预测。")}</p> : attackOrderPreview?.ok ? <>
              <p>{t("以下序号来自当前草稿的只读逐步模拟；每一步都基于前一步结算后的棋盘。")}</p>
              {preview?.assumed.length ? <p>{t("未规划机甲按待机预测；改变计划会更新顺序。")}</p> : null}
              {planning ? <p id="mecha-order-help" className="mecha-order-help">{t("棋盘上的编号标出敌人的结算顺序；斜线表示本次不会行动。")}</p> : null}
              {attackOrderPreview.steps.length ? <ol className="mecha-attack-order">{attackOrderPreview.steps.map(step => {
                const actorLabel = step.actor === "status" ? t("环境与状态") : t(enemyName(step.actor));
                const cancelLabel = step.cancel === "dead" ? t("已消灭，跳过") : step.cancel === "frozen" ? t("冻结，无法行动") : step.cancel === "stunned" ? t("眩晕，无法行动") : step.cancel === "battle_over" ? t("对局结束，后续跳过") : step.cancel === "no_target" ? t("没有可结算目标") : "";
                const deltas = [...Object.entries(step.outcome.hp).map(([id, delta]) => `${t(NAMES[id as MechId])} ${delta > 0 ? "+" : ""}${delta} HP`), ...Object.entries(step.outcome.buildings).map(([id, delta]) => `${t("建筑")} ${id} ${delta > 0 ? "+" : ""}${delta} HP`)];
                const skillLabel = step.skill === "status_tick" ? t("毒/燃烧结算") : step.skill === "environment_tick" ? t("环境结算") : monsterSkillName(step.skill, locale);
                const summary = <>{step.order}. {actorLabel} · {skillLabel}{step.cells.length ? ` · ${step.cells.map(cell => `${cell.x},${cell.y}`).join("、")}` : ""}{cancelLabel ? ` · ${cancelLabel}` : ""}</>;
                return <li key={`${step.order}-${step.actor}`} data-attack-order-step data-order={step.order} data-cancel={step.cancel || undefined}>
                  {step.actor === "status" ? <span>{summary}</span> : <button type="button" aria-pressed={s.selectedEnemy === step.actor} onClick={() => inspectEnemy(s.selectedEnemy === step.actor ? null : step.actor)}>{getUnitPortrait(step.actor) ? <MechaUnitPortrait unitId={step.actor} locale={locale} size={22} className="mecha-inline-portrait" /> : null}{summary}</button>}
                  <small>{deltas.length ? deltas.join(" · ") : cancelLabel || t("未造成生命值变化")}</small>
                </li>;
              })}</ol> : <p>{t("本次预测没有敌方阶段。")}</p>}
            </> : <p>{t("敌方顺序预测暂不可用；不能据此判断安全。")}</p>}
            <p>{t("本规则没有独立电网或环境攻击。")}</p>
          </MechaTurnOrder> : null}
          {(!compactSummary || remoteActive) ? <div className="mecha-extra-summary">
            <p>{t("大怪")} <strong>{state.boss.hp}</strong>{raiderHp ? ` · ${raiderHp}` : ""}{outcome ? ` · ${outcome}` : ""}</p>
            <p>{t("机甲单台损毁不败北；全灭、守楼全毁或超时则败北。")}</p>
            <p>{t("我方固定行动顺序")}：{["Assault", "Gunner", "Support"].map((id) => t(NAMES[id as MechId])).join(" → ")}</p>
            {s.hoveredEnemy ? <p>{t("高亮所选敌人的预告；其他威胁仍可见。")}</p> : null}
          </div> : null}
        </MechaObjectivePanel>
        {!remoteActive && !performance && s.lastLog.length > 0 ? <MechaLastResult lastLog={s.lastLog} healthTimeline={s.combat.healthTimeline} finalState={state} t={t} locale={locale} /> : null}
        <MechaTeamPanel label={t("回合与队伍规划")}>
          {deployment ? <MechaDeploymentPanel controller={controller} state={s} disabled={remoteActive || previewLoading || !deployment.interactive} submitRef={setSubmitTarget} /> : <>
          <MechaTeamTurnControls submitRef={setSubmitTarget} heading={t(state.outcome && !remoteActive ? "队伍状态" : "队伍规划")}
            status={<><strong>{state.outcome && !remoteActive ? t("对局已结束。") : <>{t("已规划")} {plannedCount}/{activeMechs.length}</>}</strong>{predictedFizzles.length ? <span id="mecha-draft-fizzle" className="mecha-planning-fizzle" role="status" data-draft-fizzle>{t("草稿预计落空：")}{predictedFizzles.map(event => t(NAMES[event.mechId])).join(locale === "en" ? ", " : "、")}</span> : null}{s.openingSuggestion && !remoteActive ? <span className="mecha-sr-only">{t("系统建议，可修改")}</span> : null}<span id="mecha-submit-status" className={planning && (packReady || pendingNames.length > 0) ? "mecha-sr-only" : undefined}>{remoteActive ? t("远程战棋期间本地规划已锁定。") : state.outcome ? t("对局已结束。") : paused ? t("演出暂停中，无法结束回合。") : performance || sequenceWaiting ? t("等待战斗演出，暂不可结束回合。") : auto ? t("自动对战中，无法手动结束回合。") : pendingNames.length ? `${t("待规划")}：${pendingNames.join("、")}` : t("已就绪，可结束回合。")}</span></>} help={<p id="mecha-reset-help" className="mecha-reset-help mecha-sr-only">{t(s.resetTurnUsed ? "本局的重置机会已用完。" : state.outcome ? "对局结束后不可重置。" : remoteActive ? "远程战棋期间不可重置。" : planning ? "每场可用一次：恢复本回合开始时的草稿，不会撤回已结算的回合。" : "暂停、自动对战或演出期间不可重置。")}</p>}>
            {!(state.outcome && !remoteActive) ? <div className={`mecha-planning-controls${s.holdConfirmation ? " is-confirming" : ""}`}>
              {!s.holdConfirmation ? <button type="button" className="mecha-submit-primary" aria-describedby={predictedFizzles.length ? "mecha-submit-status mecha-draft-fizzle" : "mecha-submit-status"} disabled={!planning || !packReady} onClick={hudActions.endTurn}>{t("结束回合")}</button> : <div className="mecha-hold-confirm" role="group" aria-label={t("确认全员待机")}>
                <div className="mecha-hold-confirm__risk" id="mecha-hold-risk" role="status">
                  <strong>{t("全员待机的预计风险")}</strong>
                  {s.holdConfirmation.buildingLoss > 0 ? <span>{t("预计建筑损失")} {s.holdConfirmation.buildingLoss}</span> : null}
                  {predictedOutcome ? <span>{predictedOutcome}</span> : null}
                </div>
                <div className="mecha-hold-confirm__actions">
                  <button type="button" disabled={remoteActive} onClick={() => controller.cancelHold()}>{t("返回修改")}</button>
                  <button type="button" className="mecha-submit-primary" aria-describedby="mecha-hold-risk" disabled={!planning} onClick={() => hudActions.confirmEndTurn(true)}>{t("继续提交")}</button>
                </div>
              </div>}
              <button type="button" className="mecha-reset-turn" disabled={!planning || !s.canResetTurn} aria-describedby="mecha-reset-help" onClick={hudActions.resetTurn}>{t("重置本回合")}</button>
            </div> : null}
          </MechaTeamTurnControls>
          <MechaRoster label={t("三机行动状态")} helpId="mecha-roster-scroll-help" help={t(state.outcome && !remoteActive ? "队伍状态" : "三机计划 · 滚动查看")}
            rows={(state.outcome && !remoteActive ? state.mechs : activeMechs).map(m => ({ id: m.id, name: t(NAMES[m.id]), hp: m.hp,
              selected: m.id === selected, disabled: remoteActive || auto || paused || Boolean(performance) || m.hp <= 0,
              onSelect: id => controller.selectMech(id), finished: Boolean(state.outcome && !remoteActive), draft: draft?.[m.id],
              openingSuggestion: s.openingSuggestion, hitDamage: preview ? preview.hitsAfter[m.id] ?? 0 : null,
              fizzle: predictedFizzles.find(event => event.mechId === m.id) ?? null, locale,
              avatar: <MechaUnitAvatar mechId={m.id} locale={locale} /> }))} /></>}
        </MechaTeamPanel>
        {deployment ? <MechaDeploymentActions controller={controller} state={s} disabled={remoteActive || previewLoading || !deployment.interactive} /> : <MechaCommandPanel className={targeting ? "is-targeting" : ""} label={t("当前机甲行动")}
          heading={<h3 tabIndex={-1}><span>{t("操作机甲")} · {selectedMech ? t(NAMES[selectedMech.id]) : t("当前机甲")}</span>{selectedMech ? <span className="mecha-selected-hp">{selectedMech.hp} / {unitMaxHp(selectedMech.id, state) ?? "?"} HP</span> : null}</h3>}
          instruction={targeting ? <p className="mecha-target-instruction">{t(actionLabel(targeting))} · {t("点击高亮目标")}</p> : null}
          deck={<MechaCommandDeck portrait={selectedMech ? <MechaUnitPortrait unitId={selectedMech.id} locale={locale} size={84} className="mecha-selected-portrait" decorative={false} /> : null}
            columns={new Set([...s.actions.map(action => action.kind), ...(planning ? s.unavailableActions.map(action => action.kind) : [])]).size}>
            {[...new Set(s.actions.map((action) => action.kind))].map((kind) => {
              const chosen = selected ? draft?.[selected] : undefined;
              const on = targeting === kind || (!targeting && Boolean(chosen?.explicit) && chosen?.action.kind === kind);
              return <MechaActionCard key={kind} type="button" data-mecha-action={kind} aria-label={t(actionLabel(kind))} className={on ? "is-selected" : ""} label={t(actionLabel(kind))} icon={<MechaActionIcon kind={kind} />} status={t("准备就绪")} aria-pressed={on} aria-describedby={inspectedAction === kind ? "mecha-action-inspection" : undefined} disabled={!planning}
                onPointerEnter={(event) => { if (event.pointerType === "mouse") setInspectedAction(kind); }}
                onPointerLeave={(event) => { if (event.pointerType === "mouse") setInspectedAction(null); }}
                onFocus={() => setInspectedAction(kind)} onBlur={() => setInspectedAction(null)}
                onPointerDown={(event) => {
                  if (event.pointerType !== "touch") return;
                  longPressed.current = false;
                  inspectTimer.current = window.setTimeout(() => { longPressed.current = true; setInspectedAction(kind); }, 450);
                }}
                onPointerUp={() => { if (inspectTimer.current !== null) window.clearTimeout(inspectTimer.current); inspectTimer.current = null; }}
                onPointerCancel={() => { if (inspectTimer.current !== null) window.clearTimeout(inspectTimer.current); inspectTimer.current = null; longPressed.current = false; }}
                onContextMenu={(event) => event.preventDefault()}
                onClick={(event) => {
                  if (longPressed.current) { event.preventDefault(); longPressed.current = false; return; }
                  setInspectedAction(null);
                  if (!selected) return;
                  if (kind !== "skip") {
                    hudActions.chooseAction(kind);
                    return;
                  }
                  hudActions.chooseAction(kind);
                }} />;
            })}
            {planning ? s.unavailableActions.map(({ kind, reason }) => <MechaActionCard type="button" className="is-unavailable" label={t(actionLabel(kind))} icon={<MechaActionIcon kind={kind} />} status={t("不可用")} key={`unavailable-${kind}`} disabled title={t(reason === "cooldown" ? "技能冷却中，本回合不可使用。" : kind === "repair" ? "当前落点没有相邻友机；调整移动可能改变结果。" : kind === "melee" || kind === "charge" ? "当前落点没有相邻敌人；调整移动可能改变结果。" : "当前草稿落点没有可射击的敌人；展开下方查看原因。")} />) : null}
          </MechaCommandDeck>}
          utilities={<div className="mecha-actions mecha-action-utilities">
            <button type="button" disabled={!planning || !s.canUndoMove} title={t("恢复最近一次移动前的草稿，可能一并恢复其他机甲规划。")} onClick={hudActions.undoMove}>{t("撤回移动")}</button>
            {targeting ? <button type="button" className="mecha-target-cancel" disabled={!planning} onClick={(event) => finishTarget(event, false)}>{t("取消选目标")}</button> : null}
          </div>}
          target={targeting ? <div className="mecha-target-preview" aria-label={t("目标试算")}>
            <p>{t("选择目标后确认，不会提交整包。")}</p>
            <MechaTargetOptions options={targetOptions.map(option => ({ key: option.id, selected: candidate?.source === "selection" && candidate.target === option.id, label: <>{getUnitPortrait(option.id) ? <MechaUnitPortrait unitId={option.id} locale={locale} size={22} className="mecha-inline-portrait" /> : null}{unitName(option.id)} · {option.cells.map(cell => `${cell.x},${cell.y}`).join("、")}</> }))}
              disabled={!planning} empty={t(s.targetValidationUnavailable ? "目标校验暂不可用；草稿未改变。" : "无合法目标")}
              after={s.targetValidationUnavailable && targetOptions.length ? <span>{t("目标校验暂不可用；草稿未改变。")}</span> : null} onSelect={(id, event) => {
              if (event.detail === 0 && document.activeElement === event.currentTarget) {
                if (candidate?.source === "selection" && candidate.target === id) {
                  candidateRef.current?.querySelector<HTMLButtonElement>(".mecha-candidate-actions button:not(:disabled)")?.focus();
                  return;
                }
                candidateKeyboardTrigger.current = event.currentTarget;
              }
              hudActions.pickTarget(s.targetOptions.findIndex(option => option.id === id));
            }} />
            {s.targetRejections.length ? <ul className="mecha-target-rejections">{s.targetRejections.map(({ option, fault }) => <li key={option.id}>{unitName(option.id)} · {t("不可选")} · {previewFaultText(fault, locale)}</li>)}</ul> : null}
          </div> : null}
          unavailable={planning && s.unavailableActions.length ? <details className="mecha-unavailable-actions">
            <summary>{t("当前不可用行动")} ({s.unavailableActions.length})</summary>
            <ul>{s.unavailableActions.map(({ kind, reason, shotTargets }) => <li key={kind}><strong>{t(actionLabel(kind))}</strong> · {t(reason === "cooldown" ? "技能冷却中，本回合不可使用。" : kind === "repair" ? "当前落点没有相邻友机；调整移动可能改变结果。" : kind === "melee" || kind === "charge" ? "当前落点没有相邻敌人；调整移动可能改变结果。" : "当前草稿落点没有可射击的敌人；展开下方查看原因。")}
              {shotTargets ? <div className="mecha-shot-diagnostics"><p>{t("按全队移动落定后的局面，逐目标显示首个不满足条件。")}</p>{shotTargets.length ? <ul>{shotTargets.map(({ id, targetCell, check }) => <li key={id}>{unitName(id)} ({targetCell.x},{targetCell.y}) · {t(shotCheckLabel(check))}{"cell" in check ? ` · ${t("阻挡格")} (${check.cell.x},${check.cell.y})` : null}</li>)}</ul> : <p>{t("场上没有存活敌人。")}</p>}</div> : null}
            </li>)}</ul>
          </details> : null}
          movement={<MechaMoveList id="mecha-move-choice" summary={t("通过列表移动")}
            label={t("选择可到达格；终点冲突会提示。")} placeholder={t("选择坐标")} applyText={t("应用移动")}
            options={reach.map(cell => ({ value: `${cell.x},${cell.y}`, label: `${cell.x}, ${cell.y}` }))}
            value={moveChoice} disabled={!planning || !selected} onChange={setMoveChoice}
            onApply={() => { const [x, y] = moveChoice.split(",").map(Number); if (selected && Number.isInteger(x) && Number.isInteger(y)) hudActions.moveTo({ x, y }); }} />} />}
            {targeting && candidate ? <div ref={candidateRef} className="mecha-candidate-result mecha-candidate-panel" data-candidate-source={candidate.source} tabIndex={0} role="region" aria-label={t("目标试算")}>
              {cellInfo ? <MechaCellInspector key={`${cellInfo.cell.x},${cellInfo.cell.y}:${cellInfo.unit?.id ?? "tile"}`} info={cellInfo} locale={locale} onClose={closeInspection} compact /> : null}
              <strong>{t("目标试算")} · {selected ? t(NAMES[selected]) : "—"} / {t(actionLabel(targeting))} → {unitName(candidate.target)}</strong>
              <p className="mecha-candidate-source">{candidate.source === "selection" ? (candidate.preview.ok && candidate.preview.revision === s.preview.revision && candidate.preview.draftVersion === s.preview.draftVersion ? t("棋盘蓝色预测：目标试算 · 尚未确认") : t("目标试算不可用，棋盘预测未知。")) : t("棋盘仍显示当前草稿，点选后更新。")}</p>
              {candidate.source === "selection" ? <div className="mecha-candidate-actions">
                <button type="button" disabled={!planning} onClick={(event) => finishTarget(event, true)}>{t("确认选择")}</button>
                <button type="button" disabled={!planning} onClick={(event) => finishTarget(event, false)}>{t("取消选目标")}</button>
              </div> : null}
              {!candidateIsCurrent ? <p>{t("目标试算不可用，棋盘预测未知。")}</p> : !candidate.preview.ok ? <p>{candidate.preview.status === "invalid" ? previewFaultText(candidate.preview.fault, locale) : t("预览暂不可用，风险未知；提交仍会重新校验。")}</p> : candidateEffects ? <MechaCandidateConsequences result={candidateEffects} baseline={s.preview} candidate={candidate.preview} locale={locale} unitName={unitName} /> : <p>{t("行动未执行，结果未知。")}</p>}
            </div> : null}
        {cellInfo && !(targeting && candidate) ? <MechaCellInspector key={`${cellInfo.cell.x},${cellInfo.cell.y}:${cellInfo.unit?.id ?? "tile"}`} info={cellInfo} locale={locale} onClose={closeInspection} /> : null}
        {inspectedAction && s.actions.some((action) => action.kind === inspectedAction) ? <div id="mecha-action-inspection" className="mecha-action-inspection" role="tooltip"><strong>{t(actionLabel(inspectedAction))}</strong> · {t(ACTION_DESCRIPTIONS[inspectedAction])}</div> : null}
        {s.notice && !(settingsPanel === "battlefield" && s.notice === t("行动建议暂不可用；草稿未改变。")) && <p role="alert">{s.notice}</p>}
        <MechaSettingsPopover id="mecha-battlefield-settings" title={t("战场设置与规则")} closeLabel={t("关闭设置")} hidden={settingsPanel !== "battlefield"} onClose={closeSettings} bodyClassName="mecha-settings-body mecha-settings">
          <p className="mecha-help">{t("左拖旋转，右拖平移，滚轮缩放；短点击选择格子。暂停时仍可调整视角。")}</p>
          <MechaBattleLegend locale={locale} view={cityView} />

          {s.notice === t("此战场没有可达的救援点，请更换战场或任务。") ? <p role="alert">{s.notice}</p> : null}
          <div className="mecha-toolbar">
            <label>{t("任务模式")}<select data-mission-mode disabled={remoteActive || Boolean(performance)} value={s.match.mission?.kind ?? "eliminate"} onChange={(event) => {
              const next = event.target.value === "rescue:v1" ? "rescue:v1" : null;
              if ((s.match.mission?.kind ?? null) !== next) requestDestructiveAction(() => { if (controller.restart({ mission: next, monsterContent: null })) setFocusedBuilding(null); });
            }}><option value="eliminate">{t("消灭敌人")}</option><option value="rescue:v1">{t("救援")}</option></select></label>
            <label>{t("战场")}<select disabled={remoteActive || Boolean(performance)} value={shapeId} onChange={(e) => {
              const next = e.target.value as FightShape;
              const nextSite = safeCatalog[next];
              if (!nextSite || next === shapeId) return;
              requestDestructiveAction(() => {
                if (!controller.restart({ site: nextSite, stake: next === "alley" ? "frontage" : "all" })) return;
                if (connectedAssault) setPreviewLoading(true);
                setShape(next);
                setFocusedBuilding(null);
              });
            }}>{SHAPES.map((item) => <option key={item.id} value={item.id} disabled={!safeCatalog[item.id]}>{t(item.label)}{catalog[item.id] && !safeCatalog[item.id] ? t(" · 出生点不安全") : ""}</option>)}</select></label>
            <label>{t("脚本")}<select disabled={remoteActive || Boolean(performance)} value={s.script} onChange={(e) => {
              const next = e.target.value as BossScriptId;
              if (next !== s.script) requestDestructiveAction(() => { if (controller.restart({ script: next })) setFocusedBuilding(null); });
            }}>{SCRIPTS.map((sc) => <option key={sc.id} value={sc.id}>{t(sc.label)}</option>)}</select></label>
            <label>{t("打法")}<select disabled={Boolean(s.match.mission) || remoteActive || paused || Boolean(performance) || Boolean(s.match.outcome) || s.match.phase !== "player_plan"} value={doctrine} onChange={(e) => controller.setDoctrine(e.target.value as DoctrineId)}>{DOCTRINES.map((item) => <option key={item.id} value={item.id}>{t(item.label)}</option>)}</select></label>
            <button type="button" disabled={remoteActive} onClick={() => requestDestructiveAction(() => { setFocusedBuilding(null); controller.restart(); })}>{t("新开一局")}</button>
            <button type="button" disabled={!s.aiAvailable || !planning || s.doctrineConfirmation} onClick={() => controller.requestDoctrineSuggestion()}>{t("生成行动建议")}</button>
            <button type="button" disabled={!planning || !s.canUndoDoctrine} onClick={() => controller.undoDoctrineSuggestion()}>{t("撤回建议")}</button>
            <button type="button" disabled={!s.aiAvailable || remoteActive || Boolean(deployment) || Boolean(state.outcome)} onClick={() => controller.toggleAuto()}>{auto ? t("停止自动") : t("自动对战")}</button>
          </div>
          <MechaMonsterPractice locale={locale} activeSpecies={s.match.monsterContent?.speciesId} disabled={remoteActive || Boolean(performance) || Boolean(viewFailed) || previewLoading} notice={practiceNotice}
            onStart={(speciesId) => changeMonsterPractice(speciesId)} onReset={() => changeMonsterPractice("reset")} onExit={() => changeMonsterPractice(null)} />
          <details className="mecha-evaluation-details" data-p2-scenarios>
            <summary>{locale === "en" ? "Curated battle combinations" : "精选战场组合"}</summary>
            <p className="mecha-help">{locale === "en" ? "Existing enemy patterns on available city sites; these are not new maps or enemy types. Starting one replaces the current match." : "基于当前城市可用战场和现有敌人脚本的组合，并非新地图或新敌人。开始后将替换当前对局。"}</p>
            <div className="mecha-toolbar">
              <label>{locale === "en" ? "Combination" : "组合"}<select data-p2-scenario-select value={scenarioId} disabled={remoteActive || Boolean(performance)} onChange={event => { setScenarioId(event.target.value); setConfirmScenario(false); setScenarioNotice(null); }}>
                <option value="">{locale === "en" ? "Choose a combination" : "选择组合"}</option>
                {P2_SCENARIOS.map(item => <option key={item.id} value={item.id}>{locale === "en" ? item.label.en : item.label.zh}</option>)}
              </select></label>
              {!confirmScenario ? <button type="button" disabled={!scenarioId || remoteActive || Boolean(performance)} onClick={() => { setScenarioNotice(null); setConfirmScenario(true); }}>{locale === "en" ? "Start combination" : "开始组合"}</button> : <>
                <button type="button" data-p2-scenario-confirm disabled={remoteActive || Boolean(performance)} onClick={() => {
                  const before = controller.getState().match;
                  const currentCatalog = matchRuntime.current.safeCatalog;
                  const candidate = resolveP2Scenario(currentCatalog, scenarioId);
                  if (!candidate.ok) {
                    setScenarioNotice(locale === "en" ? "This combination is unavailable: the current city lacks a safe, valid site or enemy lineup." : "此组合不可用：当前城市没有满足安全、部署或敌人配置条件的战场。 ");
                    setConfirmScenario(false);
                    return;
                  }
                  requestDestructiveAction(() => {
                    if (remoteLocked.current || controller.getState().match !== before || matchRuntime.current.safeCatalog !== currentCatalog || matchRuntime.current.viewFailed || matchRuntime.current.previewLoading) return;
                    const checked = resolveP2Scenario(matchRuntime.current.safeCatalog, scenarioId);
                    if (!checked.ok) { setScenarioNotice(locale === "en" ? "The site changed; please choose again." : "战场条件已变化，请重新选择。"); setConfirmScenario(false); return; }
                    const { scenario, site: nextSite } = checked;
                    if (!controller.restart({ site: nextSite, preset: scenario.preset, script: scenario.script, stake: scenario.stake, mission: null, monsterContent: null })) return;
                    // A same-site restart does not remount CityMechaWorld, so it cannot
                    // issue a second loading-complete callback for the existing asset.
                    if (nextSite !== matchRuntime.current.site && connectedAssault) setPreviewLoading(true);
                    setShape(scenario.shape); setFocusedBuilding(null); setConfirmScenario(false); setScenarioNotice(null);
                  });
                }}>{locale === "en" ? "Replace match and deploy" : "替换对局并部署"}</button>
                <button type="button" onClick={() => setConfirmScenario(false)}>{locale === "en" ? "Cancel" : "取消"}</button>
              </>}
            </div>
            {confirmScenario ? <p role="status">{locale === "en" ? "This will replace the current match. Continue?" : "将替换当前对局，是否继续？"}</p> : null}
            {scenarioNotice ? <p role="alert">{scenarioNotice}</p> : null}
          </details>
          {s.match.mission ? <p className="mecha-help">{t("救援任务暂不支持行动建议或自动对战。")}</p> : null}
          {!s.match.mission && !s.aiAvailable ? <p className="mecha-help" role="status">{t("当前敌人暂不支持行动建议或自动对战，请手动规划。")}</p> : null}
          {s.notice === t("行动建议暂不可用；草稿未改变。") ? <p className="mecha-help" role="alert">{s.notice}</p> : null}
          {s.doctrineConfirmation ? <div className="mecha-doctrine-confirm" role="group" aria-labelledby="mecha-doctrine-confirm-title">
            <p id="mecha-doctrine-confirm-title" role="status">{t("生成建议会替换当前队伍的草稿。确认后可撤回；继续手动编辑后不能撤回建议。")}</p>
            <div><button type="button" disabled={!planning} onClick={() => controller.confirmDoctrineSuggestion()}>{t("确认替换草稿")}</button><button type="button" onClick={() => controller.cancelDoctrineSuggestion()}>{t("保留当前草稿")}</button></div>
          </div> : null}
          <details className="mecha-evaluation-details" onToggle={(event) => setShowPlanEvaluation(event.currentTarget.open)}>
            <summary>{t("查看当前草稿评分")}</summary>
            {showPlanEvaluation && settingsPanel === "battlefield" ? (planning && s.packReady
              ? <MechaPlanEvaluation match={s.match} draft={s.draft} doctrine={doctrine} locale={locale} />
              : <p role="status">{t("请在本地手动规划阶段，为每台存活机甲选择行动后查看评分。")}</p>) : null}
          </details>
          <p className="mecha-help">{t("手动模式切换打法不会改变草稿。生成的建议可手动调整；搜索只比较有限候选，并非最优保证。")}</p>
          <p className="mecha-help">{t(doctrine === "tunnel" ? "攻坚更侧重伤害大怪和接近它，也会考虑机甲、建筑与胜负。" : "守楼更侧重建筑与小怪威胁，也会考虑大怪、机甲与胜负；没有小怪时转向大怪。")}</p>
          <p className="mecha-help">{t(deployment ? "选择机甲，再点击绿色格子。已放置的机甲可交换位置。" : "点一台机甲，再点能走到的格子，然后给三台都选行动。红色是当前宣告，草稿试算可能改变敌方攻击。")}</p>
          <p className="mecha-help">{t("声明与草稿试算的威胁可能不同；边框表示可选目标，卡片上的受击是敌方阶段预计损失。")}</p>
          <p className="mecha-help">{t("沿着道路能多走一倍。突击靠路，炮手爬山和平地一样，支援上坡不加价。水过不去，被推进水或山地会撞上。")}</p>
          <p className="mecha-help">{t("靠岸有水，翻山有山地，巷战是贴着楼的路，单侧临街也算。这座城没有的场地不会出现。")}</p>
          {shapeId === "alley" ? <p className="mecha-help">{t("巷战只守临街的楼。贴着路的楼拆光就输，不临街的楼还在，但不算这一局。")}</p> : null}
          <p className="mecha-help">{focusLine}</p>
          {site.spawnSpread > FLAT_SPAWN_MAX_DELTA ? <p className="mecha-help">{t("出生高差")} {site.spawnSpread.toFixed(2)} · {t("标准 1，已放宽")}</p> : null}
          <p className="mecha-help">{t("战场在这座城市的地面上。楼顶血槽只记这一局，城市里的楼还在。")}</p>
          <p className="mecha-ruleset">{t("掩体")} {state.covers.length} · {t("建筑")} {state.buildings.filter((b) => b.hp > 0).length} · {state.ruleset}</p>
        </MechaSettingsPopover>
        <MechaSettingsPopover id="mecha-remote-settings" title={t("远程战棋")} closeLabel={t("关闭设置")} hidden={settingsPanel !== "remote"} onClose={closeSettings}>
            <p role="status">{locale === "en" ? "Remote handoff is available in Mecha tactics 1.5." : "手机续玩请使用机甲战棋 1.5。"}</p>
        </MechaSettingsPopover>
      </div>
      {showQuickGuide && !(resultReady && showMatchResult) ? <MechaQuickGuide locale={locale} returnFocusRef={guideTrigger} onClose={() => setShowQuickGuide(false)} /> : null}
      {resultReady && showMatchResult ? <MechaBattleResult state={state} locale={locale} matchRecap={s.matchRecap} onView={viewResultField} onRestart={() => requestDestructiveAction(() => { setShowMatchResult(false); setFocusedBuilding(null); controller.restart(); })} onExit={requestClose} /> : null}

    </MechaHud>
  );
}
