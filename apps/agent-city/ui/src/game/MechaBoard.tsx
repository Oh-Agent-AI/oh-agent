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
import { MechaActionIcon } from "./MechaActionIcon";
import { unitMaxHp } from "./mecha/unitHealth";
import { MechaBattleLegend } from "./MechaBattleLegend";
import { MechaPlanCard } from "./MechaPlanCard";
import { MechaUnitAvatar, MechaUnitPortrait } from "./MechaUnitAvatar";
import { getUnitPortrait } from "./mecha/unitPortraits";
import { useConnectedAssault } from "../render/mecha/connectedAssaultMode";
import { terrainSurfaceHeight } from "../engine/surface/terrainSampling";
import { sampleAssaultTerrainSafety } from "./mecha/assaultTerrainSafety";
import { MechaLastResult } from "./MechaLastResult";
import { candidateResult } from "./mecha/candidateResult";
import { assaultSequenceWaiting } from "./mecha/assaultTurnPlayer";
import type { DoctrineId } from "./mecha/ai";
import { createMechaController, type MechaController } from "./mecha/controller";
import { anchorsFromCity, prepareFightTerrainAsync, type FightCatalog, type FightShape } from "./mecha/citySite";
import { startPreparedSearch } from "./mecha/fightSearchRunner";
import { cacheCatalog, cachedCatalog, encounterIsCurrent, forgetCatalog, type MonsterEncounter } from "./mecha/monsterEncounters";
import { RemoteMechaControls, type RemoteMechaStatus } from "./mecha/RemoteMechaControls";
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
  const remoteLocked = useRef(false);
  const changeRemoteStatus = (next: RemoteMechaStatus) => {
    remoteLocked.current = next !== "idle";
    setRemoteStatus(next);
  };
  const searchSeq = useRef(0);
  const playable = phase === "ready" && Boolean(engine) && catalogPlayable(catalog);

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
      const target = event.target as HTMLElement | null;
      if (target?.closest("select, input, textarea")) return;
      if (remoteLocked.current) { event.preventDefault(); event.stopPropagation(); return; }
      event.preventDefault();
      onClose();
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
      : <CityGate locale={locale} onClose={onClose} onRetry={retrySearch} title="这座城暂时没有可用机坪。" body="楼太少时往往没有平地、靠岸或巷战。可以重试，或关掉战棋。" />;
  }

  return <MechaMatch key={runId} locale={locale} onClose={onClose} engine={engine} catalog={encounter?.catalog ?? catalog} initialShape={encounter?.shape} remoteStatus={remoteStatus} remoteLocked={remoteLocked} onRemoteStatusChange={changeRemoteStatus} />;
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

const ACTION_DESCRIPTIONS: Record<Action["kind"], string> = {
  melee: "攻击相邻敌人，可推动大怪。",
  shoot: "沿直线射击射程内的敌人，路径不能被阻挡。",
  charge: "攻击相邻敌人，伤害更高，可推动大怪。",
  pierce: "沿直线射击，可穿过一处掩体、建筑或废墟。",
  repair: "为相邻友机恢复最多 4 点生命。",
  skip: "本机本回合不行动。",
};

/** 薄视图：状态、草稿、预检、结算、自动对战都在 controller 里，这里只订阅与渲染。
 *  没有城市战场时父级不会挂这个组件。 */
