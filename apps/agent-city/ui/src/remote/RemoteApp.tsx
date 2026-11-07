import { useEffect, useMemo, useRef, useState } from "react";
import { RemoteMatchClient, type RemoteConnectionState } from "../game/mecha/client/RemoteMatchClient";
import { canonicalJson, MECHA_NET_PROTOCOL, type MatchSnapshot, type SubmitDeploymentCommand, type SubmitPlanCommand, type TurnResolved } from "../game/mecha/contracts/match";
import { legalActions, living, moveBudget, pathDistance, validateAndApplyPlan, type Action, type Cell, type MatchState, type MechId } from "../game/mecha/rules";
import { blankDraft, checkDraftAction, checkDraftPlan, draftPlan, settledDraftBoard, type DraftAuthority, type DraftCheck, type DraftMap } from "../game/mecha/planning";
import { RemoteMatchSynchronizer } from "../game/mecha/client/RemoteMatchSynchronizer";
import { RemotePresentationCoordinator } from "../game/mecha/presentation/RemotePresentationCoordinator";
import { RemoteBattleScene } from "../game/mecha/presentation/RemoteBattleScene";
import type { RemoteBattleState } from "../game/mecha/presentation/BattleScenePort";
import { RemoteDeployment } from "./RemoteDeployment";
import { swapEventSink } from "../game/mecha/board";
import { useRemoteAccess } from "./remoteAccess";
import { remoteCapability } from "./remoteCapability";
import { pendingJournal, type PendingMarker } from "./pendingJournal";
import "./remote.css";

type PendingPlan = (
  | { kind: "plan"; command: SubmitPlanCommand }
) & { ruleset: string; baseline: string; uncertain: boolean; changed: boolean };

const names: Record<MechId, string> = { Assault: "突击", Gunner: "射手", Support: "支援" };

