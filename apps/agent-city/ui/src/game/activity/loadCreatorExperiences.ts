import { canonicalJson, parseMiniGamePackJson, validateAssetRefs, validateCityProjectAssetCatalog, validateMount, validateSceneDraft,
  type CityGameMountV1, type CityProjectAssetCatalogV1, type ContentRef, type MiniGamePackV1, type ModelAssetCatalogV1, type ModelAssetRefV1, type SceneDraftV1, type VisualPlaytestEvidenceV1 } from "@agent-vitals/city-sdk";
import { invokeHost } from "../../host";
import type { CityLayoutSdkViewV1 } from "../../engine/sdk/cityLayoutAdapter";
import { m as worldUnits } from "../../engine/worldScale";
import type { CreatorPublishedMiniGameV1 } from "./creatorMiniGame";

type PluginResponse<T> = { version: number; requestId: string; ok: boolean; result?: T; error?: { code: string } };
type ReleaseRow = { releaseId: string; title: string; mountCount: number };
type ReleaseSceneFields = { scene?: unknown; assets?: unknown; assetRefs?: unknown };
export type CreatorPlaytestHandoffV1 = Readonly<{ runId: string; projectId: string; revision: number; releaseId: string; snapshotDigest: string; skinId?: "miami-vice" | "desert-evening"; experiences: readonly CreatorPublishedMiniGameV1[] }>;
let requestSerial = 0;

async function hostCall<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  const instanceId = (window as Window & { __AV_PLUGIN_INSTANCE__?: string }).__AV_PLUGIN_INSTANCE__;
  if (!instanceId) throw new Error("plugin_instance_unavailable");
  const requestId = `city-creator:${++requestSerial}`;
  const response = await invokeHost<PluginResponse<T>>("plugin_request", { request: { version: 1, instanceId, requestId, method, payload } });
  if (response.version !== 1 || response.requestId !== requestId) throw new Error("plugin_response_invalid");
  if (!response.ok || response.result === undefined) throw new Error(response.error?.code ?? "creator_release_unavailable");
  return response.result;
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  if (bytes.byteLength > 256 * 1024) throw new Error("creator_game_too_large");
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function validateRelease(view: CityLayoutSdkViewV1, release: { releaseId: string; title: string; skinId?: unknown; game: unknown; mounts: CityGameMountV1[] } & ReleaseSceneFields,
  failureCodes?: string[]): Promise<readonly CreatorPublishedMiniGameV1[]> {
  const fail = (code: string) => { failureCodes?.push(code); };
  if (!Array.isArray(release.mounts) || release.mounts.length > 16) { fail("creator_release_mounts_invalid"); return []; }
  if (!release.mounts.length) { fail("creator_release_mounts_empty"); return []; }
  if (release.skinId != null && release.skinId !== "miami-vice" && release.skinId !== "desert-evening") { fail("creator_release_skin_invalid"); return []; }
  const gameJson = canonicalJson(release.game);
  const parsed = parseMiniGamePackJson(gameJson);
  if (!parsed.ok) { fail(parsed.diagnostics[0]?.code ?? "creator_release_game_invalid"); return []; }
  const game = parsed.value as MiniGamePackV1;
  const gameDigest = await sha256(game);
  const sceneResult = validateSceneDraft(release.scene ?? { schemaVersion: 1, objects: [] });
  if (!sceneResult.ok) { fail(sceneResult.diagnostics[0]?.code ?? "creator_release_scene_invalid"); return []; }
  const projectAssets = validateCityProjectAssetCatalog(release.assets ?? { schemaVersion: 1, entries: [] });
  if (!projectAssets.ok) { fail(projectAssets.diagnostics[0]?.code ?? "creator_release_assets_invalid"); return []; }
  if (!Array.isArray(release.assetRefs)) { fail("creator_release_asset_refs_invalid"); return []; }
  const assetRefs = release.assetRefs as ModelAssetRefV1[];
  const refsById = new Map(assetRefs.map(reference => [reference.assetId, reference]));
  const modelRefs = sceneResult.value.objects.flatMap(object => object.kind === "model" ? [object.asset] : []);
  const modelCatalog: ModelAssetCatalogV1 = { schemaVersion: 1, entries: projectAssets.value.entries.flatMap(entry => {
    const ref = refsById.get(entry.assetId);
    return ref ? [{ ref, relativePath: entry.relativePath, byteLength: entry.byteLength,
      boundsMeters: entry.boundsMeters ?? { x: 1, y: 1, z: 1 }, unit: "meter" as const }] : [];
  }) };
  const resolvedAssets = validateAssetRefs({ refs: modelRefs, catalog: modelCatalog });
  if (!resolvedAssets.ok) { fail(resolvedAssets.diagnostics[0]?.code ?? "creator_release_asset_refs_invalid"); return []; }
  if (resolvedAssets.value.entries.length > 16 || resolvedAssets.value.entries.reduce((total, entry) => total + entry.byteLength, 0) > 128 * 1024 * 1024) { fail("creator_release_asset_budget_exceeded"); return []; }
  const scenePackage = Object.freeze({ scene: sceneResult.value, assets: projectAssets.value, assetRefs: Object.freeze([...assetRefs]) });
  const output: CreatorPublishedMiniGameV1[] = [];
  for (const mount of release.mounts) {
    if (!mount || mount.game.digest !== gameDigest || mount.game.id !== game.id) { fail("creator_release_game_reference_mismatch"); continue; }
    const resolvedRefs: { layout: ContentRef<"city-layout">; game: ContentRef<"city-minigame"> } = {
      layout: { kind: "city-layout", id: view.layout.id, version: "1", digest: view.worldRevision },
      game: { kind: "city-minigame", id: game.id, version: mount.game.version, digest: gameDigest },
    };
    const mountValidation = validateMount({ layout: view.layout, game, mount, resolvedRefs });
    if (!mountValidation.ok) { fail(mountValidation.diagnostics[0]?.code ?? "creator_release_mount_invalid"); continue; }
    const entry = view.layout.anchors.find(anchor => anchor.id === mount.entryAnchorId);
    const geometry = entry ? view.geometry.get(entry.geometryRef) : null;
    if (!entry || entry.kind !== "spawn" || !entry.capabilities.includes("drive") || !geometry) { fail("creator_release_entry_geometry_unavailable"); continue; }
    output.push(Object.freeze({ releaseId: release.releaseId, title: release.title, ...(release.skinId ? { skinId: release.skinId } : {}), game, mount, scenePackage,
      entryPositionWorld: Object.freeze({ x: worldUnits(geometry.positionMeters.x), z: worldUnits(geometry.positionMeters.z) }) }));
  }
  return Object.freeze(output);
}

