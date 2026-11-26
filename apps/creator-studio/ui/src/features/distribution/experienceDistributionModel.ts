export type ExperiencePackageRow = Readonly<{
  experienceId: string;
  version: string;
  contentDigest: string;
  gameType: string | null;
  releaseId: string | null;
  fileCount: number;
  installed: boolean;
  installedAtMs: number | null;
}>;

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, max = 128): string | null => typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function validExperienceVersion(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9.-]+)?$/.test(value) && value.length <= 32;
}

export function parseExperiencePackages(value: unknown): readonly ExperiencePackageRow[] {
  const rows = object(value)?.experiences;
  if (!Array.isArray(rows) || rows.length > 128) throw new Error("creator_experience_list_invalid");
  return Object.freeze(rows.map(item => {
    const row = object(item);
    const experienceId = text(row?.experienceId); const version = text(row?.version, 32); const contentDigest = text(row?.contentDigest);
    const fileCount = count(row?.fileCount);
    if (!row || !experienceId || !version || !validExperienceVersion(version) || !contentDigest || !/^sha256:[a-f0-9]{64}$/.test(contentDigest)
      || fileCount === null || typeof row.installed !== "boolean") throw new Error("creator_experience_list_invalid");
    return Object.freeze({ experienceId, version, contentDigest, gameType: text(row.gameType), releaseId: text(row.releaseId), fileCount,
      installed: row.installed, installedAtMs: count(row.installedAtMs) });
  }));
}
