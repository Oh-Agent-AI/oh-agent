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
  const unavailable = busy || browserPreview || hasUncommittedProjectEdits || !hasMounts;
  return <section className="candidate-panel" aria-label="Candidate 测试与发布">
    <div className="section-title">试玩与发布</div>
    {browserPreview && <p className="muted">真实试玩与发布请在桌面 Studio 操作。</p>}
    {!candidate ? <>
      <p className="muted">{hasUncommittedProjectEdits ? "当前有未保存修改。"
        : !hasMounts ? "请先配置并保存玩法场地。"
          : "可以为当前保存版本创建试玩候选。"}</p>
      <div className="actions"><button disabled={unavailable} onClick={onCreate}>创建试玩候选</button></div>
    </> : <>
      <div className="candidate-facts"><strong>{statusLabel(candidate)}</strong><span>项目修订 {candidate.revision}</span></div>
      <div className="actions">
        <button className="secondary" disabled={unavailable || candidate.status === "testing" || candidate.status === "accepted" || candidate.status === "unknown"} onClick={onTest}>{candidate.status === "testing" ? "试玩进行中" : candidate.status === "tested" ? "重新试玩 Candidate" : "试玩 Candidate"}</button>
        <button disabled={busy || browserPreview || hasUncommittedProjectEdits || !canAcceptCandidate(candidate)} onClick={onAccept}>接受并发布 Release</button>
      </div>
      <p className="muted">运行证据：{candidateEvidenceTrust(candidate)}。</p>
      {candidate.latestRun?.failureCode && <p className="library-error" role="alert">真实失败原因：{candidate.latestRun.failureCode}</p>}
      <details><summary>查看版本与运行证据</summary>
        <p className="muted">候选 {candidate.candidateId} · {candidate.contentDigest}</p>
        {candidate.latestRun && <p className="muted">运行 {candidate.latestRun.runId} · {candidate.latestRun.status}</p>}
        {candidate.latestRun?.evidence != null && <pre className="agent-proposal-content">{JSON.stringify(candidate.latestRun.evidence, null, 2)}</pre>}
        {candidate.acceptedReleaseId && <p className="muted">正式发布 {candidate.acceptedReleaseId}</p>}
      </details>
    </>}
    <details className="candidate-release-actions"><summary>其他发布操作</summary>
      <div className="actions"><button className="secondary" disabled={!publishedReleaseId || busy || browserPreview} onClick={onPlaytestRelease}>试玩正式版</button><button className="secondary" disabled={unavailable} onClick={onDirectPublish}>直接发布 Release（旧路径）</button></div>
    </details>
  </section>;
}