function MechaMatch({ locale, onClose, engine, catalog, initialShape, remoteStatus, remoteLocked, onRemoteStatusChange }: {
  locale: GameLocale;
  onClose: () => void;
  engine: CityEngine;
  catalog: FightCatalog;
  initialShape?: FightShape;
  remoteStatus: RemoteMechaStatus;
  remoteLocked: React.RefObject<boolean>;
  onRemoteStatusChange: (status: RemoteMechaStatus) => void;
}) {
  const t = (text: string) => gameText(text, locale);
  const safeCatalog = useMemo<FightCatalog>(() => {
    if (!useConnectedAssault(import.meta.env.DEV, location.search)) return catalog;
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
  }, [catalog, engine, engine.currentLayout]);
  const [shape, setShape] = useState<FightShape>(initialShape ?? "flat");
  const shapeId: FightShape = safeCatalog[shape] || initialShape && shape === initialShape ? shape : (SHAPES.find((item) => safeCatalog[item.id])?.id ?? "flat");
  const site = safeCatalog[shapeId] ?? null;
  const [viewFailed, setViewFailed] = useState<"mode" | "preview" | "asset" | null>(null);
  const [previewLoading, setPreviewLoading] = useState(() => useConnectedAssault(import.meta.env.DEV, location.search));
  const remoteActive = remoteStatus !== "idle";
  const [showOrder, setShowOrder] = useState(false);
  const [compactSummary, setCompactSummary] = useState(true);
  const [mapFocused, setMapFocused] = useState(false);
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
  const resolvedState = s?.match ?? null;
  const performance = s?.performance ?? null;
  const draft = s?.draft;
  const selected = s?.selected;
  const targeting = s?.targeting ?? null;
  const auto = s?.auto ?? false;
  const paused = s?.paused ?? false;
  const doctrine = s?.doctrine ?? "tunnel";

  const state = performance?.before ?? resolvedState;
  const finishPerformance = () => controller?.finishPerformance();
  useEffect(() => { setInspectedCell(null); setInspectedUnitId(null); }, [controller, site, state?.turn, performance, resolvedState]);

  const sequenceTrial = import.meta.env.DEV && new URLSearchParams(location.search).get("assaultTrial") === "1" && new URLSearchParams(location.search).get("assaultSequence") === "1";
  const sequenceActive = sequenceTrial && Boolean(site && !viewFailed) && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sequenceWaiting = assaultSequenceWaiting(sequenceActive, s?.combat ?? { id: 0, actions: [] }, sequenceStatus);
  const sequenceFault = sequenceWaiting && sequenceStatus?.id === s?.combat.id && sequenceStatus?.state === "fault";

  // Settings are scrollable, but must not cover the controls that remain
  // usable while they are open. Their available height changes when, e.g.,
  // the hold confirmation expands or the selected action panel changes.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return undefined;
    const sheets = Array.from(panel.querySelectorAll<HTMLElement>(":scope > .mecha-options-menu"));
    const blockers = Array.from(panel.querySelectorAll<HTMLElement>(":scope > .mecha-turn-summary, :scope > .mecha-last-result, :scope > .mecha-pack, :scope > .mecha-selected-actions, :scope > .mecha-submit"));
    const update = () => {
      const panelRect = panel.getBoundingClientRect();
      if (!panelRect.width || !panelRect.height) return;
      const pack = panel.querySelector<HTMLElement>(":scope > .mecha-pack");
      const summary = panel.querySelector<HTMLElement>(":scope > .mecha-turn-summary");
      const resource = panel.querySelector<HTMLElement>(":scope > .mecha-quick-resource");
      const recap = panel.querySelector<HTMLElement>(":scope > .mecha-last-result");
      const submit = panel.querySelector<HTMLElement>(":scope > .mecha-submit");
      const bar = panel.parentElement?.querySelector<HTMLElement>(":scope > .mecha-battle-bar");
      const packRect = pack?.getBoundingClientRect();
      const summaryRect = summary?.getBoundingClientRect();
      const resourceRect = resource?.getBoundingClientRect();
      const barRect = bar?.getBoundingClientRect();
      const set = (name: string, value: string) => {
        if (panel.style.getPropertyValue(name) !== value) panel.style.setProperty(name, value);
      };
      const sideLayout = window.matchMedia("(min-width: 601px) and (min-height: 420px)").matches;
      const legendTop = barRect?.height ? Math.ceil(barRect.bottom - panelRect.top + 8) : 64;
      set("--mecha-legend-top", `${legendTop}px`);
      const hudTop = legendTop;
      const submitRect = submit?.getBoundingClientRect();
      const submitTop = (resourceRect?.height ?? 40) + 14;
      const rosterTop = submitTop + (submitRect?.height ?? 64) + 8;
      set("--mecha-submit-top", `${submitTop}px`);
      set("--mecha-hud-top", `${hudTop}px`);
      if (submit) set("--mecha-submit-height", `${Math.ceil(submit.getBoundingClientRect().height)}px`);
      if (resourceRect?.height) set("--mecha-roster-top", `${Math.ceil(rosterTop)}px`);
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
        const clearance = sideLayout ? panelRect.top + rosterTop + packRect.height : summaryRect.bottom;
        const available = Math.max(40, Math.floor(panelRect.bottom - clearance - bottom - 8));
        set("--mecha-pack-bottom", `${bottom}px`);
        set("--mecha-actions-available", `${available}px`);
      }
      for (const sheet of sheets) {
        const rect = sheet.getBoundingClientRect();
        let bottom = panelRect.bottom - 12;
        for (const blocker of blockers) {
          const other = blocker.getBoundingClientRect();
          if (other.width && other.height && other.left < rect.right && other.right > rect.left && other.top > rect.top && other.top < bottom) bottom = other.top - 8;
        }
        const height = `${Math.max(34, Math.floor(bottom - rect.top))}px`;
        if (sheet.style.getPropertyValue("--mecha-settings-max-height") !== height) sheet.style.setProperty("--mecha-settings-max-height", height);
      }
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(panel);
    for (const blocker of blockers) observer?.observe(blocker);
    for (const sheet of sheets) observer?.observe(sheet);
    const resource = panel.querySelector<HTMLElement>(":scope > .mecha-quick-resource");
    const bar = panel.parentElement?.querySelector<HTMLElement>(":scope > .mecha-battle-bar");
    if (resource) observer?.observe(resource);
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
    const pack = root.querySelector<HTMLElement>(":scope > .mecha-pack");
    const result = root.querySelector<HTMLElement>(":scope > .mecha-candidate-panel");
    const inspection = root.querySelector<HTMLElement>(":scope > .mecha-cell-inspector");
    const panels = [summary, actions, pack, result, inspection].filter((panel): panel is HTMLElement => Boolean(panel));
    const sideLayout = () => window.matchMedia("(min-width: 601px) and (min-height: 420px)").matches;
    const narrow = () => window.matchMedia("(min-width: 601px) and (max-width: 760px) and (min-height: 420px) and (max-height: 600px)").matches;
    const timers = new Map<HTMLElement, number>();
    let keyboardMode = false;
    const onKeyInput = () => { keyboardMode = true; };
    const onPointerInput = () => { keyboardMode = false; };
    const fit = (panel: HTMLElement) => {
      const name = panel === inspection ? "--mecha-inspector-fit-height" : panel === result ? "--mecha-candidate-fit-height" : panel === pack ? "--mecha-roster-fit-height" : panel === summary ? "--mecha-summary-fit-height" : "--mecha-actions-fit-height";
      if (!sideLayout()) {
        root.style.removeProperty(name);
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
        ? Math.min(result ? window.innerHeight * 0.3 : panel.querySelector("details[open], #mecha-order-panel") ? window.innerHeight * 0.64 : window.innerHeight * 0.38, 380, objectiveHeight)
        : available;
      // Keep every settled scrollport edge between whole lines/controls,
      // including long candidate results. The ceiling remains independent of
      // scroll position; the fit trims only a partially painted bottom row.
      // A bottom-anchored movement form must keep a stable scrollport while
      // native scrollIntoView brings its controls into view. Resizing on each
      // scroll moves its top and can clip the very button being revealed.
      const moving = panel === actions && Boolean(panel.querySelector(".mecha-move-list[open]"));
      let height = moving ? limit : wholeLineHeight(panel, limit);
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
      if (!sideLayout()) return;
      // Do not snap a keyboard user's scroll or move their focused control out
      // of view. Snap again after focus leaves the scrollport.
      if (keyboardMode && panel.contains(document.activeElement)) return;
      // Align a partially visible top line/control to the nearest edge. Large
      // controls remain scrollable rather than trapping the viewport.
      for (let i = 0; i < 8; i += 1) {
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
        panel.scrollTop += focused || Math.abs(before) <= after ? before : after;
        if (Math.abs(panel.scrollTop - previous) < 0.5) break;
      }
      fit(panel);
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

  const reach = s?.reach ?? [];
  const targetOptions = s?.targetOptions ?? [];
  const clickCell = (x: number, y: number, input: "mouse" | "touch") => {
    // The map-only view exposes cells otherwise hidden behind the HUD. Restore
    // the controls after a board pick, including an invalid pick or touch preview.
    if (mapFocused) setMapFocused(false);
    if (!state || performance || previewLoading) return;
    const info = inspectCell(state, { x, y }, performance ? {} : draft);
    setInspectedCell(info?.cell ?? null);
    setInspectedUnitId(info?.unit?.id ?? null);
    controller?.setSelectedEnemy(info?.unit?.side === "enemy" ? info.unit.id : null);
    if (sequenceWaiting || performance || remoteLocked.current) return;
    // The friendly models are already drawn at their draft endpoints. Pick the
    // displayed unit, not a different tile under its elevated mesh.
    if (!targeting && info?.unit?.side === "mech" && (info.unit.id !== selected || draft?.[info.unit.id as MechId]?.moveTo)) controller?.selectMech(info.unit.id as MechId);
    else controller?.clickCell(x, y, input);
  };
  const inspectEnemy = (actor: string | null) => {
    const attack = state && declaredAttack(state, actor);
    setInspectedCell(attack?.origin ?? null);
    setInspectedUnitId(actor);
    controller?.setSelectedEnemy(actor);
  };
  const inspectedMech = state?.mechs.find(m => m.id === inspectedUnitId && m.hp > 0);
  const inspectionPosition = inspectedMech ? draft?.[inspectedMech.id]?.moveTo ?? inspectedMech.pos : inspectedCell;
  const cellInfo = state && inspectionPosition ? inspectCell(state, inspectionPosition, performance ? {} : draft, inspectedUnitId) : null;
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
  const cityView = useMemo<CityMechaView & { declaredTelegraph: Cell[]; projectedTelegraph: Cell[] | null }>(() => {
    // A candidate identifies a unit, not the particular cell clicked. For the
    // multi-cell boss the first option cell is its rules anchor, not a claim
    // that only one of its four cells was selected.
    const candidate = s?.candidate;
    let targetPreview: { target: Cell; shove?: { from: Cell; to: Cell } } | undefined;
    if (!performance && !sequenceWaiting && !remoteActive && s?.interactive && s.preview.ok && s.targeting && selected && candidate?.source === "selection" && candidate.preview.ok) {
      const target = s.targetOptions.find((option) => option.id === candidate.target)?.cells[0];
      const result = candidateResult(candidate.preview, selected, candidate.target);
      if (target && result.action?.target === candidate.target && result.action.action === s.targeting && !result.action.fizzled) {
        // A prior action may have moved the target before this shove. Until
        // the scene labels turn stages, draw an arrow only from the selected
        // target's displayed position; the full result remains in the text.
        const shove = result.shoves.find(({ event, from, to }) => event.unit === candidate.target && from && to && from.x === target.x && from.y === target.y && (from.x !== to.x || from.y !== to.y));
        targetPreview = { target: { ...target }, ...(shove?.from && shove.to ? { shove: { from: { ...shove.from }, to: { ...shove.to } } } : {}) };
      }
    }
    return {
      combat: s?.combat,
      paused,
      figures: (state?.mechs ?? []).map((m) => {
        const planned = m.hp > 0 && !performance ? draft?.[m.id]?.moveTo : null;
        return { id: m.id, x: planned?.x ?? m.pos.x, y: planned?.y ?? m.pos.y, alive: m.hp > 0, hp: m.hp, maxHp: unitMaxHp(m.id) ?? undefined, selected: m.id === selected };
      }),
      boss: { x: state?.boss.anchor.x ?? 0, y: state?.boss.anchor.y ?? 0, alive: (state?.boss.hp ?? 0) > 0, hp: state?.boss.hp ?? 0, maxHp: unitMaxHp("boss") ?? undefined },
      raiders: (state?.raiders ?? []).map((raider) => ({ id: raider.id, x: raider.pos.x, y: raider.pos.y, alive: raider.hp > 0, hp: raider.hp, maxHp: unitMaxHp(raider.id) ?? undefined })),
      buildings: (state?.buildings ?? []).map((building) => ({ id: building.id, cells: building.cells, hp: building.hp, maxHp: building.maxHp })),
      focusedBuilding: performance || !s?.preview.ok ? null : focusedBuilding,
      telegraph: performance ? [] : (s?.telegraph ?? []),
      declaredTelegraph: performance ? [] : (s?.declaredThreats.cells ?? []),
      projectedTelegraph: performance ? null : (s?.projectedThreats?.cells ?? null),
      focusedTelegraph: performance ? [] : (s?.selectedEnemy ? (s.projectedThreats ?? s.declaredThreats).byActor[s.selectedEnemy] ?? [] : s?.focusedTelegraph ?? []),
      hoveredEnemy: s?.selectedEnemy ?? s?.hoveredEnemy ?? null,
      enemyOrder: showOrder && !performance && s?.preview.ok ? s.preview.enemyOrder : [],
      focus: performance ? [] : (s?.focusCells ?? []),
      reach: performance ? [] : reach,
      move: performance || !selected ? null : draft?.[selected]?.moveTo ?? null,
      targets: performance ? [] : targetOptions.flatMap((option) => option.cells),
      targetIds: performance ? [] : targetOptions.map((option) => option.id),
      targetPreview,
      obstacles: state?.obstacles,
      inspectedCell: cellInfo?.cell ?? null,
      // A clicked actor wins over transient hover; current declarations are
      // independent of whether the friendly draft predicts this actor's death.
      inspectionSegments: performance || !state ? [] : inspectionSegments(
        declaredAttack(state, s?.selectedEnemy ?? (cellInfo?.unit?.side === "mech" ? null : s?.hoveredEnemy ?? null)), cellInfo?.movePath ?? null),
      inspectedThreats: performance || !state ? [] : declaredAttack(state, s?.selectedEnemy ?? s?.hoveredEnemy ?? null)?.targets ?? [],
    };
  }, [s, state, draft, selected, reach, targetOptions, paused, performance, sequenceWaiting, focusedBuilding, showOrder, remoteActive, cellInfo]);

  if (!controller || !s || !state || !site) {
    return <CityGate locale={locale} onClose={onClose} title={locale === "en" ? "No safe Assault deployment." : "没有安全的 Assault 出生点。"} body={locale === "en" ? "Terrain sampling failed or the available spawn is too steep. Close the battle and try another city." : "地形采样失败或可用出生点过陡，请退出战斗并尝试其他城市。"} />;
  }

  if (viewFailed) {
    return (
      <CityGate locale={locale} onClose={onClose} closeDisabled={remoteActive} onRetry={viewFailed === "asset" ? undefined : () => setViewFailed(null)}
        title={viewFailed === "asset" ? "Assault 模型加载失败。" : viewFailed === "preview" ? "Assault 地面演出不可用。" : "三维视角被其他模式占用。"}
        body={viewFailed === "asset" ? "Assault 模型未能加载或实例化；退出战斗后检查资源。" : viewFailed === "preview" ? "路面数据失效或动作接地求解失败；可以重试，或退出战斗。" : "先退出影院、驾驶或飞行，再开战。"} recovery={remoteActive ? <RemoteMechaControls locale={locale} site={site} shape={shapeId} state={state} status={remoteStatus} canStart={false} onStatusChange={onRemoteStatusChange} onStopped={() => controller.restart()} /> : null} />
    );
  }

  const selectedMech = activeMechs.find((m) => m.id === selected);
  const skill = state.boss.intent?.skillId;
  const skillLabel = skill === "sweep" ? t("横扫") : skill === "smash" ? t("砸击") : t("跳过");
  const outcome = state.boss.hp <= 0 && state.outcome === "defeat_buildings" ? t("大怪已倒，楼先没了")
    : state.boss.hp <= 0 && state.outcome === "defeat_timeout" ? t("大怪已倒，回合用尽")
    : state.outcome === "victory" ? t("歼灭")
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
  const hasProjectedThreats = Boolean(preview && s.projectedThreats);
  const currentThreats = hasProjectedThreats ? s.projectedThreats : s.declaredThreats;
  const staked = stakeBuildings(state);
  const stakedHp = staked.reduce((total, building) => total + building.hp, 0);
  const stakedMax = staked.reduce((total, building) => total + building.maxHp, 0);
  const predictedBuildings = preview?.buildings.filter((building) => building.staked) ?? [];
  const predictedHp = predictedBuildings.reduce((total, building) => total + building.endHp, 0);
  const buildingDelta = predictedHp - stakedHp;
  const candidate = s.candidate;
  const candidateEffects = candidate?.preview.ok ? candidateResult(candidate.preview, selected!, candidate.target) : null;
  const unitName = (id: string) => id === "wall" ? t("墙或障碍") : id in NAMES ? t(NAMES[id as MechId]) : t(enemyName(id));
  const finishTarget = (event: React.MouseEvent<HTMLButtonElement>, confirm: boolean) => {
    if (event.detail === 0 && document.activeElement === event.currentTarget && targeting) {
      targetFocusReturn.current = { trigger: event.currentTarget, kind: targeting };
    }
    if (confirm) controller.confirmTarget();
    else controller.setTargeting(null);
    // Validation or a concurrent lock may keep targeting active.
    if (controller.getState().targeting) targetFocusReturn.current = null;
  };
  const predictedOutcome = preview?.outcome === "victory" ? t("预计胜利")
    : preview?.outcome === "defeat_buildings" ? t("预计防守建筑全毁")
    : preview?.outcome === "defeat_wipe" ? t("预计机甲全灭")
    : preview?.outcome === "defeat_timeout" ? t("预计回合耗尽") : null;
  const quickResource = <>
    {outcome ? <span>{outcome}</span> : null}
    <span>{t("防守建筑")}</span>
    <strong>{staked.length ? `${stakedHp}/${stakedMax}` : t("本局无守楼目标")}</strong>
    {performance ? <span>{t("演出中，不显示预测")}</span> : !state.outcome && preview && staked.length ? <span>→ {t("预计")} {predictedHp}/{stakedMax} ({buildingDelta > 0 ? "+" : ""}{buildingDelta})</span> : !state.outcome && !preview ? <span>{t("风险未知")}</span> : null}
    {preview && !s.projectedThreats ? <span>{t("草稿威胁未知")}</span> : null}
    {predictedOutcome ? <span>{predictedOutcome}</span> : null}
    {preview?.assumed.length ? <span>{t("假设待机")}：<abbr title={preview.assumed.map((id) => t(NAMES[id])).join("、")}>{preview.assumed.length}</abbr></span> : null}
    {remoteActive ? <span>{t("远程战棋期间本地规划已锁定。")}</span> : null}
  </>;

  return (
    <section className="mecha-overlay is-city has-match is-reference-hud" data-map-focus={mapFocused ? "true" : undefined} data-remote-active={remoteActive ? "true" : undefined} role="dialog" aria-label={t("机甲战棋")}>
      <CityMechaWorld ref={worldRef} engine={engine} site={site} locale={locale} view={cityView} performance={performance} paused={paused} onPerformanceComplete={finishPerformance} onCell={clickCell} onHoverCell={hoverCell} onHoverEnemy={(id) => controller.setHoveredEnemy(id)} onUnavailable={(reason) => setViewFailed(reason ?? "mode")} onPreviewLoading={setPreviewLoading} />
      <header className="mecha-battle-bar">
        <div><span>{t("回合")} {Math.min(state.turn, MAX_TURNS)}/{MAX_TURNS}</span>{paused && <span className="mecha-paused">{t("已暂停")}</span>}{previewLoading && <span role="status">{locale === "en" ? "Loading Assault model…" : "正在加载 Assault 模型…"}</span>}</div>
        <div className="mecha-battle-controls">
          <button type="button" aria-pressed={mapFocused} aria-describedby="mecha-map-focus-help" onClick={() => setMapFocused((value) => !value)}>{mapFocused ? t("恢复面板") : t("查看战场")}</button>
          <span id="mecha-map-focus-help" className="mecha-sr-only">{t("收起面板以查看战场；选择棋盘格后恢复面板。")}</span>
          <button type="button" title={t("回到可看全棋盘的战术视角")} onClick={() => worldRef.current?.resetCamera()}>{t("重置视角")}</button>
          <button type="button" aria-label={t("结算顺序")} aria-expanded={showOrder} aria-controls={showOrder ? "mecha-order-panel" : undefined} aria-describedby={showOrder && planning && preview ? "mecha-order-help" : undefined} onClick={() => { if (!showOrder) { setMapFocused(false); setCompactSummary(false); } else { panelRef.current?.querySelector<HTMLElement>(".mecha-turn-summary")?.scrollTo({ top: 0 }); } setShowOrder((value) => !value); }}>{t("顺序")}</button>
          {auto ? <button type="button" disabled={remoteActive} onClick={() => controller.stopAuto()}>{t("停止自动")}</button> : null}
          {performance || paused ? <button type="button" disabled={remoteActive || Boolean(state.outcome && !performance)} onClick={() => controller.togglePause()}>{paused ? t("继续演出") : t("暂停演出")}</button> : null}
          {performance ? <button type="button" onClick={finishPerformance}>{t("跳过演出")}</button> : null}
          <details className="mecha-battle-menu">
            <summary aria-label={t("战斗菜单")} title={t("战斗菜单")}>⋯</summary>
            <div className="mecha-battle-menu-items">
              <button type="button" disabled={remoteActive} onClick={onClose}>{t("退出战斗")}</button>
            </div>
          </details>
        </div>
      </header>
      <div className="mecha-panel" ref={panelRef}>
        {sequenceFault ? <p role="alert">{t("Assault 演出数据不完整或不一致，自动对战已等待；可重新开始一局。")}</p> : null}
        <details className="mecha-tactical-legend"><summary><span aria-hidden="true">✣ ◇ ! P</span> {t("战场图例")}{cityView.projectedTelegraph === null ? ` · ${t("风险未知")}` : ""}</summary><MechaBattleLegend locale={locale} projectedThreats={cityView.projectedTelegraph} verifiedShove={Boolean(cityView.targetPreview?.shove)} /></details>
        <div className="mecha-quick-resource">{quickResource}</div>
        <section className={`mecha-turn-summary${compactSummary && !remoteActive ? " is-compact" : ""}`} aria-label={t("战斗目标与威胁")} aria-describedby="mecha-summary-scroll-help" tabIndex={0} onKeyDown={(event) => {
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
          <div className="mecha-quick-resource-inline">{quickResource}</div>
          <p className="mecha-mobile-round">{t("回合")} {Math.min(state.turn, MAX_TURNS)}/{MAX_TURNS}{paused ? ` · ${t("已暂停")}` : ""}</p>
          {remoteActive ? <p className="mecha-resource" role="status">{t(remoteStatus === "starting" ? "正在启动远程战棋，本地规划已锁定。" : remoteStatus === "stopping" ? "正在停止远程战棋，本地规划仍锁定。" : remoteStatus === "unknown" ? "远程状态无法确认：请在远程战棋设置中停止并重试，本地规划保持锁定。" : "远程战棋已启动：桌面显示本地局面，不会同步远程战况。本地规划已锁定；停止远程将重开本地局。")}</p> : null}
          {!remoteActive ? <div className="mecha-objective-card">
            <div className="mecha-summary-heading">
              <span className="mecha-objective-heading">{t("本局目标")}</span>
              <button type="button" aria-expanded={!compactSummary} aria-label={t(compactSummary ? "展开面板" : "精简面板")} title={t(compactSummary ? "展开面板" : "精简面板")} onClick={(event) => { event.currentTarget.closest<HTMLElement>(".mecha-turn-summary")?.scrollTo({ top: 0 }); setCompactSummary((value) => !value); }}>{compactSummary ? <span aria-hidden="true">＋</span> : t("精简面板")}</button>
            </div>
            <strong className="mecha-objective-goal">{t(staked.length ? "消灭所有敌人 · 至少保住一栋防守建筑" : "消灭所有敌人")}</strong>
            <div className="mecha-objective-forecast" role="status">
              {state.outcome ? outcome : performance ? t("演出中，不显示预测") : !preview ? t("本回合预测未知") : !staked.length ? t("本局无守楼目标") : buildingDelta > 0 ? `${t("本回合预计建筑净恢复")} +${buildingDelta}` : `${t("本回合预计建筑净损失")} ${-buildingDelta}`}
              {!state.outcome && preview?.assumed.length ? <span> · {t("假设待机")}</span> : null}
              {!state.outcome && predictedOutcome ? <span className="mecha-objective-outcome">{predictedOutcome}</span> : null}
            </div>
            <span className="mecha-scroll-hint" aria-hidden="true">↕ {t("内容较多时可滚动")}</span>
          </div> : null}
          {!performance && !preview && !state.outcome ? <p className="mecha-preview-after mecha-forecast-status" role="status">{s.preview.status === "invalid" ? `${t("风险未知")} · ${previewFaultText(s.preview.fault, locale)}` : t("预览暂不可用，风险未知；提交仍会重新校验。")} {t("当前敌意不是草稿预测。")}</p> : null}
          {preview ? <details className="mecha-resource mecha-risk-details" onToggle={(event) => { if (!event.currentTarget.open) setFocusedBuilding(null); }}>
            <summary>{t("风险详情")}</summary>
            <p>{t("守楼败北条")} {staked.length ? <>{stakedHp}/{stakedMax} → {t("预计")} {predictedHp}/{stakedMax} ({buildingDelta > 0 ? "+" : ""}{buildingDelta}) · {buildingDelta <= 0 ? `${t("预计建筑损失")} ${-buildingDelta}` : `${t("预计建筑净恢复")} ${buildingDelta}`}</> : t("本局无守楼目标")}{predictedOutcome ? ` · ${predictedOutcome}` : ""}</p>
            <p>{t("整包预计机甲受击")} {hitLine}</p>
            {preview.assumed.length ? <p>{t("假设待机")}：{preview.assumed.map((id) => t(NAMES[id])).join("、")} · {t("已规划移动会保留；提交前须明确选择行动。")}</p> : null}
            <p>{t("选择建筑，高亮对应楼顶标记。")}</p><ul>{preview.buildings.map((building) => <li key={building.id}><button type="button" aria-pressed={focusedBuilding === building.id} onClick={() => setFocusedBuilding((id) => id === building.id ? null : building.id)}>{building.id} ({building.cells.map((cell) => `${cell.x},${cell.y}`).join("、")}) · {t(building.staked ? "防守建筑" : "非防守建筑，不计入败北条")} · {building.startHp} → {building.endHp}/{building.maxHp}{building.endHp <= 0 ? ` · ${t("预计毁灭")}` : ""}</button></li>)}</ul>
            {preview.log.filter((event) => event.type === "act" && event.fizzled).map((event) => event.type === "act" ? <p key={event.mechId}>{t(NAMES[event.mechId])} · {t("行动落空，不消耗冷却")} · {fizzleText(event.cause, locale)}</p> : null)}
          </details> : null}
          {!performance ? <details className="mecha-threat-details">
            <summary>{t("威胁来源与格子")}</summary>
            <p>{t("大怪当前宣告")}：{skillLabel}</p>
            <p>{t("红色三角为当前宣告；蓝色 P 为草稿试算；!P 表示两者重叠。")}</p>
            <p>{t("当前宣告威胁")}: {s.declaredThreats.cells.length ? s.declaredThreats.cells.map((cell) => `${cell.x},${cell.y}`).join("、") : t("当前没有宣告威胁格。")}</p>
            {preview && s.projectedThreats ? <>
              <p>{t("草稿试算威胁")}: {s.projectedThreats.cells.length ? s.projectedThreats.cells.map((cell) => `${cell.x},${cell.y}`).join("、") : t("本次试算没有威胁格。")}</p>
              <p>{t("列表显示草稿预测；点击敌人查看当前宣告与攻击方向。")}</p>
            </> : <p>{t("草稿试算未知；列表显示当前宣告，不能视为安全。")}</p>}
            <div className="mecha-threat-sources" aria-label={t(hasProjectedThreats ? "草稿试算威胁来源" : "当前宣告威胁来源")}>
              {currentThreats && Object.keys(currentThreats.byActor).length ? Object.entries(currentThreats.byActor).map(([actor, cells]) => <button key={actor} type="button" aria-pressed={s.selectedEnemy === actor} onClick={() => inspectEnemy(s.selectedEnemy === actor ? null : actor)}>{getUnitPortrait(actor) ? <MechaUnitPortrait unitId={actor} locale={locale} size={22} className="mecha-inline-portrait" /> : null}{t(enemyName(actor))}{hasProjectedThreats && preview?.enemyOrder.find((event) => event.actor === actor) ? ` · ${t(preview.enemyOrder.find((event) => event.actor === actor)!.skill === "sweep" ? "横扫" : "砸击")}` : ""} · {cells.map((cell) => `${cell.x},${cell.y}`).join("、")}</button>) : <span>{t(hasProjectedThreats ? "本次预测没有敌方攻击。" : "当前没有宣告威胁格。")}</span>}
            </div>
          </details> : null}
          {showOrder ? <div id="mecha-order-panel" className="mecha-order" role="region" aria-label={t("结算顺序")}>
            <p>{t("先同时移动，再按突击、射手、支援行动；随后敌方依次攻击。")}</p>
            {performance ? <p>{t("演出期间不显示预测。")}</p> : preview ? <>
              <p>{t("以下敌方顺序是草稿试算，不是当前宣告；敌人可能被消灭。")}</p>
              <p>{preview.assumed.length ? t("未规划机甲按待机预测；改变计划会更新顺序。") : t("按当前计划预测；改变计划会更新顺序。")}</p>
              {planning ? <p id="mecha-order-help" className="mecha-order-help">{t("列表编号表示预测的敌方顺序；棋盘不保证显示编号。选择敌人可查看威胁，仍可在棋盘规划移动或选目标。")}</p> : null}
              {preview.enemyOrder.length ? <ol>{preview.enemyOrder.map((event, index) => <li key={`${event.actor}-${index}`}><button type="button" aria-pressed={s.selectedEnemy === event.actor} onClick={() => inspectEnemy(s.selectedEnemy === event.actor ? null : event.actor)}>{getUnitPortrait(event.actor) ? <MechaUnitPortrait unitId={event.actor} locale={locale} size={22} className="mecha-inline-portrait" /> : null}{t(enemyName(event.actor))} · {t(event.skill === "sweep" ? "横扫" : "砸击")} · {event.cells.map((cell) => `${cell.x},${cell.y}`).join("、")}</button></li>)}</ol> : <p>{t("本次预测没有敌方攻击。")}</p>}
            </> : <p>{t("草稿试算未知；不能判断敌方顺序。")}</p>}
            <p>{t("本规则没有独立电网或环境攻击。")}</p>
          </div> : null}
          {(!compactSummary || remoteActive) ? <div className="mecha-extra-summary">
            <p>{t("大怪")} <strong>{state.boss.hp}</strong>{raiderHp ? ` · ${raiderHp}` : ""}{outcome ? ` · ${outcome}` : ""}</p>
            <p>{t("机甲单台损毁不败北；全灭、守楼全毁或超时则败北。")}</p>
            <p>{t("我方固定行动顺序")}：{["Assault", "Gunner", "Support"].map((id) => t(NAMES[id as MechId])).join(" → ")}</p>
            {s.hoveredEnemy ? <p>{t("高亮所选敌人的预告；其他威胁仍可见。")}</p> : null}
          </div> : null}
        </section>
        {!remoteActive && !performance && s.lastLog.length > 0 ? <MechaLastResult lastLog={s.lastLog} healthTimeline={s.combat.healthTimeline} t={t} locale={locale} /> : null}
        <ul className="mecha-pack" tabIndex={0} aria-label={t("三机行动状态")} aria-describedby="mecha-roster-scroll-help">
          <li className="mecha-roster-scroll-help" id="mecha-roster-scroll-help">{t("三机计划 · 滚动查看")}</li>
          {activeMechs.map((m) => <MechaPlanCard key={m.id} id={m.id} name={t(NAMES[m.id])} hp={m.hp}
            selected={m.id === selected} disabled={remoteActive || auto || paused || Boolean(performance)} onSelect={(id) => controller.selectMech(id)}
            draft={draft?.[m.id]} openingSuggestion={s.openingSuggestion} hitDamage={preview ? preview.hitsAfter[m.id] ?? 0 : null}
            locale={locale} avatar={<MechaUnitAvatar mechId={m.id} locale={locale} />} />)}
        </ul>
        <section className={targeting ? "mecha-selected-actions is-targeting" : "mecha-selected-actions"} aria-label={t("当前机甲行动")}>
          <h3 tabIndex={-1}><span>{selectedMech ? t(NAMES[selectedMech.id]) : t("当前机甲")}</span>{selectedMech ? <span className="mecha-selected-hp">{selectedMech.hp} / {unitMaxHp(selectedMech.id) ?? "?"} HP</span> : null}</h3>
          {targeting ? <p className="mecha-target-instruction">{t(actionLabel(targeting))} · {t("点击高亮目标")}</p> : null}
          <div className="mecha-command-deck">
            {selectedMech ? <MechaUnitPortrait unitId={selectedMech.id} locale={locale} size={84} className="mecha-selected-portrait" decorative={false} /> : null}
          <div className="mecha-action-cards" style={{ gridTemplateColumns: `repeat(${new Set([...s.actions.map((action) => action.kind), ...(planning ? s.unavailableActions.map((action) => action.kind) : [])]).size || 1}, minmax(0, 1fr))` }}>
            {[...new Set(s.actions.map((action) => action.kind))].map((kind) => {
              const chosen = selected ? draft?.[selected] : undefined;
              const on = targeting === kind || (!targeting && Boolean(chosen?.explicit) && chosen?.action.kind === kind);
              return <button key={kind} type="button" data-mecha-action={kind} aria-label={t(actionLabel(kind))} className={`mecha-action-card${on ? " is-selected" : ""}`} aria-pressed={on} aria-describedby={inspectedAction === kind ? "mecha-action-inspection" : undefined} disabled={!planning}
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
                    controller.setTargeting(targeting === kind ? null : kind);
                    return;
                  }
                  controller.setTargeting(null);
                  controller.setAction(selected, { kind: "skip" });
                }}><span>{t(actionLabel(kind))}</span><MechaActionIcon kind={kind} /><small>{t("准备就绪")}</small></button>;
            })}
            {planning ? s.unavailableActions.map(({ kind, reason }) => <button type="button" className="mecha-action-card is-unavailable" key={`unavailable-${kind}`} disabled title={t(reason === "cooldown" ? "技能冷却中，本回合不可使用。" : kind === "repair" ? "当前落点没有相邻友机；调整移动可能改变结果。" : kind === "melee" || kind === "charge" ? "当前落点没有相邻敌人；调整移动可能改变结果。" : "当前落点没有可射击目标（可能超出射程或被阻挡）；调整移动可能改变结果。")}><span>{t(actionLabel(kind))}</span><MechaActionIcon kind={kind} /><small>{t("不可用")}</small></button>) : null}
          </div>
          </div>
          <div className="mecha-actions mecha-action-utilities">
            <button type="button" disabled={!planning || !s.canUndoMove} title={t("恢复最近一次移动前的草稿，可能一并恢复其他机甲规划。")} onClick={() => controller.undoMove()}>{t("撤回移动")}</button>
            <button type="button" disabled={!planning || !s.canResetTurn} aria-describedby="mecha-reset-help" onClick={() => controller.resetTurn()}>{t("重置本回合")}</button>
            {targeting ? <button type="button" className="mecha-target-cancel" disabled={!planning} onClick={(event) => finishTarget(event, false)}>{t("取消选目标")}</button> : null}
          </div>
          {targeting ? <div className="mecha-target-preview" aria-label={t("目标试算")}>
            <p>{t("选择目标后确认，不会提交整包。")}</p>
            <div className="mecha-actions">{targetOptions.length ? targetOptions.map((option) => <button type="button" key={option.id} aria-pressed={candidate?.source === "selection" && candidate.target === option.id} disabled={!planning} onClick={(event) => {
              if (event.detail === 0 && document.activeElement === event.currentTarget) {
                if (candidate?.source === "selection" && candidate.target === option.id) {
                  candidateRef.current?.querySelector<HTMLButtonElement>(".mecha-candidate-actions button:not(:disabled)")?.focus();
                  return;
                }
                candidateKeyboardTrigger.current = event.currentTarget;
              }
              controller.previewTarget(option.id, "selection");
            }}>{getUnitPortrait(option.id) ? <MechaUnitPortrait unitId={option.id} locale={locale} size={22} className="mecha-inline-portrait" /> : null}{unitName(option.id)} · {option.cells.map((cell) => `${cell.x},${cell.y}`).join("、")}</button>) : <span>{t(s.targetValidationUnavailable ? "目标校验暂不可用；草稿未改变。" : "无合法目标")}</span>}{s.targetValidationUnavailable && targetOptions.length ? <span>{t("目标校验暂不可用；草稿未改变。")}</span> : null}</div>
            {s.targetRejections.length ? <ul className="mecha-target-rejections">{s.targetRejections.map(({ option, fault }) => <li key={option.id}>{unitName(option.id)} · {t("不可选")} · {previewFaultText(fault, locale)}</li>)}</ul> : null}
          </div> : null}
          {planning && s.unavailableActions.length ? <details className="mecha-unavailable-actions">
            <summary>{t("当前不可用行动")} ({s.unavailableActions.length})</summary>
            <ul>{s.unavailableActions.map(({ kind, reason }) => <li key={kind}><strong>{t(actionLabel(kind))}</strong> · {t(reason === "cooldown" ? "技能冷却中，本回合不可使用。" : kind === "repair" ? "当前落点没有相邻友机；调整移动可能改变结果。" : kind === "melee" || kind === "charge" ? "当前落点没有相邻敌人；调整移动可能改变结果。" : "当前落点没有可射击目标（可能超出射程或被阻挡）；调整移动可能改变结果。")}</li>)}</ul>
          </details> : null}
          <details className="mecha-move-list">
            <summary>{t("通过列表移动")}</summary>
            <label htmlFor="mecha-move-choice">{t("选择可到达格；终点冲突会提示。")}</label>
            <div className="mecha-move-controls">
              <select id="mecha-move-choice" value={moveChoice} disabled={!planning || !selected} onChange={(event) => setMoveChoice(event.currentTarget.value)}>
                <option value="" disabled>{t("选择坐标")}</option>
                {reach.map((cell) => <option key={`${cell.x},${cell.y}`} value={`${cell.x},${cell.y}`}>{cell.x}, {cell.y}</option>)}
              </select>
              <button type="button" disabled={!planning || !selected || !reach.some((cell) => `${cell.x},${cell.y}` === moveChoice)} onClick={() => {
                const [x, y] = moveChoice.split(",").map(Number);
                if (selected && Number.isInteger(x) && Number.isInteger(y)) controller.setMove(selected, { x, y });
              }}>{t("应用移动")}</button>
            </div>
          </details>
          <p id="mecha-reset-help" className="mecha-reset-help mecha-sr-only">{t(s.resetTurnUsed ? "本局的重置机会已用完。" : state.outcome ? "对局结束后不可重置。" : remoteActive ? "远程战棋期间不可重置。" : planning ? "每场可用一次：恢复本回合开始时的草稿，不会撤回已结算的回合。" : "暂停、自动对战或演出期间不可重置。")}</p>
        </section>
            {targeting && candidate ? <div ref={candidateRef} className="mecha-candidate-result mecha-candidate-panel" tabIndex={0} role="region" aria-label={t("目标试算")}>
              {cellInfo ? <MechaCellInspector key={`${cellInfo.cell.x},${cellInfo.cell.y}:${cellInfo.unit?.id ?? "tile"}`} info={cellInfo} locale={locale} onClose={closeInspection} compact /> : null}
              <strong>{t("目标试算")} · {selected ? t(NAMES[selected]) : "—"} / {t(actionLabel(targeting))} → {unitName(candidate.target)}</strong>
              {candidate.source === "selection" ? <div className="mecha-candidate-actions">
                <button type="button" disabled={!planning} onClick={(event) => finishTarget(event, true)}>{t("确认选择")}</button>
                <button type="button" disabled={!planning} onClick={(event) => finishTarget(event, false)}>{t("取消选目标")}</button>
              </div> : null}
              {!candidate.preview.ok ? <p>{candidate.preview.status === "invalid" ? previewFaultText(candidate.preview.fault, locale) : t("预览暂不可用，风险未知；提交仍会重新校验。")}</p> : candidateEffects?.action ? <>
                {candidateEffects.action.fizzled ? <p>{t("行动落空，不消耗冷却")} · {fizzleText(candidateEffects.action.cause, locale)}</p> : <>
                  <p>{t("行动造成的变化")} · {t("直接伤害")} {candidateEffects.action.damage}</p>
                  {candidateEffects.action.effects?.length ? candidateEffects.action.effects.map((effect) => <p key={`${effect.kind}-${effect.id}-${effect.order}`}>{unitName(effect.id)} HP {effect.before} → {effect.after}</p>) : <p>{t("没有生命变化")}</p>}
                  {candidateEffects.shoves.length ? candidateEffects.shoves.map(({ event, from, to }, index) => <div key={index}><p>{t("推挤")} {unitName(event.unit)} ({event.dir.x},{event.dir.y}) · {from ? `${from.x},${from.y}` : "?"} → {to ? `${to.x},${to.y}` : "?"}{event.hit ? ` · ${t("碰撞")} ${event.hit.split(",").map(unitName).join("、")}` : ""}</p>{event.effects?.map((effect) => <p key={`${effect.kind}-${effect.id}-${effect.order}`}>{unitName(effect.id)} HP {effect.before} → {effect.after}</p>)}</div>) : <p>{t("未发生推挤")}</p>}
                </>}
                <p>{t("整包结束目标 HP")} {candidateEffects.endHp ?? "?"}</p>
              </> : <p>{t("行动未执行，结果未知。")}</p>}
            </div> : null}
        {cellInfo && !(targeting && candidate) ? <MechaCellInspector key={`${cellInfo.cell.x},${cellInfo.cell.y}:${cellInfo.unit?.id ?? "tile"}`} info={cellInfo} locale={locale} onClose={closeInspection} /> : null}
        {inspectedAction && s.actions.some((action) => action.kind === inspectedAction) ? <div id="mecha-action-inspection" className="mecha-action-inspection" role="tooltip"><strong>{t(actionLabel(inspectedAction))}</strong> · {t(ACTION_DESCRIPTIONS[inspectedAction])}</div> : null}
        <div className="mecha-submit" ref={setSubmitTarget}>
          <div><strong>{t("已规划")} {plannedCount}/{activeMechs.length}</strong>{s.openingSuggestion && !remoteActive ? <span className="mecha-sr-only">{t("系统建议，可修改")}</span> : null}<span id="mecha-submit-status" className={planning && (packReady || pendingNames.length > 0) ? "mecha-sr-only" : undefined}>{remoteActive ? t("远程战棋期间本地规划已锁定。") : paused ? t("演出暂停中，无法结束回合。") : performance || sequenceWaiting ? t("等待战斗演出，暂不可结束回合。") : state.outcome ? t("对局已结束。") : auto ? t("自动对战中，无法手动结束回合。") : pendingNames.length ? `${t("待规划")}：${pendingNames.join("、")}` : t("已就绪，可结束回合。")}</span></div>
          {!s.holdConfirmation ? <button type="button" className="mecha-submit-primary" aria-describedby="mecha-submit-status" disabled={!planning || !packReady} onClick={() => controller.submit()}>{t("结束回合")}</button> : <div className="mecha-hold-confirm" role="group" aria-label={t("确认全员待机")}>
            <strong>{t("全员待机的预计风险")}</strong>
            {s.holdConfirmation.buildingLoss > 0 ? <span>{t("预计建筑损失")} {s.holdConfirmation.buildingLoss}</span> : null}
            {predictedOutcome ? <span>{predictedOutcome}</span> : null}
            <button type="button" disabled={remoteActive} onClick={() => controller.cancelHold()}>{t("返回修改")}</button>
            <button type="button" className="mecha-submit-primary" disabled={!planning} onClick={() => controller.confirmHold()}>{t("继续提交")}</button>
          </div>}
        </div>
        {s.notice && <p role="alert">{s.notice}</p>}
        <details className="mecha-options-menu">
          <summary>{t("战场设置与远程")}</summary>
        <details className="mecha-settings" name="mecha-battle-options">
          <summary>{t("战场设置与规则")}</summary>
          <p className="mecha-help">{t("左拖旋转，右拖平移，滚轮缩放；短点击选择格子。暂停时仍可调整视角。")}</p>
          <div className="mecha-map-legend" aria-label={t("战场图例")}>
            <span><i className="is-reach" />{t("可移动")}</span>
            <span><i className="is-move" />{t("计划落点")}</span>
            <small>{t("黄色菱形标记计划落点，尚未结算。")}</small>
            <span><i className="is-telegraph" />{t("当前宣告威胁")}</span>
            <span><i className="is-projected" />{t("草稿试算威胁")}</span>
            <small>{t("红色三角为当前宣告；蓝色 P 为草稿试算；!P 表示两者重叠。")}</small>
            <span><i className="is-focus" />{t("打法目标")}</span>
            <span><i className="is-target" />{t("可选目标")}</span>
            <small>{t("圆环为我方，菱形轮廓为敌方；黄色选中环与箭头是当前机甲。")}</small>
          </div>
          <div className="mecha-toolbar">
            <label>{t("战场")}<select disabled={remoteActive || Boolean(performance)} value={shapeId} onChange={(e) => {
              const next = e.target.value as FightShape;
              const nextSite = safeCatalog[next];
              if (!nextSite || next === shapeId) return;
              if (useConnectedAssault(import.meta.env.DEV, location.search)) setPreviewLoading(true);
              setShape(next);
              setFocusedBuilding(null);
              controller.restart({ site: nextSite, stake: next === "alley" ? "frontage" : "all" });
            }}>{SHAPES.map((item) => <option key={item.id} value={item.id} disabled={!safeCatalog[item.id]}>{t(item.label)}{catalog[item.id] && !safeCatalog[item.id] ? (locale === "en" ? " · unsafe spawn" : " · 出生点不安全") : ""}</option>)}</select></label>
            <label>{t("脚本")}<select disabled={remoteActive || Boolean(performance)} value={s.script} onChange={(e) => { setFocusedBuilding(null); controller.restart({ script: e.target.value as BossScriptId }); }}>{SCRIPTS.map((sc) => <option key={sc.id} value={sc.id}>{t(sc.label)}</option>)}</select></label>
            <label>{t("打法")}<select disabled={remoteActive || paused || Boolean(performance) || Boolean(s.match.outcome) || s.match.phase !== "player_plan"} value={doctrine} onChange={(e) => controller.setDoctrine(e.target.value as DoctrineId)}>{DOCTRINES.map((item) => <option key={item.id} value={item.id}>{t(item.label)}</option>)}</select></label>
            <button type="button" disabled={remoteActive} onClick={() => { setFocusedBuilding(null); controller.restart(); }}>{t("新开一局")}</button>
            <button type="button" disabled={!planning} onClick={() => controller.applyDoctrine()}>{t("按打法填入")}</button>
            <button type="button" disabled={remoteActive || Boolean(state.outcome)} onClick={() => controller.toggleAuto()}>{auto ? t("停止自动") : t("自动对战")}</button>
          </div>
          <p className="mecha-help">{t("点一台机甲，再点能走到的格子，然后给三台都选行动。红色是当前宣告，草稿试算可能改变敌方攻击。")}</p>
          <p className="mecha-help">{t("声明与草稿试算的威胁可能不同；边框表示可选目标，卡片上的受击是敌方阶段预计损失。")}</p>
          <p className="mecha-help">{t("沿着道路能多走一倍。突击靠路，炮手爬山和平地一样，支援上坡不加价。水过不去，被推进水或山地会撞上。")}</p>
          <p className="mecha-help">{t("攻坚先打大怪。守楼先打离楼最近的小怪。两种打法走出来的结果不同。")}</p>
          <p className="mecha-help">{t("靠岸有水，翻山有山地，巷战是贴着楼的路，单侧临街也算。这座城没有的场地不会出现。")}</p>
          {shapeId === "alley" ? <p className="mecha-help">{t("巷战只守临街的楼。贴着路的楼拆光就输，不临街的楼还在，但不算这一局。")}</p> : null}
          <p className="mecha-help">{focusLine}</p>
          {site.spawnSpread > FLAT_SPAWN_MAX_DELTA ? <p className="mecha-help">{t("出生高差")} {site.spawnSpread.toFixed(2)} · {t("标准 1，已放宽")}</p> : null}
          <p className="mecha-help">{t("战场在这座城市的地面上。楼顶血槽只记这一局，城市里的楼还在。")}</p>
          <p className="mecha-ruleset">{t("掩体")} {state.covers.length} · {t("建筑")} {state.buildings.filter((b) => b.hp > 0).length} · {state.ruleset}</p>
        </details>
        <RemoteMechaControls locale={locale} site={site} shape={shapeId} state={state} status={remoteStatus} canStart={s.interactive && !sequenceWaiting && !performance} onStatusChange={onRemoteStatusChange} onStopped={() => controller.restart()} stopTarget={submitTarget} />
        </details>
      </div>
    </section>
  );
}
