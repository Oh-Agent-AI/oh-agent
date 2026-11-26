import { useEffect, useRef, useState, type ReactNode } from "react";
import { canApproveTaskPlan, canCancelTask, canExecuteTask, canReviewTask, canReviseTaskPlan, isDefaultStudioPlan, normalizeStudioGoal, studioPhaseLabel, type StudioTaskPhase } from "../../contracts/studioTask";
import type { StudioTaskController } from "./useStudioTasks";
import { AgentDecisionCard } from "./AgentDecisionCard";
import { executorBadge } from "./AgentSelector";
import { previewSummary } from "./taskCommit";
import { studioEntityTaskContext, hasVerifiedEntityEvidence, type PreviewEntityReferenceStatus, type StudioEntityTarget } from "../../contracts/previewContext";

function taskErrorLabel(code: string): string {
  switch (code) {
    case "acp_quota_exhausted":
    case "codex_quota_exhausted":
      return "当前 Agent 的额度已用完。额度恢复后重试，或选择另一位可用的 Agent。";
    case "acp_mode_unsupported":
    case "executor_mode_unsupported":
      return "当前 Agent 无法启用受限提案。请选择另一条可用连接。";
    case "acp_image_unsupported":
      return "当前 Agent 不接收图片。可以关闭截图附件或选择其他 Agent 后重试。";
    case "creator_capture_unavailable":
    case "creator_capture_budget_exceeded":
      return "未能获取当前版本的截图。请等待视口就绪后重试，或关闭截图附件。";
    case "acp_auth_required":
      return "当前 Agent 需要登录。请完成登录后重试。";
    case "acp_output_invalid":
    case "codex_output_invalid":
      return "Agent 未能返回可识别的修改提案。可以恢复原指令再次发送，或切换 Agent。";
    case "preview_required":
      return "Agent 没有生成通过校验的改动。可以恢复原指令，补充改动对象和要求后重新发送。";
    case "preview_expired":
      return "预览已过期，请重新生成预览后再保存。";
    case "revision_conflict":
    case "story_project_revision_conflict":
      return "作品版本已变化。请重新打开作品并生成预览。";
    case "creator_task_confirmation_pending":
      return "上一次保存仍待确认结果。请先重试确认保存。";
    default:
      return code;
  }
}

