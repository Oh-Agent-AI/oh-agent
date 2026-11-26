import { validateCityInstance } from "@oh-agent/city-sdk";
import { assertCityPlanPlayable } from "../cityPlanPreflight";
import { digest } from "../adapters/creatorHostUtils";

export const DRAFT_CITY_PROFILE = Object.freeze({ schemaVersion: 1, id: "arid-dunes", version: 1, biome: "arid",
  geography: { generator: "arid-dunes-v1", parameters: { dunes: { duneScale: 190, duneAmplitude: 11, orientationDeg: 18 } } }, visuals: { themeId: "desert" } });

export type CityDraft = Readonly<{
  draftId: string;
  name: string;
  seed: number;
  contentDigest: string;
  status: "pending" | "committed" | "cancelled" | "expired" | "unknown";
  cityId: string | null;
  expiresAtMs: number;
}>;

export type ArchiveDependency = Readonly<Record<string, unknown>>;
export type CityArchivePreview = Readonly<{
  previewId: string;
  cityId: string;
  revision: number;
  canArchive: boolean;
  dependencyDigest: string;
  installations: readonly ArchiveDependency[];
  projects: readonly ArchiveDependency[];
  releases: readonly ArchiveDependency[];
  candidates: readonly ArchiveDependency[];
  worldPackage: ArchiveDependency | null;
  activeRuns: readonly ArchiveDependency[];
  expiresAtMs: number;
}>;
export type ArchivedCity = Readonly<{ cityId: string; name: string; archivedAtMs: number; dependencies: Record<string, unknown> }>;

const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const objectList = (value: unknown): readonly ArchiveDependency[] => Array.isArray(value) ? value.map(object).filter((item): item is Record<string, unknown> => item !== null) : [];

export async function cityDraftValidation(name: string, seed: number, operationId: string): Promise<Record<string, unknown>> {
  const checked = validateCityInstance({ schemaVersion: 1, cityId: "city-validation", revision: 0, name, seed, profile: DRAFT_CITY_PROFILE });
  if (checked.ok) assertCityPlanPlayable(seed, DRAFT_CITY_PROFILE);
  const request = { name, seed, profile: DRAFT_CITY_PROFILE, operationId };
  return { schemaVersion: 1, requestDigest: await digest(request), ok: checked.ok };
}

export function parseCityDraft(value: unknown): CityDraft {
  const row = object(value);
  const draftId = text(row?.draftId);
  const name = text(row?.name);
  const seed = count(row?.seed);
  const contentDigest = text(row?.contentDigest);
  const expiresAtMs = count(row?.expiresAtMs);
  if (!draftId || !name || seed === null || !contentDigest || expiresAtMs === null) throw new Error("creator_city_draft_invalid");
  const status = row?.status === "pending" || row?.status === "committed" || row?.status === "cancelled" || row?.status === "expired" ? row.status : "unknown";
  return Object.freeze({ draftId, name, seed, contentDigest, status, cityId: text(row?.cityId), expiresAtMs });
}

export function parseArchivePreview(value: unknown): CityArchivePreview {
  const row = object(value);
  const previewId = text(row?.previewId);
  const cityId = text(row?.cityId);
  const revision = count(row?.revision);
  const dependencyDigest = text(row?.dependencyDigest);
  const expiresAtMs = count(row?.expiresAtMs);
  if (!previewId || !cityId || revision === null || !dependencyDigest || expiresAtMs === null || typeof row?.canArchive !== "boolean") throw new Error("creator_archive_preview_invalid");
  return Object.freeze({ previewId, cityId, revision, canArchive: row.canArchive, dependencyDigest,
    installations: objectList(row.installations), projects: objectList(row.projects), releases: objectList(row.releases), candidates: objectList(row.candidates),
    worldPackage: object(row.worldPackage), activeRuns: objectList(row.activeRuns), expiresAtMs });
}

export function parseArchivedCities(value: unknown): readonly ArchivedCity[] {
  const row = object(value);
  if (!Array.isArray(row?.cities)) throw new Error("creator_archive_list_invalid");
  return row.cities.map(item => {
    const city = object(item);
    const cityId = text(city?.cityId);
    const archivedAtMs = count(city?.archivedAtMs);
    if (!city || !cityId || archivedAtMs === null) throw new Error("creator_archive_list_invalid");
    return Object.freeze({ cityId, name: text(city.name) ?? cityId, archivedAtMs, dependencies: object(city.dependencies) ?? {} });
  });
}

export function canCommitArchive(preview: CityArchivePreview | null, confirmed: boolean): boolean {
  return preview !== null && confirmed && preview.canArchive && preview.activeRuns.length === 0 && !!preview.previewId && !!preview.dependencyDigest;
}

export function archiveDependencyCounts(value: Readonly<Record<string, unknown>>): Readonly<{ installations: number; projects: number; releases: number; candidates: number; activeRuns: number }> {
  return { installations: objectList(value.installations).length, projects: objectList(value.projects).length,
    releases: objectList(value.releases).length, candidates: objectList(value.candidates).length, activeRuns: objectList(value.activeRuns).length };
}
