import type { ProjectRow } from "../../contracts/creatorStudio";

export function recentCreatorProjects(projects: readonly ProjectRow[], limit = 4): readonly ProjectRow[] {
  return [...projects].sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.projectId.localeCompare(b.projectId)).slice(0, Math.max(0, limit));
}

export function creationGoalBrief(goal: string): string | null {
  const trimmed = goal.trim();
  if (!trimmed) return null;
  return `创作目标：\n${trimmed}\n\n请在现有 Creator Studio 中协助实现这个目标。此说明仅复制给创作者自行使用，尚未创建或执行 Agent Task。`;
}
