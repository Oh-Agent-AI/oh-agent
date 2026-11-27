export type StudioTaskPhase = "planning" | "awaiting-plan-approval" | "ready" | "executing" | "validating" | "awaiting-review" | "accepted" | "rejected" | "failed" | "cancelled" | "unknown";

export function normalizeStudioGoal(value: string) {
  return value.replace(/\p{Cc}+/gu, " ").trim();
}
export type StudioTaskStep = Readonly<{ stepId: string; ordinal: number; title: string; kind: "analysis" | "change" | "validation" | "review" }>;
export type StudioTaskEvidence = Readonly<{ evidenceId: string; planRevision: number; stepId: string | null; criterionId: string; kind: string; trustLevel: string; summary: string; data: unknown; createdAtMs: number }>;
/**
 * 宿主绑定的结构化目标对象（P1-5/PR03）。线上保持扁平 ref 形状
 * （entityId/entityKind/previewId/projectRevision + 可选 cityRevision/worldRevision）；
 * 按 entityKind 判别：City/场景实体绑定 City 快照（cityRevision + worldRevision 必在，
 * 宿主会对照权威快照核对），Story 实体没有 City 坐标系。宿主在 task.create/execute/
 * submit 三个入口做权威校验（成员资格、归属、revision），UI 只透传。
 */
export type StudioCityTargetRef = Readonly<{
  entityKind: "scene-model" | "scene-collider" | "scene-anchor" | "city-building" | "city-decor";
  entityId: string;
  previewId: string;
  projectRevision: number;
  cityRevision: number;
  worldRevision: string;
}>;
export type StudioStoryTargetRef = Readonly<{
  entityKind: "story-node" | "story-character";
  entityId: string;
  previewId: string;
  projectRevision: number;
}>;
export type StudioTargetRef = StudioCityTargetRef | StudioStoryTargetRef;
export function studioTaskScopeId(task: Pick<StudioTask, "artifact">): string {
  return task.artifact.projectId ?? task.artifact.cityId ?? task.artifact.storyId ?? "";
}
export type StudioTask = Readonly<{
  taskId: string;
  sessionId: string;
  goalId: string;
  goalRevision: number;
  humanRequest: string;
  artifact: Readonly<{ kind: "creator-project" | "creator-city" | "creator-story"; projectId?: string; cityId?: string; storyId?: string; expectedRevision: number }>;
  targetRefs: readonly StudioTargetRef[];
  planRevision: number;
  stepIds: readonly string[];
  phase: StudioTaskPhase;
  proposedChangeSetId: string | null;
  lastEvidenceId: string | null;
  execution: Readonly<{ status: string; previewId?: string }> | null;
  steps: readonly StudioTaskStep[];
  evidence: readonly StudioTaskEvidence[];
}>;

const text = (value: unknown, maxLength = 512): string | null => typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const TASK_PHASES = ["planning", "awaiting-plan-approval", "ready", "executing", "validating", "awaiting-review", "accepted", "rejected", "failed", "cancelled"];
const taskPhase = (value: unknown): StudioTaskPhase => TASK_PHASES.includes(String(value)) ? String(value) as StudioTaskPhase : "unknown";

const CITY_TARGET_REF_KINDS: readonly StudioCityTargetRef["entityKind"][] = ["scene-model", "scene-collider", "scene-anchor", "city-building", "city-decor"];
const STORY_TARGET_REF_KINDS: readonly StudioStoryTargetRef["entityKind"][] = ["story-node", "story-character"];
/**
 * 解析宿主回显的 targetRefs（PR03 权威校验后的既有线上形状）。不符合契约的条目
 * 丢弃、不拖垮整个任务投影（与 stepIds 的宽容过滤一致）；宿主归一化后缺失的
 * cityRevision/worldRevision 为 null，City/场景条目缺这两项即视为不完整而丢弃。
 */
