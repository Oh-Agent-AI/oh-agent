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
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CityEngine } from "../engine/CityEngine";
import { doctrineFocusLine, gameText, type GameLocale } from "./gameCopy";
import { CityMechaWorld, type CityMechaView, type CityMechaWorldHandle } from "./CityMechaWorld";
import { assaultSequenceWaiting } from "./mecha/assaultTurnPlayer";
import type { DoctrineId } from "./mecha/ai";
import { createMechaController, type MechaController } from "./mecha/controller";
import { anchorsFromCity, prepareFightTerrainAsync, type FightCatalog, type FightShape } from "./mecha/citySite";
import { startPreparedSearch } from "./mecha/fightSearchRunner";
import {
  FLAT_SPAWN_MAX_DELTA, MAX_TURNS, living, stakeBuildings,
  type Action, type BossScriptId, type MechId,
} from "./mecha/rules";
import "./game.css";

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

function forgetCatalog(layout: object | null): void {
  if (layout) CATALOG_CACHE.delete(layout);
}

function catalogPlayable(catalog: FightCatalog | null): catalog is FightCatalog {
  return Boolean(catalog && SHAPES.some((item) => catalog[item.id]));
}

export type MechaAvailability = "searching" | "ready" | "empty" | "error";

type SearchPhase = "loading" | "ready" | "error";

