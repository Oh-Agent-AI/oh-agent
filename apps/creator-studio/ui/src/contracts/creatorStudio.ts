import type { CityGameMountV1, CityInstanceV1, CityLayoutSnapshotV1 } from "@oh-agent/city-sdk";
import type { inspectInstalledWorld } from "../contentSnapshot";
import type { CityInstanceRef, CreatorProjectRef, RunRef } from "./creatorProject";

export type ProjectRow = CreatorProjectRef & { title: string; updatedAtMs: number };
export type LayoutRow = { worldRevision: string; layoutId: string; seed: number; anchorCount: number; updatedAtMs: number; cityId?: string; cityRevision?: number; source?: "legacy" | "cityDraft" };
export type CityRow = CityInstanceRef & { name: string };
export type CityWorldSnapshot = Awaited<ReturnType<typeof inspectInstalledWorld>>;
export type SceneDraft = { schemaVersion: 1; objects: Array<Record<string, unknown>> };
// 试玩历史行（creator.project.playtest.history 返回的 runs 元素），状态沿用后端英文枚举不翻译。
export type PlaytestRun = RunRef & { revision: number; status: "pending" | "claimed" | "completed" | "cancelled" | "failed" | "expired"; createdAtMs: number; finishedAtMs: number | null; evidenceSource: string | null; evidence: unknown; failureCode: string | null };
export type Project = CreatorProjectRef & { title?: string; kind: string; game: unknown; cityId?: string; cityRevision?: number; cityLayout?: CityLayoutSnapshotV1 | null; cityPatch?: Record<string, unknown> | null; scene?: SceneDraft; assets?: { schemaVersion: 1; entries: Array<{ assetId: string; relativePath: string; sha256: string; byteLength: number; format: "glb-v2"; boundsMeters?: { x: number; y: number; z: number } }> }; assetRefs?: Array<Record<string, unknown>>; mounts: CityGameMountV1[]; skinId?: string };
export type ProjectCityState = { key: string; city: CityInstanceV1 | null; worldScene?: CityWorldSnapshot; error?: string };
export type CityViewStatus = "loading" | "ready" | "failed";
export type CityDiagnosticContext = { cityId: string; revision: number; correlationId: string; started: number; unavailable: boolean };
export type StudioPanel = "play" | "agent" | "project" | "code" | "library";
export type CityViewOpenResult = { cityId: string; revision: number; status: "loading"; mode: "read_only_preview" };
export type ApplyProject = (next: Project, mode: "preserve" | "replace", previous: Project | null) => { preservedDrafts: boolean };

export const layoutSelectionKey = (layout: LayoutRow): string => layout.cityId ? `${layout.cityId}::${layout.worldRevision}` : layout.worldRevision;
