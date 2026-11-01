import { useEffect, useMemo, useRef, useState } from "react";
import { RemoteMatchClient, type RemoteConnectionState } from "../game/mecha/client/RemoteMatchClient";
import { MECHA_NET_PROTOCOL, type MatchSnapshot, type SubmitPlanCommand, type TurnResolved } from "../game/mecha/contracts/match";
import { legalActions, living, moveBudget, pathDistance, validateAndApplyPlan, type Action, type Cell, type MatchState, type MechId } from "../game/mecha/rules";
import { blankDraft, checkDraftAction, checkDraftPlan, draftPlan, settledDraftBoard, type DraftAuthority, type DraftCheck, type DraftMap } from "../game/mecha/planning";
import { RemoteMatchSynchronizer } from "../game/mecha/client/RemoteMatchSynchronizer";
import { RemotePresentationCoordinator } from "../game/mecha/presentation/RemotePresentationCoordinator";
import { RemoteBattleScene } from "../game/mecha/presentation/RemoteBattleScene";
import type { BattleScenePort, RemoteBattleState } from "../game/mecha/presentation/BattleScenePort";
import { PVP_RULESET, playPvpTurn, pvpProjection } from "../game/mecha/rules/pvp";
import { swapEventSink } from "../game/mecha/board";
import type { MatchSide } from "../game/mecha/contracts/match";
import { useRemoteAccess } from "./remoteAccess";
import "./remote.css";

const names: Record<MechId, string> = { Assault: "突击", Gunner: "射手", Support: "支援" };

// Transport/mode adapter: legality remains with the same authoritative rules
// used by the host. Planning mechanics themselves are shared with City.
function remoteAuthority(remote: RemoteBattleState): DraftAuthority {
  return (plan) => {
    if (remote.ruleset === PVP_RULESET) return playPvpTurn(remote, plan);
    // PvE validation emits into a shared sink, even on rejection. A preflight
    // must not contaminate an enclosing turn log and must restore on exceptions.
    const outer = swapEventSink(null);
    try {
      const result = validateAndApplyPlan(structuredClone(remote), plan);
      return "ok" in result ? { ok: true } : { ok: false, fault: result };
    } finally {
      swapEventSink(outer);
    }
  };
}

export function remoteDraftProjection(remote: RemoteBattleState, side: MatchSide, draft: DraftMap) {
  try {
    const state = remote.ruleset === PVP_RULESET ? pvpProjection(remote, side) : remote;
    const authority = remoteAuthority(remote);
    const movement = checkDraftPlan(draftPlan(state, draft, "movement"), authority);
    if (movement.status !== "ok") return { movement, state: null, invalid: [] as MechId[], actionUnknown: false, plan: movement };
    const projected = settledDraftBoard(state, draft);
    const checks = living(state).filter((mech) => draft[mech.id].explicit)
      .map((mech) => ({ id: mech.id, result: checkDraftAction(state, draft, mech.id, draft[mech.id].action, authority) }));
    const invalid = checks.filter(({ result }) => result.status === "rejected").map(({ id }) => id);
    const actionUnknown = checks.some(({ result }) => result.status === "unknown");
    const plan = checkDraftPlan(draftPlan(state, draft), authority);
    return { movement, state: projected, invalid, actionUnknown, plan };
  } catch {
    const unknown: DraftCheck = { status: "unknown" };
    return { movement: unknown, state: null, invalid: [] as MechId[], actionUnknown: false, plan: unknown };
  }
}

