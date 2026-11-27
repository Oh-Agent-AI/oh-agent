import { useCallback, useEffect, useState } from "react";
import { boundCodePreviewRequest, canStopCodePreview, clearCodePreviewId, isTerminalCodePreviewStatus, parseCodeBuilds, parseCodePreviewCreated, parseCodePreviewStatus, parseCodeStoryEvidence, rememberCodePreviewId, type CodeBuildRowV1, type CodePreviewStatusV1, type CodeStoryEvidenceV1 } from "../../codeGamePreview";
import { parseCityListPage, type LibraryCityRow } from "../library/cityGameLibraryModel";

type Request = <T>(method: string, payload: Record<string, unknown>) => Promise<T>;

export function CodeGamePreviewPanel(props: Readonly<{
  request: Request;
  browserPreview: boolean;
  requestedBuildId?: string;
  requestedSourceCityId?: string;
  onMessage: (message: string) => void;
}>) {
  const { request, browserPreview, requestedBuildId, requestedSourceCityId, onMessage } = props;
  const [builds, setBuilds] = useState<readonly CodeBuildRowV1[]>([]);
  const [buildId, setBuildId] = useState("");
  const [cities, setCities] = useState<readonly LibraryCityRow[]>([]);
  const [sourceCityId, setSourceCityId] = useState("");
  const [status, setStatus] = useState<CodePreviewStatusV1 | null>(null);
  const [evidence, setEvidence] = useState<CodeStoryEvidenceV1 | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const loadBuilds = useCallback(async () => {
    try {
      const rows = parseCodeBuilds(await request("creator.code.builds.list", { limit: 50 }));
      setBuilds(rows);
      setBuildId(current => rows.some(row => row.buildId === current) || current === requestedBuildId
        ? current : requestedBuildId ?? rows[0]?.buildId ?? "");
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "creator_code_builds_invalid"); }
  }, [request, requestedBuildId]);
  const loadCities = useCallback(async () => {
    try {
      const page = parseCityListPage(await request("creator.city.list", { limit: 50 }));
      setCities(page.cities);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "creator_city_list_unavailable"); }
  }, [request]);
  const refreshStatus = useCallback(async () => {
    // 身份隔离：只按本 workspace 绑定的 previewId 走宿主权威状态；未绑定时呈现
    // "未在运行"，绝不回退到最后写入者获胜的 legacy 全局投影。
    const bound = boundCodePreviewRequest(buildId);
    if (!bound) { setStatus(null); return; }
    try {
      const next = parseCodePreviewStatus(await request("creator.code.preview.status", bound));
      if (!next.available) { setStatus(null); return; }
      if (isTerminalCodePreviewStatus(next)) clearCodePreviewId(buildId);
      setStatus(next);
    } catch { setStatus(null); }
  }, [request, buildId]);
  useEffect(() => {
    void loadBuilds();
    void loadCities();
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 1_000);
    return () => window.clearInterval(timer);
  }, [loadBuilds, loadCities, refreshStatus]);
  useEffect(() => {
    if (requestedBuildId) setBuildId(requestedBuildId);
    setSourceCityId(requestedSourceCityId ?? "");
  }, [requestedBuildId, requestedSourceCityId]);
  useEffect(() => {
    const runId = status?.runId;
    const previewId = status?.previewId;
    if (!runId || !previewId || browserPreview) { setEvidence(null); return; }
    let active = true;
    const load = async () => {
      try {
        const next = parseCodeStoryEvidence(await request("creator.code.story", { previewId }));
        if (active) setEvidence(next);
      } catch { if (active) setEvidence(null); }
    };
    void load();
    const timer = window.setInterval(() => void load(), 1_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [browserPreview, request, status?.previewId, status?.runId]);

  const start = async () => {
    if (!buildId || !sourceCityId || busy || browserPreview) return;
    const sourceCity = cities.find(city => city.cityId === sourceCityId);
    if (sourceCityId !== "synthetic" && !sourceCity) {
      onMessage("源 City 版本不可用，请刷新后重新选择。");
      return;
    }
    setBusy(true);
    try {
      const created = parseCodePreviewCreated(await request("creator.code.preview", { buildId, seed: 7,
        ...(sourceCity ? { source: { cityId: sourceCity.cityId, cityRevision: sourceCity.revision } } : {}) }));
      if (created.buildId !== buildId) throw new Error("creator_code_preview_created_invalid");
      rememberCodePreviewId(buildId, created.previewId);
      onMessage("已请求独立 Preview 窗口；不会打开、替换或聚焦主 City。");
      await refreshStatus();
    } catch (cause) { onMessage(`无法启动独立预览（${cause instanceof Error ? cause.message : "creator_preview_failed"}）。`); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    // 停止与轮询共用同一绑定身份：不得使用 legacy 状态里"别人的" previewId。
    const bound = boundCodePreviewRequest(buildId);
    if (!status || !bound || !canStopCodePreview(status) || busy) return;
    setBusy(true);
    try {
      await request("creator.code.preview.stop", bound);
      clearCodePreviewId(buildId);
      onMessage("已请求停止当前 Preview。");
    } catch (cause) { onMessage(`无法停止 Preview（${cause instanceof Error ? cause.message : "game_run_not_found"}）。`); }
    finally { setBusy(false); }
  };
  const selected = builds.find(row => row.buildId === buildId);
  return <section className="composition code-preview-panel" aria-label="代码游戏预览">
    <div className="section-title">不可变代码构建</div>
    <p className="muted">BuildId 绑定 Bundle、Manifest 与资产。独立 Preview 使用冻结来源，不占用或替换主 City。</p>
    <label>选择构建<select aria-label="代码构建" value={buildId} disabled={busy || (!requestedBuildId && builds.length === 0)} onChange={event => setBuildId(event.target.value)}>
      {requestedBuildId && !builds.some(row => row.buildId === requestedBuildId) &&
        <option value={requestedBuildId}>所选已安装构建 · {requestedBuildId.slice(0, 12)}</option>}
      {builds.map(row => <option key={row.buildId} value={row.buildId}>{row.displayName ?? row.gameId} · {row.gameVersion ?? "未知版本"} · {row.buildId.slice(0, 12)}</option>)}
    </select></label>
    <label>Preview 世界来源<select aria-label="Preview 世界来源" value={sourceCityId} disabled={busy} onChange={event => setSourceCityId(event.target.value)}>
      <option value="">请显式选择来源</option>
      <option value="synthetic">合成 City Fixture（仅测试）</option>
      {cities.map(city => <option key={city.cityId} value={city.cityId}>{city.name} · 版本 {city.revision}</option>)}
    </select></label>
    {selected && <code>{selected.buildId} · {selected.byteLength ?? 0} bytes</code>}
    <div className="actions"><button className="secondary" disabled={busy} onClick={() => { void loadBuilds(); void loadCities(); }}>刷新构建与来源</button>
      <button disabled={busy || !buildId || !sourceCityId || browserPreview} onClick={() => void start()}>打开独立 Preview</button>
      {status && canStopCodePreview(status) && <button className="secondary" disabled={busy || browserPreview} onClick={() => void stop()}>停止 Preview</button>}</div>
    {browserPreview && <p className="muted">浏览器使用合成数据，不读取真实构建；请在桌面应用中预览。</p>}
    {builds.length === 0 && !error && <p className="muted">尚无代码构建。请先通过 Agent/MCP 完成 Build。</p>}
    {error && <p className="status" role="alert">{error}</p>}
    <div className="code-preview-status" role="status" aria-live="polite">
      <div className="section-title">真实运行状态</div>
      {!status?.available ? <p className="muted">尚无 Preview 运行记录。</p> : <>
        <code>{status.gameId ?? "未知游戏"} · {status.status}</code>
        <p className="muted">Preview {status.previewId ?? "未知"} · Build {status.buildId ?? "未知"} · Run {status.runId ?? "尚未分配"}</p>
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
