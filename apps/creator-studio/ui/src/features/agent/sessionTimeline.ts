import type { StudioSessionTask, StudioTask, StudioTaskEvent, StudioTaskPhase } from "../../contracts/studioTask";

/**
 * 会话时间线行模型（T3 MessagesTimeline.logic 的领域化简化：discriminated union
 * 由纯函数派生，渲染只消费行）。行序 oldest-first，消息区自上而下阅读。
 */
export type TurnOutcomeState = "saved" | "failed" | "cancelled" | "rejected" | "open";
export type TurnOutcome = Readonly<{ state: TurnOutcomeState }>;
export type SettleTone = "working" | "info";

export type SessionTimelineRow =
  | Readonly<{ kind: "turn"; taskId: string; humanRequest: string; outcome: TurnOutcome }>
  | Readonly<{ kind: "active"; taskId: string }>
  | Readonly<{ kind: "settle"; id: string; label: string; detail: string | null; tone: SettleTone }>
  | Readonly<{ kind: "truncated" }>;

export const turnOutcomeLabel: Record<TurnOutcomeState, string> = {
  saved: "已保存", failed: "失败", cancelled: "已取消", rejected: "已退回", open: "未完成",
};

export function turnOutcome(phase: StudioTaskPhase): TurnOutcome {
  if (phase === "accepted") return Object.freeze({ state: "saved" });
  if (phase === "failed") return Object.freeze({ state: "failed" });
  if (phase === "cancelled") return Object.freeze({ state: "cancelled" });
  if (phase === "rejected") return Object.freeze({ state: "rejected" });
  return Object.freeze({ state: "open" });
}

/**
 * T3 ThreadNow 语义：settle 行区分「回合仍在收尾」与终态。终态由 turn 行的
 * 徽标表达；settle 行只覆盖仍在进行的相位（executing 的摘要来自最近事件流）。
 */
export function settleLine(task: Pick<StudioTask, "taskId" | "phase"> | null, events: readonly StudioTaskEvent[],
  subscriptionStatus: string): SessionTimelineRow | null {
  if (!task) return null;
  if (task.phase === "executing" || task.phase === "validating") {
    const progress = events.filter(event => event.kind === "progress" || event.kind === "executor-output");
    const detail = subscriptionStatus === "live" ? progress.at(-1)?.summary ?? null
      : subscriptionStatus === "reconnecting" ? "正在重连事件流…" : null;
    return Object.freeze({ kind: "settle", id: `settle-${task.taskId}`, label: task.phase === "validating" ? "验证中" : "执行中", detail, tone: "working" });
  }
  if (task.phase === "awaiting-review") {
    return Object.freeze({ kind: "settle", id: `settle-${task.taskId}`, label: "已生成修改", detail: "等待确认保存", tone: "info" });
  }
  if (task.phase === "ready" || task.phase === "awaiting-plan-approval") {
    return Object.freeze({ kind: "settle", id: `settle-${task.taskId}`,
      label: task.phase === "ready" ? "计划已批准" : "计划已提交", detail: task.phase === "ready" ? "可开始执行" : "等待批准", tone: "info" });
  }
  return null;
}

/** T3 activity-log 折叠纪律：失败恒显；过程事件折叠，只留最近一条摘要。 */
export type ActiveEventFold = Readonly<{ foldCount: number; latest: string | null; failures: readonly string[] }>;
export function foldActiveEvents(events: readonly StudioTaskEvent[]): ActiveEventFold {
  const progress = events.filter(event => event.kind !== "failure");
  const failures = events.filter(event => event.kind === "failure").map(event => event.summary);
  return Object.freeze({ foldCount: Math.max(0, progress.length - 1), latest: progress.at(-1)?.summary ?? null, failures: Object.freeze(failures) });
}

export function buildSessionTimelineRows(input: Readonly<{
  history: readonly StudioSessionTask[];
  truncated: boolean;
  activeTask: Pick<StudioTask, "taskId" | "phase" | "humanRequest"> | null;
  events: readonly StudioTaskEvent[];
  subscriptionStatus: string;
}>): readonly SessionTimelineRow[] {
  const rows: SessionTimelineRow[] = [];
  if (input.truncated) rows.push(Object.freeze({ kind: "truncated" }));
  const activeId = input.activeTask?.taskId ?? null;
  // 宿主历史是 newest-first → 时间线翻转成 oldest-first；活动任务由 active 块完整表达。
  for (const entry of [...input.history].reverse()) {
    if (entry.taskId === activeId) continue;
    rows.push(Object.freeze({ kind: "turn", taskId: entry.taskId, humanRequest: entry.humanRequest, outcome: turnOutcome(entry.phase) }));
  }
  if (input.activeTask) {
    rows.push(Object.freeze({ kind: "turn", taskId: input.activeTask.taskId, humanRequest: input.activeTask.humanRequest, outcome: turnOutcome(input.activeTask.phase) }));
    rows.push(Object.freeze({ kind: "active", taskId: input.activeTask.taskId }));
    const settle = settleLine(input.activeTask, input.events, input.subscriptionStatus);
    if (settle) rows.push(settle);
  }
  return Object.freeze(rows);
}