export function RemoteApp() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const locale = navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
  const t = (zh: string, en: string) => locale === "zh" ? zh : en;
  const matchId = params.get("match") ?? "";
  const { client, playerId, status: accessStatus, error: accessError } = useRemoteAccess(params);
  const [snapshot, setSnapshot] = useState<MatchSnapshot<RemoteBattleState> | null>(null);
  const [draft, setDraft] = useState<DraftMap>(blankDraft);
  const [selected, setSelected] = useState<MechId>("Assault");
  const [targeting, setTargeting] = useState<Action["kind"] | null>(null);
  const [connection, setConnection] = useState<RemoteConnectionState>("offline");
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [error, setError] = useState("");
  const [sceneUnavailable, setSceneUnavailable] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<BattleScenePort | null>(null);
  const presentationRef = useRef<RemotePresentationCoordinator | null>(null);
  const synchronizerRef = useRef<RemoteMatchSynchronizer | null>(null);
  const cellRef = useRef<(cell: Cell) => void>(() => {});
  const snapshotRef = useRef<MatchSnapshot<RemoteBattleState> | null>(null);

  useEffect(() => {
    if (!client) return;
    const sync = new RemoteMatchSynchronizer(matchId, () => client.snapshot(matchId), {
      snapshot: (next, recovered) => {
        if (snapshotRef.current && snapshotRef.current.ruleset !== next.ruleset) setHistoryUnavailable(false);
        snapshotRef.current = next;
        setSnapshot(next);
        setDraft(blankDraft());
        setTargeting(null);
        if (recovered) setHistoryUnavailable(true);
        setError("");
        presentationRef.current?.snapshot(next);
      },
      turn: (turn, next) => {
        snapshotRef.current = next;
        setSnapshot(next);
        setDraft(blankDraft());
        setTargeting(null);
        presentationRef.current?.turn(turn, next);
      },
      syncing: setSyncing,
      error: setError,
    });
    synchronizerRef.current = sync;
    const offStatus = client.onStatus((value) => { setConnection(value); sync.connection(value === "online"); });
    const offEvent = client.subscribe((event) => sync.event(event));
    void sync.resync();
    return () => { synchronizerRef.current = null; sync.dispose(); offStatus(); offEvent(); client.dispose(); };
  }, [client, matchId]);

  useEffect(() => {
    if (!canvasRef.current) return;
    try {
      const scene = new RemoteBattleScene(canvasRef.current, (cell) => cellRef.current(cell));
      sceneRef.current = scene;
      const presentation = new RemotePresentationCoordinator(setPlaying);
      presentationRef.current = presentation;
      if (snapshotRef.current) presentation.snapshot(snapshotRef.current);
      presentation.attach(scene);
      scene.setPaused(document.hidden);
      return () => { presentation.detach(scene); presentation.dispose(); presentationRef.current = null; scene.dispose(); sceneRef.current = null; };
    } catch {
      setSceneUnavailable(true);
    }
  }, [client]);

  useEffect(() => { if (accessError) setError(accessError); }, [accessError]);
  useEffect(() => {
    const visibility = () => sceneRef.current?.setPaused(document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);

  const remoteState = snapshot?.state ?? null;
  const pvp = remoteState?.ruleset === PVP_RULESET;
  const side = snapshot?.players.find((player) => player.playerId === playerId)?.side ?? "A";
  const state = remoteState ? pvp ? pvpProjection(remoteState, side) : remoteState as MatchState : null;
  const myTurn = Boolean(!syncing && !playing && connection === "online" && state && snapshot?.status === "active" && state.phase === "player_plan"
    && (!pvp || (remoteState.activeSide === side && !remoteState.winner && snapshot.players.some((player) => player.side === "B" && player.role === "guest"))));
  const ids = state ? living(state).map((mech) => mech.id) : [];
  const selectedMech = state?.mechs.find((mech) => mech.id === selected && mech.hp > 0) ?? null;
  const projection = useMemo(() => remoteState && myTurn ? remoteDraftProjection(remoteState, side, draft) : null, [remoteState, side, draft, myTurn]);
  const draftState = projection?.state ?? null;
  const actions = draftState && selectedMech && myTurn ? legalActions(draftState, selected) : [];
  const planned = ids.filter((id) => draft[id].explicit && !projection?.invalid.includes(id)).length;
  const canSubmit = projection?.movement.status === "ok" && projection.plan.status === "ok" && projection.invalid.length === 0 && !projection.actionUnknown;

  useEffect(() => {
    if (!selectedMech && ids.length > 0) setSelected(ids[0]!);
  }, [selectedMech, state]);

  const clickCell = (cell: Cell, source: "scene" | "board") => {
    if (!state || !myTurn || busy || !synchronizerRef.current?.canInteract() || presentationRef.current?.isPlaying() || state.phase !== "player_plan") return;
    // The 3D scene shows the authoritative snapshot; the 2D board shows the
    // validated draft projection when available. Pick what each face displays.
    const pickState = source === "scene" ? state : draftState ?? state;
    const mech = pickState.mechs.find((item) => item.hp > 0 && item.pos.x === cell.x && item.pos.y === cell.y);
    const enemy = state.boss.hp > 0 && cell.x >= state.boss.anchor.x && cell.x <= state.boss.anchor.x + 1 && cell.y >= state.boss.anchor.y && cell.y <= state.boss.anchor.y + 1
      ? "boss" : state.raiders.find((item) => item.hp > 0 && item.pos.x === cell.x && item.pos.y === cell.y)?.id;
    if (targeting) {
      const target = targeting === "repair" ? mech?.id : enemy;
      const action = target ? { kind: targeting, target } as Action : null;
      if (!action || !draftState || !remoteState) { setError(t("请选择当前草稿下的合法目标。", "Select a legal target for the current draft.")); return; }
      const check = checkDraftAction(state, draft, selected, action, remoteAuthority(remoteState));
      if (check.status !== "ok") {
        setError(check.status === "unknown" ? t("行动预检未知，请稍后重试。", "Action check unavailable; try again.") : t("请选择当前草稿下的合法目标。", "Select a legal target for the current draft."));
        return;
      }
      setAction(action);
      return;
    }
    if (mech) { setSelected(mech.id); setTargeting(null); return; }
    if (!selectedMech) return;
    const distance = pathDistance(state, selectedMech.pos, cell, selected, { alliesPass: true });
    if (distance === null || distance > moveBudget(selected)) { setError(t("这格不在移动范围内。", "This cell is out of reach.")); return; }
    setDraft((current) => ({ ...current, [selected]: { ...current[selected], moveTo: cell } }));
    setTargeting(null);
    setError("");
  };
  cellRef.current = (cell) => clickCell(cell, "scene");

  const setAction = (action: Action) => {
    if (!myTurn || !synchronizerRef.current?.canInteract() || presentationRef.current?.isPlaying()) return;
    setDraft((current) => ({ ...current, [selected]: { ...current[selected], action, explicit: true } }));
    setTargeting(null);
    setError("");
  };

  const submit = async () => {
    if (!client || !state || !snapshot || !myTurn || !synchronizerRef.current?.canInteract() || presentationRef.current?.isPlaying() || planned !== ids.length || !canSubmit || busy) return;
    setBusy(true);
    setError("");
    const command: SubmitPlanCommand = {
      type: "plan.submit", protocol: MECHA_NET_PROTOCOL, matchId, playerId, commandId: crypto.randomUUID(), baseRevision: state.revision,
      plan: draftPlan(state, draft),
    };
    try {
      const result = await client.submitPlan(command);
      if (result.ok) synchronizerRef.current?.turn(result.value);
      else {
        setError(result.error.code);
        if (result.error.code === "stale_revision" || result.error.code === "not_your_turn") void synchronizerRef.current?.resync();
      }
    } catch { setError("host_offline"); }
    finally { setBusy(false); }
  };

  const concede = async () => {
    if (!client || !pvp || snapshot?.status !== "active" || busy || !synchronizerRef.current?.canInteract() || presentationRef.current?.isPlaying() || !window.confirm(t("确定认输并结束本场比赛吗？", "Concede and finish this match?"))) return;
    setBusy(true);
    try {
      const result = await client.concede(matchId);
      if (result.ok) synchronizerRef.current?.turn(result.value);
      else setError(result.error.code);
    } catch { setError("host_offline"); }
    finally { setBusy(false); }
  };

  const resync = async () => {
    if (!synchronizerRef.current) return;
    setError("");
    await synchronizerRef.current.resync();
  };

  if (!client) return <main className="remote-gate"><h1>Agent City</h1><p role={accessError ? "alert" : "status"}>{accessError || (accessStatus === "waiting" ? t("邀请已登记，请在电脑端批准。批准后会自动进入对战。", "Invitation registered. Approve it on the desktop; this page will join automatically.") : accessStatus === "joining" ? t("正在登记邀请…", "Registering invitation…") : t("链接缺少比赛或连接信息，请从桌面客户端重新打开。", "The link is missing match or connection information. Reopen it from Desktop."))}</p></main>;
  return <main className="remote-app">
    <header><div><strong>Agent City</strong><span>{t("远程机甲战", "Remote Mecha Tactics")}{pvp ? ` · ${side}` : ""}</span></div><button onClick={resync}>{connection === "online" ? t("在线", "Online") : connection === "connecting" ? t("连接中", "Connecting") : t("重连", "Reconnect")}</button></header>
    <section className="remote-stage"><canvas ref={canvasRef} aria-label={t("三维机甲战场", "3D mecha battlefield")} />
      <div className="remote-status"><span>{state ? `${t("回合", "Turn")} ${state.turn} · rev ${state.revision}` : t("正在载入战场…", "Loading battlefield…")}</span><span>{!snapshot ? t("正在同步", "Synchronizing") : snapshot.status !== "active" ? t("比赛已结束", "Match finished") : syncing || connection !== "online" ? t("正在同步，操作已暂停", "Synchronizing; input paused") : playing ? t("正在播放结算，操作已暂停", "Playing turn; input paused") : pvp && !myTurn ? t("等待好友行动", "Waiting for your friend") : `${t("已规划", "Planned")} ${planned}/${ids.length}`}</span></div>
    </section>
    {sceneUnavailable && <p role="status">{t("此设备无法创建 3D 场景，已保留下方棋盘。", "3D is unavailable; the accessible board remains available.")}</p>}
    {historyUnavailable && <p role="status">{t("已同步最新局面；部分回合记录或演出可能不可回看。", "Synced to the latest state; some turn history or playback may be unavailable.")}</p>}
    {error && <p className="remote-error" role="alert">{error === "sync_incomplete" ? t("局面尚未同步，请重试。", "State is not synchronized; retry.") : error}</p>}
    {state?.outcome && <p className="remote-outcome">{t("比赛结束", "Match finished")}: {state.outcome}</p>}
    {pvp && remoteState.winner && <p className="remote-outcome">{t("比赛结束，胜方", "Match finished; winner")}: {remoteState.winner}</p>}
    <section className="remote-controls">
      <div className="remote-mechs">{state?.mechs.map((mech) => <button key={mech.id} disabled={mech.hp <= 0 || syncing || playing || connection !== "online"} className={selected === mech.id ? "selected" : ""} onClick={() => { setSelected(mech.id); setTargeting(null); }}>{names[mech.id]}<small> HP {mech.hp}</small></button>)}</div>
      <div className="remote-actions">
        {actions.map((action) => <button key={`${action.kind}:${"target" in action ? action.target : ""}`} disabled={!myTurn || busy} className={targeting === action.kind ? "selected" : ""} onClick={() => action.kind === "skip" || ("target" in action && action.target !== undefined) ? setAction(action) : setTargeting(action.kind)}>{action.kind}{"target" in action ? ` · ${action.target}` : ""}</button>)}
      </div>
      <button disabled={!myTurn || busy || !draft[selected].moveTo} onClick={() => { setDraft((current) => ({ ...current, [selected]: { ...current[selected], moveTo: null } })); setTargeting(null); setError(""); }}>{t("取消所选机甲移动", "Clear selected move")}</button>
      {projection && myTurn && <small role="status">{projection.movement.status === "unknown" ? t("移动预检未知，无法预判行动。", "Movement check unavailable; actions cannot be predicted.") : projection.movement.status === "rejected" ? `${t("移动草稿被拒绝，请调整", "Movement draft rejected; adjust it")}: ${projection.movement.fault.reason}` : projection.invalid.length > 0 ? `${t("移动后行动失效，请重新选择", "Actions invalid after movement; choose again")}: ${projection.invalid.map((id) => names[id]).join(", ")}` : projection.actionUnknown ? t("行动预检未知，无法提交。", "Action check unavailable; cannot submit.") : projection.plan.status === "unknown" ? t("整包预检未知，无法提交。", "Plan check unavailable; cannot submit.") : projection.plan.status === "rejected" ? `${t("整包预检被拒绝", "Plan check rejected")}: ${projection.plan.fault.reason}` : t("行动基于草稿移动后局面；实际结算仍可能落空。三维场景显示当前局面。", "Actions use projected positions; resolution may still fizzle. The 3D scene shows current positions.")}</small>}
      <button className="remote-submit" disabled={!state || !myTurn || planned !== ids.length || !canSubmit || busy || state.phase !== "player_plan" || Boolean(state.outcome)} onClick={submit}>{busy ? t("等待电脑结算…", "Resolving on host…") : t("提交整包并结束回合", "Submit squad plan")}</button>
      {pvp && snapshot?.status === "active" && <button disabled={busy || syncing || playing || connection !== "online"} onClick={concede}>{t("认输", "Concede")}</button>}
    </section>
    <details className="remote-board"><summary>{t("二维棋盘与可访问控制", "2D accessible board")}</summary><div>{(draftState ?? state) && Array.from({ length: 10 }, (_, y) => <div className="remote-row" key={y}>{Array.from({ length: 10 }, (_, x) => {
      const board = draftState ?? state!;
      const mech = board.mechs.find((item) => item.hp > 0 && item.pos.x === x && item.pos.y === y);
      const raider = board.raiders.find((item) => item.hp > 0 && item.pos.x === x && item.pos.y === y);
      const boss = board.boss.hp > 0 && x >= board.boss.anchor.x && x <= board.boss.anchor.x + 1 && y >= board.boss.anchor.y && y <= board.boss.anchor.y + 1;
      return <button key={x} disabled={!myTurn || busy} onClick={() => clickCell({ x, y }, "board")} aria-label={`${x},${y}`}>{mech ? names[mech.id][0] : boss ? "B" : raider ? "E" : board.terrain[y]?.[x] === "water" ? "~" : "·"}</button>;
    })}</div>)}</div></details>
  </main>;
}
