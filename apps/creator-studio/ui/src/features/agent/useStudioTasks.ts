import { useEffect, useRef, useState } from "react";
import type { CreatorRequest } from "../../adapters/creatorHost";
import {
  defaultStudioPlanSteps, mergeStudioEvents, parseStudioCapabilityStatus, parseStudioConnections, parseStudioEventBatch, parseStudioTask,
  type StudioCapabilityStatus, type StudioConnection, type StudioTask, type StudioTaskEvent,
} from "../../contracts/studioTask";

type TaskProject = Readonly<{ projectId: string; revision: number }> | null;
export type StudioSubscriptionStatus = "idle" | "connecting" | "live" | "reconnecting";

export function useStudioTasks(request: CreatorRequest, project: TaskProject) {
  const [task, setTask] = useState<StudioTask | null>(null);
  const [sessionStatus, setSessionStatus] = useState<"loading" | "available" | "unavailable">("loading");
  const [connections, setConnections] = useState<readonly StudioConnection[]>([]);
  const [capabilities, setCapabilities] = useState<StudioCapabilityStatus | null>(null);
  const [events, setEvents] = useState<readonly StudioTaskEvent[]>([]);
  const [subscriptionStatus, setSubscriptionStatus] = useState<StudioSubscriptionStatus>("idle");
  const [subscriptionError, setSubscriptionError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const sessionIdRef = useRef<string | null>(null);
  const taskIdRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const eventCursorRef = useRef(0);
  const operation = (kind: string) => `${kind}:${crypto.randomUUID()}`;
  const applyTask = (next: StudioTask) => {
    if (taskIdRef.current !== next.taskId) { eventCursorRef.current = 0; setEvents([]); }
    taskIdRef.current = next.taskId; setTask(next);
  };
  const refreshTask = async () => {
    if (!taskIdRef.current) return;
    applyTask(parseStudioTask(await request("creator.task.status", { taskId: taskIdRef.current })));
  };

  useEffect(() => {
    const generation = ++generationRef.current;
    sessionIdRef.current = null; taskIdRef.current = null; eventCursorRef.current = 0;
    setTask(null); setEvents([]); setError(""); setConnectionError(""); setConnections([]); setCapabilities(null);
    if (!project) { setSessionStatus("unavailable"); return; }
    setSessionStatus("loading");
    let heartbeat: number | undefined;
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
          agentId: "creator-studio-local", projectId: project.projectId,
          executor: "studio", transport: "studio-webview",
          capabilities: ["studio.webview", "preview.scene", "preview.game", "operation.review"],
        });
        if (generation !== generationRef.current) return;
        sessionIdRef.current = opened.sessionId;
        const existing = (opened.jobs ?? []).find(job => job && typeof job === "object" && (job as { kind?: unknown }).kind === "studio-task");
        if (existing) applyTask(parseStudioTask(existing));
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
  }, [project?.projectId, request]);

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
  const createGoal = async (goal: string) => run(async () => {
    if (!project || !sessionIdRef.current || !goal.trim()) return;
    const artifact = { kind: "creator-project", projectId: project.projectId, expectedRevision: project.revision };
    const created = parseStudioTask(await request("creator.task.create", {
      sessionId: sessionIdRef.current, goal: goal.trim(), humanRequest: goal.trim(), artifact,
      acceptanceCriteria: [
        { criterionId: "agent-preview", description: "必须生成真实 Preview 证据", requiredEvidenceKind: "preview" },
        { criterionId: "manual-review", description: "人工审阅真实证据并确认结果", requiredEvidenceKind: "human-note" },
      ], operationId: operation("goal-create"),
    }));
    applyTask(created);
    applyTask(parseStudioTask(await request("creator.task.plan.submit", {
      taskId: created.taskId, expectedPlanRevision: 1, expectedArtifactRevision: project.revision,
      steps: defaultStudioPlanSteps(), operationId: operation("plan-submit"),
    })));
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
  const executeTask = async () => run(async () => {
    if (!task) return;
    try {
      applyTask(parseStudioTask(await request("creator.task.execute", {
        taskId: task.taskId, expectedPlanRevision: task.planRevision, expectedArtifactRevision: task.artifact.expectedRevision,
        operationId: operation("task-execute"), timeoutMs: 90_000,
      })));
    } catch (error) {
      await refreshTask();
      throw error;
    }
  });
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

  return { task, sessionStatus, connections, capabilities, events, subscriptionStatus, subscriptionError, connectionError,
    busy, cancelling, error, createGoal, approvePlan, revisePlan, executeTask, appendEvidence, acceptReview, rejectReview, cancelTask, refreshTask };
}

export type StudioTaskController = ReturnType<typeof useStudioTasks>;
