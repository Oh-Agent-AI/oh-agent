/** City test surface for GDD v1.3. Rules live in `mecha/rules.ts`. */
import { useEffect, useMemo, useState } from "react";
import type { CityEngine } from "../engine/CityEngine";
import { gameText, stepBudgetLine, type GameLocale } from "./gameCopy";
import { CityMechaWorld, type CityMechaView } from "./CityMechaWorld";
import { planForDoctrine, type DoctrineId } from "./mecha/ai";
import { anchorsFromCity, siteFightShapes, type CityMechaSite, type FightShape } from "./mecha/citySite";
import { MechaLineup, type MechaBoardView } from "./MechaLineup";
import {
  BOARD, MAX_TURNS, bossExecute, bossPrepare, createMatch, incomingDamage, legalActions, living, moveBudget, pathDistance,
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

type Draft = { moveTo: Cell | null; action: Action; explicit: boolean };

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

function actionLabel(action: Action): string {
  if (action.kind === "melee") return "近战";
  if (action.kind === "shoot") return "射击";
  if (action.kind === "charge") return "冲撞";
  if (action.kind === "pierce") return "穿射";
  if (action.kind === "repair") return "维修";
  return "待机";
}

function fresh(preset: CoverPresetId, script: BossScriptId, site: CityMechaSite | null): MatchState {
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
    })
    : createMatch({ preset, script });
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

