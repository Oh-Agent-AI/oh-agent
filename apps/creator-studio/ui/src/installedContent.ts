/** 已安装内容包的纯展示模型。安装只是本机存储，不代表可运行或可信。 */
export type InstalledContentPackage = Readonly<{
  packageId: string;
  version: string;
  contentDigest: string;
  fileCount: number;
  byteLength: number;
  installedAtMs: number;
}>;

export type InstallResult = Readonly<{
  packageId: string;
  version: string;
  contentDigest: string;
  fileCount: number;
  byteLength: number;
  installedAtMs: number;
  alreadyInstalled: boolean;
}>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown, max: number) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const isDigest = (value: unknown) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const isIdentity = (value: Record<string, unknown>) => typeof value.packageId === "string" && value.packageId.length > 0 && value.packageId.length <= 128
  && typeof value.version === "string" && value.version.length > 0 && value.version.length <= 64 && isDigest(value.contentDigest)
  && isCount(value.fileCount, 128) && isCount(value.byteLength, 140 * 1024 * 1024) && Number.isSafeInteger(value.installedAtMs);

export function parseInstalledPackages(raw: unknown): InstalledContentPackage[] | null {
  if (!isObject(raw) || Object.keys(raw).length !== 1 || !Array.isArray(raw.packages) || raw.packages.length > 128) return null;
  const packages: InstalledContentPackage[] = [];
  for (const entry of raw.packages) {
    if (!isObject(entry) || Object.keys(entry).length !== 6 || !isIdentity(entry)) return null;
    packages.push(Object.freeze({ packageId: entry.packageId as string, version: entry.version as string, contentDigest: entry.contentDigest as string,
      fileCount: entry.fileCount as number, byteLength: entry.byteLength as number, installedAtMs: entry.installedAtMs as number }));
  }
  return packages;
}

export function parseInstallResult(raw: unknown): InstallResult | null {
  if (!isObject(raw) || Object.keys(raw).length !== 7 || typeof raw.alreadyInstalled !== "boolean" || !isIdentity(raw)) return null;
  return Object.freeze({ packageId: raw.packageId as string, version: raw.version as string, contentDigest: raw.contentDigest as string,
    fileCount: raw.fileCount as number, byteLength: raw.byteLength as number, installedAtMs: raw.installedAtMs as number,
    alreadyInstalled: raw.alreadyInstalled });
}

export function formatInstalledPackage(item: InstalledContentPackage): string {
  return `${item.packageId}@${item.version} · ${item.fileCount} 个文件 · ${Math.ceil(item.byteLength / 1024)} KiB · 仅本机安装`;
}
