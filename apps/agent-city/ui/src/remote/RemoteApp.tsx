import { useEffect, useMemo, useRef, useState } from "react";
import { RemoteMatchClient, type RemoteConnectionState } from "../game/mecha/client/RemoteMatchClient";
import { MECHA_NET_PROTOCOL, type MatchSnapshot, type SubmitPlanCommand, type TurnResolved } from "../game/mecha/contracts/match";
import { legalActions, living, moveBudget, pathDistance, previewPlan, type Action, type Cell, type MatchState, type MechId } from "../game/mecha/rules";
import { RemoteBattleScene } from "../game/mecha/presentation/RemoteBattleScene";
import type { BattleScenePort, RemoteBattleState } from "../game/mecha/presentation/BattleScenePort";
import { PVP_RULESET, pvpProjection } from "../game/mecha/rules/pvp";
import { useRemoteAccess } from "./remoteAccess";
import "./remote.css";

type Draft = { moveTo: Cell | null; action: Action; explicit: boolean };
type DraftMap = Record<MechId, Draft>;
const blank = (): DraftMap => ({ Assault: { moveTo: null, action: { kind: "skip" }, explicit: false }, Gunner: { moveTo: null, action: { kind: "skip" }, explicit: false }, Support: { moveTo: null, action: { kind: "skip" }, explicit: false } });
const names: Record<MechId, string> = { Assault: "突击", Gunner: "射手", Support: "支援" };

