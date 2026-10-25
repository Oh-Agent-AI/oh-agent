import assert from "node:assert/strict";
import { test } from "node:test";
import { LOT } from "../apps/agent-city/ui/src/engine/worldScale.ts";
import { createMatch, spawnsAreOpenGround } from "../apps/agent-city/ui/src/game/mecha/rules.ts";
import { CELL_LOTS, cellWorld, siteMechaWindow, type SiteAnchor } from "../apps/agent-city/ui/src/game/mecha/citySite.ts";

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

test("the board follows the street the buildings face", () => {
  const yaw = Math.PI / 5;
  const place = (id: string, lx: number, lz: number, face = yaw): SiteAnchor => {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    return { id, x: 80 + lx * c + lz * s, z: 80 - lx * s + lz * c, halfX: 3, halfZ: 3, yaw: face, ground: 4, height: 8 };
  };
  const site = siteMechaWindow({ height: () => 4 }, [
    place("west", 0, 0),
    place("mid", 2 * LOT.width, 0),
    place("north", 0, 2 * LOT.depth),
    place("side", 2 * LOT.width, 2 * LOT.depth, yaw + Math.PI / 2),
  ]);
  open(site);
  const turned = site!.yaw - yaw;
  const wrapped = ((turned + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  assert.ok(Math.abs(wrapped) < 1e-9);
  const a = cellWorld(site!, { x: 0, y: 0 });
  const b = cellWorld(site!, { x: 1, y: 0 });
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  assert.equal(CELL_LOTS, 2);
  assert.ok(Math.abs(len - CELL_LOTS * LOT.width) < 1e-9);
  const along = ((b.x - a.x) / len) * Math.cos(yaw) + ((b.z - a.z) / len) * (-Math.sin(yaw));
  assert.ok(along > 0.99);
  assert.equal(LOT.width, 7.2);
  assert.equal(LOT.depth, 8);
  assert.equal(site!.buildings.length, 4);
  assert.equal(site!.buildings.find((building) => building.id === "side")?.cells.length, 1);
});

test("a stretched frontage doubles with the cell", () => {
  const pitch = 7.6;
  const lot = (id: string, x: number, z: number): SiteAnchor => ({
    id, x, z, halfX: LOT.width / 2, halfZ: LOT.depth / 2, yaw: 0, ground: 4, height: 8,
  });
  const site = siteMechaWindow({ height: () => 4 }, [
    lot("a", 0, 0),
    lot("b", pitch, 0),
    lot("c", pitch * 2, 0),
  ]);
  open(site);
  assert.ok(site!.buildings.length >= 2);
  const a = cellWorld(site!, { x: 0, y: 0 });
  const b = cellWorld(site!, { x: 1, y: 0 });
  assert.ok(Math.abs(Math.hypot(b.x - a.x, b.z - a.z) - pitch * CELL_LOTS) < 1e-6);
  assert.ok(Math.abs(site!.cellW - pitch * CELL_LOTS) < 1e-6);
  assert.equal(site!.cellD, LOT.depth * CELL_LOTS);
});

test("a doubled cell holds a lot centered on it", () => {
  const lot = (id: string, x: number, z: number): SiteAnchor => ({
    id, x, z, halfX: LOT.width / 2, halfZ: LOT.depth / 2, yaw: 0, ground: 4, height: 8,
  });
  const site = siteMechaWindow({ height: () => 4 }, [
    lot("a", 0, 0),
    lot("b", CELL_LOTS * LOT.width, 0),
    lot("c", 0, CELL_LOTS * LOT.depth),
  ]);
  open(site);
  assert.equal(site!.buildings.length, 3);
  for (const building of site!.buildings) assert.equal(building.cells.length, 1);
  assert.ok(Math.abs(site!.cellW - CELL_LOTS * LOT.width) < 1e-9);
  assert.ok(Math.abs(site!.cellD - CELL_LOTS * LOT.depth) < 1e-9);
});