function CityGate({ locale, onClose, title, body, busy, extra, onRetry }: {
  locale: GameLocale;
  onClose: () => void;
  title: string;
  body: string;
  busy?: boolean;
  extra?: string | null;
  onRetry?: () => void;
}) {
  const t = (text: string) => gameText(text, locale);
  return (
    <section className="mecha-overlay is-city" role="dialog" aria-label={t("机甲战棋")} aria-busy={busy || undefined}>
      <header className="mecha-battle-bar">
        <div><strong>{t("机甲战棋")}</strong></div>
        <div className="mecha-battle-controls"><button type="button" onClick={onClose}>{t("退出战斗")}</button></div>
      </header>
      <div className="mecha-panel">
        <div className="mecha-city-gate">
          <p role={busy ? "status" : "alert"}>{t(title)}</p>
          <p className="mecha-help">{t(body)}</p>
          {extra ? <p className="mecha-help">{extra}</p> : null}
          <div className="mecha-actions">
            {onRetry ? <button type="button" onClick={onRetry}>{t("重试")}</button> : null}
            <button type="button" onClick={onClose}>{busy ? t("取消") : t("关闭")}</button>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Loads (or reuses) the four-shape catalog, then mounts a match keyed by it. */
export function MechaBoard({ locale, onClose, engine, onAvailability }: {
  locale: GameLocale;
  onClose: () => void;
  engine: CityEngine | null;
  onAvailability?: (next: MechaAvailability) => void;
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

  return <MechaMatch key={runId} locale={locale} onClose={onClose} engine={engine} catalog={catalog} />;
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
function MechaMatch({ locale, onClose, engine, catalog }: {
  locale: GameLocale;
  onClose: () => void;
  engine: CityEngine;
  catalog: FightCatalog;
}) {
  const t = (text: string) => gameText(text, locale);
  const [shape, setShape] = useState<FightShape>("flat");
  const shapeId: FightShape = catalog[shape] ? shape : (SHAPES.find((item) => catalog[item.id])?.id ?? "flat");
  const site = catalog[shapeId] ?? null;
  const [viewFailed, setViewFailed] = useState(false);
  const [showOrder, setShowOrder] = useState(false);
  const [inspectedAction, setInspectedAction] = useState<Action["kind"] | null>(null);
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

  const sequenceTrial = import.meta.env.DEV && new URLSearchParams(location.search).get("assaultTrial") === "1" && new URLSearchParams(location.search).get("assaultSequence") === "1";
  const sequenceActive = sequenceTrial && Boolean(site && !viewFailed) && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sequenceWaiting = assaultSequenceWaiting(sequenceActive, s?.combat ?? { id: 0, actions: [] }, sequenceStatus);
  const sequenceFault = sequenceWaiting && sequenceStatus?.id === s?.combat.id && sequenceStatus?.state === "fault";

  useEffect(() => { controller?.setLocale(locale); }, [controller, locale]);
  useEffect(() => () => { if (inspectTimer.current !== null) window.clearTimeout(inspectTimer.current); }, []);
  useEffect(() => { setInspectedAction(null); }, [selected]);

  useEffect(() => {
    if (viewFailed) controller?.stopAuto();
  }, [controller, viewFailed]);

  // 自动对战的节拍：每拍一次 tick（展示 → 结算 → 下一回合）。状态一变就重排，暂停即停。
  useEffect(() => {
    if (viewFailed || !auto || paused || performance || !controller) return undefined;
    const timer = window.setTimeout(() => controller.tick(), 700);
    return () => window.clearTimeout(timer);
  }, [controller, auto, paused, s, sequenceWaiting, viewFailed, performance]);

  const reach = s?.reach ?? [];
  const targetOptions = s?.targetOptions ?? [];
  const clickCell = (x: number, y: number) => { if (!sequenceWaiting) controller?.clickCell(x, y); };

  const activeMechs = state ? living(state) : [];
  const plannedCount = s?.plannedCount ?? 0;
  const pendingNames = (s?.pendingIds ?? []).map((id) => t(NAMES[id]));
  const packReady = s?.packReady ?? false;
  const cityView = useMemo<CityMechaView>(() => ({
    combat: s?.combat,
    paused,
    figures: (state?.mechs ?? []).map((m) => {
      const planned = m.hp > 0 && !performance ? draft?.[m.id]?.moveTo : null;
      return { id: m.id, x: planned?.x ?? m.pos.x, y: planned?.y ?? m.pos.y, alive: m.hp > 0, hp: m.hp, selected: m.id === selected };
    }),
    boss: { x: state?.boss.anchor.x ?? 0, y: state?.boss.anchor.y ?? 0, alive: (state?.boss.hp ?? 0) > 0, hp: state?.boss.hp ?? 0 },
    raiders: (state?.raiders ?? []).map((raider) => ({ id: raider.id, x: raider.pos.x, y: raider.pos.y, alive: raider.hp > 0, hp: raider.hp })),
    buildings: (state?.buildings ?? []).map((building) => ({ id: building.id, cells: building.cells, hp: building.hp, maxHp: building.maxHp })),
    telegraph: s?.telegraph ?? [],
    hoveredEnemy: s?.hoveredEnemy ?? null,
    focus: performance ? [] : (s?.focusCells ?? []),
    reach: performance ? [] : reach,
    move: performance || !selected ? null : draft?.[selected]?.moveTo ?? null,
    targets: performance ? [] : targetOptions.flatMap((option) => option.cells),
    targetIds: performance ? [] : targetOptions.map((option) => option.id),
    obstacles: state?.obstacles,
  }), [s, state, draft, selected, reach, targetOptions, paused, performance]);

  if (!controller || !s || !state || !site) {
    return <CityGate locale={locale} onClose={onClose} title="这座城暂时没有可用机坪。" body="楼太少时往往没有平地、靠岸或巷战。可以重试，或关掉战棋。" />;
  }

  if (viewFailed) {
    return (
      <CityGate locale={locale} onClose={onClose} onRetry={() => setViewFailed(false)} title="三维视角被其他模式占用。" body="先退出影院、驾驶或飞行，再开战。" />
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
  const planning = s.interactive && !sequenceWaiting;
  const previewAfter = s.preview.ok ? s.preview.telegraphAfter : null;
  const hitLine = activeMechs.map((m) => `${t(NAMES[m.id])} ${s.hits[m.id] ?? 0}`).join(" · ");
  const staked = stakeBuildings(state);
  const stakedHp = staked.reduce((total, building) => total + building.hp, 0);
  const stakedMax = staked.reduce((total, building) => total + building.maxHp, 0);

  return (
    <section className="mecha-overlay is-city" role="dialog" aria-label={t("机甲战棋")}>
      <CityMechaWorld ref={worldRef} engine={engine} site={site} view={cityView} performance={performance} paused={paused} onPerformanceComplete={finishPerformance} onCell={clickCell} onHoverEnemy={(id) => controller.setHoveredEnemy(id)} onUnavailable={() => setViewFailed(true)} />
      <header className="mecha-battle-bar">
        <div><strong>{t("机甲战棋")}</strong><span>{t("回合")} {Math.min(state.turn, MAX_TURNS)}/{MAX_TURNS}</span>{paused && <span className="mecha-paused">{t("已暂停")}</span>}</div>
        <div className="mecha-battle-controls">
          <button type="button" title={t("围绕当前观察点旋转 90°")} onClick={() => worldRef.current?.rotateCamera()}>{t("旋转 90°")}</button>
          <button type="button" title={t("回到可看全棋盘的战术视角")} onClick={() => worldRef.current?.resetCamera()}>{t("战术视角")}</button>
          {performance ? <button type="button" onClick={finishPerformance}>{t("跳过演出")}</button> : null}
          <button type="button" disabled={Boolean(state.outcome)} onClick={() => controller.togglePause()}>{paused ? t("继续") : t("暂停")}</button>
          <button type="button" onClick={onClose}>{t("退出战斗")}</button>
        </div>
      </header>
      <div className="mecha-panel">
        {sequenceFault ? <p role="alert">{t("Assault 演出数据不完整或不一致，自动对战已等待；可重新开始一局。")}</p> : null}
        <section className="mecha-turn-summary" aria-label={t("敌方预告")}>
          <div><span>{t("敌方预告")}</span><strong className="mecha-intent">{skillLabel}</strong></div>
          <p>{t("大怪")} <strong>{state.boss.hp}</strong>{raiderHp ? ` · ${raiderHp}` : ""}{outcome ? ` · ${outcome}` : ""}</p>
          <p className="mecha-resource">{t("守楼败北条")} {staked.length ? `${stakedHp}/${stakedMax}` : t("本局无守楼目标")} · {t("机甲单台损毁不败北；全灭、守楼全毁或超时则败北。")}</p>
          <button type="button" aria-expanded={showOrder} onClick={() => setShowOrder((value) => !value)}>{t("结算顺序")}</button>
          {showOrder ? <div className="mecha-order" role="region" aria-label={t("结算顺序")}>
            <p>{t("先同时移动，再按突击、射手、支援行动；随后敌方依次攻击。")}</p>
            {performance ? <p>{t("演出期间不显示预测。")}</p> : s.preview.ok ? <>
              <p>{s.preview.assumed.length ? t("未规划机甲按待机预测；改变计划会更新顺序。") : t("按当前计划预测；改变计划会更新顺序。")}</p>
              {s.preview.enemyOrder.length ? <ol>{s.preview.enemyOrder.map((event, index) => <li key={`${event.actor}-${index}`}>{t(enemyName(event.actor))} · {t(event.skill === "sweep" ? "横扫" : "砸击")} · {event.cells.map((cell) => `${cell.x},${cell.y}`).join("、")}</li>)}</ol> : <p>{t("本次预测没有敌方攻击。")}</p>}
            </> : <p>{t("预览还不可用")}</p>}
            <p>{t("本规则没有独立电网或环境攻击。")}</p>
          </div> : null}
          {previewAfter ? (
            <p className="mecha-preview-after">
              {t("推动后预告")} {previewAfter.length ? previewAfter.map((cell) => `${cell.x},${cell.y}`).join("、") : t("这一动之后没有预告格")}
              {" · "}{t("推动后受击")} {hitLine}
            </p>
          ) : <p className="mecha-preview-after">{t("预览还不可用")}</p>}
          {s.hoveredEnemy ? <p className="mecha-preview-after">{t("只显示这一只的预告")}</p> : null}
        </section>
        <ul className="mecha-pack" aria-label={t("三机行动状态")}>
          {activeMechs.map((m) => {
            const row = draft?.[m.id];
            const hitDamage = s.hits[m.id] ?? 0;
            const hit = hitDamage > 0;
            const chosen = row?.explicit ? t(actionLabel(row.action.kind)) : t("未选择");
            const current = m.id === selected;
            return (
              <li key={m.id} className={`${current ? "is-current" : ""} ${!row?.explicit ? "is-open" : hit ? "is-hit" : ""}`}>
                <button type="button" className={current ? "is-selected" : ""} aria-pressed={current} disabled={auto || paused || Boolean(performance)} onClick={() => controller.selectMech(m.id)}>{t(NAMES[m.id])} <span>{m.hp} HP</span></button>
                <span className={row?.explicit ? "mecha-plan-state is-ready" : "mecha-plan-state"}>{row?.explicit ? t("已规划") : t("待规划")}</span>
                <span className="mecha-card-action">{chosen}{row?.explicit && "target" in row.action && row.action.target ? ` ${t(row.action.kind === "repair" ? NAMES[row.action.target] : enemyName(row.action.target))}` : ""}</span>
                {hit ? <span className="mecha-hit">{t("受击")} {hitDamage}</span> : null}
              </li>
            );
          })}
        </ul>
        <section className={targeting ? "mecha-selected-actions is-targeting" : "mecha-selected-actions"} aria-label={t("当前机甲行动")}>
          <h3>{t("当前机甲")} · {selectedMech ? t(NAMES[selectedMech.id]) : "—"}{targeting ? ` · ${t(actionLabel(targeting))}：${t("点击高亮目标")}` : ""}</h3>
          <div className="mecha-actions">
            {[...new Set(s.actions.map((action) => action.kind))].map((kind) => {
              const chosen = selected ? draft?.[selected] : undefined;
              const on = targeting === kind || (!targeting && Boolean(chosen?.explicit) && chosen?.action.kind === kind);
              return <button key={kind} type="button" className={on ? "is-selected" : ""} aria-pressed={on} aria-describedby={inspectedAction === kind ? "mecha-action-inspection" : undefined} disabled={!planning}
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
                }}>{t(actionLabel(kind))}</button>;
            })}
            <button type="button" disabled={!planning || !s.canUndoMove} title={t("撤回最近一次移动。提交行动之后不能撤。")} onClick={() => controller.undoMove()}>{t("撤回移动")}</button>
            <button type="button" disabled={!planning || !s.canResetTurn} aria-describedby="mecha-reset-help" onClick={() => controller.resetTurn()}>{t("重置本回合")}</button>
            {targeting ? <button type="button" className="mecha-target-cancel" onClick={() => controller.setTargeting(null)}>{t("取消选目标")}</button> : null}
          </div>
          <p id="mecha-reset-help" className="mecha-reset-help">{t(s.resetTurnUsed ? "本局的重置机会已用完。" : state.outcome ? "对局结束后不可重置。" : planning ? "每场可用一次：恢复本回合开始时的草稿，不会撤回已结算的回合。" : "暂停、自动对战或演出期间不可重置。")}</p>
          {inspectedAction && s.actions.some((action) => action.kind === inspectedAction) ? <div id="mecha-action-inspection" className="mecha-action-inspection" role="tooltip"><strong>{t(actionLabel(inspectedAction))}</strong> · {t(ACTION_DESCRIPTIONS[inspectedAction])}</div> : null}
        </section>
        <div className="mecha-submit">
          <div><strong>{t("已规划")} {plannedCount}/{activeMechs.length}</strong><span>{paused ? t("继续战斗后可提交。") : pendingNames.length ? `${t("待规划")}：${pendingNames.join("、")}` : t("三机已就绪，可统一结算。")}</span></div>
          <button type="button" className="mecha-submit-primary" disabled={!planning || !packReady} onClick={() => controller.submit()}>{t("提交三机行动")}</button>
        </div>
        {s.notice && <p role="alert">{s.notice}</p>}
        <details className="mecha-settings">
          <summary>{t("战场设置与规则")}</summary>
          <p className="mecha-help">{t("左拖旋转，右拖平移，滚轮缩放；短点击选择格子。暂停时仍可调整视角。")}</p>
          <div className="mecha-map-legend" aria-label={t("战场图例")}>
            <span><i className="is-reach" />{t("可移动")}</span>
            <span><i className="is-move" />{t("计划落点")}</span>
            <span><i className="is-telegraph" />{t("敌方预告")}</span>
            <span><i className="is-focus" />{t("打法目标")}</span>
            <small>{t("圆环：黄/蓝/绿为我方，紫为小怪，黄绿为大怪；亮环是当前机甲。")}</small>
          </div>
          <div className="mecha-toolbar">
            <label>{t("战场")}<select disabled={Boolean(performance)} value={shapeId} onChange={(e) => {
              const next = e.target.value as FightShape;
              const nextSite = catalog[next];
              if (!nextSite) return;
              setShape(next);
              controller.restart({ site: nextSite, stake: next === "alley" ? "frontage" : "all" });
            }}>{SHAPES.map((item) => <option key={item.id} value={item.id} disabled={!catalog[item.id]}>{t(item.label)}</option>)}</select></label>
            <label>{t("脚本")}<select disabled={Boolean(performance)} value={s.script} onChange={(e) => controller.restart({ script: e.target.value as BossScriptId })}>{SCRIPTS.map((sc) => <option key={sc.id} value={sc.id}>{t(sc.label)}</option>)}</select></label>
            <label>{t("打法")}<select disabled={Boolean(performance)} value={doctrine} onChange={(e) => controller.setDoctrine(e.target.value as DoctrineId)}>{DOCTRINES.map((item) => <option key={item.id} value={item.id}>{t(item.label)}</option>)}</select></label>
            <button type="button" onClick={() => controller.restart()}>{t("新开一局")}</button>
            <button type="button" disabled={!planning} onClick={() => controller.applyDoctrine()}>{t("按打法填入")}</button>
            <button type="button" disabled={Boolean(state.outcome)} onClick={() => controller.toggleAuto()}>{auto ? t("停止自动") : t("自动对战")}</button>
          </div>
          <p className="mecha-help">{t("点一台机甲，再点能走到的格子，然后给三台都选行动。站上红色预告格会吃下这一击。")}</p>
          <p className="mecha-help">{t("红色格子是这一动之后的预告，卡片上的受击是推动之后会掉的血。")}</p>
          <p className="mecha-help">{t("沿着道路能多走一倍。突击靠路，炮手爬山和平地一样，支援上坡不加价。水过不去，被推进水或山地会撞上。")}</p>
          <p className="mecha-help">{t("攻坚先打大怪。守楼先打离楼最近的小怪。两种打法走出来的结果不同。")}</p>
          <p className="mecha-help">{t("靠岸有水，翻山有山地，巷战是贴着楼的路，单侧临街也算。这座城没有的场地不会出现。")}</p>
          {shapeId === "alley" ? <p className="mecha-help">{t("巷战只守临街的楼。贴着路的楼拆光就输，不临街的楼还在，但不算这一局。")}</p> : null}
          <p className="mecha-help">{focusLine}</p>
          {site.spawnSpread > FLAT_SPAWN_MAX_DELTA ? <p className="mecha-help">{t("出生高差")} {site.spawnSpread.toFixed(2)} · {t("标准 1，已放宽")}</p> : null}
          <p className="mecha-help">{t("战场在这座城市的地面上。楼顶血槽只记这一局，城市里的楼还在。")}</p>
          <p className="mecha-ruleset">{t("掩体")} {state.covers.length} · {t("建筑")} {state.buildings.filter((b) => b.hp > 0).length} · {state.ruleset}</p>
        </details>
      </div>
    </section>
  );
}
