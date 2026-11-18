import { validateCityInstance, validateCityLayoutSnapshotScoped, type CityInstanceV1, type CityLayoutSnapshotScoped, type SceneDraftV1, type CityProjectAssetCatalogV1 } from "@oh-agent/city-sdk";

export type CityWorldPackageRefV1 = Readonly<{ packageId: string; version: string; contentDigest: string }>;
export type LoadedCityWorldSceneV1 = Readonly<{ scene: SceneDraftV1; assets: CityProjectAssetCatalogV1; files: ReadonlyMap<string, Uint8Array> }>;

export type PendingCreatorPlaytestV1 =
  | Readonly<{ pending: false }>
  | Readonly<{ pending: true; runId: string; releaseId: string; projectId: string; revision: number; worldRevision: string;
      city: CityInstanceV1; layout: CityLayoutSnapshotScoped; worldPackage: CityWorldPackageRefV1 | null; worldScene?: LoadedCityWorldSceneV1 }>;

/** Pure parser for the pre-claim descriptor. A release's city revision, layout
 * revision and world revision must agree before the runtime may load it. */
export function parsePendingCreatorPlaytest(raw: unknown): PendingCreatorPlaytestV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof (raw as { pending?: unknown }).pending !== "boolean") {
    throw new Error("creator_playtest_pending_invalid");
  }
  const value = raw as Record<string, unknown>;
  if (value.pending === false) return { pending: false };
  const city = validateCityInstance(value.city);
  if (!city.ok) throw new Error(city.diagnostics[0]?.code ?? "creator_playtest_city_invalid");
  const layout = validateCityLayoutSnapshotScoped(value.layout);
  if (!layout.ok) throw new Error(layout.diagnostics[0]?.code ?? "creator_playtest_layout_invalid");
  let worldPackage: CityWorldPackageRefV1 | null = null;
  if (value.worldPackage != null) {
    const reference = value.worldPackage;
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) throw new Error("creator_playtest_pending_invalid");
    const ref = reference as Record<string, unknown>;
    if (typeof ref.packageId !== "string" || typeof ref.version !== "string" || typeof ref.contentDigest !== "string"
      || !/^sha256:[0-9a-f]{64}$/.test(ref.contentDigest)) throw new Error("creator_playtest_pending_invalid");
    worldPackage = Object.freeze({ packageId: ref.packageId, version: ref.version, contentDigest: ref.contentDigest });
  }
  const runId = value.runId, releaseId = value.releaseId, projectId = value.projectId, revision = value.revision, worldRevision = value.worldRevision;
  if (typeof runId !== "string" || typeof releaseId !== "string" || typeof projectId !== "string" || !Number.isSafeInteger(revision) || typeof worldRevision !== "string"
    || layout.value.cityId !== city.value.cityId || layout.value.cityRevision !== city.value.revision
    || layout.value.worldRevision !== worldRevision || layout.value.seed !== city.value.seed) {
    throw new Error("creator_playtest_pending_invalid");
  }
  return Object.freeze({ pending: true, runId, releaseId, projectId, revision: revision as number, worldRevision, city: city.value, layout: layout.value, worldPackage });
}
