import { useEffect, useRef, useState } from "react";
import type { CreatorRequest } from "../../adapters/creatorHost";
import {
  defaultStudioPlanSteps, mergeStudioEvents, normalizeStudioGoal, parseStudioCapabilityStatus, parseStudioConnections, parseStudioEventBatch, parseStudioSessionHistory,
  parseStudioTask, studioSessionTaskFromTask,
  type StudioCapabilityStatus, type StudioConnection, type StudioSessionHistory, type StudioTask, type StudioTaskEvent,
} from "../../contracts/studioTask";

export type TaskScope = Readonly<{ kind: "creator-project"; projectId: string; revision: number } | { kind: "creator-city"; cityId: string; revision: number } | { kind: "creator-story"; storyId: string; revision: number }> | null;
export type StudioSubscriptionStatus = "idle" | "connecting" | "live" | "reconnecting";

export function useStudioTasks(request: CreatorRequest, scope: TaskScope, enabled = true, hasIsolatedViewport = false, sessionId: string | null = null,
  onExecutorSelected?: (executor: string) => void) {
  const [task, setTask] = useState<StudioTask | null>(null);
  const [sessionStatus, setSessionStatus] = useState<"loading" | "available" | "unavailable">("loading");
  const [connections, setConnections] = useState<readonly StudioConnection[]>([]);
  const [capabilities, setCapabilities] = useState<StudioCapabilityStatus | null>(null);
  const [events, setEvents] = useState<readonly StudioTaskEvent[]>([]);
  const [history, setHistory] = useState<StudioSessionHistory>({ tasks: [], truncated: false });
  const [subscriptionStatus, setSubscriptionStatus] = useState<StudioSubscriptionStatus>("idle");
  const [subscriptionError, setSubscriptionError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const [preferredExecutor, setPreferredExecutor] = useState("");
  const usableExecutors = (capabilities?.executors ?? []).filter(item =>
    item.available && item.modes.some(mode => mode.restricted));
  const executor = preferredExecutor || usableExecutors[0]?.id || "";
  // 用户在选择器里点的那一次＝要写进 Session 档案的偏好；从档案回填时走
  // applyPreferredExecutor，否则每次切换会话都会把"回填"再当成一次用户选择写回去。
  const chooseExecutor = (value: string) => { setPreferredExecutor(value); onExecutorSelected?.(value); };
  const [saved, setSaved] = useState<{ artifact: StudioTask["artifact"]; revision: number } | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const taskIdRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const eventCursorRef = useRef(0);
  const operation = (kind: string) => `${kind}:${crypto.randomUUID()}`;
  const taskRef = useRef<StudioTask | null>(null);
  const applyTask = (next: StudioTask) => {
    if (taskIdRef.current !== next.taskId) {
      eventCursorRef.current = 0; setEvents([]);
      // 上一条任务落史：本会话内连续创作不断线；重开会话时由宿主历史水合。
      const previous = taskRef.current;
      if (previous) {
        setHistory(current => ({ ...current,
          tasks: [studioSessionTaskFromTask(previous), ...current.tasks.filter(item => item.taskId !== previous.taskId)] }));
      }
    }
    taskIdRef.current = next.taskId;
    taskRef.current = next;
    setTask(next);
    // 历史中的同名条目跟随相位推进（时间线徽标与当前状态一致）。
    setHistory(current => current.tasks.some(item => item.taskId === next.taskId)
      ? { ...current, tasks: current.tasks.map(item => item.taskId === next.taskId ? { ...item, phase: next.phase } : item) }
      : current);
  };
  const refreshTask = async () => {
    const taskId = taskIdRef.current;
    const generation = generationRef.current;
    if (!taskId) return;
    const next = parseStudioTask(await request("creator.task.status", { taskId }));
    if (generation === generationRef.current && taskIdRef.current === taskId) applyTask(next);
  };

  useEffect(() => {
    const generation = ++generationRef.current;
    sessionIdRef.current = null; taskIdRef.current = null; eventCursorRef.current = 0;
    taskRef.current = null;
    setTask(null); setEvents([]); setError(""); setConnectionError(""); setConnections([]); setCapabilities(null);
    setHistory({ tasks: [], truncated: false });
    if (!enabled || !scope) { setSessionStatus("unavailable"); return; }
    setSessionStatus("loading");
    let heartbeat: number | undefined;
    const scopeId = scope.kind === "creator-city" ? scope.cityId : scope.kind === "creator-story" ? scope.storyId : scope.projectId;
    const refreshConnections = async (sessionId: string) => {
      const [connectionRows, capabilityRows] = await Promise.all([
        request("creator.connection.status", {}), request("creator.capabilities.status", {}),
      ]);
      if (generation !== generationRef.current) return;
      setConnections(parseStudioConnections(connectionRows));
      setCapabilities(parseStudioCapabilityStatus(capabilityRows));
      setConnectionError(""); sessionIdRef.current = sessionId;
    };
    void (async () => {
      try {
        const opened = await request<{ sessionId: string; jobs?: unknown[] }>("creator.session.open", {
          agentId: "creator-studio-local", ...(scope.kind === "creator-city" ? { cityId: scopeId } : { projectId: scopeId }), ...(sessionId ? { sessionId } : {}),
          executor: "studio", transport: "studio-webview",
          capabilities: ["studio.webview", "preview.scene", "preview.game", "operation.review"],
        });
        if (generation !== generationRef.current) return;
        sessionIdRef.current = opened.sessionId;
        const existing = (opened.jobs ?? []).find(job => job && typeof job === "object" && (job as { kind?: unknown }).kind === "studio-task");
        if (existing) applyTask(parseStudioTask(existing));
        // 会话任务历史水合（S1 时间线；旧宿主无 tasks 字段时按空历史处理）。
        setHistory(parseStudioSessionHistory(opened));
        await refreshConnections(opened.sessionId);
        if (generation !== generationRef.current) return;
        setSessionStatus("available");
        heartbeat = window.setInterval(() => {
          const sessionId = sessionIdRef.current;
          if (!sessionId || generation !== generationRef.current) return;
          void (async () => {
            try {
              await request("creator.connection.heartbeat", { agentId: "creator-studio-local", sessionId, state: "online" });
              await refreshConnections(sessionId);
            } catch (cause) {
              if (generation === generationRef.current) setConnectionError(cause instanceof Error ? cause.message : "creator_connection_heartbeat_failed");
            }
          })();
        }, 5_000);
      } catch (cause) {
        if (generation === generationRef.current) {
          setSessionStatus("unavailable");
          setConnectionError(cause instanceof Error ? cause.message : "creator_session_unavailable");
        }
      }
    })();
    return () => { generationRef.current += 1; if (heartbeat !== undefined) window.clearInterval(heartbeat); };
  }, [enabled, scope?.kind, scope && ("projectId" in scope ? scope.projectId : "cityId" in scope ? scope.cityId : scope.storyId), sessionId, request]);

  useEffect(() => {
    const taskId = task?.taskId;
    if (!taskId || sessionStatus !== "available") { setSubscriptionStatus("idle"); return; }
    let stopped = false;
    let retry: number | undefined;
    setSubscriptionStatus("connecting"); setSubscriptionError("");
    const pause = (ms: number) => new Promise<void>(resolve => { retry = window.setTimeout(resolve, ms); });
    void (async () => {
      while (!stopped && taskIdRef.current === taskId) {
        try {
          const batch = parseStudioEventBatch(await request("creator.events.subscribe", {
            taskId, afterEventId: eventCursorRef.current, limit: 50, timeoutMs: 15_000,
          }));
          if (stopped || taskIdRef.current !== taskId) return;
          eventCursorRef.current = batch.nextAfterEventId;
          if (batch.events.length > 0) {
            setEvents(current => mergeStudioEvents(current, batch.events));
            await refreshTask();
          }
          setSubscriptionStatus("live"); setSubscriptionError("");
        } catch (cause) {
          if (stopped || taskIdRef.current !== taskId) return;
          setSubscriptionStatus("reconnecting");
          setSubscriptionError(cause instanceof Error ? cause.message : "creator_event_subscription_failed");
          await pause(1_000);
        }
      }
    })();
    return () => { stopped = true; if (retry !== undefined) window.clearTimeout(retry); };
  }, [task?.taskId, sessionStatus, request]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "creator_task_failed"); }
    finally { setBusy(false); }
  };
  /** 目标 → 建任务 + 提交默认计划；返回已提交的任务供快速通道继续批准/执行。 */
  const planSubmit = async (goal: string): Promise<StudioTask> => {
    const requestText = normalizeStudioGoal(goal);
    const generation = generationRef.current;
    if (!scope || !sessionIdRef.current || !requestText) throw new Error("creator_task_scope_unavailable");
    const scopeId = scope.kind === "creator-city" ? scope.cityId : scope.kind === "creator-story" ? scope.storyId : scope.projectId;
    const artifact = { kind: scope.kind, [scope.kind === "creator-city" ? "cityId" : scope.kind === "creator-story" ? "storyId" : "projectId"]: scopeId, expectedRevision: scope.revision };
    const created = parseStudioTask(await request("creator.task.create", {
      sessionId: sessionIdRef.current, goal: requestText, humanRequest: requestText, artifact,
      acceptanceCriteria: [
        { criterionId: "agent-preview", description: "必须生成真实 Preview 证据", requiredEvidenceKind: "preview" },
        { criterionId: "manual-review", description: "人工审阅真实证据并确认结果", requiredEvidenceKind: "human-note" },
      ], operationId: operation("goal-create"),
    }));
    if (generation === generationRef.current) applyTask(created);
    return parseStudioTask(await request("creator.task.plan.submit", {
      taskId: created.taskId, expectedPlanRevision: 1, expectedArtifactRevision: scope.revision,
      steps: defaultStudioPlanSteps(), operationId: operation("plan-submit"),
    }));
  };
  const createGoal = async (goal: string) => run(async () => {
    applyTask(await planSubmit(goal));
  });
  /** 快速通道：默认计划不携带信息，提交即批准并执行；配额同意就是这一次点击。 */
  const startTask = async (goal: string, selected: string, includeViewport = false) => run(async () => {
    if (!usableExecutors.some(item => item.id === selected) || selected !== executor) throw new Error("请选择支持受限提案的 Agent。");
    const generation = generationRef.current;
    const submitted = await planSubmit(goal);
    const approved = parseStudioTask(await request("creator.task.plan.approve", {
      taskId: submitted.taskId, planRevision: submitted.planRevision, expectedArtifactRevision: submitted.artifact.expectedRevision, operationId: operation("plan-approve"),
    }));
    if (generation !== generationRef.current) return;
    applyTask(approved);
    try {
      const executed = parseStudioTask(await request("creator.task.execute", {
        taskId: approved.taskId, expectedPlanRevision: approved.planRevision, expectedArtifactRevision: approved.artifact.expectedRevision,
        operationId: operation("task-execute"), timeoutMs: 300_000, executor: selected, mode: "restricted", includeViewport: includeViewport && hasIsolatedViewport,
      }));
      if (generation === generationRef.current) applyTask(executed);
    } catch (error) {
      await refreshTask();
      throw error;
    }
  });
  const approvePlan = async () => run(async () => {
    if (!task) return;
    applyTask(parseStudioTask(await request("creator.task.plan.approve", {
      taskId: task.taskId, planRevision: task.planRevision, expectedArtifactRevision: task.artifact.expectedRevision, operationId: operation("plan-approve"),
    })));
  });
  const revisePlan = async () => run(async () => {
    if (!task) return;
    applyTask(parseStudioTask(await request("creator.task.plan.submit", {
      taskId: task.taskId, expectedPlanRevision: task.planRevision + 1, expectedArtifactRevision: task.artifact.expectedRevision,
      steps: defaultStudioPlanSteps(), operationId: operation("plan-revise"),
    })));
  });
  const executeTask = async (selected: string, includeViewport = false) => run(async () => {
    if (!task || !usableExecutors.some(item => item.id === selected) || selected !== executor) return;
    const generation = generationRef.current;
    try {
      const executed = parseStudioTask(await request("creator.task.execute", {
        taskId: task.taskId, expectedPlanRevision: task.planRevision, expectedArtifactRevision: task.artifact.expectedRevision,
        operationId: operation("task-execute"), timeoutMs: 90_000, executor: selected, mode: "restricted", includeViewport: includeViewport && hasIsolatedViewport,
      }));
      if (generation === generationRef.current) applyTask(executed);
    } catch (error) {
      await refreshTask();
      throw error;
    }
  });
  /** R1 统一确认：UI 只传标识；Host 完成预览核对、作品提交、证据与任务终态。
   *  不走 run() 吞错：失败原样返回给变更卡，重试复用同一 operationId（Host 回执幂等）。 */
  const confirmSave = async (previewId: string, reviewerNote: string): Promise<{ ok: boolean; committedRevision?: number; error?: string }> => {
    if (!task) return { ok: false, error: "no task" };
    setBusy(true); setError("");
    try {
      const generation = generationRef.current;
      const raw = await request<Record<string, unknown>>("creator.task.confirm_save", {
        taskId: task.taskId, planRevision: task.planRevision, previewId,
        expectedArtifactRevision: task.artifact.expectedRevision,
        operationId: `confirm:${task.taskId}:${task.planRevision}`, reviewerNote,
      });
      const confirm = raw.confirm as { committedRevision?: unknown; taskId?: unknown; previewId?: unknown } | undefined;
      const revision = confirm?.committedRevision;
      const next = parseStudioTask(raw);
      if (next.taskId !== task.taskId || next.phase !== "accepted"
        || confirm?.taskId !== task.taskId || confirm?.previewId !== previewId
        || typeof revision !== "number" || !Number.isSafeInteger(revision)) {
        throw new Error("creator_task_confirm_receipt_invalid");
      }
      if (generation === generationRef.current && taskIdRef.current === task.taskId) {
        applyTask(next);
        setSaved({ artifact: task.artifact, revision });
      }
      return { ok: true, committedRevision: revision };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "creator_task_confirm_failed";
      setError(message);
      try { await refreshTask(); } catch { /* 刷新失败不掩盖原始错误 */ }
      return { ok: false, error: message };
    } finally { setBusy(false); }
  };
  const appendEvidence = async (summary: string) => run(async () => {
    if (!task || !summary.trim()) return;
    applyTask(parseStudioTask(await request("creator.task.evidence.append", {
      taskId: task.taskId, planRevision: task.planRevision, expectedArtifactRevision: task.artifact.expectedRevision,
      criterionId: "manual-review", kind: "human-note", trustLevel: "creator-declared", summary: summary.trim(), stepId: "human-review", operationId: operation("evidence-append"),
    })));
  });
  const acceptReview = async (reviewerNote: string) => run(async () => {
    if (!task) return;
    applyTask(parseStudioTask(await request("creator.task.review.accept", {
      taskId: task.taskId, planRevision: task.planRevision, expectedArtifactRevision: task.artifact.expectedRevision, reviewerNote: reviewerNote.trim(), operationId: operation("review-accept"),
    })));
  });
  const rejectReview = async (reason: string) => run(async () => {
    if (!task) return;
    applyTask(parseStudioTask(await request("creator.task.review.reject", {
      taskId: task.taskId, planRevision: task.planRevision, expectedArtifactRevision: task.artifact.expectedRevision, reason: reason.trim(), operationId: operation("review-reject"),
    })));
  });
  const cancelTask = async () => {
    if (!task || cancelling) return;
    setCancelling(true); setError("");
    try { applyTask(parseStudioTask(await request("creator.task.cancel", { taskId: task.taskId, operationId: operation("task-cancel") }))); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "creator_task_failed"); }
    finally { setCancelling(false); }
  };

  return { task, saved, history, sessionStatus, connections, capabilities, events, subscriptionStatus, subscriptionError, connectionError,
    viewportAttachmentScope: hasIsolatedViewport && scope
      ? JSON.stringify(scope) : null,
    busy, cancelling, error, executor, setExecutor: chooseExecutor, applyPreferredExecutor: setPreferredExecutor,
    createGoal, startTask, approvePlan, revisePlan, executeTask, confirmSave, appendEvidence, acceptReview, rejectReview, cancelTask, refreshTask };
}

export type StudioTaskController = ReturnType<typeof useStudioTasks>;
