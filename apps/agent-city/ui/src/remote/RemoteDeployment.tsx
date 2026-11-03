import { useEffect, useRef, useState, type RefObject } from "react";
import { RemoteMatchClient } from "../game/mecha/client/RemoteMatchClient";
import { canonicalJson, MECHA_NET_PROTOCOL, type MatchSnapshot, type SubmitDeploymentCommand } from "../game/mecha/contracts/match";
import { deployableCells, deployFaultText, validateDeployPlan } from "../game/mecha/deployment";
import { MECH_IDS, type Cell, type MatchState, type MechId } from "../game/mecha/rules";
import type { RemoteBattleState } from "../game/mecha/presentation/BattleScenePort";
import type { RemoteBattleScene } from "../game/mecha/presentation/RemoteBattleScene";
import { emptyDeploymentDraft, placeRemoteDeployment, undoRemoteDeployment } from "./deploymentDraft";

const zhNames: Record<MechId, string> = { Assault: "突击", Gunner: "射手", Support: "支援" };
const enNames: Record<MechId, string> = { Assault: "Assault", Gunner: "Gunner", Support: "Support" };

type PendingDeployment = { command: SubmitDeploymentCommand; baseline: string; uncertain: boolean; changed: boolean };

type Props = {
  snapshot: MatchSnapshot<RemoteBattleState>;
  state: MatchState;
  playerId: string;
  client: RemoteMatchClient<RemoteBattleState>;
  interactive: boolean;
  canInteract: () => boolean;
  locale: "zh" | "en";
  cellRef: RefObject<(cell: Cell) => void>;
  sceneRef: RefObject<RemoteBattleScene | null>;
  accept: (snapshot: MatchSnapshot<RemoteBattleState>) => void;
  resync: () => void;
  guarded?: boolean;
  onPendingStart?: (command: SubmitDeploymentCommand) => boolean;
  onPendingEnd?: (command: SubmitDeploymentCommand) => void;
};

