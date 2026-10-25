import assert from "node:assert/strict";
import { test } from "node:test";
import { createMatch, spawnsAreOpenGround } from "../apps/agent-city/ui/src/game/mecha/rules.ts";
import { cellWorld, siteMechaWindow, type SiteAnchor } from "../apps/agent-city/ui/src/game/mecha/citySite.ts";

function anchor(id: string, x: number, z: number, height = 8): SiteAnchor {
  return { id, x, z, halfX: 3, halfZ: 3, ground: 4, height };
}

function open(site: ReturnType<typeof siteMechaWindow>) {
  assert.ok(site);
  const state = createMatch({
    preset: "covers_sparse_mid",
    script: "siege",
    covers: [],
    buildings: site.buildings.map((building) => ({ id: building.id, cells: building.cells })),
    raiders: site.raiders,
    mechs: site.mechs,
    boss: site.boss,
  });
  assert.equal(spawnsAreOpenGround(state), true);
  assert.equal(site.raiders.length, 2);
  assert.ok(site.buildings.length >= 2);
  assert.ok(site.spawnSpread <= 1);
  const bossCells = [
    site.boss,
    { x: site.boss.x + 1, y: site.boss.y },
    { x: site.boss.x, y: site.boss.y + 1 },
    { x: site.boss.x + 1, y: site.boss.y + 1 },
  ];
  for (const cell of bossCells) {
    const world = cellWorld(site, cell);
    assert.equal(world.y, 4);
  }
}

test("a flat cluster becomes a siege board on open ground", () => {
  const site = siteMechaWindow({ height: () => 4 }, [
    anchor("west", 40, 40),
    anchor("mid", 52, 40),
    anchor("north", 40, 52),
  ]);
  open(site);
  assert.equal(site!.buildings.length, 3);
});

test("a steep cluster loses to the flat one", () => {
  const site = siteMechaWindow({
    height: (x) => (x >= 300 ? 20 + (x - 300) * 0.4 : 4),
  }, [
    anchor("flat-a", 20, 20),
    anchor("flat-b", 32, 20),
    anchor("flat-c", 24, 32),
    anchor("steep-a", 360, 20, 12),
    anchor("steep-b", 372, 24, 12),
    anchor("steep-c", 364, 36, 12),
  ]);
  open(site);
  assert.ok(site!.originX < 200);
});

test("water is not the battlefield", () => {
  const site = siteMechaWindow({
    height: (_x, z) => (z < 0 ? -3 : 4),
  }, [
    anchor("dry-a", 10, 30),
    anchor("dry-b", 22, 30),
    anchor("dry-c", 14, 42),
    anchor("wet-a", 10, -30),
    anchor("wet-b", 22, -30),
    anchor("wet-c", 14, -18),
  ]);
  open(site);
  const cells = [
    ...site!.buildings.flatMap((building) => building.cells),
    ...site!.mechs.map((mech) => mech.pos),
    ...site!.raiders.map((raider) => raider.pos),
    site!.boss,
    { x: site!.boss.x + 1, y: site!.boss.y },
    { x: site!.boss.x, y: site!.boss.y + 1 },
    { x: site!.boss.x + 1, y: site!.boss.y + 1 },
  ];
  for (const cell of cells) {
    const world = cellWorld(site!, cell);
    assert.equal(world.y, 4);
    assert.ok(world.z >= 0);
  }
});