export function parseStudioTargetRefs(value: unknown): readonly StudioTargetRef[] {
  if (!Array.isArray(value)) return [];
  const refs: StudioTargetRef[] = [];
  for (const item of value) {
    const row = object(item);
    const entityId = text(row?.entityId, 128);
    const entityKind = text(row?.entityKind, 128);
    const previewId = text(row?.previewId, 128);
    const projectRevision = count(row?.projectRevision);
    if (!row || !entityId || !entityKind || !previewId || projectRevision === null) continue;
    const storyKind = STORY_TARGET_REF_KINDS.find(kind => kind === entityKind);
    if (storyKind) {
      refs.push(Object.freeze({ entityKind: storyKind, entityId, previewId, projectRevision }));
      continue;
    }
    const cityKind = CITY_TARGET_REF_KINDS.find(kind => kind === entityKind);
    const cityRevision = count(row?.cityRevision);
    const worldRevision = text(row?.worldRevision, 256);
    if (!cityKind || cityRevision === null || !worldRevision) continue;
    refs.push(Object.freeze({ entityKind: cityKind, entityId, previewId, projectRevision, cityRevision, worldRevision }));
  }
  return Object.freeze(refs);
}

export function parseStudioTask(value: unknown): StudioTask {
  const row = object(value);
  const taskId = text(row?.taskId);
  const goalId = text(row?.goalId);
  const humanRequest = text(row?.humanRequest, 4_000);
  const artifact = object(row?.artifact);
  if (!artifact || (artifact.kind !== "creator-project" && artifact.kind !== "creator-city" && artifact.kind !== "creator-story")) throw new Error("creator_task_invalid");
  if (Object.keys(artifact).length !== 3) throw new Error("creator_task_invalid");
  const kind = artifact.kind;
  const idKey = kind === "creator-city" ? "cityId" : kind === "creator-story" ? "storyId" : "projectId";
  const scopeId = text(artifact[idKey]);
  const expectedRevision = count(artifact?.expectedRevision);
  const planRevision = count(row?.planRevision);
  const goalRevision = count(row?.goalRevision);
  if (!row || !taskId || !goalId || !humanRequest || !scopeId || expectedRevision === null || planRevision === null || goalRevision === null) throw new Error("creator_task_invalid");
  const phase = taskPhase(row.phase);
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
    artifact: Object.freeze({ kind, [idKey]: scopeId, expectedRevision }), targetRefs: parseStudioTargetRefs(row.targetRefs), planRevision, stepIds: Object.freeze(stepIds), phase,
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
export type StudioAcpAgent = Readonly<{ id: string; name: string }>;
export type StudioExecutorMode = Readonly<{ id: string; restricted: boolean; label: string; current?: boolean }>;
export type StudioExecutorStatus = Readonly<{ id: string; name: string; available: boolean; modes: readonly StudioExecutorMode[]; detail?: string }>;
export type StudioCapabilityStatus = Readonly<{ studioOnline: boolean; acpAgents: readonly StudioAcpAgent[]; executors: readonly StudioExecutorStatus[]; connections: readonly StudioConnection[]; capabilities: readonly StudioCapability[] }>;

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
  // acpAgents 可选（旧宿主无此字段）：执行器下拉的注册表条目。
  const acpAgents = Array.isArray(row.acpAgents) ? row.acpAgents.map(item => {
    const agent = object(item); const agentId = text(agent?.id);
    if (!agent || !agentId) throw new Error("creator_capability_invalid");
    return Object.freeze({ id: agentId, name: text(agent.name) ?? agentId });
  }) : [];
  // executors 可选（旧宿主无此字段）：探测到的执行器可用性与权限模式。
  const executors = Array.isArray(row.executors) ? row.executors.map(item => {
    const executor = object(item); const executorId = text(executor?.id);
    if (!executor || !executorId || typeof executor.available !== "boolean") throw new Error("creator_capability_invalid");
    const modes = Array.isArray(executor.modes) ? executor.modes.map(mode => {
      const parsed = object(mode); const modeId = text(parsed?.id);
      if (!parsed || !modeId || typeof parsed.restricted !== "boolean") throw new Error("creator_capability_invalid");
      return Object.freeze({ id: modeId, restricted: parsed.restricted, label: text(parsed.label) ?? modeId, ...(parsed.current === true ? { current: true } : {}) });
    }) : [];
    return Object.freeze({ id: executorId, name: text(executor.name) ?? executorId, available: executor.available, modes: Object.freeze(modes), ...(text(executor.detail) ? { detail: text(executor.detail)! } : {}) });
  }) : [];
  return Object.freeze({ studioOnline: row.studioOnline, acpAgents: Object.freeze(acpAgents), executors: Object.freeze(executors), connections: parseStudioConnections(row), capabilities: Object.freeze(checked) });
}

