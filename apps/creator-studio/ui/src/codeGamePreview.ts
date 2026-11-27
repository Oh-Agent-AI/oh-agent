import type { CandidateBuildRef } from "./contracts/creatorProject";

export type CodeBuildRowV1 = Readonly<CandidateBuildRef & {
  gameId: string;
  displayName: string | null;
  gameVersion: string | null;
  byteLength: number | null;
  createdAtMs: number | null;
}>;

export type CodePreviewStatusV1 = Readonly<{
  available: boolean;
  status: "starting" | "running" | "finished" | "error" | "unavailable" | "unknown";
  gameId: string | null;
  previewId: string | null;
  buildId: string | null;
  runId: string | null;
  outcome: "success" | "failure" | null;
  reason: string | null;
  tick: number | null;
  entities: number | null;
  updatedAtMs: number | null;
}>;

const text = (value: unknown, max: number): string | null => typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function parseCodeBuilds(value: unknown): readonly CodeBuildRowV1[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { builds?: unknown }).builds)) throw new Error("creator_code_builds_invalid");
  return (value as { builds: unknown[] }).builds.map(raw => {
    if (!raw || typeof raw !== "object") throw new Error("creator_code_builds_invalid");
    const row = raw as Record<string, unknown>;
    const buildId = text(row.buildId, 64);
    const gameId = text(row.gameId, 128);
    if (!buildId || !/^[a-f0-9]{64}$/.test(buildId) || !gameId) throw new Error("creator_code_builds_invalid");
    return Object.freeze({ buildId, gameId, displayName: text(row.displayName, 80), gameVersion: text(row.gameVersion, 32),
      byteLength: count(row.byteLength), createdAtMs: count(row.createdAtMs) });
  });
}

export function parseCodePreviewStatus(value: unknown): CodePreviewStatusV1 {
  if (!value || typeof value !== "object" || typeof (value as { available?: unknown }).available !== "boolean") throw new Error("creator_code_preview_status_invalid");
  const raw = value as Record<string, unknown>;
  const status = ["starting","running","finished","error","unavailable"].includes(String(raw.status)) ? String(raw.status) as CodePreviewStatusV1["status"] : "unknown";
  const outcome = raw.outcome === "success" || raw.outcome === "failure" ? raw.outcome : null;
  return Object.freeze({ available: raw.available as boolean, status, gameId: text(raw.gameId, 128), previewId: text(raw.previewId, 128), buildId: text(raw.buildId, 64),
    runId: text(raw.runId, 64), outcome, reason: text(raw.reason, 120), tick: count(raw.tick), entities: count(raw.entities), updatedAtMs: count(raw.updatedAtMs) });
}

/** `creator.code.preview`（创建）的响应：宿主 `studio_preview` 返回 requestId、
 * previewId、buildId、seed 与 `status:"queued"`。previewId 是后续轮询/停止的唯一身份。 */
export type CodePreviewCreatedV1 = Readonly<{
  requestId: string;
  previewId: string;
  buildId: string;
  seed: number | null;
  status: string;
}>;

/** 与宿主 `valid_preview_id` 对齐：≤128、首字符字母数字、只含 [A-Za-z0-9_-]。 */
export function isValidCodePreviewId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

export function parseCodePreviewCreated(value: unknown): CodePreviewCreatedV1 {
  if (!value || typeof value !== "object") throw new Error("creator_code_preview_created_invalid");
  const raw = value as Record<string, unknown>;
  const previewId = text(raw.previewId, 128);
  const buildId = text(raw.buildId, 64);
  if (!previewId || !isValidCodePreviewId(previewId) || !buildId || !/^[a-f0-9]{64}$/.test(buildId)) throw new Error("creator_code_preview_created_invalid");
  return Object.freeze({ requestId: text(raw.requestId, 128) ?? "", previewId, buildId, seed: count(raw.seed), status: text(raw.status, 32) ?? "unknown" });
}

/**
 * Preview 身份隔离：每个 workspace（本面板当前选中的 build）只绑定自己 start 出来的
 * previewId，轮询与停止都带这个 ID 走宿主按 previewId 的权威状态路径，不再依赖
 * "最后写入者获胜" 的 legacy 全局投影。用 localStorage（非 sessionStorage）保证关闭
 * 并重开 Studio 后仍能接回自己的 Preview。存储内容按不可信输入校验（同 workspaceLayout）。
 */