export function RemoteApp() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const locale = navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
  const t = (zh: string, en: string) => locale === "zh" ? zh : en;
  const matchId = params.get("match") ?? "";
  const { client, playerId, status: accessStatus, error: accessError } = useRemoteAccess(params);
  const [snapshot, setSnapshot] = useState<MatchSnapshot<RemoteBattleState> | null>(null);
  const [draft, setDraft] = useState<DraftMap>(blank);
  const [selected, setSelected] = useState<MechId>("Assault");
  const [targeting, setTargeting] = useState<Action["kind"] | null>(null);
  const [connection, setConnection] = useState<RemoteConnectionState>("offline");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<BattleScenePort | null>(null);
  const cellRef = useRef<(cell: Cell) => void>(() => {});
  const snapshotRef = useRef<MatchSnapshot<RemoteBattleState> | null>(null);

  const applySnapshot = (next: MatchSnapshot<RemoteBattleState>) => {
    const current = snapshotRef.current;
    if (current && ((current.mode === "pvp" && next.mode === "pve") || (current.mode === next.mode && next.revision < current.revision))) return;
    snapshotRef.current = next;
    setSnapshot(next);
    setDraft(blank());
    setTargeting(null);
    setError("");
  };

  const applyTurn = (turn: TurnResolved<RemoteBattleState>) => {
    const current = snapshotRef.current;
    if (!current || turn.matchId !== current.matchId || turn.revision <= current.revision || turn.state.ruleset !== current.ruleset) return;
    const next: MatchSnapshot<RemoteBattleState> = { ...current, revision: turn.revision, state: turn.state, status: ("outcome" in turn.state ? turn.state.outcome : turn.state.winner) ? "finished" : "active" };
    snapshotRef.current = next;
    setSnapshot(next);
    setDraft(blank());
    setTargeting(null);
    void sceneRef.current?.playTurn(turn);
  };

  useEffect(() => {
    if (!client) return;
    const offStatus = client.onStatus(setConnection);
    const offEvent = client.subscribe((event) => {
      if (event.type === "turn.resolved") applyTurn(event.result);
      else if (event.type === "match.replaced") applySnapshot(event.snapshot);
      else {
        const current = snapshotRef.current;
        if (current) {
          snapshotRef.current = { ...current, status: "closed" };
          setSnapshot(snapshotRef.current);
        }
        setError("room_closed");
      }
    });
    void client.snapshot(matchId).then((result) => {
      if (result.ok) applySnapshot(result.value);
      else setError(result.error.code);
    }).catch(() => setError("host_offline"));
    return () => { offStatus(); offEvent(); client.dispose(); };
  }, [client, matchId]);

  useEffect(() => {
    if (!canvasRef.current) return;
    try {
      const scene = new RemoteBattleScene(canvasRef.current, (cell) => cellRef.current(cell));
      sceneRef.current = scene;
      return () => { scene.dispose(); sceneRef.current = null; };
    } catch {
      setError(t("此设备无法创建 3D 场景，已保留下方棋盘。", "3D is unavailable; the accessible board remains available."));
    }
  }, []);

  useEffect(() => { if (accessError) setError(accessError); }, [accessError]);
  useEffect(() => { if (snapshot) sceneRef.current?.applySnapshot(snapshot); }, [snapshot]);
  useEffect(() => {
    const visibility = () => sceneRef.current?.setPaused(document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);

  const remoteState = snapshot?.state ?? null;
  const pvp = remoteState?.ruleset === PVP_RULESET;
  const side = snapshot?.players.find((player) => player.playerId === playerId)?.side ?? "A";
  const state = remoteState ? pvp ? pvpProjection(remoteState, side) : remoteState as MatchState : null;
  const myTurn = Boolean(state && snapshot?.status === "active" && state.phase === "player_plan"
    && (!pvp || (remoteState.activeSide === side && !remoteState.winner && snapshot.players.some((player) => player.side === "B" && player.role === "guest"))));
  const ids = state ? living(state).map((mech) => mech.id) : [];
  const selectedMech = state?.mechs.find((mech) => mech.id === selected && mech.hp > 0) ?? null;
  const actions = state && selectedMech && myTurn ? legalActions(state, selected) : [];
  const planned = ids.filter((id) => draft[id].explicit).length;
  const preview = state && !pvp ? previewPlan(state as MatchState, { revision: state.revision, items: ids.map((id) => ({ mechId: id, ...draft[id] })) }) : null;

  useEffect(() => {
    if (!selectedMech && ids.length > 0) setSelected(ids[0]!);
  }, [selectedMech, state]);

  const clickCell = (cell: Cell) => {
    if (!state || !myTurn || busy || state.phase !== "player_plan") return;
    const mech = state.mechs.find((item) => item.hp > 0 && item.pos.x === cell.x && item.pos.y === cell.y);
    const enemy = state.boss.hp > 0 && cell.x >= state.boss.anchor.x && cell.x <= state.boss.anchor.x + 1 && cell.y >= state.boss.anchor.y && cell.y <= state.boss.anchor.y + 1
      ? "boss" : state.raiders.find((item) => item.hp > 0 && item.pos.x === cell.x && item.pos.y === cell.y)?.id;
    if (targeting) {
      const target = targeting === "repair" ? mech?.id : enemy;
      if (!target) { setError(t("请选择高亮的合法目标。", "Select a highlighted legal target.")); return; }
      setAction({ kind: targeting, target } as Action);
      return;
    }
    if (mech) { setSelected(mech.id); return; }
    if (!selectedMech) return;
    const distance = pathDistance(state, selectedMech.pos, cell, selected, { alliesPass: true });
    if (distance === null || distance > moveBudget(selected)) { setError(t("这格不在移动范围内。", "This cell is out of reach.")); return; }
    setDraft((current) => ({ ...current, [selected]: { ...current[selected], moveTo: cell } }));
    setError("");
  };
  cellRef.current = clickCell;

  const setAction = (action: Action) => {
    setDraft((current) => ({ ...current, [selected]: { ...current[selected], action, explicit: true } }));
    setTargeting(null);
    setError("");
  };

  const submit = async () => {
    if (!client || !state || !snapshot || !myTurn || planned !== ids.length || busy) return;
    setBusy(true);
    setError("");
    const command: SubmitPlanCommand = {
      type: "plan.submit", protocol: MECHA_NET_PROTOCOL, matchId, playerId, commandId: crypto.randomUUID(), baseRevision: state.revision,
      plan: { revision: state.revision, items: ids.map((id) => ({ mechId: id, moveTo: draft[id].moveTo, action: draft[id].action })) },
    };
    try {
      const result = await client.submitPlan(command);
      if (result.ok) applyTurn(result.value);
      else setError(result.error.code);
    } catch { setError("host_offline"); }
    finally { setBusy(false); }
  };

  const concede = async () => {
    if (!client || !pvp || snapshot?.status !== "active" || busy || !window.confirm(t("确定认输并结束本场比赛吗？", "Concede and finish this match?"))) return;
    setBusy(true);
    try {
      const result = await client.concede(matchId);
      if (result.ok) applyTurn(result.value);
      else setError(result.error.code);
    } catch { setError("host_offline"); }
    finally { setBusy(false); }
  };

  const resync = async () => {
    if (!client) return;
    setBusy(true);
    try {
      const result = await client.snapshot(matchId);
      if (result.ok) applySnapshot(result.value);
      else setError(result.error.code);
    } catch { setError("host_offline"); }
    finally { setBusy(false); }
  };

  if (!client) return <main className="remote-gate"><h1>Agent City</h1><p role={accessError ? "alert" : "status"}>{accessError || (accessStatus === "waiting" ? t("邀请已登记，请在电脑端批准。批准后会自动进入对战。", "Invitation registered. Approve it on the desktop; this page will join automatically.") : accessStatus === "joining" ? t("正在登记邀请…", "Registering invitation…") : t("链接缺少比赛或连接信息，请从桌面客户端重新打开。", "The link is missing match or connection information. Reopen it from Desktop."))}</p></main>;
  return <main className="remote-app">
    <header><div><strong>Agent City</strong><span>{t("远程机甲战", "Remote Mecha Tactics")}{pvp ? ` · ${side}` : ""}</span></div><button onClick={resync}>{connection === "online" ? t("在线", "Online") : connection === "connecting" ? t("连接中", "Connecting") : t("重连", "Reconnect")}</button></header>
    <section className="remote-stage"><canvas ref={canvasRef} aria-label={t("三维机甲战场", "3D mecha battlefield")} />
      <div className="remote-status"><span>{state ? `${t("回合", "Turn")} ${state.turn} · rev ${state.revision}` : t("正在载入战场…", "Loading battlefield…")}</span><span>{snapshot?.status !== "active" ? t("比赛已结束", "Match finished") : pvp && !myTurn ? t("等待好友行动", "Waiting for your friend") : `${t("已规划", "Planned")} ${planned}/${ids.length}`}</span></div>
    </section>
    {error && <p className="remote-error" role="alert">{error}</p>}
    {state?.outcome && <p className="remote-outcome">{t("比赛结束", "Match finished")}: {state.outcome}</p>}
    {pvp && remoteState.winner && <p className="remote-outcome">{t("比赛结束，胜方", "Match finished; winner")}: {remoteState.winner}</p>}
    <section className="remote-controls">
      <div className="remote-mechs">{state?.mechs.map((mech) => <button key={mech.id} disabled={mech.hp <= 0} className={selected === mech.id ? "selected" : ""} onClick={() => setSelected(mech.id)}>{names[mech.id]}<small> HP {mech.hp}</small></button>)}</div>
      <div className="remote-actions">
        {actions.map((action) => <button key={`${action.kind}:${"target" in action ? action.target : ""}`} disabled={!myTurn} className={targeting === action.kind ? "selected" : ""} onClick={() => action.kind === "skip" ? setAction(action) : setTargeting(action.kind)}>{action.kind}{"target" in action ? ` · ${action.target}` : ""}</button>)}
      </div>
      <button className="remote-submit" disabled={!state || !myTurn || planned !== ids.length || busy || state.phase !== "player_plan" || Boolean(state.outcome)} onClick={submit}>{busy ? t("等待电脑结算…", "Resolving on host…") : t("提交整包并结束回合", "Submit squad plan")}</button>
      {pvp && snapshot?.status === "active" && <button disabled={busy} onClick={concede}>{t("认输", "Concede")}</button>}
      {preview && !preview.ok && <small>{preview.fault.cause ?? preview.fault.code}</small>}
    </section>
    <details className="remote-board"><summary>{t("二维棋盘与可访问控制", "2D accessible board")}</summary><div>{state && Array.from({ length: 10 }, (_, y) => <div className="remote-row" key={y}>{Array.from({ length: 10 }, (_, x) => {
      const mech = state.mechs.find((item) => item.hp > 0 && item.pos.x === x && item.pos.y === y);
      const boss = state.boss.hp > 0 && x >= state.boss.anchor.x && x <= state.boss.anchor.x + 1 && y >= state.boss.anchor.y && y <= state.boss.anchor.y + 1;
      return <button key={x} onClick={() => clickCell({ x, y })} aria-label={`${x},${y}`}>{mech ? names[mech.id][0] : boss ? "B" : state.terrain[y]?.[x] === "water" ? "~" : "·"}</button>;
    })}</div>)}</div></details>
  </main>;
}
