import { boardToWorld, type CityMechaSite, type FightCatalog, type FightShape } from "./citySite";
import { clearsHighways, segmentDistance } from "../../engine/roadGeometry";
import { BOARD, FLAT_SPAWN_MAX_DELTA } from "./rules";

export const FIGHT_SHAPES: readonly FightShape[] = ["flat", "shore", "ridge", "alley"];

export type MonsterEncounter = {
  shape: FightShape;
  site: CityMechaSite;
  layout: object;
  model: object;
  catalog: FightCatalog;
  at: { x: number; z: number };
};

type CatalogCacheEntry = { model: object; catalog: FightCatalog };
const CATALOG_CACHE = new WeakMap<object, CatalogCacheEntry>();

export function cachedCatalog(layout: object | null, model: object | null): FightCatalog | null {
  if (!layout || !model) return null;
  const entry = CATALOG_CACHE.get(layout);
  return entry && entry.model === model ? entry.catalog : null;
}

export function cacheCatalog(layout: object, model: object, catalog: FightCatalog): void {
  CATALOG_CACHE.set(layout, { model, catalog });
}

export function forgetCatalog(layout: object | null): void {
  if (layout) CATALOG_CACHE.delete(layout);
}

type EncounterObstacles = {
  highways: Array<Array<{ x: number; z: number }>>;
  highwayRamps?: Array<{ points: Array<{ x: number; z: number }>; width: number }>;
};

function safeBossSite(site: CityMechaSite, obstacles: EncounterObstacles): CityMechaSite | null {
  const occupied = new Set([...site.blocked, ...site.buildings.flatMap((building) => building.cells), ...site.mechs.map((mech) => mech.pos), ...site.raiders.map((raider) => raider.pos)].map((cell) => `${cell.x},${cell.y}`));
  const otherHeights = [...site.mechs.map((mech) => mech.pos), ...site.raiders.map((raider) => raider.pos)].map((cell) => site.heights[cell.y]?.[cell.x]);
  const candidates = [];
  for (let y = 0; y <= 5; y += 1) for (let x = 0; x < BOARD - 1; x += 1) {
    const cells = [{ x, y }, { x: x + 1, y }, { x, y: y + 1 }, { x: x + 1, y: y + 1 }];
    if (cells.some((cell) => occupied.has(`${cell.x},${cell.y}`) || !["land", "road"].includes(site.terrain[cell.y]?.[cell.x] ?? ""))) continue;
    const heights = [...otherHeights, ...cells.map((cell) => site.heights[cell.y]?.[cell.x])];
    if (heights.some((height) => height === undefined || !Number.isFinite(height))) continue;
    const spread = Math.max(...heights as number[]) - Math.min(...heights as number[]);
    if (spread > Math.max(FLAT_SPAWN_MAX_DELTA, site.spawnSpread) + 1e-6) continue;
    const at = boardToWorld(site, (x + 1) * site.cellW, (y + 1) * site.cellD);
    if (!clearsHighways(at, 38, 38, obstacles.highways)) continue;
    if ((obstacles.highwayRamps ?? []).some((ramp) => ramp.points.slice(1).some((end, i) => segmentDistance(at, ramp.points[i]!, end) < Math.hypot(38, 38) / 2 + ramp.width / 2 + 1))) continue;
    candidates.push({ x, y, spread });
  }
  candidates.sort((a, b) => Math.abs(a.x - site.boss.x) + Math.abs(a.y - site.boss.y) - Math.abs(b.x - site.boss.x) - Math.abs(b.y - site.boss.y) || a.y - b.y || a.x - b.x);
  const chosen = candidates[0];
  return chosen ? { ...site, boss: { x: chosen.x, y: chosen.y }, spawnSpread: chosen.spread } : null;
}

export function encountersFromCatalog(layout: object, model: object, catalog: FightCatalog, obstacles?: EncounterObstacles): MonsterEncounter[] {
  return FIGHT_SHAPES.flatMap((shape) => {
    const original = catalog[shape];
    const site = original && obstacles ? safeBossSite(original, obstacles) : original;
    if (!site) return [];
    const adjustedCatalog = site === original ? catalog : { ...catalog, [shape]: site };
    const at = boardToWorld(site, (site.boss.x + 1) * site.cellW, (site.boss.y + 1) * site.cellD);
    return [{ shape, site, layout, model, catalog: adjustedCatalog, at }];
  });
}

export function encounterIsCurrent(encounter: MonsterEncounter, layout: object | null, model: object | null): boolean {
  return encounter.layout === layout && encounter.model === model && encounter.catalog[encounter.shape] === encounter.site;
}
