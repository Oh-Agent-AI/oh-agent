import type { CityInstanceRef, InstallationRef } from "../../contracts/creatorProject";

export const LIBRARY_RESOURCE_KINDS = Object.freeze([
  Object.freeze({ id: "city", label: "City 世界", description: "独立 City 实例", available: true }),
  Object.freeze({ id: "story", label: "Story Project", description: "宿主 Registry · 稳定 story_id", available: true }),
  Object.freeze({ id: "game", label: "Game Build", description: "不可变构建 · 仅测试与安装", available: true }),
] as const);

export type LibraryKind = "city" | "story" | "game";

export type LibraryCityRow = Readonly<CityInstanceRef & {
  name: string;
  /** PR14 缺陷⑥：宿主 creator.city.list 的布局快照存在性信号；旧宿主缺省 true。 */
  hasLayout?: boolean;
  worldRevision: string | null;
  capabilities: readonly string[] | null;
  compatibility: string | null;
  compatible: boolean | null;
}>;

export type CityListPage = Readonly<{
  cities: readonly LibraryCityRow[];
  nextCursor: string | null;
}>;

export type InstallationRow = Readonly<InstallationRef & {
  cityRevision: number | null;
  gameId: string;
  status: "installed" | "disabled" | "update-available" | "unknown";
  createdAtMs: number | null;
}>;

export type InstallDiagnostic = Readonly<{
  code: string;
  severity: "error" | "warning" | "info" | "unknown";
  message: string;
  path: string | null;
}>;

export type InstallPreview = Readonly<{
  previewId: string | null;
  ok: boolean | null;
  canInstall: boolean | null;
  requiresUpdateConfirmation: boolean;
  currentBuildId: string | null;
  diagnostics: readonly InstallDiagnostic[];
}>;

export type InstallRequest = Readonly<{
  buildId: string;
  targetCityId: string;
  expectedCityRevision: number;
  operationId: string;
  runAfterInstall: false;
  replaceCurrentView: false;
  allowOfficialStoryWrites: false;
}>;

const text = (value: unknown, max: number): string | null => typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
const revision = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function parseCityListPage(value: unknown): CityListPage {
  if (!value || typeof value !== "object" || !Array.isArray((value as { cities?: unknown }).cities)) throw new Error("creator_city_list_invalid");
  const raw = value as Record<string, unknown>;
  const cities = (raw.cities as unknown[]).map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("creator_city_list_invalid");
    const row = item as Record<string, unknown>;
    const cityId = text(row.cityId, 128);
    const name = text(row.name, 160);
    const cityRevision = revision(row.revision) ?? revision(row.cityRevision);
    if (!cityId || !name || cityRevision === null) throw new Error("creator_city_list_invalid");
    const hasLayout = row.hasLayout === undefined ? true : row.hasLayout === true;
    let capabilities: readonly string[] | null = null;
    if (row.capabilities !== undefined) {
      if (!Array.isArray(row.capabilities) || row.capabilities.length > 64) throw new Error("creator_city_list_invalid");
      capabilities = Object.freeze(row.capabilities.map(capability => {
        const parsed = text(capability, 128);
        if (!parsed) throw new Error("creator_city_list_invalid");
        return parsed;
      }));
    }
    return Object.freeze({ cityId, name, revision: cityRevision, hasLayout, worldRevision: text(row.worldRevision, 128), capabilities,
      compatibility: text(row.compatibilityStatus, 64) ?? text(row.compatibility, 64),
      compatible: typeof row.compatible === "boolean" ? row.compatible : null });
  });
  return Object.freeze({ cities: Object.freeze(cities), nextCursor: text(raw.nextCursor, 256) });
}

export function parseInstallations(value: unknown): readonly InstallationRow[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { installations?: unknown }).installations)) throw new Error("creator_code_installations_invalid");
  return Object.freeze((value as { installations: unknown[] }).installations.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("creator_code_installations_invalid");
    const row = item as Record<string, unknown>;
    const installationId = text(row.installationId, 128);
    const cityId = text(row.cityId, 128);
    const gameId = text(row.gameId, 128);
    const buildId = text(row.buildId, 128);
    if (!installationId || !cityId || !gameId || !buildId) throw new Error("creator_code_installations_invalid");
    const status = row.status === "installed" || row.status === "disabled" || row.status === "update-available" ? row.status : "unknown";
    return Object.freeze({ installationId, cityId, gameId, buildId, status,
      cityRevision: revision(row.cityRevision), createdAtMs: revision(row.createdAtMs) });
  }));
}

export function installedGamesForCity(installations: readonly InstallationRow[], cityId: string): readonly InstallationRow[] {
  return installations.filter(item => item.cityId === cityId && item.status === "installed");
}

export function parseInstallationPage(value: unknown) {
  const installations = parseInstallations(value);
  return { installations, installedCount: revision((value as { installedCount?: unknown }).installedCount) };
}

