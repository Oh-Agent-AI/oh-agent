import { useState } from "react";
import type { DeployPlacement } from "./deployment";
import type { MatchState } from "./board";
import type { SequentialRecord } from "./sequentialTurn";
import { buildSequentialOpening } from "./sequentialOpening";
import { remoteRequest } from "./remoteRequest";
import type { SequentialSnapshot } from "./contracts/sequentialTransport";
import { parseSequentialSnapshotResult } from "./contracts/sequentialTransport";
import type { EnemyPolicy } from "./enemy/contracts";

/** Desktop handoff for the v1.5 command stream; it never routes the host back to classic. */
export function SequentialRemoteControls({ locale, evidence, disabled, onActive, onRecovered, onClose }: {
  locale: "zh-Hans" | "en";
  evidence: { initial: MatchState; placements: DeployPlacement[]; records: SequentialRecord[]; enemyPolicy: EnemyPolicy } | null;
  disabled: boolean;
  onActive: (active: boolean) => void;
  onRecovered: (snapshot: SequentialSnapshot) => Promise<void>;
  onClose: () => void;
}) {
  const zh = locale !== "en";
  const [relay] = useState(() => sessionStorage.getItem("agent-city-relay") ?? "");
  const [link, setLink] = useState("");
  const [status, setStatus] = useState<"idle" | "starting" | "active" | "stopping">("idle");
  const [error, setError] = useState("");
  const start = async () => {
    if (!evidence || evidence.enemyPolicy !== "baup" || disabled || status !== "idle") return;
    setStatus("starting"); setError(""); onActive(true);
    try {
      const opening = buildSequentialOpening(evidence);
      const result = await remoteRequest("mecha.remote.start-sequential", { relay, opening });
      if (typeof result.remoteUrl !== "string" || typeof result.matchId !== "string") throw new Error("plugin_response_invalid");
      sessionStorage.setItem("agent-city-relay", relay);
      setLink(result.remoteUrl); setStatus("active");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "remote_unavailable");
      setStatus("idle"); onActive(false);
    }
  };
  const stop = async () => {
    if (status !== "active") return;
    setStatus("stopping");
    try {
      const result = await remoteRequest("mecha.remote.stop", {});
      const parsed = parseSequentialSnapshotResult({ ok: true, snapshot: result.snapshot });
      if (!parsed?.ok) throw new Error("remote_snapshot_unavailable");
      await onRecovered(parsed.snapshot);
      setLink(""); setStatus("idle"); onActive(false);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "remote_unavailable"); setStatus("active"); }
  };
  return <section className="mecha-remote-panel" aria-label={zh ? "远程控制" : "Remote control"}>
    <header className="mecha-remote-dialog-head"><strong>{zh ? "手机续玩（1.5）" : "Continue on phone (1.5)"}</strong><button type="button" onClick={onClose}>{zh ? "关闭" : "Close"}</button></header>
    <div className="mecha-remote-dialog-actions">
      {status !== "active" ? <button type="button" disabled={!evidence || evidence.enemyPolicy !== "baup" || disabled || status !== "idle"} onClick={() => void start()}>{status === "starting" ? (zh ? "正在生成…" : "Creating…") : (zh ? "生成手机链接" : "Create phone link")}</button>
        : <><a href={link} target="_blank" rel="noreferrer">{zh ? "打开手机链接" : "Open phone link"}</a><button type="button" onClick={() => void stop()}>{zh ? "停止远程" : "Stop remote"}</button></>}
      {error && <p role="alert">{error}</p>}
      {evidence && evidence.enemyPolicy !== "baup" && <p role="status">{zh ? "当前对局的敌人策略暂不支持手机续玩。" : "This match's enemy policy does not yet support phone handoff."}</p>}
      <p className="mecha-v15-note">{zh ? "交接后桌面端不会自动同步手机上的操作；停止远程前请先确认。" : "Desktop does not auto-sync phone moves; confirm before stopping remote."}</p>
    </div>
  </section>;
}
