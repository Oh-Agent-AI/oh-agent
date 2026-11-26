import type { LibraryCityRow } from "../library/cityGameLibraryModel";
import type { StoryDocument } from "./storyEditorModel";

export type StoryTarget = Pick<StoryDocument, "storyId" | "storyVersion" | "contentDigest">;
export type StoryInstallation = Readonly<{ storyVersion: string; contentDigest: string }>;
type UpdateConfirmation = Readonly<{
  currentStoryVersion: string; currentPackageDigest: string; targetStoryVersion: string; targetPackageDigest: string;
}>;
export type StoryInstallPreview = Readonly<{
  previewId: string; canInstall: boolean; diagnostics: readonly string[];
  expiresAtMs: number; updateConfirmation: UpdateConfirmation | null;
}>;

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("story_host_response_invalid");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("story_host_response_invalid");
  return value;
}

export function parseStoryInstallation(value: unknown, storyId: string, cityId: string): StoryInstallation | null {
  const installations = row(value).installations;
  if (!Array.isArray(installations)) throw new Error("story_host_response_invalid");
  const match = installations.map(row).find(item => item.storyId === storyId && item.cityId === cityId && item.status === "installed");
  return match ? { storyVersion: text(match.storyVersion), contentDigest: text(match.contentDigest) } : null;
}

export function parseStoryInstallPreview(value: unknown, target: StoryTarget, city: LibraryCityRow): StoryInstallPreview {
  const preview = row(value);
  if (preview.storyId !== target.storyId || preview.storyVersion !== target.storyVersion
    || preview.targetPackageDigest !== target.contentDigest || preview.targetCityId !== city.cityId
    || preview.expectedCityRevision !== city.revision) throw new Error("story_install_digest_conflict");
  if (typeof preview.canInstall !== "boolean" || typeof preview.requiresUpdateConfirmation !== "boolean"
    || typeof preview.expiresAtMs !== "number" || !Number.isSafeInteger(preview.expiresAtMs) || !Array.isArray(preview.diagnostics)) {
    throw new Error("story_host_response_invalid");
  }
  return {
    previewId: text(preview.previewId), canInstall: preview.canInstall, expiresAtMs: preview.expiresAtMs,
    diagnostics: preview.diagnostics.map(item => text(row(item).message)),
    updateConfirmation: preview.requiresUpdateConfirmation ? {
      currentStoryVersion: text(preview.currentStoryVersion), currentPackageDigest: text(preview.currentPackageDigest),
      targetStoryVersion: target.storyVersion, targetPackageDigest: target.contentDigest,
    } : null,
  };
}

export function readExistingStoryRunId(value: unknown, storyId: string, cityId: string): string {
  const status = row(value);
  if (status.storyId !== storyId || status.cityId !== cityId) throw new Error("story_run_scope_mismatch");
  if (status.run === null) return "";
  const run = row(status.run);
  if (run.status !== "active" && run.status !== "paused") throw new Error("story_host_response_invalid");
  return text(run.storyRunId);
}

export function readStoryRunId(value: unknown, target: StoryTarget, cityId: string): string {
  const run = row(value);
  if (run.storyId !== target.storyId || run.cityId !== cityId || run.contentDigest !== target.contentDigest || run.status !== "active") {
    throw new Error("story_run_scope_mismatch");
  }
  return text(run.storyRunId);
}

export function storyPlaytestError(code: string): string {
  switch (code) {
    case "story_install_revision_conflict":
      return "City 已更新。请刷新城市后重新检查安装。";
    case "story_install_digest_conflict":
      return "剧情版本已变化。请重新打开 Story，确认版本后再试。";
    case "preview_expired":
      return "安装检查已过期，请重新检查。";
    case "story_install_incompatible":
      return "当前无法安装。请重新检查安装条件。";
    default:
      return `操作失败（${code}）。`;
  }
}
