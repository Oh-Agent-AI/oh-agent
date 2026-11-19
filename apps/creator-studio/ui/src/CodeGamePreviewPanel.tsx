import { useCallback, useEffect, useState } from "react";
import { canStopCodePreview, parseCodeBuilds, parseCodePreviewStatus, parseCodeStoryEvidence, type CodeBuildRowV1, type CodePreviewStatusV1, type CodeStoryEvidenceV1 } from "./codeGamePreview";

type Request = <T>(method: string, payload: Record<string, unknown>) => Promise<T>;

export function CodeGamePreviewPanel(props: Readonly<{
  request: Request;
  browserPreview: boolean;
  onMessage: (message: string) => void;
}>) {
  const { request, browserPreview, onMessage } = props;
  const [builds, setBuilds] = useState<readonly CodeBuildRowV1[]>([]);
  const [buildId, setBuildId] = useState("");
  const [status, setStatus] = useState<CodePreviewStatusV1 | null>(null);
  const [evidence, setEvidence] = useState<CodeStoryEvidenceV1 | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const loadBuilds = useCallback(async () => {
    try {
      const rows = parseCodeBuilds(await request("creator.code.builds.list", { limit: 50 }));
      setBuilds(rows);
      setBuildId(current => rows.some(row => row.buildId === current) ? current : rows[0]?.buildId ?? "");
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "creator_code_builds_invalid"); }
  }, [request]);
  const refreshStatus = useCallback(async () => {
    try { setStatus(parseCodePreviewStatus(await request("creator.code.preview.status", {}))); }
    catch { setStatus(null); }
  }, [request]);
  useEffect(() => {
    void loadBuilds();
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 1_000);
    return () => window.clearInterval(timer);
  }, [loadBuilds, refreshStatus]);
  useEffect(() => {
    const runId = status?.runId;
    if (!runId || browserPreview) { setEvidence(null); return; }
    let active = true;
    const load = async () => {
      try {
        const next = parseCodeStoryEvidence(await request("creator.code.story", {}));
        if (active) setEvidence(next);
      } catch { if (active) setEvidence(null); }
    };
    void load();
    const timer = window.setInterval(() => void load(), 1_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [browserPreview, request, status?.runId]);

  const start = async () => {
    if (!buildId || busy || browserPreview) return;
    setBusy(true);
    try {
      await request("creator.code.preview", { buildId, seed: 7 });
      onMessage("已请求在真实 City 中预览；窗口会自动打开。");
      await refreshStatus();
    } catch (cause) { onMessage(`无法启动代码预览（${cause instanceof Error ? cause.message : "creator_preview_failed"}）。`); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    if (!status || !canStopCodePreview(status) || busy) return;
    setBusy(true);
    try {
      await request("creator.code.preview.stop", { buildId: status.buildId!, runId: status.runId! });
      onMessage("已请求停止当前 Preview。");
    } catch (cause) { onMessage(`无法停止 Preview（${cause instanceof Error ? cause.message : "game_run_not_found"}）。`); }
    finally { setBusy(false); }
  };
  const selected = builds.find(row => row.buildId === buildId);
  return <section className="composition code-preview-panel" aria-label="代码游戏预览">
    <div className="section-title">不可变代码构建</div>
    <p className="muted">BuildId 绑定 Bundle、Manifest 与资产。Preview 在真实 City 中运行，不改变项目草稿。</p>
    <label>选择构建<select aria-label="代码构建" value={buildId} disabled={busy || builds.length === 0} onChange={event => setBuildId(event.target.value)}>
      {builds.map(row => <option key={row.buildId} value={row.buildId}>{row.gameId} · {row.gameVersion ?? "未知版本"} · {row.buildId.slice(0, 12)}</option>)}
    </select></label>
    {selected && <code>{selected.buildId} · {selected.byteLength ?? 0} bytes</code>}
    <div className="actions"><button className="secondary" disabled={busy} onClick={() => void loadBuilds()}>刷新构建</button>
      <button disabled={busy || !buildId || browserPreview} onClick={() => void start()}>在 City 中预览</button>
      {status && canStopCodePreview(status) && <button className="secondary" disabled={busy || browserPreview} onClick={() => void stop()}>停止 Preview</button>}</div>
    {browserPreview && <p className="muted">浏览器使用合成数据，不读取真实构建；请在桌面应用中预览。</p>}
    {builds.length === 0 && !error && <p className="muted">尚无代码构建。请先通过 Agent/MCP 完成 Build。</p>}
    {error && <p className="status" role="alert">{error}</p>}
    <div className="code-preview-status" role="status" aria-live="polite">
      <div className="section-title">真实运行状态</div>
      {!status?.available ? <p className="muted">尚无 Preview 运行记录。</p> : <>
        <code>{status.gameId ?? "未知游戏"} · {status.status}</code>
        <p className="muted">Build {status.buildId ?? "未知"} · Run {status.runId ?? "尚未分配"}</p>
        <p className="muted">tick {status.tick ?? 0} · entities {status.entities ?? 0} · outcome {status.outcome ?? "pending"}</p>
        {status.reason && <p className="muted">{status.reason}</p>}
      </>}
    </div>
    {evidence?.available && <div className="code-story-evidence" role="group" aria-label="Story 与 Dialogue 证据">
      <div className="section-title">Story / Dialogue 证据</div>
      <p className="muted">Story revision {evidence.storyRevision ?? "未知"} · 好感度 {evidence.affection ?? "未设置"}</p>
      {evidence.rules.map(rule => <code key={rule.ruleId}>{rule.ruleId} · {rule.status}{rule.nextDueUtcMs === null ? "" : ` · ${new Date(rule.nextDueUtcMs).toLocaleString()}`}</code>)}
      {evidence.dialogue.map(entry => <p key={entry.eventId} className="code-dialogue-entry">{entry.text}</p>)}
      {!evidence.rules.length && !evidence.dialogue.length && evidence.affection === null && <p className="muted">当前游戏尚未产生 Story 或已提交的对白证据。</p>}
    </div>}
  </section>;
}