export function MechaBoard({ locale, onClose, engine }: { locale: GameLocale; onClose: () => void; engine: CityEngine | null }) {
  const t = (text: string) => gameText(text, locale);
  const catalog = useMemo(() => {
    const layout = engine?.currentLayout;
    const model = engine?.currentModel;
    if (!layout || !model) return null;
    try {
      return siteFightShapes(layout.terrain, anchorsFromCity(layout, model), layout.roadEdges);
    } catch (error) {
      console.warn("mecha city site failed", error);
      return null;
    }
  }, [engine, engine?.currentLayout, engine?.currentModel]);
  const [shape, setShape] = useState<FightShape>("flat");
  const [doctrine, setDoctrine] = useState<DoctrineId>("tunnel");
  const shapeId: FightShape = catalog?.[shape] ? shape : (SHAPES.find((item) => catalog?.[item.id])?.id ?? "flat");
  const site = catalog?.[shapeId] ?? null;
  const [preset, setPreset] = useState<CoverPresetId>("covers_sparse_mid");
  const [script, setScript] = useState<BossScriptId>("siege");
  const [state, setState] = useState<MatchState>(() => fresh("covers_sparse_mid", "siege", site));
  const [draft, setDraft] = useState<Record<MechId, Draft>>(() => blankDraft(fresh("covers_sparse_mid", "siege", site)));
  const [selected, setSelected] = useState<MechId>("Assault");
  const [notice, setNotice] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const [beat, setBeat] = useState<"show" | "resolve">("show");

  const restart = (nextPreset = preset, nextScript = script, nextSite: CityMechaSite | null = site) => {
    const match = fresh(nextPreset, nextScript, nextSite);
    setPreset(nextPreset);
    setScript(nextScript);
    setState(match);
    setDraft(blankDraft(match));
    setSelected(living(match)[0]?.id ?? "Assault");
    setNotice(null);
    setAuto(false);
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
    const unit = living(state).find((m) => same(m.pos, c));
    if (unit) classes.push(`is-${unit.id.toLowerCase()}`, unit.id === selected ? "is-selected" : "");
    if (draft[selected]?.moveTo && same(draft[selected].moveTo!, c)) classes.push("is-move");
    if (reach.some((k) => same(k, c))) classes.push("is-reach");
    return classes.filter(Boolean).join(" ");
  };

  useEffect(() => {
    if (!auto) return undefined;
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
  }, [auto, beat, doctrine, locale, selected, state]);

  const clickCell = (x: number, y: number) => {
    if (auto || state.phase !== "player_plan") return;
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

  const packReady = living(state).every((m) => draft[m.id]?.explicit);
  const cityView = useMemo<CityMechaView>(() => ({
    figures: state.mechs.map((m) => {
      const planned = m.hp > 0 ? draft[m.id]?.moveTo : null;
      return { id: m.id, x: planned?.x ?? m.pos.x, y: planned?.y ?? m.pos.y, alive: m.hp > 0, selected: m.id === selected };
    }),
    boss: { x: state.boss.anchor.x, y: state.boss.anchor.y, alive: state.boss.hp > 0 },
    raiders: state.raiders.map((raider) => ({ id: raider.id, x: raider.pos.x, y: raider.pos.y, alive: raider.hp > 0 })),
    buildings: state.buildings.map((building) => ({ id: building.id, cells: building.cells, hp: building.hp, maxHp: building.maxHp })),
    telegraph: telegraphs(state),
    reach,
    move: draft[selected]?.moveTo ?? null,
  }), [state, draft, selected, reach]);
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
    if (state.phase !== "player_plan" || !packReady) return;
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

  const onCity = Boolean(site && engine);
  return (
    <section className={onCity ? "mecha-overlay is-city" : "mecha-overlay"} role="dialog" aria-label={t("机甲战棋")}>
      {onCity && engine && site ? <CityMechaWorld engine={engine} site={site} view={cityView} onCell={clickCell} /> : null}
      <div className="mecha-panel">
        <header>
          <h2>{t("机甲战棋")}</h2>
          <button type="button" onClick={onClose} aria-label={t("关闭机甲战棋")}>×</button>
        </header>
        <p className="mecha-help">{t("点一台机甲，再点能走到的格子，然后给三台都选行动。站上红色预告格会吃下这一击。")}</p>
        <p className="mecha-help">{t("沿着道路能多走一倍。突击靠路，炮手爬山和平地一样，支援上坡不加价。水过不去，被推进水或山地会撞上。")}</p>
        <p className="mecha-help">{t("攻坚先打大怪。守楼先打离楼最近的小怪。两种打法走出来的结果不同。")}</p>
        {onCity ? <p className="mecha-help">{t("靠岸有水，翻山有山地，巷战是贴着楼的路，单侧临街也算。这座城没有的场地不会出现。")}</p> : null}
        {onCity ? <p className="mecha-help">{t("战场在这座城市的地面上。楼顶血槽只记这一局，城市里的楼还在。")}</p> : engine ? <p className="mecha-help">{t("这座城市没有一块够平的战场，仍用方格棋盘。")}</p> : null}
        {onCity ? null : <MechaLineup label={t("机甲与怪兽")} view={view} />}
        <ul className="mecha-pack">
          {living(state).map((m) => {
            const row = draft[m.id];
            const dest = row?.moveTo ?? m.pos;
            const hit = incomingDamage(state, m.id, dest) > 0;
            const chosen = row?.explicit ? t(actionLabel(row.action)) : t("未选择");
            const stepCost = pathDistance(state, m.pos, dest, m.id);
            return (
              <li key={m.id} className={!row?.explicit ? "is-open" : hit ? "is-hit" : ""}>
                <button type="button" className={m.id === selected ? "is-selected" : ""} onClick={() => setSelected(m.id)}>{t(NAMES[m.id])} {m.hp}</button>
                <span>{row?.moveTo ? `${row.moveTo.x},${row.moveTo.y}` : t("原位")}</span>
                <span>{stepBudgetLine(stepCost, moveBudget(m.id), locale)}</span>
                <span>{chosen}{row?.explicit && row.action.kind === "repair" ? ` ${t(NAMES[row.action.target])}` : ""}</span>
                {hit ? <span>{t("预告伤害")} {incomingDamage(state, m.id, dest)}</span> : null}
              </li>
            );
          })}
        </ul>
        <div className="mecha-toolbar">
          {onCity && catalog ? <label>{t("战场")}<select value={shapeId} onChange={(e) => {
            const next = e.target.value as FightShape;
            const nextSite = catalog[next];
            if (!nextSite) return;
            setShape(next);
            restart(preset, script, nextSite);
          }}>{SHAPES.map((item) => <option key={item.id} value={item.id} disabled={!catalog[item.id]}>{t(item.label)}</option>)}</select></label> : onCity ? <span>{t("城市实地")}</span> : <label>{t("布局")}<select value={preset} onChange={(e) => restart(e.target.value as CoverPresetId, script)}>{PRESETS.map((p) => <option key={p.id} value={p.id}>{t(p.label)}</option>)}</select></label>}
          <label>{t("脚本")}<select value={script} onChange={(e) => restart(preset, e.target.value as BossScriptId)}>{SCRIPTS.map((s) => <option key={s.id} value={s.id}>{t(s.label)}</option>)}</select></label>
          <label>{t("打法")}<select value={doctrine} onChange={(e) => {
            const next = e.target.value as DoctrineId;
            setDoctrine(next);
            if (!state.outcome && state.phase === "player_plan") setDraft(draftFromPlan(state, planForDoctrine(state, next)));
          }}>{DOCTRINES.map((item) => <option key={item.id} value={item.id}>{t(item.label)}</option>)}</select></label>
          <button type="button" onClick={() => restart()}>{t("新开一局")}</button>
          <button type="button" disabled={Boolean(state.outcome) || state.phase !== "player_plan"} onClick={() => { setAuto(false); setDraft(draftFromPlan(state, planForDoctrine(state, doctrine))); }}>{t("按打法填入")}</button>
          <button type="button" disabled={Boolean(state.outcome)} onClick={() => { setBeat("show"); setAuto((on) => !on); }}>{auto ? t("停止自动") : t("自动对战")}</button>
        </div>
        <p>{t("回合")} {Math.min(state.turn, MAX_TURNS)}/{MAX_TURNS} · {t("预告")} {skillLabel} · {t("大怪")} {state.boss.hp}{raiderHp ? ` · ${raiderHp}` : ""}{outcome ? ` · ${outcome}` : ""}</p>
        {onCity ? null : <div className="mecha-grid" style={{ gridTemplateColumns: `repeat(${BOARD}, 28px)` }}>
          {Array.from({ length: BOARD * BOARD }, (_, i) => {
            const x = i % BOARD;
            const y = Math.floor(i / BOARD);
            return <button key={`${x},${y}`} type="button" className={paint(x, y)} aria-label={`${x},${y}`} onClick={() => clickCell(x, y)} />;
          })}
        </div>}
        <div className="mecha-actions">
          {actions.map((action) => {
            const label = actionLabel(action);
            const chosen = draft[selected];
            const on = Boolean(chosen?.explicit) && actionKey(chosen.action) === actionKey(action);
            const named = action.kind === "repair" ? ` ${t(NAMES[action.target])}` : "target" in action && action.target ? ` ${t(enemyName(action.target))}` : "";
            return <button key={actionKey(action)} type="button" className={on ? "is-selected" : ""} disabled={auto || state.phase !== "player_plan"} onClick={() => setDraft((prev) => ({ ...prev, [selected]: { ...prev[selected], action, explicit: true } }))}>{t(label)}{named}</button>;
          })}
          <button type="button" disabled={auto || state.phase !== "player_plan" || !packReady} onClick={submit}>{t("提交三机行动")}</button>
        </div>
        {notice && <p role="alert">{notice}</p>}
        <p className="mecha-legend">{t("掩体")} {state.covers.length} · {t("建筑")} {state.buildings.filter((b) => b.hp > 0).length} · {state.ruleset}</p>
      </div>
    </section>
  );
}
