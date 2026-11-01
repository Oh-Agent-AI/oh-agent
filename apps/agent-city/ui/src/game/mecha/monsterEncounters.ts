import { boardToWorld, type CityMechaSite, type FightCatalog, type FightShape } from "./citySite";

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

export function encountersFromCatalog(layout: object, model: object, catalog: FightCatalog): MonsterEncounter[] {
  return FIGHT_SHAPES.flatMap((shape) => {
    const site = catalog[shape];
    if (!site) return [];
    const at = boardToWorld(site, (site.boss.x + 1) * site.cellW, (site.boss.y + 1) * site.cellD);
    return [{ shape, site, layout, model, catalog, at }];
  });
}

export function encounterIsCurrent(encounter: MonsterEncounter, layout: object | null, model: object | null): boolean {
  return encounter.layout === layout && encounter.model === model && encounter.catalog[encounter.shape] === encounter.site;
}