const previewIdStorageKey = (scope: string): string => `oh-agent.studio.code-preview.v1:${scope}`;

export function readCodePreviewId(scope: string): string | null {
  if (!scope) return null;
  try {
    const raw = window.localStorage.getItem(previewIdStorageKey(scope));
    return typeof raw === "string" && isValidCodePreviewId(raw) ? raw : null;
  } catch { return null; }
}

export function rememberCodePreviewId(scope: string, previewId: string): void {
  if (!scope || !isValidCodePreviewId(previewId)) return;
  try { window.localStorage.setItem(previewIdStorageKey(scope), previewId); } catch { /* 绑定失败不挡创作；下次 start 重新绑定 */ }
}

export function clearCodePreviewId(scope: string): void {
  if (!scope) return;
  try { window.localStorage.removeItem(previewIdStorageKey(scope)); } catch { /* 清理失败无害：读到终态会再清 */ }
}

/** 本 workspace 绑定 Preview 的请求载荷（轮询与停止共用同一身份来源）；未绑定 → null，
 * 此时 UI 必须呈现"未在运行"，不得回退 legacy 全局投影。 */
export function boundCodePreviewRequest(scope: string): Readonly<{ previewId: string }> | null {
  const previewId = readCodePreviewId(scope);
  return previewId ? Object.freeze({ previewId }) : null;
}

/** 只有宿主确认的终态（finished/error）才允许清掉本地绑定；创建后、游戏首次上报前的
 * `available:false` 不是终态，不能据此解绑，否则启动窗口期的轮询会丢失身份。 */
export function isTerminalCodePreviewStatus(status: CodePreviewStatusV1): boolean {
  return status.available && (status.status === "finished" || status.status === "error");
}

export type CodeStoryEvidenceV1 = Readonly<{
  available: boolean;
  storyRevision: string | null;
  affection: number | null;
  rules: readonly Readonly<{ ruleId: string; nextDueUtcMs: number | null; status: string }>[];
  dialogue: readonly Readonly<{ eventId: string; text: string; createdAtMs: number | null }>[];
}>;

export function parseCodeStoryEvidence(value: unknown): CodeStoryEvidenceV1 {
  if (!value || typeof value !== "object" || typeof (value as { available?: unknown }).available !== "boolean") throw new Error("creator_code_story_invalid");
  const raw = value as Record<string, unknown>;
  if (!raw.available) return Object.freeze({ available: false, storyRevision: null, affection: null, rules: [], dialogue: [] });
  const state = raw.state && typeof raw.state === "object" ? raw.state as Record<string, unknown> : {};
  const affection = count(state.affection);
  const rules = Array.isArray(raw.rules) ? raw.rules.map(rawRule => {
    if (!rawRule || typeof rawRule !== "object") throw new Error("creator_code_story_invalid");
    const rule = rawRule as Record<string, unknown>;
    const ruleId = text(rule.ruleId, 128);
    const status = text(rule.status, 32);
    if (!ruleId || !status) throw new Error("creator_code_story_invalid");
    return Object.freeze({ ruleId, nextDueUtcMs: count(rule.nextDueUtcMs), status });
  }) : [];
  const dialogue = Array.isArray(raw.dialogue) ? raw.dialogue.map(rawEntry => {
    if (!rawEntry || typeof rawEntry !== "object") throw new Error("creator_code_story_invalid");
    const entry = rawEntry as Record<string, unknown>;
    const eventId = text(entry.eventId, 128);
    const content = text(entry.text, 2_000);
    if (!eventId || !content) throw new Error("creator_code_story_invalid");
    return Object.freeze({ eventId, text: content, createdAtMs: count(entry.createdAtMs) });
  }) : [];
  return Object.freeze({ available: true, storyRevision: text(raw.storyRevision, 128), affection, rules, dialogue });
}

export function canStopCodePreview(status: CodePreviewStatusV1): boolean {
  return (status.status === "starting" || status.status === "running") && !!status.previewId && !!status.runId;
}
