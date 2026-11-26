/**
 * 会话中心三栏的宽度模型（设计基线 §1：默认 16/34/50、最小 220/360/420、分隔条可拖动、
 * 每个 Project 记住自己的布局）。纯计算放在这里，拖动与持久化在 useWorkspaceLayout。
 *
 * 只存 Session 与对话两栏的像素宽，预览栏吃掉剩余宽度——三栏宽度之和恒等于容器宽度，
 * 不存百分比，就不会出现"改窗口后三栏各自按比例缩、总和溢出"的经典漂移。
 */
export type WorkspaceWidths = Readonly<{ sessions: number; agent: number }>;

export const WORKSPACE_MIN_SESSIONS = 220;
export const WORKSPACE_MIN_AGENT = 360;
export const WORKSPACE_MIN_PREVIEW = 420;
/** 两条分隔条各占的宽度（grid 里是独立列，必须从可用宽度里先扣掉）。 */
export const WORKSPACE_SPLITTER = 6;

const MIN_TOTAL = WORKSPACE_MIN_SESSIONS + WORKSPACE_MIN_AGENT + WORKSPACE_MIN_PREVIEW;

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max));

const availableOf = (containerWidth: number): number => Math.max(0, Math.round(containerWidth)) - WORKSPACE_SPLITTER * 2;

/** 宽窗口的初始比例（16% / 34%），窄到装不下三栏最小宽时按最小宽比例压缩而不是溢出。 */
export function defaultWorkspaceWidths(containerWidth: number): WorkspaceWidths {
  const available = availableOf(containerWidth);
  if (available <= 0) return { sessions: WORKSPACE_MIN_SESSIONS, agent: WORKSPACE_MIN_AGENT };
  if (available < MIN_TOTAL) {
    return { sessions: Math.round(WORKSPACE_MIN_SESSIONS * available / MIN_TOTAL),
      agent: Math.round(WORKSPACE_MIN_AGENT * available / MIN_TOTAL) };
  }
  return clampWorkspaceWidths({ sessions: Math.round(available * 0.16), agent: Math.round(available * 0.34) }, containerWidth);
}

/**
 * 把任意宽度夹进合法区间：Session ≥220、对话 ≥360、预览 ≥420。
 * 先夹 Session 再夹对话——反过来的话，拖窄对话栏会把 Session 顶出最小宽，
 * 拖动时用户看到的是"我拖这栏、那栏变"。
 */
export function clampWorkspaceWidths(widths: WorkspaceWidths, containerWidth: number): WorkspaceWidths {
  const available = availableOf(containerWidth);
  if (available < MIN_TOTAL) return defaultWorkspaceWidths(containerWidth);
  const sessions = clamp(Math.round(widths.sessions), WORKSPACE_MIN_SESSIONS, available - WORKSPACE_MIN_AGENT - WORKSPACE_MIN_PREVIEW);
  const agent = clamp(Math.round(widths.agent), WORKSPACE_MIN_AGENT, available - sessions - WORKSPACE_MIN_PREVIEW);
  return { sessions, agent };
}

/** localStorage 里的布局是不可信输入：超范围/非有限数一律当没有存过。 */
export function parseWorkspaceWidths(value: unknown): WorkspaceWidths | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const size = (entry: unknown): entry is number => typeof entry === "number" && Number.isFinite(entry) && entry >= 100 && entry <= 4_000;
  if (!size(row.sessions) || !size(row.agent)) return null;
  return { sessions: Math.round(row.sessions), agent: Math.round(row.agent) };
}

/**
 * 布局模式：`balanced` 三栏，`preview` 收起 Session 与对话、预览占满（设计基线 §1
 * "独立全屏预览，保留返回对话的入口"）。宽度与模式一起存——恢复布局时不能只恢复宽度
 * 却把用户离开时的全屏状态丢掉。
 */
export type WorkspaceFocus = "balanced" | "preview";

export type WorkspaceLayoutRecord = Readonly<{ widths: WorkspaceWidths; focus: WorkspaceFocus }>;

/** 旧记录没有 focus 字段：缺省即 balanced，不能让一次升级把所有人的布局作废。 */
export function parseWorkspaceLayout(value: unknown): WorkspaceLayoutRecord | null {
  const widths = parseWorkspaceWidths(value);
  if (!widths) return null;
  const focus = (value as Record<string, unknown>).focus === "preview" ? "preview" : "balanced";
  return { widths, focus };
}

const storageKey = (projectKey: string): string => `oh-agent.studio.workspace-layout.v1:${projectKey}`;

export function readWorkspaceLayout(projectKey: string): WorkspaceLayoutRecord | null {
  if (!projectKey) return null;
  try { return parseWorkspaceLayout(JSON.parse(window.localStorage.getItem(storageKey(projectKey)) ?? "null")); }
  catch { return null; }
}

export function rememberWorkspaceLayout(projectKey: string, layout: WorkspaceLayoutRecord): void {
  if (!projectKey) return;
  try {
    window.localStorage.setItem(storageKey(projectKey), JSON.stringify({
      sessions: Math.round(layout.widths.sessions), agent: Math.round(layout.widths.agent), focus: layout.focus,
    }));
  } catch { /* 布局记忆失败不该挡住创作；下次打开退回默认比例 */ }
}
