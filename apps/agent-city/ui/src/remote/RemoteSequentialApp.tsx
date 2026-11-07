import { useEffect, useRef, useState } from "react";
import type { Action, Cell, MatchState, MechId } from "../game/mecha/board";
import { mech, moveBudget, occupant, pathDistance } from "../game/mecha/board";
import { legalActions } from "../game/mecha/combat";
import { restoreSequentialSnapshot } from "../game/mecha/session/SequentialMatchSession";
import type { SequentialCommand, SequentialTurn } from "../game/mecha/sequentialTurn";
import { useRemoteAccess } from "./remoteAccess";
import "./remote.css";

const MECHS: MechId[] = ["Assault", "Gunner", "Support"];
type PhoneCommand = { kind: "move"; mech: MechId; to: Cell } | { kind: "act"; mech: MechId; action: Action } | { kind: "end"; confirmUnused: true };
const NAME: Record<MechId, string> = { Assault: "突击", Gunner: "射手", Support: "支援" };

/** Minimal v1.5 phone surface: command stream, no plan staging, no local authority. */
export function RemoteSequentialApp({ params }: { params: URLSearchParams }) {
  const matchId = params.get("match") ?? "";
  const { client, status, error: accessError } = useRemoteAccess(params);
  const [turn, setTurn] = useState<SequentialTurn | null>(null);
  const [selected, setSelected] = useState<MechId>("Assault");
  const [message, setMessage] = useState("");
  const sequence = useRef(0);
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void client.sequentialSnapshot(matchId).then(result => {
      if (cancelled) return;
      if (!result.ok) { setMessage(`读取失败：${result.error.code}`); return; }
      try { setTurn(restoreSequentialSnapshot(result.snapshot)); }
      catch { setMessage("快照无法重建"); }
    }).catch(() => { if (!cancelled) setMessage("连接失败"); });
    return () => { cancelled = true; };
  }, [client, matchId]);
  const state = turn?.snapshot().match ?? null;
  const submit = async (command: PhoneCommand) => {
    if (!client || !turn || !state) return;
    const base = state.revision;
    const result = await client.submitSequentialCommand(matchId, base, { ...command, id: `phone-${++sequence.current}`, revision: base } as SequentialCommand);
    if (!result.ok) { setMessage(`命令失败：${result.error.code}`); return; }
    setMessage("");
    try { setTurn(restoreSequentialSnapshot(result.snapshot)); }
    catch { setMessage("返回快照无法重建"); }
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
    if (!unit || unit.hp <= 0 || state.outcome) return false;
    if (occupant(state, to) !== "empty") return false;
    const distance = pathDistance(state, unit.pos, to, selected, { alliesPass: true });
    return distance !== null && distance <= moveBudget(selected);
  };
  const actions: Action[] = state ? legalActions(state, selected).filter(action => action.kind !== "skip") : [];
  return <main className="mecha-remote mecha-v15-phone" style={{ padding: 12, maxWidth: 720, margin: "0 auto" }}>
    <h1 style={{ fontSize: 18 }}>机甲战棋 1.5 · 手机续玩</h1>
    {accessError && <p role="alert">{accessError}</p>}
    {message && <p role="alert">{message}</p>}
    {!state ? <p>{status === "failed" ? "连接失败" : "正在读取对局…"}</p> : <>
      <p>回合 {state.turn} · revision {state.revision}{state.outcome ? ` · 结束：${state.outcome}` : ""}</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: 2, margin: "8px 0" }}>
        {Array.from({ length: 100 }, (_, index) => {
          const x = index % 10, y = Math.floor(index / 10);
          const label = cellUnit(x, y);
          const movable = !label && canMoveTo({ x, y });
          return <button key={index} type="button" disabled={Boolean(state.outcome)} onClick={() => {
            if (label === "突击" || label === "射手" || label === "支援") { setSelected(MECHS.find(id => NAME[id] === label)!); return; }
            if (movable) void submit({ kind: "move", mech: selected, to: { x, y } });
          }} style={{ aspectRatio: "1", minWidth: 0, padding: 0, fontSize: 11, background: movable ? "#1f5f4a" : label ? "#3b3b3b" : "#171717", color: "#fff", border: "1px solid #333" }}>{label.slice(0, 1)}</button>;
        })}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {MECHS.map(id => <button key={id} type="button" aria-pressed={selected === id} onClick={() => setSelected(id)}>{NAME[id]}</button>)}
        <button type="button" disabled={Boolean(state.outcome)} onClick={() => void submit({ kind: "end", confirmUnused: true })}>结束回合</button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {actions.map((action, index) => <button key={index} type="button" disabled={Boolean(state.outcome)} onClick={() => void submit({ kind: "act", mech: selected, action })}>{action.kind}{"target" in action ? ` · ${action.target}` : ""}</button>)}
      </div>
    </>}
  </main>;
}
