import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PluginRequestV1, PluginResponseV1 } from "@agent-vitals/app-sdk";
import { invokeHost } from "../../host";
import type { CityMechaSite, FightShape } from "./citySite";
import { remoteArenaFromSite, remoteStateFromSite } from "./contracts/arena";
import type { MatchState } from "./rules";

let sequence = 0;
async function remoteRequest(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const request: PluginRequestV1 = {
    version: 1,
    instanceId: window.__AV_PLUGIN_INSTANCE__ ?? "",
    requestId: `mecha-remote-${++sequence}`,
    method,
    payload,
  };
  const response = await invokeHost<PluginResponseV1<Record<string, unknown>>>("plugin_request", { request });
  if (response.version !== 1 || response.requestId !== request.requestId) throw new Error("plugin_response_invalid");
  if (!response.ok || !response.result) throw new Error(response.error?.code ?? "remote_unavailable");
  return response.result;
}

export type RemoteMechaStatus = "idle" | "starting" | "active" | "stopping" | "unknown";

export function RemoteMechaControls({ locale, site, shape, state, status, canStart, onStatusChange, onStopped, stopTarget, presentation = "disclosure" }: {
  locale: "zh-Hans" | "en";
  site: CityMechaSite;
  shape: FightShape;
  state: MatchState;
  status: RemoteMechaStatus;
  canStart: boolean;
  onStatusChange: (status: RemoteMechaStatus) => void;
  onStopped: () => void;
  stopTarget?: HTMLElement | null;
  presentation?: "disclosure" | "panel";
}) {
  const [relay, setRelay] = useState(() => sessionStorage.getItem("agent-city-relay") ?? "");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const operation = useRef(false);
  const stopButton = useRef<HTMLButtonElement | null>(null);
  const [inviteLink, setInviteLink] = useState("");
  const [pending, setPending] = useState<Array<{ deviceId: string; playerId: string }>>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const zh = locale !== "en";
  const start = async () => {
    if (operation.current || status !== "idle" || !canStart) return;
    operation.current = true;
    onStatusChange("starting");
    setBusy(true); setError("");
    try {
      const arena = remoteArenaFromSite(site, { arenaId: `city-${shape}`, sourceRevision: `${shape}-${state.revision}` });
      const method = "mecha.remote.start-v3";
      const result = await remoteRequest(method, { relay, arena, state: remoteStateFromSite(site, state) });
      if (typeof result.remoteUrl !== "string" || typeof result.matchId !== "string") throw new Error("plugin_response_invalid");
      sessionStorage.setItem("agent-city-relay", relay);
      setLink(result.remoteUrl); onStatusChange("active");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "remote_unavailable");
      // The host may have created a session even when its reply was lost.
      onStatusChange("unknown");
    } finally { operation.current = false; setBusy(false); }
  };
  useEffect(() => {
    if (!link || status !== "active") return;
    let alive = true;
    const refresh = async () => {
      try {
        const result = await remoteRequest("mecha.remote.pending", {});
        if (alive && Array.isArray(result.pending)) setPending(result.pending as Array<{ deviceId: string; playerId: string }>);
      } catch { /* the next poll retries transient host/reply failures */ }
    };
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [link, status]);
  const invite = async () => {
    setBusy(true); setError("");
    try {
      const result = await remoteRequest("mecha.remote.invite", {});
      if (typeof result.inviteUrl !== "string") throw new Error("plugin_response_invalid");
      setInviteLink(result.inviteUrl); setMessage(zh ? "邀请十分钟内有效，且只能登记一次。" : "The invitation expires in ten minutes and can be registered once.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "remote_unavailable"); }
    finally { setBusy(false); }
  };
  const approve = async (deviceId: string) => {
    setBusy(true); setError("");
    try {
      await remoteRequest("mecha.remote.approve", { deviceId });
      setPending((items) => items.filter((item) => item.deviceId !== deviceId));
      setMessage(zh ? "好友已加入 B 阵营，双方从新的对称战局开始。" : "Your friend joined side B. A new symmetric match has started.");
    } catch (cause) {
      setError(cause instanceof Error && cause.message === "remote_match_invalid" && state.phase === "deployment"
        ? (zh ? "好友未能加入：如果手机端仍在部署，请先确认部署后重试；否则请检查远程连接。" : "Could not add your friend. If remote deployment is still pending, confirm it before retrying; otherwise check the remote connection.")
        : cause instanceof Error ? cause.message : "remote_unavailable");
    }
    finally { setBusy(false); }
  };
  const revoke = async (deviceId: string) => {
    setBusy(true); setError("");
    try {
      await remoteRequest("mecha.remote.revoke", { deviceId });
      setPending((items) => items.filter((item) => item.deviceId !== deviceId));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "remote_unavailable"); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    if (operation.current || (status !== "active" && status !== "unknown")) return;
    operation.current = true;
    onStatusChange("stopping");
    setBusy(true); setError("");
    try {
      const result = await remoteRequest("mecha.remote.stop", {});
      if (result.ok !== true) throw new Error("plugin_response_invalid");
      setLink(""); setInviteLink(""); setPending([]); setMessage("");
      // The persistent stop button disappears on success; return keyboard focus
      // to a visible battle control rather than dropping it onto the document.
      if (document.activeElement === stopButton.current) {
        const overlay = stopButton.current?.closest(".mecha-overlay");
        const fallback = stopTarget
          ? overlay?.querySelector<HTMLElement>(".mecha-battle-controls button:not(:disabled)")
          : overlay?.querySelector<HTMLElement>(".mecha-city-gate .mecha-actions button:not(:disabled)");
        fallback?.focus();
      }
      onStopped(); onStatusChange("idle");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "remote_unavailable");
      onStatusChange("unknown");
    } finally { operation.current = false; setBusy(false); }
  };
  const persistentStop = status !== "idle" && status !== "starting" ? (
    <>
      <button ref={stopButton} type="button" className="mecha-remote-stop" aria-label={busy || status === "stopping" ? (zh ? "远程操作进行中" : "Remote operation in progress") : undefined} aria-disabled={busy || status === "stopping"} onClick={() => { if (!busy && status !== "stopping") void stop(); }}>{busy || status === "stopping" ? "…" : status === "unknown" || !link ? (zh ? "停止远程并恢复本地" : "Stop remote and restore local play") : (zh ? "停止远程" : "Stop remote")}</button>
      {error && status === "unknown" && <span role="alert">{error}</span>}
    </>
  ) : null;
  const controls = <>
    <p className="mecha-help">{zh ? "只分享当前战场的比赛快照。电脑必须保持运行、联网且不休眠；开启后桌面本地回合暂时锁定。" : "Shares only this battle snapshot. Keep the desktop running and awake. Local turns are locked while remote play is active."}</p>
    {state.phase === "deployment" && <p className="mecha-help">{zh ? "远程将从未部署状态开始，本地未确认的部署草稿不会同步。请在手机上重新部署并确认，确认前无法批准好友加入；停止远程会重开本地局。" : "Remote play starts without deployments; the unconfirmed local draft is not transferred. Place and confirm on the remote device before approving a friend. Stopping remote play restarts the local match."}</p>}
    {status === "unknown" && <p role="status">{zh ? "远程状态无法确认。本地保持锁定；请停止远程并重试，确认成功后才能继续。" : "Remote state is unknown. Local play remains locked; stop remote and retry until confirmed."}</p>}
    {link && status === "active" ? <div className="mecha-toolbar">
      <textarea aria-label={zh ? "手机远程链接" : "Remote link"} readOnly rows={3} value={link} onFocus={(event) => event.currentTarget.select()} />
      <button type="button" onClick={() => { void navigator.clipboard?.writeText(link).catch(() => setError("clipboard_unavailable")); }}>{zh ? "复制手机链接" : "Copy phone link"}</button>
      <button type="button" disabled={busy} onClick={invite}>{zh ? "邀请好友对战" : "Invite a friend"}</button>
      {message && <p className="mecha-help">{message}</p>}
      {inviteLink && <textarea aria-label={zh ? "好友邀请链接" : "Friend invitation link"} readOnly rows={3} value={inviteLink} onFocus={(event) => event.currentTarget.select()} />}
      {inviteLink && <button type="button" onClick={() => { void navigator.clipboard?.writeText(inviteLink).catch(() => setError("clipboard_unavailable")); }}>{zh ? "复制好友链接" : "Copy friend link"}</button>}
      {pending.map((device) => <div key={device.deviceId}>
        <span>{zh ? "好友请求加入" : "Friend requests access"}</span>
        <button type="button" disabled={busy} onClick={() => approve(device.deviceId)}>{zh ? "批准并开始 1v1" : "Approve and start 1v1"}</button>
        <button type="button" disabled={busy} onClick={() => revoke(device.deviceId)}>{zh ? "拒绝" : "Decline"}</button>
      </div>)}
      <p className="mecha-help">{zh ? "批准后 PvE 快照会切换为双方满编的新 PvP 战局；停止远程后桌面也会重开本地局。" : "Approval replaces the PvE snapshot with a fresh full-squad PvP match. Stopping remote play also restarts the local match."}</p>
    </div> : status === "unknown" || status === "stopping" || status === "active" ? null : <div className="mecha-toolbar">
      <label>{zh ? "中继 HTTPS 地址" : "Relay HTTPS URL"}<input type="url" required value={relay} placeholder="https://your-worker.workers.dev" onChange={(event) => setRelay(event.target.value)} /></label>
      <button type="button" disabled={busy || status !== "idle" || !canStart || !relay.startsWith("https://")} onClick={start}>{busy ? "…" : zh ? "开启并生成链接" : "Start and create link"}</button>
    </div>}
    {status === "idle" && !canStart && <p className="mecha-help">{zh ? "请先停止自动对战、结束演出并回到可规划的回合。" : "Stop auto play, finish animations, and return to a planning turn first."}</p>}
    {error && status !== "unknown" && <p role="alert">{error}</p>}
  </>;
  return <>
    {presentation === "panel" ? <div className="mecha-remote-settings">{controls}</div> : <details className="mecha-settings mecha-remote-settings" name="mecha-battle-options">
      <summary>{zh ? "手机远程战棋" : "Remote mecha tactics"}</summary>
      {controls}
    </details>}
    {stopTarget && persistentStop ? createPortal(persistentStop, stopTarget) : persistentStop}
  </>;
}