export function StudioTaskPanel({ controller, goal, onGoalChange, projectReady, commitBlockedReason, target, targetReference, targetReferenceStatus = "current", onClearTarget, onViewChanges, children, tools }: Readonly<{
  controller: StudioTaskController;
  children?: ReactNode;
  tools?: ReactNode;
  target?: string;
  targetReference?: StudioEntityTarget;
  targetReferenceStatus?: PreviewEntityReferenceStatus;
  onClearTarget?: () => void;
  onViewChanges?: () => void;
  goal: string;
  onGoalChange: (goal: string) => void;
  projectReady: boolean;
  /** 确认前置检查（作用域/版本/未提交草稿）；null 表示可确认。 */
  commitBlockedReason?: string | null;
}>)
{
  const { task, sessionStatus, capabilities, events, subscriptionStatus, subscriptionError, connectionError,
    busy, cancelling, error, executor, startTask, viewportAttachmentScope, approvePlan, revisePlan, executeTask, confirmSave, rejectReview, cancelTask, refreshTask } = controller;
  const [viewportExecutor, setViewportExecutor] = useState("");
  useEffect(() => { setViewportExecutor(""); }, [executor]);
  const [reviewNote, setReviewNote] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState("");
  const previewEvidence = task?.evidence.slice().reverse().find(item => item.kind === "preview" && item.trustLevel === "host-observed"
    && item.planRevision === task.planRevision) ?? null;
  const previewId = typeof (previewEvidence?.data as Record<string, unknown> | null)?.previewId === "string"
    ? String((previewEvidence!.data as Record<string, unknown>).previewId) : "";
  // 「已验证」只有 City 试玩证据这一条通道；Story 目标如实停在未验证。
  const entityVerified = task && targetReference?.kind === "city" ? hasVerifiedEntityEvidence(task.evidence, targetReference.reference) : false;
  const confirmSaveNow = async () => {
    if (!task || !previewEvidence || !previewId || committing) return;
    setCommitting(true); setCommitResult("");
    const outcome = await controller.confirmSave(previewId, reviewNote.trim());
    setCommitResult(outcome.ok ? `已保存（版本 ${outcome.committedRevision ?? "?"}）。` : taskErrorLabel(outcome.error ?? "creator_task_confirm_failed"));
    setCommitting(false);
  };
  const connection = sessionStatus === "available" ? `事件订阅 ${subscriptionStatus}` : sessionStatus === "loading" ? "正在连接" : "不可用";
  const studioOnline = capabilities?.studioOnline === true;
  const nextGoal = normalizeStudioGoal(goal);
  const targetSuffix = targetReference ? studioEntityTaskContext(targetReference) : target ? `（关联对象：${target}）` : "";
  const submissionGoal = nextGoal + targetSuffix;
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const canStart = !task || ["accepted", "rejected", "failed", "cancelled"].includes(task.phase);
  const executors = capabilities?.executors ?? [];
  const executorStatus = executors.find(item => item.id === executor);
  const badge = executorStatus ? executorBadge(executorStatus) : null;
  // R3/P0：所选执行器不可用时禁止开始创作，原因直接可见。
  const chosenUnavailable = !executor || !badge || badge.disabled;
  const viewportConsent = viewportAttachmentScope && executor.startsWith("acp:") ? JSON.stringify([viewportAttachmentScope, executor]) : "";
  const includeViewport = !!viewportConsent && viewportExecutor === viewportConsent;
  const viewportOption = viewportConsent && (
    <label className="agent-viewport-attachment"><span><input type="checkbox" checked={includeViewport} disabled={busy || chosenUnavailable || !projectReady}
      onChange={event => setViewportExecutor(event.target.checked ? viewportConsent : "")} /> 附上当前视口截图</span>
      <small className="muted">截图会发送给所选 Agent，联网 Agent 可能将图片交给模型服务。</small>
    </label>
  );
  const pendingDraft = useRef<{ previousTaskId?: string; submitted: string; draft: string } | null>(null);
  useEffect(() => {
    const pending = pendingDraft.current;
    if (!pending || !task || task.taskId === pending.previousTaskId || task.humanRequest !== pending.submitted) return;
    pendingDraft.current = null;
    if (goal === pending.draft) onGoalChange("");
  }, [goal, task, onGoalChange]);
  const failure = task?.phase === "failed" ? events.slice().reverse().find(event => event.kind === "failure") : undefined;
  const failureData = failure?.data as { code?: unknown; executor?: unknown } | undefined;
  const failureCode = typeof failureData?.code === "string" ? failureData.code : "";
  const failedExecutor = executors.find(item => item.id === failureData?.executor)?.name;
  const canSend = canStart && projectReady && studioOnline && !busy && sessionStatus === "available" && !!nextGoal && submissionGoal.length <= 4000 && !chosenUnavailable
    && (!targetReference || targetReferenceStatus === "current");
  function send() {
    if (!canSend) return;
    pendingDraft.current = { previousTaskId: task?.taskId, submitted: submissionGoal, draft: goal };
    setViewportExecutor("");
    setReviewNote(""); setCommitResult("");
    void startTask(submissionGoal, executor, includeViewport);
  }
  return <section className="studio-task-panel" aria-label="创作任务">
    <div className="agent-timeline" aria-label="任务时间线">
    {children}

    {sessionStatus === "available" && !executor && <p role="status">请在 Host 连接支持受限提案的 ACP Agent。</p>}
    {task && <>
      <div className="agent-user-message">{task.humanRequest}</div>
      {previewEvidence && <div className="agent-result-state" aria-label="修改状态">
        <span className="active">已生成修改</span>
        <span className={task.phase === "accepted" ? "active" : ""}>{task.phase === "accepted" ? "已保存" : "未保存"}</span>
        <span className={entityVerified ? "active" : ""}>{entityVerified ? "已验证" : "未验证"}</span>
      </div>}
      {task.phase === "failed" ? <AgentDecisionCard tone="error" title={failedExecutor ? `${failedExecutor} · 执行失败` : "执行失败"}>
        <p role="alert">{error || failureCode ? taskErrorLabel(error || failureCode) : "可以检查执行详情，或重新准备任务。"}</p>
        <div className="actions">
          <button className="secondary" disabled={busy || !!nextGoal} onClick={() => {
            const original = task.humanRequest;
            onGoalChange(targetSuffix && original.endsWith(targetSuffix) ? original.slice(0, -targetSuffix.length) : original);
            composerInput.current?.focus();
          }}>恢复原指令</button>
        </div>
        {nextGoal && <small>输入区已有草稿。</small>}
      </AgentDecisionCard> : <>
        {!canApproveTaskPlan(task) && !canExecuteTask(task) && !canReviewTask(task) && <strong role="status">{studioPhaseLabel(task.phase as StudioTaskPhase)}</strong>}
        {error && <p className="library-error" role="alert">{taskErrorLabel(error)}</p>}
      </>}
      {task.phase === "executing" && events.at(-1) && <p className="agent-latest-event">{events.at(-1)?.summary}</p>}
      {(connectionError || subscriptionError) && <p className="library-error" role="alert">{connectionError && `心跳：${connectionError} `}{subscriptionError && `订阅：${subscriptionError}；将从最后确认的位置继续。`}</p>}
      {(canApproveTaskPlan(task) || canExecuteTask(task)) && <AgentDecisionCard title={canExecuteTask(task) ? "准备执行" : "确认创作计划"}>
        <ol>{task.steps.map(step => <li key={step.stepId}>{step.title}</li>)}</ol>
        {canExecuteTask(task) && viewportOption}
        {canExecuteTask(task) && (!studioOnline || chosenUnavailable) && <p className="muted">连接可用的 Agent 后即可执行。</p>}
        <div className="actions">
          {canExecuteTask(task) && <button disabled={busy || !studioOnline || chosenUnavailable} onClick={() => { setViewportExecutor(""); void executeTask(executor, includeViewport); }}>开始执行</button>}
          {canApproveTaskPlan(task) && <button disabled={busy} onClick={() => void approvePlan()}>{isDefaultStudioPlan(task) ? "批准默认计划" : "批准计划"}</button>}
          {canReviseTaskPlan(task) && <button className="secondary" disabled={busy} onClick={() => void revisePlan()}>退回计划</button>}
        </div>
      </AgentDecisionCard>}
      {canReviewTask(task) && previewEvidence && <AgentDecisionCard title="确认 Agent 修改">
          <ul className="preview-summary">{previewSummary(previewEvidence, task.artifact.kind).map((line, index) => <li key={index}>{line}</li>)}</ul>
          <details><summary>原始证据</summary><pre className="agent-proposal-content">{JSON.stringify(previewEvidence.data, null, 2)}</pre></details>
          <p className="muted">{previewEvidence.summary}</p>
          {commitBlockedReason && <p className="muted">{commitBlockedReason}</p>}
          <details><summary>添加验收意见</summary><textarea aria-label="人工验收意见（可选）" value={reviewNote} disabled={busy || committing} onChange={event => setReviewNote(event.target.value)} /></details>
          <div className="actions">
            {onViewChanges && <button className="secondary" onClick={onViewChanges}>查看改动</button>}
            <button disabled={committing || busy || !previewId || !!commitBlockedReason} title={commitBlockedReason ?? "确认后按 Host 已校验的 Preview 保存并完成任务"} onClick={() => void confirmSaveNow()}>确认保存</button>
            <button className="secondary" disabled={committing || busy} onClick={() => { setCommitResult(""); void rejectReview(reviewNote.trim() || "人工退回该 Preview。"); }}>退回</button>
          </div>
      </AgentDecisionCard>}
      {canReviewTask(task) && !previewEvidence && <AgentDecisionCard title="验收任务">
        <label>人工验收意见<textarea aria-label="人工验收意见" value={reviewNote} disabled={busy} onChange={event => setReviewNote(event.target.value)} /></label>
        <div className="actions"><button disabled={busy || !reviewNote.trim()} onClick={() => void controller.acceptReview(reviewNote)}>接受任务</button><button className="secondary" disabled={busy || !reviewNote.trim()} onClick={() => void rejectReview(reviewNote)}>退回任务</button></div>
      </AgentDecisionCard>}
      {canCancelTask(task) && <div className="agent-task-controls"><button className="secondary"
        disabled={cancelling || (busy && task.phase !== "executing")} onClick={() => void cancelTask()}>
        {cancelling ? "正在取消…" : "取消任务"}
      </button></div>}
      <details className="agent-evidence">
        <summary className="section-title">详情（过程与证据）</summary>
        <div className="studio-evidence-list">
          {events.length === 0 ? <p className="muted">尚无事件。</p> : events.map(item => <article key={item.eventId}>
            <strong>#{item.seq} · {item.kind} · {item.trustLevel}</strong><p>{item.summary}</p>
            <code>{item.source} · eventId {item.eventId}</code>
          </article>)}
        </div>
        <div className="studio-evidence-list">
          {task.evidence.length === 0 ? <p className="muted">尚无证据。</p> : task.evidence.map(item => <article key={item.evidenceId}><strong>{item.kind} · {item.trustLevel}</strong><p>{item.summary}</p><code>{item.evidenceId} · planRevision {item.planRevision}</code></article>)}
        </div>
        <div className="studio-task-steps">{task.steps.map(step => <div key={step.stepId}><strong>{step.ordinal + 1}. {step.title}</strong><span className="muted">{step.kind} · {step.stepId}</span></div>)}</div>
        <div className="candidate-facts"><code>{task.goalId} · goalRevision {task.goalRevision} · planRevision {task.planRevision}</code><span className="muted">{task.artifact.kind} · expectedRevision {task.artifact.expectedRevision}</span></div>
        <button className="secondary" disabled={busy || !task} onClick={() => void refreshTask()}>刷新任务</button>
      </details>
    </>}
    {commitResult && <p role="status">{commitResult}</p>}
    {!task && error && <p className="library-error" role="alert">{taskErrorLabel(error)}</p>}
    <details className="agent-secondary-tools"><summary>连接与工具</summary>
    <details><summary>连接详情</summary><p>{connection}</p>
      {executors.map(item => <p key={item.id}>{item.name} · {executorBadge(item).disabled ? item.detail ?? "连接不可用" : "可用于创作"}</p>)}
    </details>
    {tools}
    </details>
    </div>
    <form className="agent-compose" onSubmit={event => { event.preventDefault(); send(); }}>
      {target && <div className="agent-target-chip" title={targetReference ? (targetReference.kind === "city" ? targetReference.reference.entityId : targetReference.entityId) : undefined}><span>{target}{targetReference && <code> · {targetReference.kind === "city" ? targetReference.reference.entityId : targetReference.entityId}</code>}</span><button type="button" aria-label="移除关联对象" onClick={onClearTarget}>×</button></div>}
      {targetReference && targetReferenceStatus !== "current" && <small role="alert">对象版本已过期或不属于当前 Project，请在 Preview 重新选择后再发送。</small>}
      <textarea ref={composerInput} aria-label="创作目标" maxLength={4000} value={goal} onChange={event => onGoalChange(event.target.value)}
        placeholder={canStart ? "描述想创建或修改的内容…" : "起草下一个任务…"}
        onKeyDown={event => { if (!event.nativeEvent.isComposing && event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send(); } }} />
      {!canStart && <small>当前任务结束后可发送下一条。</small>}
      {submissionGoal.length > 4000 && <small role="alert">请缩短目标，含关联对象最多 4000 字。</small>}
      {canStart && viewportOption}
      <div className="agent-compose-tools">
        <button type="submit" disabled={!canSend} title="发送任务（⌘ / Ctrl + Enter）">发送 ↑</button>
      </div>
    </form>
  </section>;
}
