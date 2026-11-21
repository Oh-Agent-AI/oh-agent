import { useState } from "react";
import { canApproveTaskPlan, canCancelTask, canReviewTask, canReviseTaskPlan, studioPhaseLabel, type StudioTaskPhase } from "../../contracts/studioTask";
import type { StudioTaskController } from "./useStudioTasks";

export function StudioTaskPanel({ controller }: Readonly<{ controller: StudioTaskController }>) {
  const { task, sessionStatus, busy, error, createGoal, approvePlan, revisePlan, appendEvidence, acceptReview, rejectReview, cancelTask, refreshTask } = controller;
  const [goal, setGoal] = useState("");
  const [evidence, setEvidence] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const connection = sessionStatus === "available" ? "本地任务账本可用 · Agent 执行未连接" : sessionStatus === "loading" ? "正在打开本地任务账本" : "本地任务账本不可用 · Agent 执行未连接";
  const append = async () => { await appendEvidence(evidence); };
  return <section className="studio-task-panel" aria-label="Studio Task 生命周期">
    <div className="agent-workspace-heading"><div><span className="section-title">Goal / Plan / Evidence</span><p className="muted">{connection}</p></div><button className="secondary" disabled={busy || !task} onClick={() => void refreshTask()}>刷新</button></div>
    {!task ? <>
      <p className="muted">创建持久目标和计划，不会执行 Agent，也不会自动产生完成证据。</p>
      <label>创作目标<textarea aria-label="持久任务目标" value={goal} disabled={busy || sessionStatus !== "available"} onChange={event => setGoal(event.target.value)} /></label>
      <div className="actions"><button disabled={busy || sessionStatus !== "available" || !goal.trim()} onClick={() => void createGoal(goal)}>创建目标并提交计划</button></div>
    </> : <>
      <div className="candidate-facts"><strong>{studioPhaseLabel(task.phase as StudioTaskPhase)}</strong><code>{task.goalId} · goalRevision {task.goalRevision} · planRevision {task.planRevision}</code><span className="muted">artifact {task.artifact.projectId} · expectedRevision {task.artifact.expectedRevision}</span></div>
      <p className="muted">{task.humanRequest}</p>
      <div className="studio-task-steps">{task.steps.map(step => <div key={step.stepId}><strong>{step.ordinal + 1}. {step.title}</strong><span className="muted">{step.kind} · {step.stepId}</span></div>)}</div>
      <div className="actions">
        {canApproveTaskPlan(task) && <button disabled={busy} onClick={() => void approvePlan()}>批准当前计划</button>}
        {canReviseTaskPlan(task) && <button className="secondary" disabled={busy} onClick={() => void revisePlan()}>退回并修订计划</button>}
        {canCancelTask(task) && <button className="secondary" disabled={busy} onClick={() => void cancelTask()}>取消任务</button>}
      </div>
      {(task.phase === "ready" || task.phase === "executing" || task.phase === "validating" || task.phase === "awaiting-review") && <div className="studio-evidence-form">
        <label>人工证据说明<textarea aria-label="人工证据说明" value={evidence} disabled={busy} onChange={event => setEvidence(event.target.value)} placeholder="记录真实观察；这只是 creator-declared，不是 Host 验证" /></label>
        <div className="actions"><button className="secondary" disabled={busy || !evidence.trim()} onClick={() => void append()}>追加人工证据</button></div>
      </div>}
      {canReviewTask(task) && <div className="studio-review-form">
        <label>人工验收意见<textarea aria-label="人工验收意见" value={reviewNote} disabled={busy} onChange={event => setReviewNote(event.target.value)} /></label>
        <div className="actions"><button disabled={busy || !reviewNote.trim()} onClick={() => void acceptReview(reviewNote)}>接受任务</button><button className="secondary" disabled={busy || !reviewNote.trim()} onClick={() => void rejectReview(reviewNote)}>退回任务</button></div>
      </div>}
      <div className="studio-evidence-list"><div className="section-title">持久证据</div>
        {task.evidence.length === 0 ? <p className="muted">尚无证据。批准计划或完成构建不会自动产生证据。</p> : task.evidence.map(item => <article key={item.evidenceId}><strong>{item.kind} · {item.trustLevel}</strong><p>{item.summary}</p><code>{item.evidenceId} · planRevision {item.planRevision}</code></article>)}
      </div>
    </>}
    {error && <p className="library-error" role="alert">{error}</p>}
  </section>;
}
