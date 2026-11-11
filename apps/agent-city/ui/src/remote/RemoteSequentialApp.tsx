import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Action, Cell, MatchState, MechId } from "../game/mecha/board";
import { mech, moveBudget, occupant, pathDistance } from "../game/mecha/board";
import { legalActions } from "../game/mecha/combat";
import { statusBlocks } from "../game/mecha/statusEffects";
import { restoreSequentialSnapshot } from "../game/mecha/session/SequentialMatchSession";
import type { SequentialCommand, SequentialTurn } from "../game/mecha/sequentialTurn";
import { useRemoteAccess } from "./remoteAccess";
import { RemoteCityScene } from "./city/RemoteCityScene";
import type { RemoteCityDisplay } from "./city/cityDisplayProjection";
import type { CityMechaView } from "../game/CityMechaWorld";
import "./remote.css";

const MECHS: MechId[] = ["Assault", "Gunner", "Support"];
type PhoneCommand = { kind: "move"; mech: MechId; to: Cell } | { kind: "act"; mech: MechId; action: Action } | { kind: "end"; confirmUnused: true } | { kind: "undo" };
const NAME: Record<MechId, string> = { Assault: "突击", Gunner: "射手", Support: "支援" };

/** Minimal v1.5 phone surface: command stream, no plan staging, no local authority. */
export function RemoteSequentialApp({ params }: { params: URLSearchParams }) {
  const matchId = params.get("match") ?? "";
  const { client, status, error: accessError } = useRemoteAccess(params);
  const [turn, setTurn] = useState<SequentialTurn | null>(null);
  const [cityDisplay, setCityDisplay] = useState<RemoteCityDisplay | null>(null);
  const [selected, setSelected] = useState<MechId>("Assault");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const sequence = useRef(0);
  const commandSession = useRef("");
  if (!commandSession.current) commandSession.current = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const load = useCallback(async () => {
    if (!client || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const result = await client.sequentialSnapshot(matchId);
      if (!result.ok) { setMessage(`读取失败：${result.error.code}`); return; }
      setTurn(restoreSequentialSnapshot(result.snapshot)); setMessage("");
      const city = await client.citySnapshot(matchId) as { ok?: boolean; scene?: RemoteCityDisplay };
      if (city.ok && city.scene?.schema === "remote-city-display:v2" && city.scene.layout?.schema === "remote-city-layout:v1") setCityDisplay(city.scene);
    } catch { setMessage("连接失败"); }
    finally { busyRef.current = false; setBusy(false); }
  }, [client, matchId]);
  useEffect(() => { void load(); }, [load]);
  const state = turn?.snapshot().match ?? null;
  const rights = turn?.snapshot().rights[selected];
  const restrictions = state?.statusEncounter ? statusBlocks(state.statusEncounter.statuses, selected) ?? { move: true, action: true } : { move: false, action: false };
  const submit = async (command: PhoneCommand) => {
    if (!client || !turn || !state || busyRef.current || message) return;
    busyRef.current = true; setBusy(true);
    const base = state.revision;
    try {
      const result = await client.submitSequentialCommand(matchId, base, { ...command, id: `phone-${commandSession.current}-${++sequence.current}`, revision: base } as SequentialCommand);
      if (!result.ok) { setMessage(`命令失败：${result.error.code}，请重新读取`); return; }
      setTurn(restoreSequentialSnapshot(result.snapshot)); setMessage("");
    } catch { setMessage("命令结果未确认，请重新读取"); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const cellUnit = (x: number, y: number): string => {
    if (!state) return "";
    for (const id of MECHS) { const unit = mech(state, id); if (unit && unit.hp > 0 && unit.pos.x === x && unit.pos.y === y) return NAME[id]; }
    if (state.boss.hp > 0 && x === state.boss.anchor.x && y === state.boss.anchor.y) return "大怪";
    for (const raider of state.raiders) if (raider.hp > 0 && raider.pos.x === x && raider.pos.y === y) return "小怪";
    return "";
  };
  const canMoveTo = (to: Cell): boolean => {
    if (!state) return false;
    const unit = mech(state, selected);
    if (!unit || unit.hp <= 0 || state.outcome || !rights?.move || restrictions.move) return false;
    if (occupant(state, to) !== "empty") return false;
    const distance = pathDistance(state, unit.pos, to, selected, { alliesPass: true });
    return distance !== null && distance <= moveBudget(selected);
  };
  const actions: Action[] = state && rights?.action && !restrictions.action ? legalActions(state, selected) : [];
  const selectedUnit = state?.mechs.find(unit => unit.id === selected) ?? null;
  const cityView = useMemo<CityMechaView | null>(() => {
    if (!state) return null;
    const declared = [state.boss.intent, ...state.raiders.map(unit => unit.intent)].flatMap(intent => intent?.local ?? []);
    const selectedMech = state.mechs.find(unit => unit.id === selected);
    const reachable: Cell[] = [];
    if (selectedMech?.hp && !state.outcome && turn?.snapshot().rights[selected].move && !restrictions.move) {
      for (let y = 0; y < 10; y += 1) for (let x = 0; x < 10; x += 1) {
        const cell = { x, y };
        if (occupant(state, cell) === "empty") {
          const distance = pathDistance(state, selectedMech.pos, cell, selected, { alliesPass: true });
          if (distance !== null && distance <= moveBudget(selected)) reachable.push(cell);
        }
      }
    }
    return {
      figures: state.mechs.map(unit => ({ id: unit.id, x: unit.pos.x, y: unit.pos.y, alive: unit.hp > 0, selected: unit.id === selected, hp: unit.hp, maxHp: unit.id === "Assault" ? 14 : unit.id === "Gunner" ? 11 : 12 })),
      boss: { x: state.boss.anchor.x, y: state.boss.anchor.y, alive: state.boss.hp > 0, hp: state.boss.hp, maxHp: 18 },
      raiders: state.raiders.map(unit => ({ id: unit.id, x: unit.pos.x, y: unit.pos.y, alive: unit.hp > 0, hp: unit.hp, maxHp: 5 })),
      buildings: state.buildings.map(building => ({ id: building.id, cells: building.cells, hp: building.hp, maxHp: building.maxHp })),
      declaredTelegraph: declared, declaredIntents: [], projectedTelegraph: null, telegraph: declared, focusedTelegraph: [],
      deployment: false, focus: selectedMech?.hp ? [selectedMech.pos] : [], reach: reachable, move: null, targets: [], targetIds: [], obstacles: state.obstacles,
    };
  }, [state, selected, turn, restrictions.move]);
  const onSceneCell = (x: number, y: number) => {
    const cell = { x, y };
    const label = cellUnit(x, y);
    if (label === "突击" || label === "射手" || label === "支援") { setSelected(MECHS.find(id => NAME[id] === label)!); return; }
    if (canMoveTo(cell)) void submit({ kind: "move", mech: selected, to: cell });
  };
  return <main className="mecha-remote mecha-v15-phone remote-city-phone">
    <RemoteCityScene display={cityDisplay} view={cityView} locale="zh-Hans" onCell={onSceneCell} />
    <section className="remote-city-controls">
    <h1 style={{ fontSize: 18 }}>机甲战棋 1.5 · 手机续玩</h1>
    {accessError && <p role="alert">{accessError}</p>}
    {message && <p role="alert">{message} <button type="button" onClick={() => void load()}>重新读取</button></p>}
    {!state ? <p>{status === "failed" ? "连接失败" : "正在读取对局…"}</p> : <>
      <p>回合 {state.turn} · 选中：{NAME[selected]} · HP {selectedUnit?.hp ?? 0} · 大怪 HP {state.boss.hp}</p>
      <p className="remote-city-instructions">“全城”查看真实 Agent City；点“战场”操作对局。点友方机甲切换单位，点绿色可达格移动，再选攻击/技能执行。</p>
      {state.outcome && <p role="status"><strong>对局结束：{state.outcome === "victory" ? "胜利" : "失败"}</strong></p>}
      <fieldset disabled={busy || Boolean(message)} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {MECHS.map(id => <button key={id} type="button" aria-pressed={selected === id} onClick={() => setSelected(id)}>{NAME[id]}</button>)}
        <button type="button" disabled={Boolean(state.outcome) || turn?.undoMech() !== selected} onClick={() => void submit({ kind: "undo" })}>撤销移动</button>
        <button type="button" disabled={Boolean(state.outcome)} onClick={() => void submit({ kind: "end", confirmUnused: true })}>结束回合</button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {actions.map((action, index) => <button key={index} type="button" disabled={Boolean(state.outcome)} onClick={() => void submit({ kind: "act", mech: selected, action })}>{actionLabel(action)}</button>)}
      </div>
      </fieldset>
    </>}
    </section>
  </main>;
}

function actionLabel(action: Action): string {
  const label: Record<Action["kind"], string> = { skip: "待机", melee: "近战", shoot: "射击", charge: "突击冲撞", pierce: "穿甲射击", repair: "维修" };
  if (!("target" in action) || !action.target) return label[action.kind];
  const target = action.target === "boss" ? "大怪" : action.target === "Assault" ? "突击" : action.target === "Gunner" ? "射手" : action.target === "Support" ? "支援" : "小怪";
  return `${label[action.kind]} · ${target}`;
}
