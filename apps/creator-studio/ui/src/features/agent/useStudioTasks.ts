import { useEffect, useRef, useState } from "react";
import type { CreatorRequest } from "../../adapters/creatorHost";
import { defaultStudioPlanSteps, parseStudioTask, type StudioTask } from "../../contracts/studioTask";

type TaskProject = Readonly<{ projectId: string; revision: number }> | null;

export function useStudioTasks(request: CreatorRequest, project: TaskProject) {
  const [task, setTask] = useState<StudioTask | null>(null);
  const [sessionStatus, setSessionStatus] = useState<"loading" | "available" | "unavailable">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sessionIdRef = useRef<string | null>(null);
  const taskIdRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const operation = (kind: string) => `${kind}:${crypto.randomUUID()}`;
  const applyTask = (next: StudioTask) => { taskIdRef.current = next.taskId; setTask(next); };
  const refreshTask = async () => {
    if (!taskIdRef.current) return;
    applyTask(parseStudioTask(await request("creator.task.status", { taskId: taskIdRef.current })));
  };

  useEffect(() => {
    const generation = ++generationRef.current;
    sessionIdRef.current = null; taskIdRef.current = null; setTask(null); setError("");
    if (!project) { setSessionStatus("unavailable"); return; }
    setSessionStatus("loading");
    void (async () => {
      try {
        const opened = await request<{ sessionId: string; jobs?: unknown[] }>("creator.session.open", { agentId: "creator-studio-local", projectId: project.projectId });
        if (generation !== generationRef.current) return;
        sessionIdRef.current = opened.sessionId;
        const existing = (opened.jobs ?? []).find(job => job && typeof job === "object" && (job as { kind?: unknown }).kind === "studio-task");
        if (existing) applyTask(parseStudioTask(existing));
        setSessionStatus("available");
      } catch {
        if (generation === generationRef.current) setSessionStatus("unavailable");
      }
    })();
    return () => { generationRef.current += 1; };
  }, [project?.projectId, request]);
  useEffect(() => {
    if (task?.phase !== "executing") return;
    const timer = window.setInterval(() => void refreshTask(), 2_000);
    return () => window.clearInterval(timer);
  }, [task?.phase, task?.taskId]);

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
    setTask(current => current ? { ...current, phase: "executing" } : current);
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
  const cancelTask = async () => run(async () => {
    if (!task) return;
    applyTask(parseStudioTask(await request("creator.task.cancel", { taskId: task.taskId, operationId: operation("task-cancel") })));
  });

  return { task, sessionStatus, busy, error, createGoal, approvePlan, revisePlan, executeTask, appendEvidence, acceptReview, rejectReview, cancelTask, refreshTask };
}

export type StudioTaskController = ReturnType<typeof useStudioTasks>;
