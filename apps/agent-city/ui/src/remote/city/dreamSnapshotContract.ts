import type { RemoteCitySnapshot, RemoteCityVisualPalette } from "./cityDisplayProjection";

/** Preliminary visitor contract; the trusted host must independently validate all data before sending. */
export type DreamCitySnapshotV1 = {
  schema: "dream-city-snapshot:v2";
  revision: number;
  snapshot: RemoteCitySnapshot;
  display: DreamCityDisplayV1;
  palettes: RemoteCityVisualPalette[];
  heroBuildingId: string | null;
};

/** Approved visitor-facing labels and usage, kept out of the renderer model. */
export type DreamCityDisplayV1 = {
  schema: "agent-city-display:v1";
  city: { sessionCount: number; activeCount: number; tokensTotal: number; truncated: boolean };
  districts: Array<{ id: string; label: string; sessionCount: number; activeCount: number; tokensTotal: number }>;
  buildings: Array<{ id: string; title: string | null; titleSource: "codex_thread_name" | "claude_ai_title" | "dsh_workspace_title" | null; sessionCount: number; active: boolean; tokensTotal: number }>;
};

const alias = /^(?:district|building)-(?:(\d{4,8})|([a-f0-9]{16}|[a-f0-9]{32}))$/;
const validAlias = (value: string) => {
  const match = alias.exec(value);
  return Boolean(match && (match[1] ? Number(match[1]) > 0 : /[1-9a-f]/.test(match[2]!)));
};
const color = /^#[a-fA-F0-9]{6}$/;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** Compatibility and bounds check, not a privacy projection or a substitute for the host's allowlist. */
export function parseDreamCitySnapshot(bytes: Uint8Array): DreamCitySnapshotV1 {
  let data: unknown;
  try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("dream_snapshot_invalid"); }
  if (!record(data) || !exact(data, ["schema", "revision", "snapshot", "display", "palettes", "heroBuildingId"]) || data.schema !== "dream-city-snapshot:v2"
      || !Number.isSafeInteger(data.revision) || Number(data.revision) < 1 || !record(data.snapshot)
      || !exact(data.snapshot, ["layout", "model"]) || !record(data.snapshot.layout) || !record(data.snapshot.model)) throw new Error("dream_snapshot_invalid");
  const layout = data.snapshot.layout, model = data.snapshot.model;
  if (layout.schema !== "remote-city-layout:v1" || layout.generatorVersion !== 1 || !record(layout.data) || !record(layout.camera)
      || !Array.isArray(model.districts) || !model.districts.length || model.districts.length > 32
      || !Array.isArray(model.buildings) || model.buildings.length > 5000 || !Array.isArray(model.rows) || model.rows.length > 4000
      || model.rows.length !== 0 || !record(model.stats) || !Array.isArray(data.palettes) || data.palettes.length !== model.districts.length
      || !record(data.display) || !exact(data.display, ["schema", "city", "districts", "buildings"]) || data.display.schema !== "agent-city-display:v1"
      || !record(data.display.city) || !exact(data.display.city, ["sessionCount", "activeCount", "tokensTotal", "truncated"])
      || !Array.isArray(data.display.districts) || !Array.isArray(data.display.buildings)) throw new Error("dream_snapshot_invalid");
  const districts = new Set<string>();
  for (const district of model.districts) {
    if (!record(district) || typeof district.id !== "string" || !validAlias(district.id) || !district.id.startsWith("district-") || districts.has(district.id)) throw new Error("dream_snapshot_invalid");
    districts.add(district.id);
  }
  const buildings = new Map<string, string>();
  for (const building of model.buildings) {
    if (!record(building) || typeof building.id !== "string" || !validAlias(building.id) || !building.id.startsWith("building-") || buildings.has(building.id)
        || typeof building.districtId !== "string" || !districts.has(building.districtId)) throw new Error("dream_snapshot_invalid");
    buildings.set(building.id, building.districtId);
  }
  const usage = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  const display = data.display as unknown as DreamCityDisplayV1;
  if (!usage(display.city.sessionCount) || !usage(display.city.activeCount) || !usage(display.city.tokensTotal) || typeof display.city.truncated !== "boolean"
      || display.districts.length !== districts.size || display.buildings.length > 4000) throw new Error("dream_snapshot_invalid");
  const shownDistricts = new Set<string>();
  for (const item of display.districts) {
    if (!record(item) || !exact(item, ["id", "label", "sessionCount", "activeCount", "tokensTotal"]) || typeof item.id !== "string"
        || !districts.has(item.id) || shownDistricts.has(item.id) || typeof item.label !== "string" || !item.label.trim() || [...item.label].length > 256
        || !usage(item.sessionCount) || !usage(item.activeCount) || !usage(item.tokensTotal)) throw new Error("dream_snapshot_invalid");
    shownDistricts.add(item.id);
  }
  const shownBuildings = new Set<string>();
  for (const item of display.buildings) {
    if (!record(item) || !exact(item, ["id", "title", "titleSource", "sessionCount", "active", "tokensTotal"]) || typeof item.id !== "string"
        || !buildings.has(item.id) || shownBuildings.has(item.id) || !(item.title === null || (typeof item.title === "string" && !!item.title.trim() && [...item.title].length <= 256))
        || !(item.titleSource === null || ["codex_thread_name", "claude_ai_title", "dsh_workspace_title"].includes(item.titleSource as string))
        || (item.title === null) !== (item.titleSource === null) || !usage(item.sessionCount) || item.sessionCount > 1
        || typeof item.active !== "boolean" || !usage(item.tokensTotal)) throw new Error("dream_snapshot_invalid");
    shownBuildings.add(item.id);
  }
  if (shownBuildings.size !== buildings.size) throw new Error("dream_snapshot_invalid");
  const colors = new Set<string>();
  let totalShare = 0;
  for (const entry of data.palettes) {
    if (!record(entry) || !exact(entry, ["districtId", "palette", "landmarkHeight", "flagShare"]) || typeof entry.districtId !== "string"
        || !districts.has(entry.districtId) || colors.has(entry.districtId) || !record(entry.palette) || !exact(entry.palette, ["wall", "roof", "accent", "park"])
        || Object.values(entry.palette).some(value => typeof value !== "string" || !color.test(value))
        || typeof entry.landmarkHeight !== "number" || !Number.isFinite(entry.landmarkHeight) || entry.landmarkHeight < 0 || entry.landmarkHeight > 90
        || typeof entry.flagShare !== "number" || !Number.isFinite(entry.flagShare) || entry.flagShare < 0 || entry.flagShare > 1) throw new Error("dream_snapshot_invalid");
    colors.add(entry.districtId);
    totalShare += entry.flagShare;
  }
  if (totalShare > 0 && Math.abs(totalShare - 1) > 1e-9) throw new Error("dream_snapshot_invalid");
  if (data.heroBuildingId !== null && (typeof data.heroBuildingId !== "string" || !buildings.has(data.heroBuildingId))) throw new Error("dream_snapshot_invalid");
  if (typeof data.heroBuildingId === "string") {
    const districtId = buildings.get(data.heroBuildingId);
    if (!Array.isArray(layout.data.districts) || !layout.data.districts.some(district => record(district) && district.id === districtId
      && record(district.slots) && Array.isArray(district.slots.__remoteMap)
      && district.slots.__remoteMap.some((slot: unknown) => Array.isArray(slot) && slot.length === 2 && slot[0] === data.heroBuildingId))) throw new Error("dream_snapshot_invalid");
  }
  return data as DreamCitySnapshotV1;
}
