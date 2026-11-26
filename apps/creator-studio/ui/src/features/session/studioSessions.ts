export type StudioSessionScope = Readonly<
  { kind: "creator-project"; projectId: string } | { kind: "creator-city"; cityId: string }
>;

export type StudioSessionSummary = Readonly<{
  sessionId: string;
  label: string;
  state: "open" | "closed";
  createdAtMs: number;
  updatedAtMs: number;
  latestTask: Readonly<{ taskId: string; phase: string; humanRequest: string; expectedRevision: number | null }> | null;
  /** Host 持久化的未发送草稿；旧库行没有这一列时是空串。 */
  draft: string;
  /** Host 持久化的首选执行器；空串表示"跟随默认可用执行器"。 */
  preferredExecutor: string;
}>;

/** 只带要改的字段：Host 把"没提供"和"提供空串"区分开（空串 = 清空草稿）。 */
export type StudioSessionPatch = Readonly<{ label?: string; draft?: string; preferredExecutor?: string }>;

export const SESSION_LABEL_MAX = 80;
export const SESSION_DRAFT_MAX = 4_000;

const text = (value: unknown, max = 128): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
// 向后兼容：旧 Host 的 list 行没有 draft/preferredExecutor，缺列按空串处理，
// 但类型错了（数字、超长）仍然拒绝——"读不到"不等于"可以乱读"。
const optionalText = (value: unknown, max: number): boolean =>
  value === undefined || value === null || (typeof value === "string" && value.length <= max);

export function parseStudioSessionList(value: unknown): readonly StudioSessionSummary[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { sessions?: unknown }).sessions)) throw new Error("creator_session_list_invalid");
  return (value as { sessions: unknown[] }).sessions.map(raw => {
    const row = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!row || !text(row.sessionId) || !text(row.label, SESSION_LABEL_MAX) || (row.state !== "open" && row.state !== "closed")
      || !time(row.createdAtMs) || !time(row.updatedAtMs)
      || !optionalText(row.draft, SESSION_DRAFT_MAX) || !optionalText(row.preferredExecutor, 128)) throw new Error("creator_session_list_invalid");
    const task = row.latestTask && typeof row.latestTask === "object" && !Array.isArray(row.latestTask)
      ? row.latestTask as Record<string, unknown> : null;
    if (row.latestTask !== null && (!task || !text(task.taskId) || !text(task.phase, 32) || !text(task.humanRequest, 4_000)
      || (task.expectedRevision !== null && !time(task.expectedRevision)))) throw new Error("creator_session_list_invalid");
    return Object.freeze({ sessionId: row.sessionId, label: row.label, state: row.state,
      createdAtMs: row.createdAtMs, updatedAtMs: row.updatedAtMs,
      latestTask: task ? Object.freeze({ taskId: task.taskId as string, phase: task.phase as string,
        humanRequest: task.humanRequest as string, expectedRevision: task.expectedRevision as number | null }) : null,
      draft: typeof row.draft === "string" ? row.draft : "",
      preferredExecutor: typeof row.preferredExecutor === "string" ? row.preferredExecutor : "" });
  });
}

/** 标签规范化：去首尾空白后必须是 1..80 个字符且不含控制字符；不合法返回 null。 */
export function sessionLabelValue(label: string): string | null {
  const trimmed = label.trim();
  // eslint-disable-next-line no-control-regex
  return trimmed && trimmed.length <= SESSION_LABEL_MAX && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : null;
}

/** Session 搜索框：标签与最近一次需求都参与匹配，空查询返回原数组。 */
export function filterStudioSessions(sessions: readonly StudioSessionSummary[], query: string): readonly StudioSessionSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return sessions;
  return sessions.filter(session => `${session.label}\n${session.latestTask?.humanRequest ?? ""}`.toLocaleLowerCase().includes(needle));
}

/** 本地乐观更新一行（Host 回执前先把界面改对），其他行保持同一引用。 */
export function applyStudioSessionPatch(sessions: readonly StudioSessionSummary[], sessionId: string, patch: StudioSessionPatch): readonly StudioSessionSummary[] {
  return sessions.map(session => session.sessionId === sessionId ? Object.freeze({ ...session, ...patch }) : session);
}

/** 归档后应停在哪个 open 会话上；没有别的 open 会话时返回 null（调用方新建一个）。 */
export function nextStudioSessionAfterArchive(sessions: readonly StudioSessionSummary[], archivedSessionId: string): string | null {
  return sessions.find(session => session.state === "open" && session.sessionId !== archivedSessionId)?.sessionId ?? null;
}

/**
 * 新建会话的默认名："创作会话 N" 取**第一个没被占用的编号**（历史会话也算占用）。
 * 用 sessions.length+1 的话，归档两个再新建会重新得到"创作会话 1"，
 * 侧栏里就出现两个同名会话——恢复历史会话时根本分不出哪个是哪个。
 */
export function nextStudioSessionLabel(sessions: readonly StudioSessionSummary[]): string {
  const used = new Set(sessions.map(session => session.label));
  for (let index = 1; index <= 999; index += 1) {
    const label = `创作会话 ${index}`;
    if (!used.has(label)) return label;
  }
  return `创作会话 ${sessions.length + 1}`;
}

const selectionKey = "oh-agent.studio.session-selection.v1";
const draftsKey = "oh-agent.studio.session-drafts.v1";

function readMap(key: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([id, text]) => id.length <= 160 && typeof text === "string" && text.length <= SESSION_DRAFT_MAX).slice(-100));
  } catch { return {}; }
}

function writeMap(key: string, values: Record<string, string>): void {
  try { window.localStorage.setItem(key, JSON.stringify(values)); } catch { /* storage denial must not block the Host session */ }
}

export function readSelectedStudioSession(scopeKey: string): string | null {
  return readMap(selectionKey)[scopeKey] ?? null;
}

export function rememberSelectedStudioSession(scopeKey: string, sessionId: string): void {
  writeMap(selectionKey, { ...readMap(selectionKey), [scopeKey]: sessionId });
}

/**
 * 旧版本把草稿只镜像在 localStorage（Host 还没有草稿列）。Host 成为唯一权威后，
 * 这些草稿按会话迁移一次：读到非空就交给 Host 并删除本地副本，读走即删是关键——
 * 否则本地旧值会在下一次加载时把 Host 上的新草稿覆盖回去。
 */
export function takeLegacyStudioSessionDraft(sessionId: string): string | null {
  const drafts = readMap(draftsKey);
  const value = drafts[sessionId];
  if (!value) return null;
  delete drafts[sessionId];
  writeMap(draftsKey, drafts);
  return value;
}

/** 旧草稿镜像的只读视图（迁移诊断/测试用）；Host 档案才是呈现来源。 */
export function readStudioSessionDrafts(): Record<string, string> {
  return readMap(draftsKey);
}

/** 旧版本草稿镜像的写入端：Host 持久化之后只剩迁移种子（测试与一次性回填）用它。 */
export function rememberStudioSessionDraft(sessionId: string, draft: string): void {
  const drafts = readMap(draftsKey);
  if (draft) drafts[sessionId] = draft.slice(0, SESSION_DRAFT_MAX); else delete drafts[sessionId];
  writeMap(draftsKey, drafts);
}
