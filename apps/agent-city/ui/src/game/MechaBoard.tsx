/** City test surface for GDD v1.3. Rules live in `mecha/rules.ts`.
 *
 *  The battlefield search is not a render side effect. The board shell paints
 *  first, the city adapter samples every point the search can query into a
 *  transferable snapshot, and the search itself runs in a worker (or a sliced
 *  main-thread fallback). A successful catalog is cached per layout+model so
 *  reopening is instant; a city revision that lands mid-search aborts the old
 *  run instead of letting a stale catalog reach the board.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CityEngine } from "../engine/CityEngine";
import { doctrineFocusLine, gameText, stepBudgetLine, type GameLocale } from "./gameCopy";
import { CityMechaWorld, type CityMechaView, type CityMechaWorldHandle } from "./CityMechaWorld";
import { doctrineFocus, doctrineFocusCells, planForDoctrine, type DoctrineId } from "./mecha/ai";
import { anchorsFromCity, prepareFightTerrainAsync, type CityMechaSite, type FightCatalog, type FightShape } from "./mecha/citySite";
import { startPreparedSearch } from "./mecha/fightSearchRunner";
import { MechaLineup, type MechaBoardView } from "./MechaLineup";
import {
  BOARD, FLAT_SPAWN_MAX_DELTA, MAX_TURNS, bossExecute, bossPrepare, createMatch, incomingDamage, legalActions, living, moveBudget, pathDistance,
  validateAndApplyPlan, type Action, type BossScriptId, type Cell, type CoverPresetId, type MatchState, type MechId,
} from "./mecha/rules";
import "./game.css";

const PRESETS: Array<{ id: CoverPresetId; label: string }> = [
  { id: "covers_sparse_mid", label: "稀疏中轴" },
  { id: "covers_diag_corridor", label: "对角走廊" },
  { id: "covers_twin_clusters", label: "双掩体团" },
];
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

/** Successful catalogs are pure projections of the layout/model pair. Keying on
 *  the layout object means a re-plan (`applyModel` replaces it) invalidates the
 *  entry without any manual bookkeeping. */
type CatalogCacheEntry = { model: object; catalog: FightCatalog };
const CATALOG_CACHE = new WeakMap<object, CatalogCacheEntry>();

function cachedCatalog(layout: object | null, model: object | null): FightCatalog | null {
  if (!layout || !model) return null;
  const entry = CATALOG_CACHE.get(layout);
  return entry && entry.model === model ? entry.catalog : null;
}

function cacheCatalog(layout: object, model: object, catalog: FightCatalog): void {
  CATALOG_CACHE.set(layout, { model, catalog });
}

type SearchPhase = "loading" | "ready" | "error";

