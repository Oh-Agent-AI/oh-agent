import { useEffect, useState } from "react";
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

export function RemoteMechaControls({ locale, site, shape, state, onActiveChange, onStopped }: {
  locale: "zh-Hans" | "en";
  site: CityMechaSite;
  shape: FightShape;
  state: MatchState;
  onActiveChange: (active: boolean) => void;
  onStopped: () => void;
}) {
  const [relay, setRelay] = useState(() => sessionStorage.getItem("agent-city-relay") ?? "");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [inviteLink, setInviteLink] = useState("");
  const [pending, setPending] = useState<Array<{ deviceId: string; playerId: string }>>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const zh = locale !== "en";
  const start = async () => {
    setBusy(true); setError("");
    try {
      const arena = remoteArenaFromSite(site, { arenaId: `city-${shape}`, sourceRevision: `${shape}-${state.revision}` });
      const result = await remoteRequest("mecha.remote.start", { relay, arena, state: remoteStateFromSite(site, state) });
      if (typeof result.remoteUrl !== "string" || typeof result.matchId !== "string") throw new Error("plugin_response_invalid");
      sessionStorage.setItem("agent-city-relay", relay);
      setLink(result.remoteUrl); onActiveChange(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "remote_unavailable"); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (!link) return;
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
  }, [link]);
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
    } catch (cause) { setError(cause instanceof Error ? cause.message : "remote_unavailable"); }
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
    setBusy(true); setError("");
    try {
      await remoteRequest("mecha.remote.stop", {});
      setLink(""); setInviteLink(""); setPending([]); setMessage("");
      onActiveChange(false); onStopped();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "remote_unavailable"); }
    finally { setBusy(false); }
  };
  return <details className="mecha-settings">
    <summary>{zh ? "手机远程战棋" : "Remote mecha tactics"}</summary>
    <p className="mecha-help">{zh ? "只分享当前战场的比赛快照。电脑必须保持运行、联网且不休眠；开启后桌面本地回合暂时锁定。" : "Shares only this battle snapshot. Keep the desktop running and awake. Local turns are locked while remote play is active."}</p>
    {link ? <div className="mecha-toolbar">
      <textarea aria-label={zh ? "手机远程链接" : "Remote link"} readOnly rows={3} value={link} onFocus={(event) => event.currentTarget.select()} />
      <button type="button" onClick={() => { void navigator.clipboard?.writeText(link).catch(() => setError("clipboard_unavailable")); }}>{zh ? "复制手机链接" : "Copy phone link"}</button>
      <button type="button" disabled={busy} onClick={stop}>{busy ? "…" : zh ? "停止远程" : "Stop remote"}</button>
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
    </div> : <div className="mecha-toolbar">
      <label>{zh ? "中继 HTTPS 地址" : "Relay HTTPS URL"}<input type="url" required value={relay} placeholder="https://your-worker.workers.dev" onChange={(event) => setRelay(event.target.value)} /></label>
      <button type="button" disabled={busy || !relay.startsWith("https://")} onClick={start}>{busy ? "…" : zh ? "开启并生成链接" : "Start and create link"}</button>
    </div>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
