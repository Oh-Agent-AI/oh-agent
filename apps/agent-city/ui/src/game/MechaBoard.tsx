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
