import { useCallback, useEffect, useState } from "react";
import type { CreatorRequest } from "../../adapters/creatorHost";
import { errorCode } from "../../adapters/creatorHostUtils";
import type { PlaytestRun, ProjectRow } from "../../contracts/creatorStudio";
import { candidateEvidenceTrust, parseProjectCandidate, type ProjectCandidate } from "../../contracts/candidate";
import { parseCodeBuilds, type CodeBuildRowV1 } from "../../codeGamePreview";
import { parseCityDiagnostics, parseCodeTestRecord, parseGroundInspection, parsePlaytestHistory, traceSummary, type CityDiagnostic, type CodeTestRecordV1, type GroundInspection } from "./evidenceCenterModel";

/** PR06：无头 Code Game 测试记录的证据卡。执行成功（executionOk）与游戏结论
 * （verdict）分开呈现；逐断言结果与世界身份折叠展示，原始记录不展开。 */
const codeTestVerdictLabel = (record: CodeTestRecordV1): string =>
  record.verdict === "passed" ? "场景通过" : record.verdict === "failed" ? "场景未通过" : `不确定（${record.verdictReason ?? "无原因"}）`;

function CodeTestEvidence({ record }: Readonly<{ record: CodeTestRecordV1 }>) {
  return <div className="code-test-evidence">
    <p>无头测试：executionOk {String(record.executionOk)} · <strong>{codeTestVerdictLabel(record)}</strong></p>
    <p className="muted">源 revision {record.workspaceRevision ?? "未知"}{record.scenarioId ? ` · 场景 ${record.scenarioId}` : " · 未指定场景"}{record.cityId ? ` · City ${record.cityId} rev ${record.cityRevision ?? "未知"}` : " · 合成 fixture"}{record.snapshotDigest || record.worldSnapshotDigest ? ` · snapshot ${(record.worldSnapshotDigest ?? record.snapshotDigest ?? "").slice(0, 12)}…` : ""}</p>
    {record.assertions.length > 0 && <details><summary>逐断言结果（{record.assertions.length}）</summary><pre className="agent-proposal-content">{JSON.stringify(record.assertions, null, 2)}</pre></details>}
  </div>;
}

function RunEvidence({ run }: Readonly<{ run: PlaytestRun }>) {
  const trace = traceSummary(run.evidence);
  const evidence = run.evidence && typeof run.evidence === "object" && !Array.isArray(run.evidence) ? run.evidence as Record<string, unknown> : null;
  return <article className="evidence-run-card"><div className="evidence-run-heading"><strong>{run.runId}</strong><span>{run.status}</span></div>
    <code>Candidate/Release {run.releaseId} · project revision {run.revision}</code>
    <p>来源：{run.evidenceSource === "host-verified" ? "Host Trace 复算一致" : run.evidenceSource === "city-client-reported" ? "City 客户端回报" : "无证据来源"} · outcome {String(evidence?.outcome ?? "未回报")}</p>
    {trace && <p>Trace：{trace.count} 个输入事件 · tick {trace.firstTick ?? "未知"} → {trace.lastTick ?? "未知"}{trace.hostDisagreement ? " · Host 复算不一致（保留客户端原证据）" : ""}</p>}
    {run.failureCode && <p className="library-error">失败码：{run.failureCode}</p>}
    {run.evidence !== null && <details><summary>查看 Host 返回的证据</summary><pre className="agent-proposal-content">{JSON.stringify(run.evidence, null, 2)}</pre></details>}
  </article>;
}