export function defaultStudioPlanSteps(): readonly StudioTaskStep[] {
  return [
    { stepId: "review-goal", ordinal: 0, title: "核对目标、项目范围与验收标准", kind: "analysis" },
    { stepId: "validate-city", ordinal: 1, title: "在真实 City 中验证当前已保存 revision", kind: "validation" },
    { stepId: "human-review", ordinal: 2, title: "人工审阅证据并决定是否接受", kind: "review" },
  ];
}

/** 默认模板计划不携带信息：快速通道自动批准，只有非默认计划（外部/agent 提议）才停闸。 */
export function isDefaultStudioPlan(task: Pick<StudioTask, "steps">): boolean {
  const defaults = defaultStudioPlanSteps();
  return task.steps.length === defaults.length
    && task.steps.every((step, index) => step.stepId === defaults[index]?.stepId && step.kind === defaults[index]?.kind);
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

/** 会话任务历史（宿主 creator.session.open/status 的 tasks 数组；newest-first、上限 30）。 */
export type StudioSessionTask = Readonly<{
  taskId: string;
  phase: StudioTaskPhase;
  humanRequest: string;
  artifactKind: string;
  expectedRevision: number | null;
  updatedAtMs: number | null;
}>;
export type StudioSessionHistory = Readonly<{ tasks: readonly StudioSessionTask[]; truncated: boolean }>;

export function parseStudioSessionHistory(value: unknown): StudioSessionHistory {
  const row = object(value);
  // tasks 可选（旧宿主无此字段）：缺省按空历史处理，UI 不因宿主旧版而失败。
  const tasks = Array.isArray(row?.tasks) ? row.tasks.map(item => {
    const task = object(item);
    const taskId = text(task?.taskId);
    const humanRequest = text(task?.humanRequest, 4_000);
    if (!task || !taskId || !humanRequest) throw new Error("creator_session_invalid");
    return Object.freeze({
      taskId, phase: taskPhase(task.phase), humanRequest,
      artifactKind: text(task.artifactKind) ?? "unknown",
      expectedRevision: count(task.expectedRevision),
      updatedAtMs: count(task.updatedAtMs),
    });
  }) : [];
  return Object.freeze({ tasks: Object.freeze(tasks), truncated: row?.tasksTruncated === true });
}

/** 把活动任务折算成历史条目（本会话内连续创作时落史；重开由宿主水合）。 */
export function studioSessionTaskFromTask(task: Pick<StudioTask, "taskId" | "phase" | "humanRequest" | "artifact">): StudioSessionTask {
  return Object.freeze({ taskId: task.taskId, phase: task.phase, humanRequest: task.humanRequest,
    artifactKind: task.artifact.kind, expectedRevision: task.artifact.expectedRevision, updatedAtMs: Date.now() });
}

/** 会话侧栏状态（T3 Sidebar.logic 优先级语义：待确认 > 失败 > 进行中 > 已结束 > 空闲）。 */
export type SessionRowStatus = "awaiting-confirmation" | "failed" | "working" | "settled" | "idle";
export function resolveSessionStatus(latestTask: Readonly<{ phase: string }> | null | undefined): SessionRowStatus {
  switch (latestTask?.phase) {
    case "awaiting-review": return "awaiting-confirmation";
    case "failed": return "failed";
    case "planning": case "awaiting-plan-approval": case "ready": case "executing": case "validating": return "working";
    case "accepted": case "rejected": case "cancelled": return "settled";
    default: return "idle";
  }
}
export const sessionStatusLabel: Record<SessionRowStatus, string> = {
  "awaiting-confirmation": "等待确认", failed: "失败", working: "进行中", settled: "已结束", idle: "空闲",
};
