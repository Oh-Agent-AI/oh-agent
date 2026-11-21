import { canAcceptCandidate, candidateEvidenceTrust, type ProjectCandidate } from "../../contracts/candidate";

const statusLabel = (candidate: ProjectCandidate): string => ({
  created: "已创建，待真实试玩", testing: "真实试玩进行中", tested: "已有完成证据，待人工接受",
  "test-failed": "试玩未完成，可重试", accepted: "已接受为正式 Release", unknown: "状态未知",
}[candidate.status]);

export function CandidatePanel(props: Readonly<{
  candidate: ProjectCandidate | null;
  busy: boolean;
  browserPreview: boolean;
  hasUncommittedProjectEdits: boolean;
  hasMounts: boolean;
  publishedReleaseId: string | null;
  onCreate: () => void;
  onTest: () => void;
  onAccept: () => void;
  onPlaytestRelease: () => void;
  onDirectPublish: () => void;
}>) {
  const { candidate, busy, browserPreview, hasUncommittedProjectEdits, hasMounts, publishedReleaseId, onCreate, onTest, onAccept, onPlaytestRelease, onDirectPublish } = props;
  const unavailable = busy || hasUncommittedProjectEdits || !hasMounts;
  return <section className="candidate-panel" aria-label="Candidate 测试与发布">
    <div className="section-title">先测试 Candidate，再人工发布</div>
    <p className="muted">Candidate 绑定当前已保存 projectId + revision + contentDigest，不是 Release，也不会把 publication 变成 published。构建和校验通过不等于真实可玩。</p>
    {!candidate ? <>
      <p className="muted">当前没有 Candidate。请先保存全部修改，再创建不可变测试快照。</p>
      <div className="actions"><button disabled={unavailable || browserPreview} onClick={onCreate}>创建 Candidate</button></div>
    </> : <>
      <div className="candidate-facts"><strong>{statusLabel(candidate)}</strong><code>revision {candidate.revision} · {candidate.contentDigest.slice(0, 19)}…</code></div>
      <div className="actions">
        <button className="secondary" disabled={unavailable || browserPreview || candidate.status === "testing" || candidate.status === "accepted" || candidate.status === "unknown"} onClick={onTest}>{candidate.status === "testing" ? "试玩进行中" : candidate.status === "tested" ? "重新试玩 Candidate" : "试玩 Candidate"}</button>
        <button disabled={busy || hasUncommittedProjectEdits || !canAcceptCandidate(candidate)} onClick={onAccept}>接受并发布 Release</button>
      </div>
      <p className="muted">运行证据：{candidateEvidenceTrust(candidate)}。{candidate.latestRun ? `Run ${candidate.latestRun.runId} · ${candidate.latestRun.status}` : "尚未启动 Run"}</p>
      {candidate.latestRun?.failureCode && <p className="library-error" role="alert">真实失败原因：{candidate.latestRun.failureCode}</p>}
      {candidate.latestRun?.evidence !== null && candidate.latestRun?.evidence !== undefined && <details><summary>查看真实运行证据</summary><pre className="agent-proposal-content">{JSON.stringify(candidate.latestRun.evidence, null, 2)}</pre></details>}
      {candidate.acceptedReleaseId && <p className="muted">已关联正式 Release：{candidate.acceptedReleaseId}</p>}
    </>}
    <div className="candidate-release-actions"><span className="muted">既有 Release 路径保持兼容；无 Candidate 时仍可试玩旧发布版本。</span><div className="actions"><button className="secondary" disabled={!publishedReleaseId || busy || browserPreview} onClick={onPlaytestRelease}>试玩已发布 Release</button><button className="secondary" disabled={unavailable} onClick={onDirectPublish}>直接发布 Release（旧路径）</button></div></div>
  </section>;
}
