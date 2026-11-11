import type { CityModel } from "../../cityModel";
import type { BackdropMode, CityLayout } from "../../engine/cityLayout";
import type { ReturnCameraView } from "../../game/types";
import { captureCityVisualHero, captureCityVisualPalettes, createCitySnapshotProjector } from "./cityDisplayProjection";
import type { DreamCityDisplayV1, DreamCitySnapshotV1 } from "./dreamSnapshotContract";

let dreamCaptureRevision = 0;

function publicationActivityKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const opaque = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `dream-publication-${opaque}`;
}

/**
 * Build a local candidate for future publishing. This is not an authorization
 * or a complete privacy projection: layout deep validation is still required.
 */
export function createDreamSnapshotCandidate(model: CityModel, layout: CityLayout, backdrop: BackdropMode, camera: ReturnCameraView): DreamCitySnapshotV1 {
  const snapshot = createCitySnapshotProjector(layout.seed, layout, backdrop, camera)(model);
  // City rendering consumes activityKey only as a cache/invalidation identity.
  // Replace the seed-derived key for Dream candidates without changing geometry.
  snapshot.layout.data.activityKey = publicationActivityKey();
  // This is a local capture sequence, not an authority/data revision. The future
  // publication manager must assign and bind its own immutable publication revision.
  dreamCaptureRevision = Math.max(Date.now(), dreamCaptureRevision + 1);
  snapshot.layout.revision = dreamCaptureRevision;
  const palettes = captureCityVisualPalettes(model, snapshot);
  const heroBuildingId = captureCityVisualHero(model, layout, snapshot);
  const districtIds = [...new Set(model.districts.map(item => item.id))].sort();
  const buildingIds = [...new Set([...model.buildings.map(item => item.id), ...model.rows.keys()])].sort();
  const districtAliases = new Map(districtIds.map((id, index) => [id, `district-${String(index + 1).padStart(4, "0")}`]));
  const buildingAliases = new Map(buildingIds.map((id, index) => [id, `building-${String(index + 1).padStart(4, "0")}`]));
  const boundedLabel = (value: string | null | undefined) => value?.trim().slice(0, 256) || "未命名";
  const display: DreamCityDisplayV1 = {
    schema: "agent-city-display:v1",
    city: { sessionCount: model.stats.totalSessions, activeCount: model.stats.activeCount, tokensTotal: model.stats.tokensTotal, truncated: model.stats.truncated },
    districts: model.districts.map(item => ({ id: districtAliases.get(item.id)!, label: boundedLabel(item.label),
      sessionCount: item.sessionCount, activeCount: item.activeCount, tokensTotal: item.tokensTotal })),
    buildings: model.buildings.map(item => {
      const row = model.rows.get(item.id);
      const source = row?.title_source;
      const titleSource = source === "codex_thread_name" || source === "claude_ai_title" || source === "dsh_workspace_title" ? source : null;
      const title = titleSource ? boundedLabel(row?.title) : null;
      return { id: buildingAliases.get(item.id)!, title, titleSource: title ? titleSource : null,
        sessionCount: 1, active: item.active, tokensTotal: item.tokensTotal };
    }),
  };
  const names = new Map(snapshot.model.districts.map((district, index) => [district.id, `城区 ${index + 1}`]));
  const layoutDistricts = snapshot.layout.data.districts;
  if (!Array.isArray(layoutDistricts)) throw new Error("dream_candidate_invalid");
  for (const district of layoutDistricts) {
    if (!district || typeof district !== "object" || typeof district.id !== "string" || !names.has(district.id)) throw new Error("dream_candidate_invalid");
    district.label = names.get(district.id);
    district.sessionCount = 0;
  }
  // These visual layers also carry source statistics or timestamps. Their
  // placement and dimensions are already fixed in the projected layout.
  for (const layer of [snapshot.layout.data.massing, snapshot.layout.data.contextBuildings, snapshot.layout.data.civics]) {
    if (!Array.isArray(layer)) throw new Error("dream_candidate_invalid");
  }
  for (const block of snapshot.layout.data.massing as Array<Record<string, unknown>>) { block.count = 0; block.tokens = 0; }
  for (const building of snapshot.layout.data.contextBuildings as Array<Record<string, unknown>>) building.appearAt = 0;
  for (const civic of snapshot.layout.data.civics as Array<Record<string, unknown>>) civic.unlockAt = 0;
  snapshot.model = {
    ...snapshot.model,
    districts: snapshot.model.districts.map(district => ({ ...district, label: names.get(district.id)!, sessionCount: 0, tokensTotal: 0, activeCount: 0 })),
    buildings: snapshot.model.buildings.map(building => ({ ...building, tokensTotal: 0, active: false, builtFraction: 1,
      busyness: 0, aggregated: false, extraCount: 0, startedAt: 1, endedAt: null })),
    rows: [],
    stats: { renderedSessions: 0, aggregatedSessions: 0, totalSessions: 0, tokensTotal: 0, activeCount: 0, truncated: false },
  };
  return { schema: "dream-city-snapshot:v2", revision: dreamCaptureRevision, snapshot, display, palettes, heroBuildingId };
}

