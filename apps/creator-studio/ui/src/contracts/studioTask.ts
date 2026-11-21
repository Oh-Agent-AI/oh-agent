export type StudioTaskPhase = "planning" | "awaiting-plan-approval" | "ready" | "executing" | "validating" | "awaiting-review" | "accepted" | "rejected" | "failed" | "cancelled" | "unknown";
export type StudioTaskStep = Readonly<{ stepId: string; ordinal: number; title: string; kind: "analysis" | "change" | "validation" | "review" }>;
export type StudioTaskEvidence = Readonly<{ evidenceId: string; planRevision: number; stepId: string | null; criterionId: string; kind: string; trustLevel: string; summary: string; data: unknown; createdAtMs: number }>;
export type StudioTask = Readonly<{
  taskId: string;
  sessionId: string;
  goalId: string;
  goalRevision: number;
  humanRequest: string;
  artifact: Readonly<{ kind: "creator-project"; projectId: string; expectedRevision: number }>;
  planRevision: number;
  stepIds: readonly string[];
  phase: StudioTaskPhase;
  proposedChangeSetId: string | null;
  lastEvidenceId: string | null;
  steps: readonly StudioTaskStep[];
  evidence: readonly StudioTaskEvidence[];
}>;

const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function parseStudioTask(value: unknown): StudioTask {
  const row = object(value);
  const taskId = text(row?.taskId);
  const goalId = text(row?.goalId);
  const humanRequest = text(row?.humanRequest);
  const artifact = object(row?.artifact);
  const projectId = text(artifact?.projectId);
  const expectedRevision = count(artifact?.expectedRevision);
  const planRevision = count(row?.planRevision);
  const goalRevision = count(row?.goalRevision);
  if (!row || !taskId || !goalId || !humanRequest || artifact?.kind !== "creator-project" || !projectId || expectedRevision === null || planRevision === null || goalRevision === null) throw new Error("creator_task_invalid");
  const phases = ["planning", "awaiting-plan-approval", "ready", "executing", "validating", "awaiting-review", "accepted", "rejected", "failed", "cancelled"];
  const phase = phases.includes(String(row.phase)) ? String(row.phase) as StudioTaskPhase : "unknown";
  const stepIds = Array.isArray(row.stepIds) ? row.stepIds.filter((id): id is string => typeof id === "string") : [];
  const steps = Array.isArray(row.steps) ? row.steps.map(item => {
    const step = object(item);
    const stepId = text(step?.stepId);
    const ordinal = count(step?.ordinal);
    const title = text(step?.title);
    const kind = step?.kind === "analysis" || step?.kind === "change" || step?.kind === "validation" || step?.kind === "review" ? step.kind : null;
    if (!stepId || ordinal === null || !title || !kind) throw new Error("creator_task_invalid");
    return Object.freeze({ stepId, ordinal, title, kind });
  }) : [];
  const evidence = Array.isArray(row.evidence) ? row.evidence.map(item => {
    const entry = object(item);
    const evidenceId = text(entry?.evidenceId);
    const planRevision = count(entry?.planRevision);
    const criterionId = text(entry?.criterionId);
    const kind = text(entry?.kind);
    const trustLevel = text(entry?.trustLevel);
    const summary = text(entry?.summary);
    const createdAtMs = count(entry?.createdAtMs);
    if (!entry || !evidenceId || planRevision === null || !criterionId || !kind || !trustLevel || !summary || createdAtMs === null) throw new Error("creator_task_invalid");
    return Object.freeze({ evidenceId, planRevision, stepId: text(entry.stepId), criterionId, kind, trustLevel, summary, data: entry.data ?? null, createdAtMs });
  }) : [];
  return Object.freeze({ taskId, sessionId: text(row.sessionId) ?? "", goalId, goalRevision, humanRequest,
    artifact: Object.freeze({ kind: "creator-project", projectId, expectedRevision }), planRevision, stepIds: Object.freeze(stepIds), phase,
    proposedChangeSetId: text(row.proposedChangeSetId), lastEvidenceId: text(row.lastEvidenceId), steps: Object.freeze(steps), evidence: Object.freeze(evidence) });
}

export function defaultStudioPlanSteps(): readonly StudioTaskStep[] {
  return [
    { stepId: "review-goal", ordinal: 0, title: "核对目标、项目范围与验收标准", kind: "analysis" },
    { stepId: "validate-city", ordinal: 1, title: "在真实 City 中验证当前已保存 revision", kind: "validation" },
    { stepId: "human-review", ordinal: 2, title: "人工审阅证据并决定是否接受", kind: "review" },
  ];
}

export function canApproveTaskPlan(task: StudioTask | null): boolean {
  return task?.phase === "awaiting-plan-approval";
}
export function canReviewTask(task: StudioTask | null): boolean {
  return task?.phase === "awaiting-review";
}
export function canCancelTask(task: StudioTask | null): boolean {
  return task !== null && !["accepted", "rejected", "failed", "cancelled"].includes(task.phase);
}
export function canReviseTaskPlan(task: StudioTask | null): boolean {
  return task !== null && ["ready", "awaiting-review", "rejected", "failed", "cancelled"].includes(task.phase);
}

export function studioPhaseLabel(phase: StudioTaskPhase): string {
  return ({
    planning: "规划中", "awaiting-plan-approval": "等待计划批准", ready: "计划已批准，执行器未连接", executing: "执行中",
    validating: "验证中", "awaiting-review": "等待人工验收", accepted: "已接受", rejected: "已退回", failed: "失败", cancelled: "已取消", unknown: "状态未知",
  })[phase];
}
