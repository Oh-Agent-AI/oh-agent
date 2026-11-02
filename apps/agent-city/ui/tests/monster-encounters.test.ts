import test from "node:test";
import assert from "node:assert/strict";
import { boardToWorld, type CityMechaSite, type FightCatalog } from "../src/game/mecha/citySite.ts";
import { cacheCatalog, cachedCatalog, encounterIsCurrent, encountersFromCatalog, forgetCatalog } from "../src/game/mecha/monsterEncounters.ts";
import { clearsHighways } from "../src/engine/roadGeometry.ts";
import { matchFromSite } from "../src/game/mecha/matchFromSite.ts";
import { spawnsAreOpenGround } from "../src/game/mecha/rules.ts";

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

test("encounter relocates its boss away from elevated roads without changing the battlefield", () => {
  const flat: CityMechaSite = { ...site(0, 0), cellW: 20, cellD: 20, heights: Array.from({ length: 10 }, () => Array(10).fill(2)), terrain: Array.from({ length: 10 }, () => Array(10).fill("land")), boss: { x: 2, y: 1 }, mechs: [{ id: "Assault", pos: { x: 0, y: 9 } }, { id: "Gunner", pos: { x: 4, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }], raiders: [{ id: "w", pos: { x: 0, y: 6 } }, { id: "e", pos: { x: 9, y: 6 } }] };
  const catalog: FightCatalog = { flat, shore: null, ridge: null, alley: null };
  const highways = [[{ x: 60, z: -100 }, { x: 60, z: 300 }]];
  const layout = {}, model = {};
  const [encounter] = encountersFromCatalog(layout, model, catalog, { highways });
  assert.ok(encounter);
  assert.notDeepEqual(encounter.site.boss, flat.boss);
  assert.equal(encounter.site.originX, flat.originX);
  assert.equal(encounter.site.terrain, flat.terrain);
  assert.ok(clearsHighways(encounter.at, 38, 38, highways));
  assert.deepEqual(matchFromSite(encounter.site, { preset: "none", script: "siege" }).boss.anchor, encounter.site.boss);
  assert.ok(spawnsAreOpenGround(matchFromSite(encounter.site, { preset: "none", script: "siege" })));
  assert.ok(encounterIsCurrent(encounter, layout, model));
  const ramps = [{ points: [{ x: -100, z: -100 }, { x: 300, z: -100 }, { x: 300, z: 300 }, { x: -100, z: 300 }, { x: -100, z: -100 }], width: 500 }];
  assert.equal(encountersFromCatalog(layout, model, catalog, { highways, highwayRamps: ramps }).length, 0);
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
