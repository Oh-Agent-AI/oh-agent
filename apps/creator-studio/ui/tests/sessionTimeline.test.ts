import test from "node:test";
import assert from "node:assert/strict";
import { parseStudioSessionHistory, resolveSessionStatus, sessionStatusLabel, studioSessionTaskFromTask } from "../src/contracts/studioTask.ts";
import { buildSessionTimelineRows, foldActiveEvents, settleLine, turnOutcome, turnOutcomeLabel } from "../src/features/agent/sessionTimeline.ts";

const historyTask = (taskId: string, phase: string) => ({ taskId, phase, humanRequest: `需求 ${taskId}`, artifactKind: "creator-project", expectedRevision: 3, updatedAtMs: 100 });
const event = (eventId: number, kind: string, summary: string) => ({ eventId, taskId: "t-active", seq: eventId, kind, source: "studio", trustLevel: "host-observed", summary, data: null, createdAtMs: eventId });

test("session history parsing is bounded, typed, and tolerant of old hosts", () => {
  const parsed = parseStudioSessionHistory({ tasks: [historyTask("t-2", "accepted"), historyTask("t-1", "failed")], tasksTruncated: true });
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.tasks[0].phase, "accepted");
  assert.equal(parsed.tasks[1].taskId, "t-1");
  assert.equal(parsed.tasks[0].expectedRevision, 3);
  // 旧宿主没有 tasks 字段：按空历史处理，不抛错。
  assert.deepEqual(parseStudioSessionHistory({}), { tasks: [], truncated: false });
  assert.equal(parseStudioSessionHistory({ tasks: [{ taskId: "t-3", phase: "nonsense", humanRequest: "x" }] }).tasks[0].phase, "unknown");
  assert.throws(() => parseStudioSessionHistory({ tasks: [{ phase: "failed" }] }), /creator_session_invalid/);
});

test("turn outcomes map terminal phases and keep open phases honest", () => {
  assert.equal(turnOutcome("accepted").state, "saved");
  assert.equal(turnOutcome("failed").state, "failed");
  assert.equal(turnOutcome("cancelled").state, "cancelled");
  assert.equal(turnOutcome("rejected").state, "rejected");
  assert.equal(turnOutcome("executing").state, "open");
  assert.equal(turnOutcomeLabel.open, "未完成");
});

test("timeline rows render oldest-first, exclude the active task from history, and mark truncation", () => {
  const rows = buildSessionTimelineRows({
    history: [historyTask("t-new", "awaiting-review"), historyTask("t-old", "accepted")],
    truncated: true,
    activeTask: { taskId: "t-new", phase: "awaiting-review", humanRequest: "需求 t-new" },
    events: [],
    subscriptionStatus: "live",
  });
  assert.equal(rows[0].kind, "truncated");
  assert.deepEqual(rows[1], { kind: "turn", taskId: "t-old", humanRequest: "需求 t-old", outcome: { state: "saved" } });
  // 活动任务不重复出现在历史里，而是 turn + active 槽位成对出现。
  assert.deepEqual(rows[2], { kind: "turn", taskId: "t-new", humanRequest: "需求 t-new", outcome: { state: "open" } });
  assert.equal(rows[3].kind, "active");
  const settles = rows.filter(row => row.kind === "settle");
  assert.equal(settles.length, 1);
  assert.equal(settles[0].label, "已生成修改");
});

test("settle lines separate live execution from reconnection and terminal phases", () => {
  const executing = { taskId: "t-active", phase: "executing" as const };
  const live = settleLine(executing, [event(1, "progress", "读取世界"), event(2, "progress", "重建布局")], "live");
  assert.equal(live?.tone, "working");
  assert.equal(live?.detail, "重建布局");
  const reconnecting = settleLine(executing, [], "reconnecting");
  assert.equal(reconnecting?.detail, "正在重连事件流…");
  assert.equal(settleLine(executing, [], "idle")?.detail, null);
  assert.equal(settleLine({ taskId: "t", phase: "accepted" }, [], "live"), null);
  assert.equal(settleLine(null, [], "live"), null);
});

test("active event fold keeps failures visible and folds progress into one summary", () => {
  const fold = foldActiveEvents([
    event(1, "progress", "第一步"), event(2, "progress", "第二步"), event(3, "executor-output", "工具输出"),
    event(4, "failure", "预览校验失败"),
  ]);
  assert.equal(fold.failures.length, 1);
  assert.equal(fold.failures[0], "预览校验失败");
  assert.equal(fold.latest, "工具输出");
  assert.equal(fold.foldCount, 2);
  assert.deepEqual(foldActiveEvents([]), { foldCount: 0, latest: null, failures: [] });
});

test("studioSessionTaskFromTask snapshots the active task for the in-session history", () => {
  const task = { taskId: "t-9", phase: "awaiting-review" as const, humanRequest: "把出租车移到桥上",
    artifact: { kind: "creator-project" as const, projectId: "project-1", expectedRevision: 7 } };
  const entry = studioSessionTaskFromTask(task);
  assert.equal(entry.taskId, "t-9");
  assert.equal(entry.phase, "awaiting-review");
  assert.equal(entry.artifactKind, "creator-project");
  assert.equal(entry.expectedRevision, 7);
  assert.equal(typeof entry.updatedAtMs, "number");
});

test("session row status follows the T3 priority: awaiting-confirmation > failed > working > settled > idle", () => {
  assert.equal(resolveSessionStatus({ phase: "awaiting-review" }), "awaiting-confirmation");
  assert.equal(resolveSessionStatus({ phase: "failed" }), "failed");
  for (const phase of ["planning", "awaiting-plan-approval", "ready", "executing", "validating"]) {
    assert.equal(resolveSessionStatus({ phase }), "working");
  }
  for (const phase of ["accepted", "rejected", "cancelled"]) {
    assert.equal(resolveSessionStatus({ phase }), "settled");
  }
  assert.equal(resolveSessionStatus(null), "idle");
  assert.equal(resolveSessionStatus({ phase: "mystery" }), "idle");
  assert.equal(sessionStatusLabel["awaiting-confirmation"], "等待确认");
  assert.equal(sessionStatusLabel.failed, "失败");
  assert.equal(sessionStatusLabel.settled, "已结束");
});
