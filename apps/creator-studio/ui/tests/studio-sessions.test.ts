import test from "node:test";
import assert from "node:assert/strict";
import {
  applyStudioSessionPatch, filterStudioSessions, nextStudioSessionAfterArchive, nextStudioSessionLabel, parseStudioSessionList, readSelectedStudioSession,
  readStudioSessionDrafts, rememberSelectedStudioSession, rememberStudioSessionDraft, sessionLabelValue, takeLegacyStudioSessionDraft,
} from "../src/features/session/studioSessions.ts";

const row = {
  sessionId: "csession-a", label: "城市布局", state: "open", createdAtMs: 1, updatedAtMs: 2,
  latestTask: { taskId: "task-a", phase: "awaiting-review", humanRequest: "调整出租车", expectedRevision: 3 },
};

test("Studio Session lists preserve task and revision context and reject malformed rows", () => {
  // 旧 Host 的行没有 draft/preferredExecutor：缺列按空串读，不能让整份列表解析失败。
  const sessions = parseStudioSessionList({ sessions: [row, { ...row, sessionId: "csession-b", label: "侦探剧情", latestTask: null }] });
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]?.latestTask?.expectedRevision, 3);
  assert.equal(sessions[1]?.latestTask, null);
  assert.equal(sessions[0]?.draft, "");
  assert.equal(sessions[0]?.preferredExecutor, "");
  assert.throws(() => parseStudioSessionList({ sessions: [{ ...row, sessionId: "" }] }), /creator_session_list_invalid/);
  assert.throws(() => parseStudioSessionList({ sessions: [{ ...row, latestTask: { ...row.latestTask, expectedRevision: -1 } }] }), /creator_session_list_invalid/);
  // 类型错了仍然拒绝：读不到可以降级，读到脏数据不能装作没事。
  assert.throws(() => parseStudioSessionList({ sessions: [{ ...row, draft: 7 }] }), /creator_session_list_invalid/);
  assert.throws(() => parseStudioSessionList({ sessions: [{ ...row, preferredExecutor: "x".repeat(129) }] }), /creator_session_list_invalid/);
});

test("Session profiles carry a Host draft and preferred executor per row", () => {
  const sessions = parseStudioSessionList({ sessions: [
    { ...row, draft: "把黄色出租车移到桥上", preferredExecutor: "acp:claude" },
    { ...row, sessionId: "csession-b", label: "侦探剧情", draft: "", preferredExecutor: "" },
  ] });
  assert.equal(sessions[0]?.draft, "把黄色出租车移到桥上");
  assert.equal(sessions[0]?.preferredExecutor, "acp:claude");
  // 乐观更新只换目标行，其他行保持同一引用（列表不整体重渲染）。
  const patched = applyStudioSessionPatch(sessions, "csession-a", { draft: "改到桥面", label: "出租车过桥" });
  assert.equal(patched[0]?.draft, "改到桥面");
  assert.equal(patched[0]?.label, "出租车过桥");
  assert.equal(patched[1], sessions[1]);
  assert.equal(patched[0]?.preferredExecutor, "acp:claude");
});

test("Session search matches label and the latest request, case-insensitively", () => {
  const sessions = parseStudioSessionList({ sessions: [
    { ...row, label: "城市布局", latestTask: { ...row.latestTask, humanRequest: "把出租车移到桥上" } },
    { ...row, sessionId: "csession-b", label: "Detective Story", latestTask: { ...row.latestTask, humanRequest: "加一段夜雨追逐" } },
    { ...row, sessionId: "csession-c", label: "车辆修复", latestTask: null },
  ] });
  assert.equal(filterStudioSessions(sessions, "  "), sessions);
  assert.equal(filterStudioSessions(sessions, "出租车").length, 1);
  assert.equal(filterStudioSessions(sessions, "detective").length, 1);
  assert.equal(filterStudioSessions(sessions, "追逐")[0]?.sessionId, "csession-b");
  assert.equal(filterStudioSessions(sessions, "车辆").length, 1);
  assert.equal(filterStudioSessions(sessions, "不存在").length, 0);
});

test("Session labels are normalized or rejected before they reach the Host", () => {
  assert.equal(sessionLabelValue("  城市布局  "), "城市布局");
  assert.equal(sessionLabelValue("a".repeat(80)), "a".repeat(80));
  assert.equal(sessionLabelValue("   "), null);
  assert.equal(sessionLabelValue("a".repeat(81)), null);
  assert.equal(sessionLabelValue("坏\u0007名字"), null);
});

test("Archiving the active session lands on another open session, never a closed one", () => {
  const sessions = parseStudioSessionList({ sessions: [
    { ...row, state: "open" }, { ...row, sessionId: "csession-b", state: "closed" }, { ...row, sessionId: "csession-c", state: "open" },
  ] });
  assert.equal(nextStudioSessionAfterArchive(sessions, "csession-a"), "csession-c");
  assert.equal(nextStudioSessionAfterArchive(sessions, "csession-c"), "csession-a");
  const onlyOne = parseStudioSessionList({ sessions: [{ ...row, state: "open" }, { ...row, sessionId: "csession-b", state: "closed" }] });
  assert.equal(nextStudioSessionAfterArchive(onlyOne, "csession-a"), null);
});

test("New session names take the first free number, archived rows included", () => {
  const named = (...labels: string[]) => parseStudioSessionList({ sessions: labels.map((label, index) =>
    ({ ...row, sessionId: `csession-${index}`, label })) });
  assert.equal(nextStudioSessionLabel(named()), "创作会话 1");
  assert.equal(nextStudioSessionLabel(named("创作会话 1")), "创作会话 2");
  // 归档两个再新建：不能又给"创作会话 1"（历史会话仍占着这个名字）。
  assert.equal(nextStudioSessionLabel(named("创作会话 1", "创作会话 2", "创作会话 3")), "创作会话 4");
  assert.equal(nextStudioSessionLabel(named("创作会话 1", "创作会话 3")), "创作会话 2");
  // 用户改过名的会话不占默认编号。
  assert.equal(nextStudioSessionLabel(named("出租车过桥", "侦探剧情")), "创作会话 1");
});

test("Session selection and composer drafts restore independently by Project and session", () => {
  const values = new Map<string, string>();
  const previous = globalThis.window;
  Object.assign(globalThis, { window: { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } } });
  try {
    rememberSelectedStudioSession("creator-project:project-a", "csession-a");
    rememberSelectedStudioSession("creator-project:project-b", "csession-b");
    rememberStudioSessionDraft("csession-a", "修改城市布局");
    rememberStudioSessionDraft("csession-b", "修改侦探剧情");
    assert.equal(readSelectedStudioSession("creator-project:project-a"), "csession-a");
    assert.equal(readSelectedStudioSession("creator-project:project-b"), "csession-b");
    assert.deepEqual(readStudioSessionDrafts(), { "csession-a": "修改城市布局", "csession-b": "修改侦探剧情" });
    // 迁移读走即删：否则旧本地值会在下次加载时反盖 Host 上的新草稿。
    assert.equal(takeLegacyStudioSessionDraft("csession-a"), "修改城市布局");
    assert.equal(takeLegacyStudioSessionDraft("csession-a"), null);
    assert.deepEqual(readStudioSessionDrafts(), { "csession-b": "修改侦探剧情" });
    rememberStudioSessionDraft("csession-b", "");
    assert.deepEqual(readStudioSessionDrafts(), {});
  } finally {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.assign(globalThis, { window: previous });
  }
});
