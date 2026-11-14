/**
 * 世界内容包预检结果的纯展示模型。宿主只返回不可信摘要；这里严格收窄字段，
 * 禁止 UI 把“完整性通过”误读成“可安装/可信任”。
 */
export type WorldPackageInspection = Readonly<{
  inspectionId: string;
  packageId: string;
  version: string;
  contentDigest: string;
  fileCount: number;
  checks: Readonly<{ integrity: string; semantics: string; compatibility: string; publisher: string; installation: string }>;
}>;

const KEYS = ["kind", "inspectionId", "packageId", "version", "contentDigest", "fileCount", "installable", "checks"] as const;
const CHECK_KEYS = ["integrity", "semantics", "compatibility", "publisher", "installation"] as const;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function parseWorldPackageInspection(raw: unknown): WorldPackageInspection | null {
  if (!isObject(raw) || Object.keys(raw).length !== KEYS.length || !KEYS.every(key => key in raw)) return null;
  if (raw.kind !== "city-world" || raw.installable !== false) return null;
  if (typeof raw.inspectionId !== "string" || !/^content-inspection-\d+-\d+$/.test(raw.inspectionId)) return null;
  if (typeof raw.packageId !== "string" || raw.packageId.length === 0 || raw.packageId.length > 128) return null;
  if (typeof raw.version !== "string" || raw.version.length === 0 || raw.version.length > 64) return null;
  if (typeof raw.contentDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(raw.contentDigest)) return null;
  if (!Number.isSafeInteger(raw.fileCount) || (raw.fileCount as number) < 0 || (raw.fileCount as number) > 128) return null;
  if (!isObject(raw.checks) || Object.keys(raw.checks).length !== CHECK_KEYS.length || !CHECK_KEYS.every(key => key in (raw.checks as object))) return null;
  const checks = raw.checks as Record<string, unknown>;
  if (!CHECK_KEYS.every(key => typeof checks[key] === "string" && (checks[key] as string).length <= 64)) return null;
  return Object.freeze({
    inspectionId: raw.inspectionId,
    packageId: raw.packageId,
    version: raw.version,
    contentDigest: raw.contentDigest,
    fileCount: raw.fileCount as number,
    checks: Object.freeze({ integrity: checks.integrity as string, semantics: checks.semantics as string,
      compatibility: checks.compatibility as string, publisher: checks.publisher as string, installation: checks.installation as string }),
  });
}

/** 只描述已检查与未检查项；永不出现“可安装”或本机路径。 */
export function formatWorldPackageInspection(inspection: WorldPackageInspection): string {
  return `${inspection.packageId}@${inspection.version} · ${inspection.fileCount} 个文件 · 完整性通过 · 语义/运行时兼容/来源未检查 · 不可安装`;
}