/** Only the complete packet is sent; the tentative placements never enter the snapshot. */
export function RemoteDeployment({ snapshot, state, playerId, client, interactive, canInteract, locale, cellRef, sceneRef, accept, resync, guarded = false, onPendingStart, onPendingEnd }: Props) {
  const [draft, setDraft] = useState(emptyDeploymentDraft);
  const [selected, setSelected] = useState<MechId>("Assault");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingDeployment | null>(null);
  const sending = useRef(false);
  const pendingRef = useRef<PendingDeployment | null>(null);
  const stateVersion = useRef(canonicalJson(state));
  const t = (zh: string, en: string) => locale === "zh" ? zh : en;
  const names = locale === "zh" ? zhNames : enNames;
  const isOwner = snapshot.players.some(p => p.playerId === playerId && p.role === "host" && p.side === "A");
  const enabled = interactive && isOwner && !busy && !pending && !guarded;
  const cells = deployableCells(state);
  const allowed = new Set(cells.map(c => `${c.x},${c.y}`));
  const plan = { revision: state.revision, placements: draft.placements };
  const validation = validateDeployPlan(state, plan);
  const canConfirm = validation.ok;
  const pendingChanged = Boolean(pending && (pending.changed || pendingRef.current?.changed || pending.baseline !== canonicalJson(state)));

  useEffect(() => {
    const next = canonicalJson(state);
    if (next === stateVersion.current) return;
    stateVersion.current = next;
    const entry = pendingRef.current;
    if (!entry) setDraft(emptyDeploymentDraft());
    else if (entry.baseline !== next) {
      // A later rollback cannot prove that the earlier request was cancelled.
      entry.changed = true;
      setPending(previous => previous ? { ...previous, changed: true } : previous);
    }
    setError(locale === "zh" ? "战场状态已更新，请检查部署。" : "The battlefield changed; check your deployment.");
  }, [state, locale]);

  useEffect(() => {
    sceneRef.current?.setDeploymentPreview(state, draft.placements);
    return () => sceneRef.current?.setDeploymentPreview(null);
  }, [sceneRef, state, draft]);

  const place = (cell: Cell) => {
    if (!enabled || !canInteract()) return;
    const result = placeRemoteDeployment(state, draft, selected, cell);
    setDraft(result.draft);
    setError(result.fault ? deployFaultText(result.fault, locale === "en") : "");
  };
  cellRef.current = place;

  const submit = async () => {
    if (!interactive || !canInteract() || !isOwner || sending.current || (!pending && (guarded || !canConfirm))) return;
    // A same-revision correction does not prove an earlier request is cancelled.
    if (pending && (pending.changed || pendingRef.current?.changed || pending.baseline !== canonicalJson(state))) return;
    const entry = pending ?? {
      command: {
        type: "deployment.submit", protocol: MECHA_NET_PROTOCOL, matchId: snapshot.matchId, playerId,
        commandId: crypto.randomUUID(), baseRevision: state.revision,
        plan: structuredClone(plan),
      } satisfies SubmitDeploymentCommand,
      baseline: canonicalJson(state),
      uncertain: false,
      changed: false,
    };
    if (!pending && onPendingStart && !onPendingStart(entry.command)) {
      setError(t("无法保存待确认保护，请检查浏览器存储。", "Unable to save pending-request protection; check browser storage."));
      return;
    }
    sending.current = true;
    setBusy(true);
    pendingRef.current = entry;
    setPending(entry);
    setError("");
    try {
      const result = await client.submitDeployment(entry.command);
      if (pendingRef.current !== entry) return;
      if (result.ok) {
        accept(result.value);
      } else if (entry.uncertain || ["host_offline", "unavailable", "invalid_message", "duplicate_command"].includes(result.error.code)) {
        // A rejected retry cannot cancel the earlier request still in flight.
        entry.uncertain = true;
        setPending({ ...entry });
        setError(t("确认结果未知，先同步；如战场未变，可重试同一请求。", "Confirmation is uncertain. Sync first; retry only if the battlefield is unchanged."));
        resync();
      } else {
        pendingRef.current = null;
        onPendingEnd?.(entry.command);
        setPending(null);
        setError(result.error.code === "invalid_deployment" && result.error.fault
          ? deployFaultText(result.error.fault, locale === "en") : result.error.code);
        if (result.error.code === "stale_revision" || result.error.code === "match_finished") resync();
      }
    } catch {
      if (pendingRef.current !== entry) return;
      entry.uncertain = true;
      setPending({ ...entry });
      setError(t("确认结果未知，先同步；如战场未变，可重试同一请求。", "Confirmation is uncertain. Sync first; retry only if the battlefield is unchanged."));
      resync();
    } finally { sending.current = false; setBusy(false); }
  };

  return <section className="remote-controls remote-deployment" aria-label={t("开局部署", "Deployment")}>
    <h2>{t("开局部署", "Deployment")}</h2>
    <p role="status">{t("已部署", "Placed")} {draft.placements.length}/3 · {t("选择机甲，再点击绿色格子。已放置机甲可交换位置。", "Select a mech, then a green cell. Placed mechs can swap positions.")}</p>
    <p className="remote-deployment-note">{t("这是本设备的未确认草稿，刷新页面或切换设备不会保留。确认后才生成敌方意图。", "This unconfirmed draft is local to this device and is lost on reload or device change. Enemy intent appears after confirmation.")}</p>
    {!isOwner && <p role="status">{t("只有房主可以部署。", "Only the host can deploy.")}</p>}
    {!validation.ok && validation.fault.code === "insufficient_space" && <p className="remote-error" role="alert">{deployFaultText(validation.fault, locale === "en")}</p>}
    <div className="remote-mechs">{MECH_IDS.map(id => {
      const placement = draft.placements.find(p => p.mechId === id);
      return <button key={id} className={selected === id ? "selected" : ""} aria-pressed={selected === id} disabled={!enabled} onClick={() => setSelected(id)}>{names[id]}<small>{placement ? `${t("已放置", "Placed")} · ${placement.pos.x}, ${placement.pos.y}` : t("未放置", "Not placed")}</small></button>;
    })}</div>
    {error && <p className="remote-error" role="alert">{error}</p>}
    {guarded && !pending && <p role="status">{t("先前的部署请求尚未确认；请等待局面更新，或请房主停止远程并重新开局。", "A previous deployment is unconfirmed. Wait for an update, or ask the host to stop and restart the match.")}</p>}
    {pending && <p role="status">{t("等待确认结果时草稿已锁定；重试会复用相同命令，不会重复部署。", "Draft locked while confirmation is uncertain; retries reuse the same command.")}</p>}
    {pendingChanged && <p role="alert">{t("同版本战场已变化，无法安全重试。请等待局面更新，或请房主停止远程并重新开局。", "The battlefield changed without a new revision; retry is unsafe. Wait for an update, or ask the host to stop and restart the match.")}</p>}
    <div className="remote-deployment-actions">
      <button disabled={!enabled || !draft.history.length} onClick={() => { setDraft(undoRemoteDeployment(draft)); setError(""); }}>{t("撤销", "Undo")}</button>
      <button disabled={!enabled || !draft.placements.length} onClick={() => { setDraft(emptyDeploymentDraft()); setError(""); }}>{t("重置", "Reset")}</button>
      <button className="remote-submit" disabled={!interactive || !isOwner || busy || pendingChanged || (!pending && (guarded || !canConfirm))} onClick={submit}>{busy ? t("正在确认…", "Confirming…") : pending ? t("重试确认", "Retry confirmation") : t("确认部署", "Confirm deployment")}</button>
    </div>
    <details className="remote-board" open><summary>{t("部署棋盘与可访问控制", "Deployment board and accessible controls")}</summary><div>{Array.from({ length: 10 }, (_, y) => <div className="remote-row" key={y}>{Array.from({ length: 10 }, (_, x) => {
      const cell = { x, y };
      const placement = draft.placements.find(p => p.pos.x === x && p.pos.y === y);
      const isAllowed = allowed.has(`${x},${y}`);
      const enemy = state.raiders.some(r => r.hp > 0 && r.pos.x === x && r.pos.y === y) || (state.boss.hp > 0 && x >= state.boss.anchor.x && x <= state.boss.anchor.x + 1 && y >= state.boss.anchor.y && y <= state.boss.anchor.y + 1);
      return <button key={x} className={isAllowed ? "deployable" : ""} disabled={!enabled} onClick={() => place(cell)} aria-label={`${x}, ${y} · ${placement ? names[placement.mechId] : isAllowed ? t("可部署", "deployable") : t("不可部署", "unavailable")}`}>{placement ? names[placement.mechId][0] : enemy ? "E" : state.terrain[y]?.[x] === "water" ? "~" : "·"}</button>;
    })}</div>)}</div></details>
  </section>;
}