/** Loads (or reuses) the four-shape catalog, then mounts a match keyed by it. */
export function MechaBoard({ locale, onClose, engine }: { locale: GameLocale; onClose: () => void; engine: CityEngine | null }) {
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
  const searchSeq = useRef(0);

  useEffect(() => {
    if (!engine) {
      setCatalog(null);
      setPhase("ready");
      return undefined;
    }
    const layout = engine.currentLayout;
    const model = engine.currentModel;
    if (!layout || !model) {
      // No modelled city: the component falls back to the grid board, which is an
      // explicit state rather than a failed search.
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
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  if (phase === "ready") {
    return <MechaMatch key={runId} locale={locale} onClose={onClose} engine={engine} catalog={catalog} />;
  }

  return (
    <section className="mecha-overlay is-city" role="dialog" aria-label={t("机甲战棋")} aria-busy={phase === "loading"}>
      <header className="mecha-battle-bar">
        <div><strong>{t("机甲战棋")}</strong></div>
        <div className="mecha-battle-controls"><button type="button" onClick={onClose}>{t("退出战斗")}</button></div>
      </header>
      <div className="mecha-panel">
        {phase === "error" ? (
          <>
            <p role="alert">{t("战场选择失败")}</p>
            <p className="mecha-help">{t("城市地形暂时无法生成战场，可以重试或关掉战棋。")}</p>
            <div className="mecha-actions">
              <button type="button" onClick={() => setRetry((value) => value + 1)}>{t("重试")}</button>
              <button type="button" onClick={onClose}>{t("关闭")}</button>
            </div>
          </>
        ) : (
          <>
            <p role="status">{t("正在选择战场…")}</p>
            {sampled.total > 0 && sampled.done < sampled.total && <p className="mecha-help">{t("正在读取城市地形")} {sampled.done}/{sampled.total}</p>}
            {checked > 0 && <p className="mecha-help">{t("正在检查")} {checked} {t("个候选")}</p>}
            <div className="mecha-actions">
              <button type="button" onClick={onClose}>{t("取消")}</button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

type Draft = { moveTo: Cell | null; action: Action; explicit: boolean };
type TargetKind = Exclude<Action["kind"], "skip">;
type TargetOption = { id: string; cells: Cell[] };

function actionKey(action: Action): string {
  if (action.kind === "repair") return `repair:${action.target}`;
  if ("target" in action && action.target) return `${action.kind}:${action.target}`;
  return action.kind;
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

function validTarget(state: MatchState, id: MechId, moveTo: Cell | null, kind: TargetKind, target: string): boolean {
  const scratch = structuredClone(state);
  const action = { kind, target } as Action;
  const result = validateAndApplyPlan(scratch, {
    revision: scratch.revision,
    items: living(scratch).map((mech) => ({ mechId: mech.id, moveTo: mech.id === id ? moveTo : null, action: mech.id === id ? action : { kind: "skip" } })),
  });
  return !("ok" in result);
}

function footprintCells(anchor: Cell): Cell[] {
  return [anchor, { x: anchor.x + 1, y: anchor.y }, { x: anchor.x, y: anchor.y + 1 }, { x: anchor.x + 1, y: anchor.y + 1 }];
}

function fresh(preset: CoverPresetId, script: BossScriptId, site: CityMechaSite | null, stake: "all" | "frontage" = "all"): MatchState {
  const state = site
    ? createMatch({
      preset,
      script,
      covers: [],
      terrain: site.terrain.map((row) => row.slice()),
      heights: site.heights.map((row) => row.slice()),
      buildings: script === "siege" || script === "raid_ssw" ? site.buildings.map((building) => ({ id: building.id, cells: building.cells.map((cell) => ({ ...cell })) })) : [],
      raiders: script === "siege" ? site.raiders.map((raider) => ({ id: raider.id, pos: { ...raider.pos } })) : [],
      mechs: site.mechs.map((mech) => ({ id: mech.id, pos: { ...mech.pos } })),
      boss: { ...site.boss },
      stake,
    })
    : createMatch({ preset, script, stake });
  bossPrepare(state);
  return state;
}

function blankDraft(state: MatchState): Record<MechId, Draft> {
  return {
    Assault: { moveTo: null, action: { kind: "skip" }, explicit: false },
    Gunner: { moveTo: null, action: { kind: "skip" }, explicit: false },
    Support: { moveTo: null, action: { kind: "skip" }, explicit: false },
    ...Object.fromEntries(living(state).map((m) => [m.id, { moveTo: null, action: { kind: "skip" as const }, explicit: false }])),
  } as Record<MechId, Draft>;
}

function same(a: Cell, b: Cell) {
  return a.x === b.x && a.y === b.y;
}

function telegraphs(state: MatchState): Cell[] {
  const cells = [...(state.boss.intent?.projected ?? [])];
  for (const raider of state.raiders) cells.push(...(raider.intent?.projected ?? []));
  return cells;
}

function draftFromPlan(state: MatchState, plan: { items: Array<{ mechId: MechId; moveTo: Cell | null; action: Action }> }): Record<MechId, Draft> {
  const next = blankDraft(state);
  for (const item of plan.items) next[item.mechId] = { moveTo: item.moveTo, action: item.action, explicit: true };
  return next;
}

/** 新开一局时打法下拉还在，草稿按这个打法填上。结算后的下一回合仍是空白，等玩家自己填。 */
function openingDraft(state: MatchState, doctrine: DoctrineId): Record<MechId, Draft> {
  if (state.outcome || state.phase !== "player_plan") return blankDraft(state);
  return draftFromPlan(state, planForDoctrine(state, doctrine));
}

function MechaMatch({ locale, onClose, engine, catalog }: {
  locale: GameLocale;
  onClose: () => void;
  engine: CityEngine | null;
  catalog: FightCatalog | null;
}) {
  const t = (text: string) => gameText(text, locale);
  const [shape, setShape] = useState<FightShape>("flat");
  const [doctrine, setDoctrine] = useState<DoctrineId>("tunnel");
  const shapeId: FightShape = catalog?.[shape] ? shape : (SHAPES.find((item) => catalog?.[item.id])?.id ?? "flat");
  const site = catalog?.[shapeId] ?? null;
  const [preset, setPreset] = useState<CoverPresetId>("covers_sparse_mid");
  const [script, setScript] = useState<BossScriptId>("siege");
  const openingStake = shapeId === "alley" ? "frontage" : "all";
  const [state, setState] = useState<MatchState>(() => fresh("covers_sparse_mid", "siege", site, openingStake));
  const [draft, setDraft] = useState<Record<MechId, Draft>>(() => openingDraft(state, "tunnel"));
  const [selected, setSelected] = useState<MechId>("Assault");
  const [targeting, setTargeting] = useState<TargetKind | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [viewFailed, setViewFailed] = useState(false);
  const [auto, setAuto] = useState(false);
  const [paused, setPaused] = useState(false);
  const [beat, setBeat] = useState<"show" | "resolve">("show");
  const worldRef = useRef<CityMechaWorldHandle>(null);

  const restart = (nextPreset = preset, nextScript = script, nextSite: CityMechaSite | null = site, nextStake: "all" | "frontage" = shapeId === "alley" ? "frontage" : "all") => {
    const match = fresh(nextPreset, nextScript, nextSite, nextStake);
    setPreset(nextPreset);
    setScript(nextScript);
    setState(match);
    setDraft(openingDraft(match, doctrine));
    setSelected(living(match)[0]?.id ?? "Assault");
    setTargeting(null);
    setNotice(null);
    setAuto(false);
    setPaused(false);
    setBeat("show");
  };

  const selectedMech = living(state).find((m) => m.id === selected);
  const reach = useMemo(() => {
    if (!selectedMech || state.phase !== "player_plan") return [];
    const cells: Cell[] = [];
    for (let y = 0; y < BOARD; y += 1) {
      for (let x = 0; x < BOARD; x += 1) {
        const dist = pathDistance(state, selectedMech.pos, { x, y }, selected);
        if (dist !== null && dist <= moveBudget(selected)) cells.push({ x, y });
      }
    }
    return cells;
  }, [state, selected, selectedMech]);

  const actions = useMemo(() => {
    if (!selectedMech) return [];
    const scratch = structuredClone(state);
    const who = scratch.mechs.find((m) => m.id === selected && m.hp > 0);
    const dest = draft[selected]?.moveTo;
    if (who && dest) who.pos = dest;
    return legalActions(scratch, selected);
  }, [state, selected, selectedMech, draft]);

  const targetOptions = useMemo<TargetOption[]>(() => {
    if (!targeting || !selectedMech) return [];
    const options: TargetOption[] = targeting === "repair"
      ? living(state).filter((mech) => mech.id !== selected).map((mech) => ({ id: mech.id, cells: [{ ...mech.pos }] }))
      : [
        ...(state.boss.hp > 0 ? [{ id: "boss", cells: footprintCells(state.boss.anchor) }] : []),
        ...state.raiders.filter((raider) => raider.hp > 0).map((raider) => ({ id: raider.id, cells: [{ ...raider.pos }] })),
      ];
    const moveTo = draft[selected]?.moveTo ?? null;
    return options.filter((option) => validTarget(state, selected, moveTo, targeting, option.id));
  }, [state, selected, selectedMech, targeting, draft]);

  const paint = (x: number, y: number) => {
    const c = { x, y };
    const classes = ["mecha-cell"];
    const ground = state.terrain[y]?.[x];
    if (ground === "water") classes.push("is-water");
    if (ground === "mountain") classes.push("is-mountain");
    if (ground === "road") classes.push("is-road");
    if (state.covers.some((k) => same(k, c))) classes.push("is-cover");
    const building = state.buildings.find((b) => b.cells.some((k) => same(k, c)));
    if (building) classes.push(building.hp > 0 ? "is-cover" : "is-rubble");
    if (state.boss.hp > 0 && x >= state.boss.anchor.x && x <= state.boss.anchor.x + 1 && y >= state.boss.anchor.y && y <= state.boss.anchor.y + 1) classes.push("is-boss");
    if (state.raiders.some((raider) => raider.hp > 0 && same(raider.pos, c))) classes.push("is-raider");
    if (telegraphs(state).some((k) => same(k, c))) classes.push("is-telegraph");
    if (targetOptions.some((option) => option.cells.some((cell) => same(cell, c)))) classes.push("is-target");
    const unit = living(state).find((m) => same(m.pos, c));
    if (unit) classes.push(`is-${unit.id.toLowerCase()}`, unit.id === selected ? "is-selected" : "");
    if (doctrineFocusCells(state, doctrine).some((cell) => same(cell, c))) classes.push("is-focus");
    if (draft[selected]?.moveTo && same(draft[selected].moveTo!, c)) classes.push("is-move");
    if (reach.some((k) => same(k, c))) classes.push("is-reach");
    return classes.filter(Boolean).join(" ");
  };

  useEffect(() => {
    setTargeting(null);
  }, [selected, state.turn, auto, paused]);

  useEffect(() => {
    if (!auto || paused) return undefined;
    if (state.outcome) {
      setAuto(false);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      if (state.phase === "enemy_prepare") {
        const next = structuredClone(state);
        bossPrepare(next);
        setState(next);
        setDraft(blankDraft(next));
        setBeat("show");
        return;
      }
      if (state.phase !== "player_plan") return;
      if (beat === "show") {
        setDraft(draftFromPlan(state, planForDoctrine(state, doctrine)));
        setBeat("resolve");
        return;
      }
      const next = structuredClone(state);
      const result = validateAndApplyPlan(next, planForDoctrine(state, doctrine));
      if (!("ok" in result)) {
        setAuto(false);
        setNotice(gameText("整包被拒，局面未变，可以重提。", locale));
        return;
      }
      if (next.phase === "resolving_boss") bossExecute(next);
      if (next.phase === "enemy_prepare") bossPrepare(next);
      const alive = living(next);
      setState(next);
      setDraft(blankDraft(next));
      setBeat("show");
      if (!alive.some((m) => m.id === selected) && alive[0]) setSelected(alive[0].id);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [auto, paused, beat, doctrine, locale, selected, state]);

  const clickCell = (x: number, y: number) => {
    if (auto || paused || state.phase !== "player_plan") return;
    if (targeting) {
      const option = targetOptions.find((item) => item.cells.some((cell) => cell.x === x && cell.y === y));
      if (!option) {
        setNotice(t("这里不是合法目标，请点击地图上的高亮单位。"));
        return;
      }
      const action = { kind: targeting, target: option.id } as Action;
      setDraft((prev) => ({ ...prev, [selected]: { ...prev[selected], action, explicit: true } }));
      setTargeting(null);
      setNotice(null);
      return;
    }
    const occupant = living(state).find((m) => same(m.pos, { x, y }));
    if (occupant && occupant.id !== selected) {
      setSelected(occupant.id);
      return;
    }
    if (!selectedMech) return;
    if (!reach.some((k) => k.x === x && k.y === y)) return;
    const moveTo = same(selectedMech.pos, { x, y }) ? null : { x, y };
    const scratch = structuredClone(state);
    const who = scratch.mechs.find((m) => m.id === selected && m.hp > 0);
    if (who && moveTo) who.pos = moveTo;
    const legal = new Set(legalActions(scratch, selected).map(actionKey));
    setDraft((prev) => {
      const current = prev[selected];
      const keep = current?.explicit && legal.has(actionKey(current.action));
      return { ...prev, [selected]: { moveTo, action: keep ? current.action : { kind: "skip" }, explicit: Boolean(keep) } };
    });
    setNotice(null);
  };

  const activeMechs = living(state);
  const plannedCount = activeMechs.filter((m) => draft[m.id]?.explicit).length;
  const pendingNames = activeMechs.filter((m) => !draft[m.id]?.explicit).map((m) => t(NAMES[m.id]));
  const packReady = pendingNames.length === 0;
  const cityView = useMemo<CityMechaView>(() => ({
    figures: state.mechs.map((m) => {
      const planned = m.hp > 0 ? draft[m.id]?.moveTo : null;
      return { id: m.id, x: planned?.x ?? m.pos.x, y: planned?.y ?? m.pos.y, alive: m.hp > 0, selected: m.id === selected };
    }),
    boss: { x: state.boss.anchor.x, y: state.boss.anchor.y, alive: state.boss.hp > 0 },
    raiders: state.raiders.map((raider) => ({ id: raider.id, x: raider.pos.x, y: raider.pos.y, alive: raider.hp > 0 })),
    buildings: state.buildings.map((building) => ({ id: building.id, cells: building.cells, hp: building.hp, maxHp: building.maxHp })),
    telegraph: telegraphs(state),
    focus: doctrineFocusCells(state, doctrine),
    reach,
    move: draft[selected]?.moveTo ?? null,
    targets: targetOptions.flatMap((option) => option.cells),
    targetIds: targetOptions.map((option) => option.id),
  }), [state, draft, selected, reach, doctrine, targetOptions]);
  const view = useMemo<MechaBoardView>(() => ({
    figures: state.mechs.map((m) => {
      const planned = m.hp > 0 ? draft[m.id]?.moveTo : null;
      return { id: m.id, x: planned?.x ?? m.pos.x, y: planned?.y ?? m.pos.y, alive: m.hp > 0, selected: m.id === selected };
    }),
    boss: { x: state.boss.anchor.x, y: state.boss.anchor.y, alive: state.boss.hp > 0 },
    raiders: state.raiders.map((raider) => ({ id: raider.id, x: raider.pos.x, y: raider.pos.y, alive: raider.hp > 0 })),
    covers: [
      ...state.covers,
      ...state.buildings.filter((b) => b.hp > 0).flatMap((b) => b.cells),
    ],
    telegraph: telegraphs(state),
  }), [state, draft, selected]);

  const submit = () => {
    if (auto || paused || state.phase !== "player_plan" || !packReady) return;
    const next = structuredClone(state);
    const result = validateAndApplyPlan(next, {
      revision: next.revision,
      items: living(next).map((m) => ({ mechId: m.id, moveTo: draft[m.id]?.moveTo ?? null, action: draft[m.id]?.action ?? { kind: "skip" } })),
    });
    if (!("ok" in result)) {
      setNotice(t("整包被拒，局面未变，可以重提。"));
      return;
    }
    if (next.phase === "resolving_boss") bossExecute(next);
    if (next.phase === "enemy_prepare") bossPrepare(next);
    const alive = living(next);
    setState(next);
    setDraft(blankDraft(next));
    if (!alive.some((m) => m.id === selected) && alive[0]) setSelected(alive[0].id);
    setNotice(null);
  };

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
  const focus = doctrineFocus(state, doctrine);
  const focusLine = doctrineFocusLine(doctrine, gameText(enemyName(focus.id), locale), focus.building ? `${focus.building.x},${focus.building.y}` : null, locale);

  const viewEngine = viewFailed ? null : engine;
  const onCity = Boolean(site && viewEngine);
  return (
    <section className={onCity ? "mecha-overlay is-city" : "mecha-overlay"} role="dialog" aria-label={t("机甲战棋")}>
      {onCity && viewEngine && site ? <CityMechaWorld ref={worldRef} engine={viewEngine} site={site} view={cityView} onCell={clickCell} onUnavailable={() => setViewFailed(true)} /> : null}
      <header className="mecha-battle-bar">
        <div><strong>{t("机甲战棋")}</strong><span>{t("回合")} {Math.min(state.turn, MAX_TURNS)}/{MAX_TURNS}</span>{paused && <span className="mecha-paused">{t("已暂停")}</span>}</div>
        <div className="mecha-battle-controls">
          {onCity ? <>
            <button type="button" title={t("围绕当前观察点旋转 90°")} onClick={() => worldRef.current?.rotateCamera()}>{t("旋转 90°")}</button>
            <button type="button" title={t("回到可看全棋盘的战术视角")} onClick={() => worldRef.current?.resetCamera()}>{t("战术视角")}</button>
          </> : null}
          <button type="button" disabled={Boolean(state.outcome)} onClick={() => setPaused((value) => !value)}>{paused ? t("继续") : t("暂停")}</button>
          <button type="button" onClick={onClose}>{t("退出战斗")}</button>
        </div>
      </header>
      <div className="mecha-panel">
        <section className="mecha-turn-summary" aria-label={t("敌方预告")}>
          <div><span>{t("敌方预告")}</span><strong className="mecha-intent">{skillLabel}</strong></div>
          <p>{t("大怪")} <strong>{state.boss.hp}</strong>{raiderHp ? ` · ${raiderHp}` : ""}{outcome ? ` · ${outcome}` : ""}</p>
        </section>
        {onCity ? null : <MechaLineup label={t("机甲与怪兽")} view={view} />}
        <ul className="mecha-pack" aria-label={t("三机行动状态")}>
          {activeMechs.map((m) => {
            const row = draft[m.id];
            const dest = row?.moveTo ?? m.pos;
            const hit = incomingDamage(state, m.id, dest) > 0;
            const chosen = row?.explicit ? t(actionLabel(row.action.kind)) : t("未选择");
            const stepCost = pathDistance(state, m.pos, dest, m.id);
            const current = m.id === selected;
            return (
              <li key={m.id} className={`${current ? "is-current" : ""} ${!row?.explicit ? "is-open" : hit ? "is-hit" : ""}`}>
                <button type="button" className={current ? "is-selected" : ""} aria-pressed={current} disabled={auto || paused} onClick={() => setSelected(m.id)}>{t(NAMES[m.id])} <span>{m.hp} HP</span></button>
                <span className={row?.explicit ? "mecha-plan-state is-ready" : "mecha-plan-state"}>{row?.explicit ? t("已规划") : t("待规划")}</span>
                {onCity ? null : <><span>{row?.moveTo ? `${row.moveTo.x},${row.moveTo.y}` : t("原位")}</span><span>{stepBudgetLine(stepCost, moveBudget(m.id), locale)}</span></>}
                <span className="mecha-card-action">{chosen}{row?.explicit && "target" in row.action && row.action.target ? ` ${t(row.action.kind === "repair" ? NAMES[row.action.target] : enemyName(row.action.target))}` : ""}</span>
                {hit ? <span className="mecha-hit">{t("受击")} {incomingDamage(state, m.id, dest)}</span> : null}
              </li>
            );
          })}
        </ul>
        {onCity ? null : <div className="mecha-grid" style={{ gridTemplateColumns: `repeat(${BOARD}, 28px)` }}>
          {Array.from({ length: BOARD * BOARD }, (_, i) => {
            const x = i % BOARD;
            const y = Math.floor(i / BOARD);
            return <button key={`${x},${y}`} type="button" className={paint(x, y)} aria-label={`${x},${y}`} disabled={auto || paused || state.phase !== "player_plan"} onClick={() => clickCell(x, y)} />;
          })}
        </div>}
        <section className={targeting ? "mecha-selected-actions is-targeting" : "mecha-selected-actions"} aria-label={t("当前机甲行动")}>
          <h3>{t("当前机甲")} · {selectedMech ? t(NAMES[selectedMech.id]) : "—"}{targeting ? ` · ${t(actionLabel(targeting))}：${t("点击高亮目标")}` : ""}</h3>
          <div className="mecha-actions">
            {[...new Set(actions.map((action) => action.kind))].map((kind) => {
              const chosen = draft[selected];
              const on = targeting === kind || (!targeting && Boolean(chosen?.explicit) && chosen.action.kind === kind);
              return <button key={kind} type="button" className={on ? "is-selected" : ""} aria-pressed={on} disabled={auto || paused || state.phase !== "player_plan"} onClick={() => {
                setNotice(null);
                if (kind !== "skip") {
                  setTargeting((current) => current === kind ? null : kind);
                  return;
                }
                setTargeting(null);
                setDraft((prev) => ({ ...prev, [selected]: { ...prev[selected], action: { kind: "skip" }, explicit: true } }));
              }}>{t(actionLabel(kind))}</button>;
            })}
            {targeting ? <button type="button" className="mecha-target-cancel" onClick={() => setTargeting(null)}>{t("取消选目标")}</button> : null}
          </div>
        </section>
        <div className="mecha-submit">
          <div><strong>{t("已规划")} {plannedCount}/{activeMechs.length}</strong><span>{paused ? t("继续战斗后可提交。") : pendingNames.length ? `${t("待规划")}：${pendingNames.join("、")}` : t("三机已就绪，可统一结算。")}</span></div>
          <button type="button" className="mecha-submit-primary" disabled={auto || paused || state.phase !== "player_plan" || !packReady} onClick={submit}>{t("提交三机行动")}</button>
        </div>
        {notice && <p role="alert">{notice}</p>}
        <details className="mecha-settings">
          <summary>{t("战场设置与规则")}</summary>
          {onCity ? <p className="mecha-help">{t("左拖旋转，右拖平移，滚轮缩放；短点击选择格子。暂停时仍可调整视角。")}</p> : null}
          <div className="mecha-map-legend" aria-label={t("战场图例")}>
            <span><i className="is-reach" />{t("可移动")}</span>
            <span><i className="is-move" />{t("计划落点")}</span>
            <span><i className="is-telegraph" />{t("敌方预告")}</span>
            <span><i className="is-focus" />{t("打法目标")}</span>
            <small>{t("圆环：黄/蓝/绿为我方，紫为小怪，黄绿为大怪；亮环是当前机甲。")}</small>
          </div>
          <div className="mecha-toolbar">
            {onCity && catalog ? <label>{t("战场")}<select value={shapeId} onChange={(e) => {
              const next = e.target.value as FightShape;
              const nextSite = catalog[next];
              if (!nextSite) return;
              setShape(next);
              restart(preset, script, nextSite, next === "alley" ? "frontage" : "all");
            }}>{SHAPES.map((item) => <option key={item.id} value={item.id} disabled={!catalog[item.id]}>{t(item.label)}</option>)}</select></label> : onCity ? <span>{t("城市实地")}</span> : <label>{t("布局")}<select value={preset} onChange={(e) => restart(e.target.value as CoverPresetId, script)}>{PRESETS.map((p) => <option key={p.id} value={p.id}>{t(p.label)}</option>)}</select></label>}
            <label>{t("脚本")}<select value={script} onChange={(e) => restart(preset, e.target.value as BossScriptId)}>{SCRIPTS.map((s) => <option key={s.id} value={s.id}>{t(s.label)}</option>)}</select></label>
            <label>{t("打法")}<select value={doctrine} onChange={(e) => {
              const next = e.target.value as DoctrineId;
              setDoctrine(next);
              if (!state.outcome && state.phase === "player_plan") setDraft(draftFromPlan(state, planForDoctrine(state, next)));
            }}>{DOCTRINES.map((item) => <option key={item.id} value={item.id}>{t(item.label)}</option>)}</select></label>
            <button type="button" onClick={() => restart()}>{t("新开一局")}</button>
            <button type="button" disabled={auto || paused || Boolean(state.outcome) || state.phase !== "player_plan"} onClick={() => { setAuto(false); setDraft(draftFromPlan(state, planForDoctrine(state, doctrine))); }}>{t("按打法填入")}</button>
            <button type="button" disabled={Boolean(state.outcome)} onClick={() => { setPaused(false); setBeat("show"); setAuto((on) => !on); }}>{auto ? t("停止自动") : t("自动对战")}</button>
          </div>
          <p className="mecha-help">{t("点一台机甲，再点能走到的格子，然后给三台都选行动。站上红色预告格会吃下这一击。")}</p>
          <p className="mecha-help">{t("沿着道路能多走一倍。突击靠路，炮手爬山和平地一样，支援上坡不加价。水过不去，被推进水或山地会撞上。")}</p>
          <p className="mecha-help">{t("攻坚先打大怪。守楼先打离楼最近的小怪。两种打法走出来的结果不同。")}</p>
          {onCity ? <p className="mecha-help">{t("靠岸有水，翻山有山地，巷战是贴着楼的路，单侧临街也算。这座城没有的场地不会出现。")}</p> : null}
          {onCity && shapeId === "alley" ? <p className="mecha-help">{t("巷战只守临街的楼。贴着路的楼拆光就输，不临街的楼还在，但不算这一局。")}</p> : null}
          <p className="mecha-help">{focusLine}</p>
          {onCity && site && site.spawnSpread > FLAT_SPAWN_MAX_DELTA ? <p className="mecha-help">{t("出生高差")} {site.spawnSpread.toFixed(2)} · {t("标准 1，已放宽")}</p> : null}
          {onCity ? <p className="mecha-help">{t("战场在这座城市的地面上。楼顶血槽只记这一局，城市里的楼还在。")}</p>
            : viewFailed ? <p className="mecha-help">{t("三维视角被其他模式占用，改用方格棋盘。")}</p>
            : engine ? <p className="mecha-help">{t("这座城市没有一块够平的战场，仍用方格棋盘。")}</p> : null}
          <p className="mecha-ruleset">{t("掩体")} {state.covers.length} · {t("建筑")} {state.buildings.filter((b) => b.hp > 0).length} · {state.ruleset}</p>
        </details>
      </div>
    </section>
  );
}