export type StoryInstallationRow = Readonly<{
  installationId: string; cityId: string; storyId: string; storyVersion: string; contentDigest: string;
}>;

export function parseInstalledStories(value: unknown): readonly StoryInstallationRow[] {
  const installations = (value as { installations?: unknown } | null)?.installations;
  if (!Array.isArray(installations)) throw new Error("creator_story_installations_invalid");
  return installations.flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("creator_story_installations_invalid");
    const row = item as Record<string, unknown>;
    if (row.status !== "installed") return [];
    const installationId = text(row.installationId, 128);
    const cityId = text(row.cityId, 128);
    const storyId = text(row.storyId, 128);
    const storyVersion = text(row.storyVersion, 64);
    const contentDigest = text(row.contentDigest, 96);
    if (!installationId || !cityId || !storyId || !storyVersion || !contentDigest) throw new Error("creator_story_installations_invalid");
    return [{ installationId, cityId, storyId, storyVersion, contentDigest }];
  });
}

export type StoryProjectRow = Readonly<{
  storyId: string;
  title: string;
  storyVersion: string;
  revision: number;
  contentDigest: string;
  schemaVersion: number | null;
  graphBytes: number | null;
  canonBytes: number | null;
  nodeCount: number | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
}>;

export function parseStoryProjects(value: unknown): readonly StoryProjectRow[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { projects?: unknown }).projects)) throw new Error("creator_story_projects_invalid");
  return Object.freeze((value as { projects: unknown[] }).projects.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("creator_story_projects_invalid");
    const row = item as Record<string, unknown>;
    const storyId = text(row.storyId, 128);
    const title = text(row.title, 200);
    const storyVersion = text(row.storyVersion, 64);
    const digest = text(row.contentDigest, 96);
    const storyRevision = revision(row.revision);
    if (!storyId || !title || !storyVersion || digest === null || storyRevision === null) throw new Error("creator_story_projects_invalid");
    return Object.freeze({ storyId, title, storyVersion, revision: storyRevision, contentDigest: digest,
      schemaVersion: revision(row.schemaVersion), graphBytes: revision(row.graphBytes), canonBytes: revision(row.canonBytes), nodeCount: revision(row.nodeCount),
      createdAtMs: revision(row.createdAtMs), updatedAtMs: revision(row.updatedAtMs) });
  }));
}

export function parseInstallPreview(value: unknown): InstallPreview {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("creator_code_install_preview_invalid");
  const raw = value as Record<string, unknown>;
  if (raw.diagnostics !== undefined && !Array.isArray(raw.diagnostics)) throw new Error("creator_code_install_preview_invalid");
  const diagnostics = (raw.diagnostics as unknown[] | undefined ?? []).map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("creator_code_install_preview_invalid");
    const row = item as Record<string, unknown>;
    const severity = row.severity === "error" || row.severity === "warning" || row.severity === "info" ? row.severity : "unknown";
    return Object.freeze({ code: text(row.code, 128) ?? "未知诊断", severity,
      message: text(row.message, 1_000) ?? "宿主未提供诊断说明", path: text(row.path, 256) });
  });
  return Object.freeze({ previewId: text(raw.previewId, 128), ok: typeof raw.ok === "boolean" ? raw.ok : null,
    canInstall: typeof raw.canInstall === "boolean" ? raw.canInstall : null,
    requiresUpdateConfirmation: raw.requiresUpdateConfirmation === true,
    currentBuildId: text(raw.currentBuildId, 128), diagnostics: Object.freeze(diagnostics) });
}

export function buildInstallRequest(buildId: string, targetCityId: string, expectedCityRevision: number, operationId: string): InstallRequest {
  return Object.freeze({ buildId, targetCityId, expectedCityRevision, operationId,
    runAfterInstall: false, replaceCurrentView: false, allowOfficialStoryWrites: false });
}

export function buildInstallCommitRequest(preview: InstallPreview, buildId: string, operationId: string): Record<string, unknown> {
  if (!preview.previewId) throw new Error("creator_code_install_preview_invalid");
  return { previewId: preview.previewId, operationId,
    ...(preview.requiresUpdateConfirmation ? { updateConfirmation: { currentBuildId: preview.currentBuildId, buildId } } : {}) };
}

export function isInstallPreviewAllowed(preview: InstallPreview | null): preview is InstallPreview & { previewId: string } {
  return preview !== null && preview.previewId !== null && preview.ok !== false && preview.canInstall === true
    && !preview.diagnostics.some(diagnostic => diagnostic.severity === "error");
}

export function canCommitInstall(preview: InstallPreview | null, updateConfirmed = false): boolean {
  return isInstallPreviewAllowed(preview)
    && (!preview.requiresUpdateConfirmation || (updateConfirmed && preview.currentBuildId !== null));
}
