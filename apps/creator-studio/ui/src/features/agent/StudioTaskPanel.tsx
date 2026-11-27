import { useEffect, useRef, useState, type ReactNode } from "react";
import { canApproveTaskPlan, canCancelTask, canExecuteTask, canReviewTask, canReviseTaskPlan, isDefaultStudioPlan, normalizeStudioGoal, studioPhaseLabel, type StudioTargetRef, type StudioTaskPhase } from "../../contracts/studioTask";
import type { StudioTaskController } from "./useStudioTasks";
import { AgentDecisionCard } from "./AgentDecisionCard";
import { AgentErrorBanner } from "./AgentErrorBanner";
import { buildSessionTimelineRows, foldActiveEvents } from "./sessionTimeline";
import { SessionTimeline } from "./SessionTimelineView";
import { useStopPhase } from "./useStopPhase";
import { useLiveRegion } from "./useLiveRegion";
import { executorBadge } from "./AgentSelector";
import { previewSummary } from "./taskCommit";
import { entityVerificationLevel, type EntityVerificationLevel, type PreviewEntityReferenceStatus, type StudioEntityTarget } from "../../contracts/previewContext";

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
    case "executor_lost":
      return "Agent 进程已中断（宿主可能重启过）。可以恢复原指令重新发送。";
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
    busy, error, executor, startTask, viewportAttachmentScope, approvePlan, revisePlan, executeTask, confirmSave, rejectReview, cancelTask, refreshTask, history } = controller;
  const [viewportExecutor, setViewportExecutor] = useState("");
  useEffect(() => { setViewportExecutor(""); }, [executor]);
  const [reviewNote, setReviewNote] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState("");
  // T3 ThreadErrorBanner：按 任务×错误码 键控的关闭状态；换任务或换错误码重新出现。
  const [dismissedBanner, setDismissedBanner] = useState<string | null>(null);
  // T3 queued-turn 的回合边界形态（真 steer 属 R5 会话化，这里如实标注）。
  const [autoSendNext, setAutoSendNext] = useState(false);
  const { stopPhase, requestStop } = useStopPhase();
  const { announce } = useLiveRegion();
  const previewEvidence = task?.evidence.slice().reverse().find(item => item.kind === "preview" && item.trustLevel === "host-observed"
    && item.planRevision === task.planRevision) ?? null;
  const previewId = typeof (previewEvidence?.data as Record<string, unknown> | null)?.previewId === "string"
    ? String((previewEvidence!.data as Record<string, unknown>).previewId) : "";
  // 验证状态分三级：Host 独立验证 > City 客户端回报（试玩通过）> 未验证；
  // Story 目标没有客户端试玩通道，如实停在未验证。
  const entityVerification = task && targetReference?.kind === "city"
    ? entityVerificationLevel(task.evidence, targetReference.reference) : "none";
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
  // P1-5：对象身份走结构化 targetRefs 由宿主绑定校验；自然语言里只留人读的名称提示。
  // 只有携带宿主 Preview 台账可核对的 previewId 的引用才构造（宿主 PR03 权威校验
  // 按 previewId 核对存在与归属）；从 live 视口选取（无 previewId）不带结构化绑定。
  const cityTarget = targetReference?.kind === "city" && targetReferenceStatus === "current" ? targetReference.reference : null;
  const targetRefs: readonly StudioTargetRef[] = cityTarget && cityTarget.previewId ? [{
    entityKind: cityTarget.entityKind, entityId: cityTarget.entityId, previewId: cityTarget.previewId,
    projectRevision: cityTarget.projectRevision, cityRevision: cityTarget.cityRevision, worldRevision: cityTarget.worldRevision,
  }] : [];
  const targetSuffix = cityTarget ? `（关联对象：${cityTarget.label}）` : target ? `（关联对象：${target}）` : "";
  const submissionGoal = nextGoal + targetSuffix;
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const canStart = !task || ["accepted", "rejected", "failed", "cancelled"].includes(task.phase);
  const taskSettled = canStart;
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
  const restoreGoal = () => {
    if (!task) return;
    const original = task.humanRequest;
    onGoalChange(targetSuffix && original.endsWith(targetSuffix) ? original.slice(0, -targetSuffix.length) : original);
    composerInput.current?.focus();
  };
  const dispatchGoal = (draft: string, withViewport: boolean) => {
    const text = normalizeStudioGoal(draft);
    if (!text) return;
    pendingDraft.current = { previousTaskId: task?.taskId, submitted: text + targetSuffix, draft };
    setViewportExecutor("");
    setReviewNote(""); setCommitResult("");
    void startTask(text + targetSuffix, executor, withViewport, targetRefs);
  };
  const send = () => { if (canSend) dispatchGoal(goal, includeViewport); };
  // 排队下一条：任务落终态且勾选「结束后自动发送」时发送草稿（回合边界排队）。
  useEffect(() => {
    if (!autoSendNext || !taskSettled) return;
    const draft = normalizeStudioGoal(goal);
    if (!draft) { setAutoSendNext(false); return; }
    if (busy || !projectReady || !studioOnline || sessionStatus !== "available" || chosenUnavailable) return;
    if (targetReference && targetReferenceStatus !== "current") return;
    setAutoSendNext(false);
    dispatchGoal(draft, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSendNext, taskSettled, goal, busy, projectReady, studioOnline, sessionStatus, chosenUnavailable, targetReferenceStatus, task]);
  // 相位转换播报（读屏；settle 行的内容随相位而来，这里播一次即可）。
  const announcedPhase = useRef("");
  useEffect(() => {
    if (!task) { announcedPhase.current = ""; return; }
    const key = `${task.taskId}:${task.phase}`;
    if (announcedPhase.current === key) return;
    announcedPhase.current = key;
    announce(task.phase === "failed" && (error || failureCode) ? `执行失败。${taskErrorLabel(error || failureCode)}` : studioPhaseLabel(task.phase));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task, error, failureCode, announce]);
  useEffect(() => { if (commitResult) announce(commitResult); }, [commitResult, announce]);
  const fold = foldActiveEvents(events);
  const rows = buildSessionTimelineRows({ history: history.tasks, truncated: history.truncated,
    activeTask: task ? { taskId: task.taskId, phase: task.phase, humanRequest: task.humanRequest } : null,
    events, subscriptionStatus });
  const bannerCode = error || "";
  const bannerKey = `${task?.taskId ?? "no-task"}:${bannerCode}`;
  const showBanner = !!bannerCode && dismissedBanner !== bannerKey && task?.phase !== "failed";
  const sendBlockers: string[] = [];
  if (!nextGoal) sendBlockers.push("请输入创作目标");
  if (!projectReady) sendBlockers.push("作品尚未就绪");
  if (!studioOnline) sendBlockers.push("Studio 连接不可用");
  if (sessionStatus !== "available") sendBlockers.push("会话未就绪");
  if (busy) sendBlockers.push("正在处理上一个操作");
  if (chosenUnavailable) sendBlockers.push("请选择可用的 Agent");
  if (submissionGoal.length > 4000) sendBlockers.push("目标超长（含关联对象 ≤4000 字）");
  if (targetReference && targetReferenceStatus !== "current") sendBlockers.push("关联对象已过期，请在 Preview 重新选择");
  if (!canStart) sendBlockers.push("当前任务进行中，可勾选「结束后自动发送」排队");
  const sendDisabledReason = sendBlockers[0] ?? null;
  const renderActive = () => task && <>
    {previewEvidence && <div className="agent-result-state" aria-label="修改状态">
      <span className="active">已生成修改</span>
      <span className={task.phase === "accepted" ? "active" : ""}>{task.phase === "accepted" ? "已保存" : "未保存"}</span>
      <span className={entityVerification === "host-verified" ? "active" : ""}>{entityVerification === "host-verified" ? "Host 验证通过" : entityVerification === "client-reported" ? "试玩通过（客户端回报）" : "未验证"}</span>
    </div>}
    {task.phase === "failed" ? <AgentDecisionCard tone="error" title={failedExecutor ? `${failedExecutor} · 执行失败` : "执行失败"}>
      <p role="alert">{error || failureCode ? taskErrorLabel(error || failureCode) : "可以检查执行详情，或重新准备任务。"}</p>
      <div className="actions">
        <button className="secondary" disabled={busy || !!nextGoal} onClick={restoreGoal}>恢复原指令</button>
      </div>
      {nextGoal && <small>输入区已有草稿。</small>}
    </AgentDecisionCard> : <>
      {!canApproveTaskPlan(task) && !canExecuteTask(task) && !canReviewTask(task) && <strong role="status">{studioPhaseLabel(task.phase as StudioTaskPhase)}</strong>}
      {/* T3 activity-log 折叠纪律：最近一条过程摘要就地显示，完整历史在详情折叠。 */}
      {(task.phase === "executing" || task.phase === "validating") && (fold.latest || fold.foldCount > 0) &&
        <p className="agent-latest-event">已执行 {events.length} 步{fold.latest ? ` · 最近：${fold.latest}` : ""}</p>}
    </>}
    {(connectionError || subscriptionError) && <p className="library-error" role="alert">{connectionError && `心跳：${connectionError} `}{subscriptionError && `订阅：${subscriptionError}；将从最后确认的位置继续。`}</p>}
    {task && (canApproveTaskPlan(task) || canExecuteTask(task)) && <AgentDecisionCard title={canExecuteTask(task) ? "准备执行" : "确认创作计划"}>
      <ol>{task.steps.map(step => <li key={step.stepId}>{step.title}</li>)}</ol>
      {canExecuteTask(task) && viewportOption}
      {canExecuteTask(task) && (!studioOnline || chosenUnavailable) && <p className="muted">连接可用的 Agent 后即可执行。</p>}
      <div className="actions">
        {canExecuteTask(task) && <button disabled={busy || !studioOnline || chosenUnavailable} onClick={() => { setViewportExecutor(""); void executeTask(executor, includeViewport); }}>开始执行</button>}
        {canApproveTaskPlan(task) && <button disabled={busy} onClick={() => void approvePlan()}>{isDefaultStudioPlan(task) ? "批准默认计划" : "批准计划"}</button>}
        {canReviseTaskPlan(task) && <button className="secondary" disabled={busy} onClick={() => void revisePlan()}>退回计划</button>}
      </div>
    </AgentDecisionCard>}
    {task && canReviewTask(task) && previewEvidence && <AgentDecisionCard title="确认 Agent 修改">
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
    {task && canReviewTask(task) && !previewEvidence && <AgentDecisionCard title="验收任务">
      <label>人工验收意见<textarea aria-label="人工验收意见" value={reviewNote} disabled={busy} onChange={event => setReviewNote(event.target.value)} /></label>
      <div className="actions"><button disabled={busy || !reviewNote.trim()} onClick={() => void controller.acceptReview(reviewNote)}>接受任务</button><button className="secondary" disabled={busy || !reviewNote.trim()} onClick={() => void rejectReview(reviewNote)}>退回任务</button></div>
    </AgentDecisionCard>}
    {task && canCancelTask(task) && <div className="agent-task-controls"><button className="secondary"
      disabled={stopPhase === "pending" || stopPhase === "landed" || (busy && task.phase !== "executing")}
      title={stopPhase === "timedOut" ? "上一次取消未在时限内确认，可重试" : undefined}
      onClick={() => requestStop(() => cancelTask())}>
      {stopPhase === "pending" ? "正在取消…" : stopPhase === "timedOut" ? "取消未确认，点击重试" : "取消任务"}
    </button></div>}
    {task && <details className="agent-evidence">
      <summary className="section-title">详情（过程与证据）</summary>
      <div className="studio-evidence-list">
        {events.length === 0 ? <p className="muted">尚无事件。</p> : events.map(item => <article key={item.eventId}>
          {/* R2：默认视图只有「时间 · 摘要」；kind/trustLevel/eventId 收进原始记录。 */}
          <p>{new Date(item.createdAtMs).toLocaleTimeString()} · {item.summary}</p>
          <details className="agent-raw-record"><summary>原始记录</summary>
            <code>#{item.seq} · {item.kind} · {item.trustLevel} · {item.source} · eventId {item.eventId}</code>
          </details>
        </article>)}
      </div>
      <div className="studio-evidence-list">
        {task.evidence.length === 0 ? <p className="muted">尚无证据。</p> : task.evidence.map(item => <article key={item.evidenceId}>
          <p>{item.kind} · {item.summary}</p>
          <details className="agent-raw-record"><summary>原始记录</summary>
            <code>{item.evidenceId} · trustLevel {item.trustLevel} · planRevision {item.planRevision}</code>
          </details>
        </article>)}
      </div>
      <div className="studio-task-steps">{task.steps.map(step => <div key={step.stepId}><strong>{step.ordinal + 1}. {step.title}</strong><span className="muted">{step.kind}</span></div>)}</div>
      <details className="agent-raw-record"><summary>任务标识</summary>
        <code>{task.goalId} · goalRevision {task.goalRevision} · planRevision {task.planRevision}</code>
        <code>{task.artifact.kind} · expectedRevision {task.artifact.expectedRevision}</code>
      </details>
      <button className="secondary" disabled={busy || !task} onClick={() => void refreshTask()}>刷新任务</button>
    </details>}
  </>;
  return <section className="studio-task-panel" aria-label="创作任务">
    <SessionTimeline followKey={task?.taskId ?? "no-task"} rows={rows} renderActive={renderActive}
      header={children}
      emptyHint={<>
        {sessionStatus === "available" && !executor && <p role="status">请在 Host 连接支持受限提案的 ACP Agent。</p>}
        {!task && <p className="muted">描述想创建或修改的内容，选择 Agent 后发送。每条任务会生成修改预览，确认后才保存。</p>}
      </>} />
    {showBanner && <AgentErrorBanner message={taskErrorLabel(bannerCode)} code={bannerCode}
      onDismiss={() => setDismissedBanner(bannerKey)} />}
    <form className="agent-compose" onSubmit={event => { event.preventDefault(); send(); }}>
      {target && <div className="agent-target-chip" title={targetReference ? (targetReference.kind === "city" ? targetReference.reference.entityId : targetReference.entityId) : undefined}><span>{target}{targetReference && <code> · {targetReference.kind === "city" ? targetReference.reference.entityId : targetReference.entityId}</code>}</span><button type="button" aria-label="移除关联对象" onClick={onClearTarget}>×</button></div>}
      {targetReference && targetReferenceStatus !== "current" && <small role="alert">对象版本已过期或不属于当前 Project，请在 Preview 重新选择后再发送。</small>}
      <textarea ref={composerInput} aria-label="创作目标" maxLength={4000} value={goal} onChange={event => onGoalChange(event.target.value)}
        placeholder={canStart ? "描述想创建或修改的内容…" : "起草下一个任务…"}
        onKeyDown={event => { if (!event.nativeEvent.isComposing && event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send(); } }} />
      {!canStart && <div className="agent-queue-next">
        <label><input type="checkbox" checked={autoSendNext} disabled={!normalizeStudioGoal(goal)}
          onChange={event => setAutoSendNext(event.target.checked)} /> 任务结束后自动发送</label>
        <small className="muted">回合边界排队；执行中的任务暂不支持中途插入新指令。</small>
      </div>}
      {canStart && !autoSendNext && submissionGoal.length > 4000 && <small role="alert">请缩短目标，含关联对象最多 4000 字。</small>}
      {canStart && viewportOption}
      <div className="agent-compose-tools">
        <button type="submit" disabled={!canSend}
          title={`发送任务（⌘ / Ctrl + Enter）${sendDisabledReason ? ` · ${sendDisabledReason}` : ""}`}
          aria-description={sendDisabledReason ?? undefined}>发送 ↑</button>
      </div>
    </form>
  </section>;
}
