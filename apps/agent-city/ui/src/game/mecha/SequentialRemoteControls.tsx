import { useState } from "react";
import type { DeployPlacement } from "./deployment";
import type { MatchState } from "./board";
import type { SequentialRecord } from "./sequentialTurn";
import { buildSequentialOpening } from "./sequentialOpening";
import { remoteRequest } from "./remoteRequest";
import type { SequentialSnapshot } from "./contracts/sequentialTransport";
import { parseSequentialSnapshotResult } from "./contracts/sequentialTransport";
import type { EnemyPolicy } from "./enemy/contracts";
import type { RemoteCityDisplay } from "../../remote/city/cityDisplayProjection";
import type { CityMechaSite } from "./citySite";
import { prepareRemoteCityDisplay } from "../../remote/city/trustedRemoteCityDisplay";

const DEFAULT_RELAY_URL = "https://relay.ohagent.ai";

/** Desktop handoff for the v1.5 command stream; it never routes the host back to classic. */
export function SequentialRemoteControls({ locale, evidence, cityScene, site, disabled, onActive, onRecovered, onClose }: {
  locale: "zh-Hans" | "en";
  evidence: { initial: MatchState; placements: DeployPlacement[]; records: SequentialRecord[]; enemyPolicy: EnemyPolicy } | null;
  cityScene: RemoteCityDisplay | null;
  site: CityMechaSite;
  disabled: boolean;
  onActive: (active: boolean) => void;
  onRecovered: (snapshot: SequentialSnapshot) => Promise<void>;
  onClose: () => void;
}) {
  const zh = locale !== "en";
  const [relay, setRelay] = useState(() => sessionStorage.getItem("agent-city-relay") ?? DEFAULT_RELAY_URL);
  const [link, setLink] = useState("");
  const [matchId, setMatchId] = useState("");
  const [status, setStatus] = useState<"idle" | "starting" | "active" | "stopping">("idle");
  const [error, setError] = useState("");
  const validRelay = (() => {
    try { const url = new URL(relay.trim()); return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password; }
    catch { return false; }
  })();
  const start = async () => {
    if (!evidence || !cityScene || evidence.enemyPolicy !== "baup" || disabled || !validRelay || status !== "idle") return;
    setStatus("starting"); setError(""); onActive(true);
    try {
      const opening = buildSequentialOpening(evidence, site);
      const { site: citySite, ...cityDisplay } = cityScene;
      const trustedCityDisplay = prepareRemoteCityDisplay(cityDisplay);
      const bootstrap = { ruleset: "mecha-v1.5", ...opening, citySite, projections: [{ id: "city-remote-display:v2", value: trustedCityDisplay }] };
      const result = await remoteRequest("remote.session.start", { capabilityId: "mecha:v4", relay: relay.trim(), bootstrap });
      if (typeof result.remoteUrl !== "string" || typeof result.sessionId !== "string") throw new Error("plugin_response_invalid");
      sessionStorage.setItem("agent-city-relay", relay.trim());
      setLink(result.remoteUrl); setMatchId(result.sessionId); setStatus("active");
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "remote_unavailable";
      const messages: Record<string, [string, string]> = {
        remote_city_too_large: ["城市场景快照超过 230 KiB，无法创建远程链接。", "The city snapshot exceeds 230 KiB, so a remote link cannot be created."],
        remote_match_too_large: ["对局和城市场景合计超过 256 KiB，无法创建远程链接。", "The match and city snapshot exceed 256 KiB, so a remote link cannot be created."],
        remote_match_invalid: ["远程对局或城市场景快照无效，请刷新场景后重试。", "The remote match or city snapshot is invalid. Refresh the scene and try again."],
      };
      setError(messages[code]?.[zh ? 0 : 1] ?? code);
      setStatus("idle"); onActive(false);
    }
  };
  const stop = async () => {
    if (status !== "active") return;
    setStatus("stopping");
    try {
      const result = await remoteRequest("remote.session.stop", { capabilityId: "mecha:v4", sessionId: matchId });
      const parsed = parseSequentialSnapshotResult({ ok: true, snapshot: result.snapshot });
      if (!parsed?.ok) throw new Error("remote_snapshot_unavailable");
      await onRecovered(parsed.snapshot);
      setLink(""); setMatchId(""); setStatus("idle"); onActive(false);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "remote_unavailable"); setStatus("active"); }
  };
  return <section className="mecha-remote-panel" aria-label={zh ? "远程控制" : "Remote control"}>
    <header className="mecha-remote-dialog-head"><strong>{zh ? "手机续玩（1.5）" : "Continue on phone (1.5)"}</strong><button type="button" onClick={onClose}>{zh ? "关闭" : "Close"}</button></header>
    <div className="mecha-remote-dialog-actions">
      <label>{zh ? "中继服务地址" : "Relay service URL"}<input type="url" value={relay} disabled={status !== "idle"} onChange={event => setRelay(event.currentTarget.value)} placeholder={DEFAULT_RELAY_URL} autoComplete="url" /></label>
      {status !== "active" ? <button type="button" disabled={!evidence || !cityScene || evidence.enemyPolicy !== "baup" || disabled || !validRelay || status !== "idle"} onClick={() => void start()}>{status === "starting" ? (zh ? "正在生成…" : "Creating…") : (zh ? "生成手机链接" : "Create phone link")}</button>
        : <><a href={link} target="_blank" rel="noreferrer">{zh ? "打开手机链接" : "Open phone link"}</a><button type="button" onClick={() => void stop()}>{zh ? "停止远程" : "Stop remote"}</button></>}
      {error && <p role="alert">{error}</p>}
      {evidence && evidence.enemyPolicy !== "baup" && <p role="status">{zh ? "当前对局的敌人策略暂不支持手机续玩。" : "This match's enemy policy does not yet support phone handoff."}</p>}
      <p className="mecha-v15-note">{zh ? "远程设备可查看本机城市、会话名称和用量，并操作本局机甲。中继通过加密传输转发数据，但未启用端到端加密。停止远程会关闭设备访问。" : "The remote device can view this city, session names and usage, and control this match. The relay uses encrypted transport, but end-to-end encryption is not enabled. Stopping remote access closes the device connection."}</p>
    </div>
  </section>;
}
