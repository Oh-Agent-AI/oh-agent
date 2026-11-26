import type { StudioExecutorStatus } from "../../contracts/studioTask";

/**
 * Agent 目录（重设计文档 R6 的展示层切片）：按品牌去重、按状态分组——
 * 可用于创作 > 待连接/不可用（原因可见）。纯函数，供选择器与测试复用。
 */
export type DirectoryStatus = "usable" | "needs-setup" | "unavailable";
export type ExecutorEntry = Readonly<{
  id: string;
  name: string;
  status: DirectoryStatus;
  /** 不可用/待配置的具体原因；可用时为 null。 */
  reason: string | null;
}>;
export type BrandGroup = Readonly<{
  brand: string;
  entries: readonly ExecutorEntry[];
  usableCount: number;
}>;

export function classifyExecutor(status: Pick<StudioExecutorStatus, "available" | "modes" | "detail">): DirectoryStatus {
  if (!status.available) return "unavailable";
  if (!status.modes.some(mode => mode.restricted)) return "needs-setup";
  return "usable";
}

export function executorReason(status: StudioExecutorStatus, classifier: DirectoryStatus): string | null {
  if (classifier === "unavailable") return status.detail ?? "连接不可用";
  if (classifier === "needs-setup") return "此 Agent 未提供受限提案模式";
  return null;
}

export function toExecutorEntry(status: StudioExecutorStatus): ExecutorEntry {
  const classifier = classifyExecutor(status);
  return Object.freeze({ id: status.id, name: status.name, status: classifier, reason: executorReason(status, classifier) });
}

/** 同名多条连接归并为一个品牌条目；品牌内可用连接排前，品牌间可用品牌排前。 */
export function groupByBrand(items: readonly StudioExecutorStatus[]): readonly BrandGroup[] {
  const brands = new Map<string, ExecutorEntry[]>();
  for (const item of items) {
    const entry = toExecutorEntry(item);
    const list = brands.get(entry.name) ?? [];
    list.push(entry);
    brands.set(entry.name, list);
  }
  const groups = Array.from(brands.entries(), ([brand, entries]) => {
    const ordered = [...entries].sort((a, b) => (a.status === "usable" ? 0 : 1) - (b.status === "usable" ? 0 : 1));
    return Object.freeze({ brand, entries: Object.freeze(ordered), usableCount: entries.filter(entry => entry.status === "usable").length });
  });
  return Object.freeze(groups.sort((a, b) => (a.usableCount > 0 ? 0 : 1) - (b.usableCount > 0 ? 0 : 1)));
}

export function directorySummary(groups: readonly BrandGroup[]): string {
  const usable = groups.reduce((total, group) => total + group.usableCount, 0);
  const rest = groups.reduce((total, group) => total + group.entries.length, 0) - usable;
  if (rest === 0) return `${usable} 条可用于创作`;
  if (usable === 0) return `${rest} 条待连接`;
  return `${usable} 条可用于创作 · ${rest} 条待连接`;
}