export function EvidenceCenterPanel(props: Readonly<{
  request: CreatorRequest;
  browserPreview: boolean;
  activeCity: Readonly<{ cityId: string; revision: number }> | null;
  inspectGround: (input: { x: number; z: number; heading: number; regionId?: string }) => Promise<unknown>;
}>) {
  const { request, browserPreview, activeCity, inspectGround } = props;
  const [projects, setProjects] = useState<readonly ProjectRow[]>([]);
  const [projectId, setProjectId] = useState("");
  const [candidate, setCandidate] = useState<ProjectCandidate | null>(null);
  const [runs, setRuns] = useState<readonly PlaytestRun[]>([]);
  const [diagnostics, setDiagnostics] = useState<readonly CityDiagnostic[]>([]);
  const [builds, setBuilds] = useState<readonly CodeBuildRowV1[]>([]);
  const [testRecords, setTestRecords] = useState<Readonly<Record<string, CodeTestRecordV1>>>({});
  const [loading, setLoading] = useState(!browserPreview);
  const [error, setError] = useState("");
  const [groundBusy, setGroundBusy] = useState(false);
  const [ground, setGround] = useState<GroundInspection | null>(null);
  const [pose, setPose] = useState({ x: "0", z: "0", heading: "0", regionId: "" });

  const loadProjects = useCallback(async () => {
    if (browserPreview) return;
    setLoading(true); setError("");
    try {
      const result = await request<{ projects: ProjectRow[] }>("creator.project.list", { limit: 50 });
      setProjects(result.projects);
      setProjectId(current => result.projects.some(row => row.projectId === current) ? current : result.projects[0]?.projectId ?? "");
      const buildRows = parseCodeBuilds(await request("creator.code.builds.list", { limit: 50 }));
      setBuilds(buildRows);
      // PR06：有界回读无头测试记录（每 build 一条）。桌面宿主的 creator.* 路由
      // 尚未接入 creator_code_test_record 时逐条降级为缺席，不阻塞证据视图。
      const settled = await Promise.allSettled(buildRows.slice(0, 8).map(build => request("creator.code.test.record", { buildId: build.buildId })));
      const records: Record<string, CodeTestRecordV1> = {};
      for (const outcome of settled) {
        if (outcome.status === "fulfilled") {
          try { const record = parseCodeTestRecord(outcome.value); records[record.buildId] = record; } catch { /* 坏记录不阻塞 */ }
        }
      }
      setTestRecords(records);
    } catch (cause) { setError(errorCode(cause, "creator_evidence_unavailable")); }
    finally { setLoading(false); }
  }, [browserPreview, request]);
  const loadEvidence = useCallback(async () => {
    if (!projectId || browserPreview) { setCandidate(null); setRuns([]); setDiagnostics([]); return; }
    setLoading(true); setError("");
    try {
      const [candidateValue, history, project] = await Promise.all([
        request("creator.project.candidate.read", { projectId }),
        request("creator.project.playtest.history", { projectId, limit: 32 }),
        request<Record<string, unknown>>("creator.project.read", { projectId }),
      ]);
      setCandidate(parseProjectCandidate(candidateValue)); setRuns(parsePlaytestHistory(history));
      const cityId = typeof project.cityId === "string" ? project.cityId : null;
      setDiagnostics(cityId ? parseCityDiagnostics(await request("creator.city.diagnostic.list", { cityId, limit: 50 })) : []);
    } catch (cause) { setError(errorCode(cause, "creator_evidence_unavailable")); }
    finally { setLoading(false); }
  }, [browserPreview, projectId, request]);
  useEffect(() => { void loadProjects(); }, [loadProjects]);
  useEffect(() => { void loadEvidence(); }, [loadEvidence]);
  const refresh = () => { void loadProjects().then(loadEvidence); };
  const runGroundInspection = async () => {
    if (!activeCity || browserPreview) return;
    const x = Number(pose.x); const z = Number(pose.z); const heading = Number(pose.heading);
    if (![x,z,heading].every(Number.isFinite)) { setError("ground_pose_invalid"); return; }
    setGroundBusy(true); setError("");
    try { setGround(parseGroundInspection(await inspectGround({ x, z, heading, ...(pose.regionId ? { regionId: pose.regionId } : {}) }))); }
    catch (cause) { setGround(null); setError(errorCode(cause, "ground_inspection_unavailable")); }
    finally { setGroundBusy(false); }
  };

  return <div className="evidence-center">
    <div className="home-section-heading"><div><span className="section-title">统一证据视图</span><p className="muted">所有行来自 Host 现有 Candidate、Build、Run、Trace 与 City 诊断；不创建第二份证据账本。</p></div><button className="secondary" disabled={loading || browserPreview} onClick={refresh}>刷新证据</button></div>
    <label>Creator Project<select aria-label="证据项目" value={projectId} disabled={loading || projects.length === 0} onChange={event => setProjectId(event.target.value)}><option value="">选择项目</option>{projects.map(project => <option key={project.projectId} value={project.projectId}>{project.title} · revision {project.revision}</option>)}</select></label>
    {error && <p className="library-error" role="alert">{error}</p>}
    <div className="evidence-grid">
      <section className="evidence-section"><span className="section-title">Candidate / Run / Trace</span>
        {candidate ? <><p><strong>{candidate.candidateId}</strong> · {candidate.status} · revision {candidate.revision}</p><p className="muted">{candidateEvidenceTrust(candidate)}</p></> : <p className="muted">当前项目没有 Candidate。</p>}
        {runs.length === 0 ? <p className="muted">当前项目没有试玩 Run。</p> : runs.map(run => <RunEvidence key={run.runId} run={run} />)}
      </section>
      <section className="evidence-section"><span className="section-title">不可变 Code Build</span><p className="muted">Build 是全局不可变产物；没有项目绑定时不推断其归属。</p>
        {builds.length === 0 ? <p className="muted">尚无 Code Build。</p> : builds.map(build => <article key={build.buildId}><code>{build.buildId}</code><p>{build.gameId} · {build.gameVersion ?? "未知版本"} · {build.byteLength ?? "未知"} bytes</p>{testRecords[build.buildId] && <CodeTestEvidence record={testRecords[build.buildId]} />}</article>)}
      </section>
      <section className="evidence-section"><span className="section-title">City 生命周期诊断</span><p className="muted">这些是持久化、脱敏的 Host 事件，不是物理接地证明。</p>
        {diagnostics.length === 0 ? <p className="muted">当前项目未绑定 City，或该 City 没有诊断事件。</p> : diagnostics.map((item, index) => <article key={`${item.correlationId}:${item.atMs}:${index}`}><code>{item.event}{item.code ? ` · ${item.code}` : ""}</code><p>City revision {item.revision} · {item.correlationId} · {item.elapsedMs === null ? "未知耗时" : `${item.elapsedMs} ms`}</p></article>)}
      </section>
      <section className="evidence-section ground-debug-section"><span className="section-title">Ground Debug · 真实四轮支撑</span>
        <p className="muted">从当前渲染 City 的 Surface 编译结果查询整车覆盖、四轮接触高度、俯仰与滚转；不使用固定高度代替地形。</p>
        {!activeCity ? <p className="muted">先在项目工作区打开一个只读 City 草稿，才能查询其实际地形。</p> : <p><code>{activeCity.cityId} · revision {activeCity.revision}</code></p>}
        <div className="ground-pose-grid"><label>X<input aria-label="Ground X" value={pose.x} onChange={event => setPose({ ...pose, x: event.target.value })} /></label><label>Z<input aria-label="Ground Z" value={pose.z} onChange={event => setPose({ ...pose, z: event.target.value })} /></label><label>Heading（弧度）<input aria-label="Ground Heading" value={pose.heading} onChange={event => setPose({ ...pose, heading: event.target.value })} /></label><label>Region ID（可选）<input aria-label="Ground Region" value={pose.regionId} onChange={event => setPose({ ...pose, regionId: event.target.value })} /></label></div>
        <div className="actions"><button disabled={!activeCity || groundBusy || browserPreview} onClick={() => void runGroundInspection()}>查询真实接地</button></div>
        {ground && <div className="ground-result" role="status"><strong>{ground.status === "ready" ? "四轮支撑已解析" : `无法形成合法支撑：${ground.code ?? "未知"}`}</strong><code>{ground.regionId ?? "未选择 Region"} · {ground.worldRevision ?? "未知世界版本"}</code>{ground.reason && <p>{ground.reason}</p>}{ground.status === "ready" && <><p>中心高度 {ground.y?.toFixed(4)} · pitch {((ground.pitch ?? 0) * 180 / Math.PI).toFixed(2)}° · roll {((ground.roll ?? 0) * 180 / Math.PI).toFixed(2)}°</p><div className="ground-wheel-grid">{["前轮左","前轮右","后轮左","后轮右"].map((label, index) => <span key={label}>{label}<code>{ground.wheels[index].toFixed(4)} m</code></span>)}</div></>}</div>}
      </section>
    </div>
  </div>;
}
