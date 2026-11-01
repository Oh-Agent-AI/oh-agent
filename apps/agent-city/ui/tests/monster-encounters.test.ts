import test from "node:test";
import assert from "node:assert/strict";
import { boardToWorld, type CityMechaSite, type FightCatalog } from "../src/game/mecha/citySite.ts";
import { cacheCatalog, cachedCatalog, encounterIsCurrent, encountersFromCatalog, forgetCatalog } from "../src/game/mecha/monsterEncounters.ts";

function site(x: number, yaw: number): CityMechaSite {
  return { originX: x, originZ: 25, yaw, cellW: 8, cellD: 12, heights: [], terrain: [], buildings: [], blocked: [], mechs: [], boss: { x: 2, y: 3 }, raiders: [], spawnSpread: 0 };
}

test("encounters use the boss footprint in the selected city's terrain", () => {
  const layout = {}, model = {};
  const flat = site(4, 0), shore = site(200, Math.PI / 2);
  const catalog: FightCatalog = { flat, shore, ridge: null, alley: null };
  const encounters = encountersFromCatalog(layout, model, catalog);
  assert.deepEqual(encounters.map((entry) => entry.shape), ["flat", "shore"]);
  for (const entry of encounters) {
    assert.equal(entry.site, catalog[entry.shape]);
    assert.deepEqual(entry.at, boardToWorld(entry.site, (entry.site.boss.x + 1) * entry.site.cellW, (entry.site.boss.y + 1) * entry.site.cellD));
    assert.equal(encounterIsCurrent(entry, layout, model), true);
    assert.equal(encounterIsCurrent(entry, {}, model), false);
    assert.equal(encounterIsCurrent(entry, layout, {}), false);
  }
  assert.equal(encountersFromCatalog(layout, model, { flat: null, shore: null, ridge: null, alley: null }).length, 0);
});

test("catalog cache is scoped to both layout and model", () => {
  const layout = {}, model = {};
  const catalog: FightCatalog = { flat: site(1, 0), shore: null, ridge: null, alley: null };
  cacheCatalog(layout, model, catalog);
  assert.equal(cachedCatalog(layout, model), catalog);
  assert.equal(cachedCatalog(layout, {}), null);
  forgetCatalog(layout);
  assert.equal(cachedCatalog(layout, model), null);
});