/** Claims a Studio-initiated playtest only after a release is pinned to this live City revision. */
export async function claimCreatorPlaytest(view: CityLayoutSdkViewV1): Promise<CreatorPlaytestHandoffV1 | null> {
  let handoff: { runId: string; releaseId: string; projectId: string; revision: number; snapshotDigest: string; skinId?: unknown; game: unknown; mounts: CityGameMountV1[] } & ReleaseSceneFields;
  try {
    handoff = await hostCall<typeof handoff>("city.creator.playtest.claim", {});
  } catch (error) {
    if (error instanceof Error && error.message === "creator_playtest_not_found") return null;
    throw error;
  }
  const failureCodes: string[] = [];
  const experiences = await validateRelease(view, { ...handoff, title: "Creator Studio 试玩" }, failureCodes);
  if (!experiences.length) {
    await finishCreatorPlaytest(handoff.runId, "failed", undefined, failureCodes[0] ?? "creator_playtest_release_incompatible");
    throw new Error("creator_playtest_release_incompatible");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(handoff.snapshotDigest)) throw new Error("creator_playtest_snapshot_digest_invalid");
  const skinId = handoff.skinId === "miami-vice" || handoff.skinId === "desert-evening" ? handoff.skinId : undefined;
  return Object.freeze({ runId: handoff.runId, projectId: handoff.projectId, revision: handoff.revision, releaseId: handoff.releaseId,
    snapshotDigest: handoff.snapshotDigest, ...(skinId ? { skinId } : {}), experiences });
}

export async function finishCreatorPlaytest(runId: string, status: "completed" | "cancelled" | "failed", evidence?: VisualPlaytestEvidenceV1, failureCode?: string): Promise<void> {
  await hostCall("city.creator.playtest.finish", { runId, status, evidence: evidence ?? null, ...(failureCode ? { failureCode } : {}) });
}

/** Reads only explicitly published releases, then validates every game against this live City revision. */
export async function loadCreatorPublishedMiniGames(view: CityLayoutSdkViewV1): Promise<readonly CreatorPublishedMiniGameV1[]> {
  const list = await hostCall<{ releases: ReleaseRow[] }>("city.creator.experiences.list", {
    layoutId: view.layout.id, worldRevision: view.worldRevision, limit: 8,
  });
  if (!Array.isArray(list.releases)) throw new Error("creator_release_response_invalid");
  const output: CreatorPublishedMiniGameV1[] = [];
  for (const row of list.releases.slice(0, 8)) {
    if (!row || typeof row.releaseId !== "string" || typeof row.title !== "string" || !Number.isInteger(row.mountCount) || row.mountCount < 1 || row.mountCount > 16) continue;
    const release = await hostCall<{ releaseId: string; revision: number; skinId?: unknown; game: unknown; mounts: CityGameMountV1[] } & ReleaseSceneFields>("city.creator.experiences.read", {
      releaseId: row.releaseId, layoutId: view.layout.id, worldRevision: view.worldRevision,
    });
    if (release.releaseId !== row.releaseId) continue;
    output.push(...await validateRelease(view, { ...release, title: row.title }));
    if (output.length >= 16) return Object.freeze(output.slice(0, 16));
  }
  return Object.freeze(output);
}
