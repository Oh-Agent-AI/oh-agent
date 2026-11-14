import { validateCityInstance, validateCityLayoutSnapshotV2, type CityInstanceV1, type CityLayoutSnapshotV2 } from "@agent-vitals/city-sdk";

export type PendingCreatorPlaytestV1 =
  | Readonly<{ pending: false }>
  | Readonly<{ pending: true; runId: string; releaseId: string; projectId: string; revision: number; worldRevision: string;
      city: CityInstanceV1; layout: CityLayoutSnapshotV2 }>;

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
  const layout = validateCityLayoutSnapshotV2(value.layout);
  if (!layout.ok) throw new Error(layout.diagnostics[0]?.code ?? "creator_playtest_layout_invalid");
  const runId = value.runId, releaseId = value.releaseId, projectId = value.projectId, revision = value.revision, worldRevision = value.worldRevision;
  if (typeof runId !== "string" || typeof releaseId !== "string" || typeof projectId !== "string" || !Number.isSafeInteger(revision) || typeof worldRevision !== "string"
    || layout.value.cityId !== city.value.cityId || layout.value.cityRevision !== city.value.revision
    || layout.value.worldRevision !== worldRevision || layout.value.seed !== city.value.seed) {
    throw new Error("creator_playtest_pending_invalid");
  }
  return Object.freeze({ pending: true, runId, releaseId, projectId, revision: revision as number, worldRevision, city: city.value, layout: layout.value });
}
