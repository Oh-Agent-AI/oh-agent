import test from "node:test";
import assert from "node:assert/strict";
import { Box3, Scene, Vector3 } from "three";
import { createCityMonster, disposeCityMonster } from "../src/game/cityMonster.ts";
import { encountersFromCatalog } from "../src/game/mecha/monsterEncounters.ts";
import type { CityMechaSite, FightCatalog } from "../src/game/mecha/citySite.ts";

function encounter() {
  const site: CityMechaSite = { originX: 10, originZ: 20, yaw: Math.PI / 2, cellW: 8, cellD: 8, heights: [], terrain: [], buildings: [], blocked: [], mechs: [], boss: { x: 2, y: 3 }, raiders: [], spawnSpread: 0 };
  const catalog: FightCatalog = { flat: site, shore: null, ridge: null, alley: null };
  return encountersFromCatalog({}, {}, catalog)[0]!;
}

test("city monster stands at the battle boss location and follows ground height", () => {
  const point = encounter();
  const boss = createCityMonster(point, () => 13);
  assert.equal(boss.position.x, point.at.x);
  assert.equal(boss.position.z, point.at.z);
  assert.equal(boss.position.y, 13);
  assert.equal(boss.scale.x, 2);
  const bounds = new Box3().setFromObject(boss);
  assert.ok(Math.abs(bounds.min.y - 13) < 0.15, `feet ${bounds.min.y} should meet ground`);
  assert.ok(bounds.max.y > 20);
  const scene = new Scene();
  scene.add(boss);
  assert.ok(scene.children.includes(boss));
  scene.remove(boss);
  disposeCityMonster(boss);
  assert.equal(boss.userData.disposed, true);
  assert.ok(!scene.children.includes(boss));
});

test("ground sampling is footprint based and invalid terrain is refused", () => {
  const point = encounter();
  const sampled: Vector3[] = [];
  const boss = createCityMonster(point, (x, z) => { sampled.push(new Vector3(x, 2 + x * .01, z)); return 2 + x * .01; });
  assert.equal(sampled.length, 4);
  assert.deepEqual(sampled.map(({ x, z }) => [x - point.at.x, z - point.at.z]), [[-13, -7.4], [13, -7.4], [-13.4, 8.2], [13.4, 8.2]].map(([dx, dz]) => [point.at.x + dx! - point.at.x, point.at.z + dz! - point.at.z]));
  assert.ok(Math.abs(boss.position.y - sampled.reduce((sum, sample) => sum + sample.y, 0) / 4) < 1e-9);
  disposeCityMonster(boss);
  assert.throws(() => createCityMonster(point, () => NaN), /ground height unavailable/);
});
