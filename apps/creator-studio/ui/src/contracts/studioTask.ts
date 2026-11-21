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
  execution: Readonly<{ status: string; previewId?: string }> | null;
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
  const execution = object(row.execution);
  return Object.freeze({ taskId, sessionId: text(row.sessionId) ?? "", goalId, goalRevision, humanRequest,
    artifact: Object.freeze({ kind: "creator-project", projectId, expectedRevision }), planRevision, stepIds: Object.freeze(stepIds), phase,
    proposedChangeSetId: text(row.proposedChangeSetId), lastEvidenceId: text(row.lastEvidenceId), steps: Object.freeze(steps), evidence: Object.freeze(evidence),
    execution: execution ? Object.freeze({ status: text(execution.status) ?? "unknown", ...(text(execution.previewId) ? { previewId: text(execution.previewId)! } : {}) }) : null });
}

export type StudioConnectionState = "online" | "busy" | "degraded" | "offline";
export type StudioConnection = Readonly<{
  agentId: string; sessionId: string; executor: string; transport: string;
  state: StudioConnectionState; lastSeenMs: number; expiresAtMs: number;
  capabilities: readonly string[]; lastStableError: string | null;
}>;
export type StudioTaskEvent = Readonly<{
  eventId: number; taskId: string; seq: number;
  kind: "accepted" | "plan" | "progress" | "executor-output" | "preview" | "evidence" | "failure" | "cancel" | "review";
  source: string; trustLevel: string; summary: string; data: unknown; createdAtMs: number;
}>;
export type StudioEventBatch = Readonly<{ events: readonly StudioTaskEvent[]; nextAfterEventId: number; hasMore: boolean; waitTimedOut: boolean }>;
export type StudioCapability = Readonly<{ id: string; headless: boolean; requiresStudioWebView: boolean; note: string }>;
export type StudioCapabilityStatus = Readonly<{ studioOnline: boolean; connections: readonly StudioConnection[]; capabilities: readonly StudioCapability[] }>;

const connectionState = (value: unknown): StudioConnectionState => value === "online" || value === "busy" || value === "degraded" || value === "offline" ? value : "offline";
function parseConnection(value: unknown): StudioConnection {
  const row = object(value);
  const agentId = text(row?.agentId); const sessionId = text(row?.sessionId);
  const lastSeenMs = count(row?.lastSeenMs); const expiresAtMs = count(row?.expiresAtMs);
  if (!row || !agentId || !sessionId || lastSeenMs === null || expiresAtMs === null) throw new Error("creator_connection_invalid");
  return Object.freeze({ agentId, sessionId, executor: text(row.executor) ?? "unknown", transport: text(row.transport) ?? "unknown",
    state: connectionState(row.state), lastSeenMs, expiresAtMs,
    capabilities: Object.freeze(Array.isArray(row.capabilities) ? row.capabilities.filter((item): item is string => typeof item === "string") : []),
    lastStableError: text(row.lastStableError) });
}

export function parseStudioConnections(value: unknown): readonly StudioConnection[] {
  const rows = object(value)?.connections;
  if (!Array.isArray(rows)) throw new Error("creator_connection_invalid");
  return Object.freeze(rows.map(parseConnection));
}

export function parseStudioEventBatch(value: unknown): StudioEventBatch {
  const row = object(value); const events = row?.events;
  const nextAfterEventId = count(row?.nextAfterEventId);
  if (!row || !Array.isArray(events) || nextAfterEventId === null || typeof row.hasMore !== "boolean" || typeof row.waitTimedOut !== "boolean") throw new Error("creator_event_invalid");
  const kinds = ["accepted", "plan", "progress", "executor-output", "preview", "evidence", "failure", "cancel", "review"];
  const checked = events.map(item => {
    const event = object(item); const eventId = count(event?.eventId); const taskId = text(event?.taskId); const seq = count(event?.seq);
    const summary = text(event?.summary); const source = text(event?.source); const trustLevel = text(event?.trustLevel); const createdAtMs = count(event?.createdAtMs);
    if (!event || eventId === null || !taskId || seq === null || !summary || !source || !trustLevel || createdAtMs === null || !kinds.includes(String(event.kind))) throw new Error("creator_event_invalid");
    return Object.freeze({ eventId, taskId, seq, kind: String(event.kind) as StudioTaskEvent["kind"], source, trustLevel, summary, data: event.data ?? null, createdAtMs });
  });
  return Object.freeze({ events: Object.freeze(checked), nextAfterEventId, hasMore: row.hasMore, waitTimedOut: row.waitTimedOut });
}

export function mergeStudioEvents(current: readonly StudioTaskEvent[], incoming: readonly StudioTaskEvent[]): readonly StudioTaskEvent[] {
  const byId = new Map(current.map(event => [event.eventId, event]));
  for (const event of incoming) if (!byId.has(event.eventId)) byId.set(event.eventId, event);
  return Object.freeze([...byId.values()].sort((a, b) => a.seq - b.seq).slice(-200));
}

export function parseStudioCapabilityStatus(value: unknown): StudioCapabilityStatus {
  const row = object(value); const capabilities = row?.capabilities;
  if (!row || typeof row.studioOnline !== "boolean" || !Array.isArray(capabilities)) throw new Error("creator_capability_invalid");
  const checked = capabilities.map(item => {
    const capability = object(item); const id = text(capability?.id); const note = text(capability?.note);
    if (!capability || !id || !note || typeof capability.headless !== "boolean" || typeof capability.requiresStudioWebView !== "boolean") throw new Error("creator_capability_invalid");
    return Object.freeze({ id, note, headless: capability.headless, requiresStudioWebView: capability.requiresStudioWebView });
  });
  return Object.freeze({ studioOnline: row.studioOnline, connections: parseStudioConnections(row), capabilities: Object.freeze(checked) });
}

export function defaultStudioPlanSteps(): readonly StudioTaskStep[] {
  return [
    { stepId: "review-goal", ordinal: 0, title: "核对目标、项目范围与验收标准", kind: "analysis" },
    { stepId: "validate-city", ordinal: 1, title: "在真实 City 中验证当前已保存 revision", kind: "validation" },
    { stepId: "human-review", ordinal: 2, title: "人工审阅证据并决定是否接受", kind: "review" },
  ];
}

export function canExecuteTask(task: StudioTask | null): boolean {
  return task?.phase === "ready";
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
    planning: "规划中", "awaiting-plan-approval": "等待计划批准", ready: "计划已批准，可执行", executing: "执行中",
    validating: "验证中", "awaiting-review": "等待人工验收", accepted: "已接受", rejected: "已退回", failed: "失败", cancelled: "已取消", unknown: "状态未知",
  })[phase];
}