// Transport/mode adapter: legality remains with the same authoritative rules
// used by the host. Planning mechanics themselves are shared with City.
function remoteAuthority(remote: MatchState): DraftAuthority {
  return (plan) => {
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

export function remoteDraftProjection(state: MatchState, draft: DraftMap) {
  try {
    const authority = remoteAuthority(state);
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
  // A marker is written before transmission. It contains no payload or credentials.
  const journalContext = useMemo(() => {
    let storage: Storage | null = null;
    try { storage = window.sessionStorage; } catch { /* fail closed */ }
    const identity = { matchId, playerId, capability: remoteCapability(params) ?? "", room: params.get("room") ?? "", invite: params.get("invite") ?? "", device: params.get("device") ?? "" };
    const journal = pendingJournal(storage, identity);
    return { identity: JSON.stringify(identity), journal, initial: journal.read() };
  }, [matchId, playerId, params]);
  const [snapshot, setSnapshot] = useState<MatchSnapshot<RemoteBattleState> | null>(null);
  const [draft, setDraft] = useState<DraftMap>(blankDraft);
  const [selected, setSelected] = useState<MechId>("Assault");
  const [targeting, setTargeting] = useState<Action["kind"] | null>(null);
  const [connection, setConnection] = useState<RemoteConnectionState>("offline");
  const [busy, setBusy] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null);
  const [pendingDeployment, setPendingDeployment] = useState<SubmitDeploymentCommand | null>(null);
  const [recoveryMarker, setRecoveryMarker] = useState<PendingMarker | null>(() => journalContext.initial.status === "pending" ? journalContext.initial.marker : null);
  const [journalFault, setJournalFault] = useState(() => journalContext.initial.status === "error");
  const [syncing, setSyncing] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [error, setError] = useState("");
  const [sceneUnavailable, setSceneUnavailable] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<RemoteBattleScene | null>(null);
  const presentationRef = useRef<RemotePresentationCoordinator | null>(null);
  const synchronizerRef = useRef<RemoteMatchSynchronizer | null>(null);
  const cellRef = useRef<(cell: Cell) => void>(() => {});
  const snapshotRef = useRef<MatchSnapshot<RemoteBattleState> | null>(null);
  const pendingPlanRef = useRef<PendingPlan | null>(null);
  const pendingDeploymentRef = useRef<SubmitDeploymentCommand | null>(null);
  const journalIdentityRef = useRef(journalContext.identity);
  const markerRef = useRef<PendingMarker | null>(journalContext.initial.status === "pending" ? journalContext.initial.marker : null);
  const journalFaultRef = useRef(journalContext.initial.status === "error");
  const currentJournalIdentityRef = useRef(journalContext.identity);
  currentJournalIdentityRef.current = journalContext.identity;
  const identityChanged = journalIdentityRef.current !== journalContext.identity;
  const failJournal = () => { journalFaultRef.current = true; setJournalFault(true); };
  const beginMarker = (kind: PendingMarker["kind"], command: { matchId: string; playerId: string; commandId: string; baseRevision: number }) => {
    if (journalIdentityRef.current !== currentJournalIdentityRef.current || journalFaultRef.current || markerRef.current) return false;
    const marker: PendingMarker = { version: 1, kind, matchId: command.matchId, playerId: command.playerId, commandId: command.commandId, baseRevision: command.baseRevision };
    if (!journalContext.journal.begin(marker)) { failJournal(); return false; }
    markerRef.current = marker;
    return true;
  };
  const clearMarker = (command: { matchId: string; playerId: string; commandId: string; baseRevision: number }) => {
    const marker = markerRef.current;
    if (!marker || marker.matchId !== command.matchId || marker.playerId !== command.playerId || marker.commandId !== command.commandId || marker.baseRevision !== command.baseRevision) return;
    if (journalIdentityRef.current !== currentJournalIdentityRef.current || !journalContext.journal.clear(marker)) { failJournal(); return; }
    markerRef.current = null;
    setRecoveryMarker(null);
  };
  const settleJournal = (next: MatchSnapshot<RemoteBattleState>) => {
    const marker = markerRef.current;
    if (marker && next.matchId === marker.matchId && (next.revision > marker.baseRevision || next.status !== "active")) clearMarker(marker);
  };

  const setPending = (pending: PendingPlan | null) => {
    pendingPlanRef.current = pending;
    setPendingPlan(pending);
  };
  const setDeploymentPending = (command: SubmitDeploymentCommand | null) => {
    pendingDeploymentRef.current = command;
    setPendingDeployment(command);
  };
  const settleDeployment = (next: MatchSnapshot<RemoteBattleState>) => {
    const pending = pendingDeploymentRef.current;
    if (pending && (next.revision > pending.baseRevision || next.status !== "active")) setDeploymentPending(null);
  };
  // A snapshot at the command's original revision does not prove that an
  // in-flight request won't arrive later. Keep it locked until authority moves.
  const settlePending = (next: MatchSnapshot<RemoteBattleState>) => {
    const pending = pendingPlanRef.current;
    if (pending && (next.revision > pending.command.baseRevision || next.status !== "active")) setPending(null);
    else if (pending && !pending.changed && (next.ruleset !== pending.ruleset || canonicalJson(next.state) !== pending.baseline)) {
      // Keep the original object for an in-flight response, but never retry it
      // after a same-revision correction, even if the board later rolls back.
      pending.changed = true;
      setPendingPlan({ ...pending });
    }
    return pendingPlanRef.current !== null;
  };

  useEffect(() => {
    if (!client) return;
    const sync = new RemoteMatchSynchronizer(matchId, () => client.snapshot(matchId), {
      snapshot: (next, recovered) => {
        if (snapshotRef.current && snapshotRef.current.ruleset !== next.ruleset) setHistoryUnavailable(false);
        snapshotRef.current = next;
        setSnapshot(next);
        settleJournal(next);
        settleDeployment(next);
        if (!settlePending(next)) setDraft(blankDraft());
        setTargeting(null);
        if (recovered) setHistoryUnavailable(true);
        setError("");
        presentationRef.current?.snapshot(next);
      },
      turn: (turn, next) => {
        snapshotRef.current = next;
        setSnapshot(next);
        settleJournal(next);
        settleDeployment(next);
        if (!settlePending(next)) setDraft(blankDraft());
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
    // Best effort only: browsers may suppress this prompt, especially on mobile.
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!pendingPlanRef.current && !pendingDeploymentRef.current && !markerRef.current && !journalFaultRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  useEffect(() => {
    const visibility = () => sceneRef.current?.setPaused(document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);

  const remoteState = snapshot?.state ?? null;
  const state = remoteState as MatchState | null;
  const deploying = Boolean(state?.phase === "deployment");
  const journalBlocked = Boolean(recoveryMarker || journalFault || identityChanged);
  const myTurn = Boolean(!journalBlocked && !pendingPlan && !pendingDeployment && !syncing && !playing && connection === "online" && state && snapshot?.status === "active" && state.phase === "player_plan"
    );
  const ids = state ? living(state).map((mech) => mech.id) : [];
  const selectedMech = state?.mechs.find((mech) => mech.id === selected && mech.hp > 0) ?? null;
  const projection = useMemo(() => remoteState && myTurn ? remoteDraftProjection(remoteState as MatchState, draft) : null, [remoteState, draft, myTurn]);
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
      const check = checkDraftAction(state, draft, selected, action, remoteAuthority(state));
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

  const sendPendingPlan = async (pending: PendingPlan) => {
    if (!client || busy || journalFaultRef.current || journalIdentityRef.current !== currentJournalIdentityRef.current || !synchronizerRef.current?.canInteract() || presentationRef.current?.isPlaying()) return;
    // An older host may replace the mode without bumping revision. Never send
    // a command from the former ruleset into that ambiguous replacement.
    if (pending.changed || snapshotRef.current?.ruleset !== pending.ruleset || snapshotRef.current.revision !== pending.command.baseRevision
      || canonicalJson(snapshotRef.current.state) !== pending.baseline) return;
    setBusy(true);
    setError("");
    try {
      const result = await client.submitPlan(pending.command);
      if (pendingPlanRef.current !== pending) return;
      if (result.ok && result.value.matchId === pending.command.matchId && result.value.playerId === pending.command.playerId
        && result.value.commandId === pending.command.commandId && result.value.revision > pending.command.baseRevision
        && result.value.state.ruleset === pending.ruleset) {
        synchronizerRef.current?.turn(result.value);
      } else {
        const code = result.ok ? "invalid_message" : result.error.code;
        // Once a request's outcome is unknown, a later rejected retry cannot
        // prove that the original request is no longer in flight.
        if (pending.uncertain || ["host_offline", "unavailable", "invalid_message", "duplicate_command"].includes(code)) {
          pending.uncertain = true;
          setPendingPlan({ ...pending });
        } else { clearMarker(pending.command); setPending(null); }
        setError(code);
        if (pending.uncertain || ["stale_revision", "not_your_turn", "match_finished", "room_closed"].includes(code)) void synchronizerRef.current?.resync();
      }
    } catch {
      if (pendingPlanRef.current !== pending) return;
      pending.uncertain = true;
      setPendingPlan({ ...pending });
      setError("host_offline");
      void synchronizerRef.current?.resync();
    } finally { setBusy(false); }
  };

  const submit = async () => {
    if (!client || !state || !snapshot || snapshotRef.current !== snapshot || !myTurn || journalFaultRef.current || markerRef.current || pendingPlanRef.current || pendingDeploymentRef.current || !synchronizerRef.current?.canInteract() || presentationRef.current?.isPlaying() || planned !== ids.length || !canSubmit || busy) return;
    const pending: PendingPlan = { kind: "plan", ruleset: snapshot.ruleset, baseline: canonicalJson(snapshot.state), uncertain: false, changed: false, command: {
      type: "plan.submit", protocol: MECHA_NET_PROTOCOL, matchId, playerId, commandId: crypto.randomUUID(), baseRevision: state.revision,
      plan: draftPlan(state, draft),
    } };
    if (!beginMarker(pending.kind, pending.command)) return;
    setPending(pending);
    await sendPendingPlan(pending);
  };


  const resync = async () => {
    if (!synchronizerRef.current) return;
    setError("");
    await synchronizerRef.current.resync();
  };

  if (!client) return <main className="remote-gate"><h1>Agent City</h1><p role={accessError ? "alert" : "status"}>{accessError || (accessStatus === "waiting" ? t("邀请已登记，请在电脑端批准。批准后会自动进入对战。", "Invitation registered. Approve it on the desktop; this page will join automatically.") : accessStatus === "joining" ? t("正在登记邀请…", "Registering invitation…") : t("链接缺少比赛或连接信息，请从桌面客户端重新打开。", "The link is missing match or connection information. Reopen it from Desktop."))}</p></main>;
  return <main className="remote-app">
    <header><div><strong>Agent City</strong><span>{t("远程机甲战", "Remote Mecha Tactics")}</span></div><button onClick={resync}>{connection === "online" ? syncing ? t("重新同步", "Sync again") : t("在线", "Online") : connection === "connecting" ? t("连接中", "Connecting") : t("重连", "Reconnect")}</button></header>
    <section className="remote-stage"><canvas ref={canvasRef} aria-label={t("三维机甲战场", "3D mecha battlefield")} />
      <div className="remote-status"><span>{state ? `${t("回合", "Turn")} ${state.turn} · rev ${state.revision}` : t("正在载入战场…", "Loading battlefield…")}</span><span>{!snapshot ? t("正在同步", "Synchronizing") : snapshot.status !== "active" ? t("比赛已结束", "Match finished") : pendingPlan || pendingDeployment || journalBlocked ? t("提交结果待确认，操作已暂停", "Submission unconfirmed; input paused") : syncing || connection !== "online" ? t("正在同步，操作已暂停", "Synchronizing; input paused") : playing ? t("正在播放结算，操作已暂停", "Playing turn; input paused") : deploying ? t("开局部署", "Deployment") : `${t("已规划", "Planned")} ${planned}/${ids.length}`}</span></div>
    </section>
    {sceneUnavailable && <p role="status">{t("此设备无法创建 3D 场景，已保留下方棋盘。", "3D is unavailable; the accessible board remains available.")}</p>}
    {historyUnavailable && <p role="status">{t("已同步最新局面；部分回合记录或演出可能不可回看。", "Synced to the latest state; some turn history or playback may be unavailable.")}</p>}
    {error && <p className="remote-error" role="alert">{error === "sync_incomplete" ? t("局面尚未同步，请重试。", "State is not synchronized; retry.") : (error === "host_offline" || error === "unavailable") ? connection === "online" ? t("已连接中继，但电脑端暂不可用；正在自动重试，操作已暂停。", "Relay connected, but the host is unavailable. Retrying automatically; input is paused.") : t("连接中断，正在尝试恢复；操作已暂停。", "Connection lost. Attempting to reconnect; input is paused.") : error}</p>}
    {(pendingPlan || pendingDeployment || recoveryMarker) && <p role="status">{t("同一标签页刷新后会尽力保留待确认锁，但无法恢复重试；其他标签页、设备或浏览器清理存储不受保护。", "This tab attempts to retain the pending lock after reload, but cannot restore retry. Other tabs, devices, or cleared browser storage are not protected.")}</p>}
    {recoveryMarker && <p role="status">{t("刷新前的请求尚未确认，无法在此页面重试。请等待局面更新，或请房主停止远程并重新开局。", "A request from before reload is unconfirmed and cannot be retried here. Wait for an update, or ask the host to stop and restart the match.")}</p>}
    {(journalFault || identityChanged) && <p role="alert">{t("待确认保护存储不可用或身份已变化，操作已暂停。不要清除站点数据；请检查存储权限，或请房主停止远程并重新开局。", "Pending-request storage is unavailable or identity changed; input is paused. Do not clear site data. Check storage permissions, or ask the host to stop and restart the match.")}</p>}
    {pendingPlan && <div className="remote-pending" role="status">
      <p>{t("提交结果尚未确认。同版本快照不能证明原请求已取消，请重试原命令或等待局面更新。", "Submission is unconfirmed. A same-revision snapshot does not cancel the original request; retry the same command or wait for the state to advance.")}</p>
      <button disabled={busy || journalBlocked || syncing || playing || connection !== "online" || pendingPlan.changed || snapshot?.ruleset !== pendingPlan.ruleset || snapshot?.revision !== pendingPlan.command.baseRevision || canonicalJson(snapshot.state) !== pendingPlan.baseline} onClick={() => { const pending = pendingPlanRef.current; if (pending) void sendPendingPlan(pending); }}>{t("重试原提交", "Retry original submission")}</button>
      {pendingPlan.changed && <p>{t("同版本战场已变化，无法安全重试。请等待局面更新，或请房主停止远程并重新开局。", "The battlefield changed without a new revision; retry is unsafe. Wait for an update, or ask the host to stop and restart the match.")}</p>}
    </div>}
    {pendingDeployment && !deploying && <p role="status">{t("先前的部署请求尚未确认；请等待局面更新，或请房主停止远程并重新开局。", "A previous deployment is unconfirmed. Wait for an update, or ask the host to stop and restart the match.")}</p>}
    {state?.outcome && <p className="remote-outcome">{t("比赛结束", "Match finished")}: {state.outcome}</p>}
    {deploying && snapshot && state ? <RemoteDeployment
      key={`${snapshot.matchId}:${snapshot.revision}`}
      snapshot={snapshot} state={state} playerId={playerId} client={client} locale={locale}
      interactive={!journalBlocked && !pendingPlan && !syncing && !playing && connection === "online" && snapshot.status === "active"}
      guarded={Boolean(pendingDeployment || journalBlocked)}
      onPendingStart={command => { if (!beginMarker("deployment", command)) return false; setDeploymentPending(command); return true; }}
      onPendingEnd={command => { if (pendingDeploymentRef.current?.commandId === command.commandId) { clearMarker(command); setDeploymentPending(null); } }}
      cellRef={cellRef} sceneRef={sceneRef} canInteract={() => snapshotRef.current === snapshot && Boolean(synchronizerRef.current?.canInteract())}
      accept={(next) => synchronizerRef.current?.event({ type: "match.replaced", snapshot: next })}
      resync={() => { void synchronizerRef.current?.resync(); }}
    /> : <><section className="remote-controls">
      <div className="remote-mechs">{state?.mechs.map((mech) => <button key={mech.id} disabled={mech.hp <= 0 || journalBlocked || Boolean(pendingPlan) || Boolean(pendingDeployment) || busy || syncing || playing || connection !== "online"} className={selected === mech.id ? "selected" : ""} onClick={() => { setSelected(mech.id); setTargeting(null); }}>{names[mech.id]}<small> HP {mech.hp}</small></button>)}</div>
      <div className="remote-actions">
        {actions.map((action) => <button key={`${action.kind}:${"target" in action ? action.target : ""}`} disabled={!myTurn || busy} className={targeting === action.kind ? "selected" : ""} onClick={() => action.kind === "skip" || ("target" in action && action.target !== undefined) ? setAction(action) : setTargeting(action.kind)}>{action.kind}{"target" in action ? ` · ${action.target}` : ""}</button>)}
      </div>
      <button disabled={!myTurn || busy || !draft[selected].moveTo} onClick={() => { setDraft((current) => ({ ...current, [selected]: { ...current[selected], moveTo: null } })); setTargeting(null); setError(""); }}>{t("取消所选机甲移动", "Clear selected move")}</button>
      {projection && myTurn && <small role="status">{projection.movement.status === "unknown" ? t("移动预检未知，无法预判行动。", "Movement check unavailable; actions cannot be predicted.") : projection.movement.status === "rejected" ? `${t("移动草稿被拒绝，请调整", "Movement draft rejected; adjust it")}: ${projection.movement.fault.reason}` : projection.invalid.length > 0 ? `${t("移动后行动失效，请重新选择", "Actions invalid after movement; choose again")}: ${projection.invalid.map((id) => names[id]).join(", ")}` : projection.actionUnknown ? t("行动预检未知，无法提交。", "Action check unavailable; cannot submit.") : projection.plan.status === "unknown" ? t("整包预检未知，无法提交。", "Plan check unavailable; cannot submit.") : projection.plan.status === "rejected" ? `${t("整包预检被拒绝", "Plan check rejected")}: ${projection.plan.fault.reason}` : t("行动基于草稿移动后局面；实际结算仍可能落空。三维场景显示当前局面。", "Actions use projected positions; resolution may still fizzle. The 3D scene shows current positions.")}</small>}
      <button className="remote-submit" disabled={!state || !myTurn || planned !== ids.length || !canSubmit || busy || state.phase !== "player_plan" || Boolean(state.outcome)} onClick={submit}>{busy ? t("等待电脑结算…", "Resolving on host…") : t("提交整包并结束回合", "Submit squad plan")}</button>

    </section>
    <details className="remote-board"><summary>{t("二维棋盘与可访问控制", "2D accessible board")}</summary><div>{(draftState ?? state) && Array.from({ length: 10 }, (_, y) => <div className="remote-row" key={y}>{Array.from({ length: 10 }, (_, x) => {
      const board = draftState ?? state!;
      const mech = board.mechs.find((item) => item.hp > 0 && item.pos.x === x && item.pos.y === y);
      const raider = board.raiders.find((item) => item.hp > 0 && item.pos.x === x && item.pos.y === y);
      const boss = board.boss.hp > 0 && x >= board.boss.anchor.x && x <= board.boss.anchor.x + 1 && y >= board.boss.anchor.y && y <= board.boss.anchor.y + 1;
      return <button key={x} disabled={!myTurn || busy} onClick={() => clickCell({ x, y }, "board")} aria-label={`${x},${y}`}>{mech ? names[mech.id][0] : boss ? "B" : raider ? "E" : board.terrain[y]?.[x] === "water" ? "~" : "·"}</button>;
    })}</div>)}</div></details></>}
  </main>;
}
