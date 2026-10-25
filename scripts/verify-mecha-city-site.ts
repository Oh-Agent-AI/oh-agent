import assert from "node:assert/strict";
import { test } from "node:test";
import { LOT } from "../apps/agent-city/ui/src/engine/worldScale.ts";
import { createMatch, pathDistance, spawnsAreOpenGround } from "../apps/agent-city/ui/src/game/mecha/rules.ts";
import { groundRoadClearance } from "../apps/agent-city/ui/src/engine/surface/roadClearance.ts";
import { CELL_LOTS, cellWorld, siteFightShapes, siteMechaWindow, type SiteAnchor } from "../apps/agent-city/ui/src/game/mecha/citySite.ts";

function anchor(id: string, x: number, z: number, height = 8): SiteAnchor {
  return { id, x, z, halfX: 3, halfZ: 3, ground: 4, height };
}

function open(site: ReturnType<typeof siteMechaWindow>) {
  assert.ok(site);
  const state = createMatch({
    preset: "covers_sparse_mid",
    script: "siege",
    covers: [],
    terrain: site.terrain,
    heights: site.heights,
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

test("the board stores the face sampled at each cell center", () => {
  const slopeOf = (x: number, z: number) => (x < -40 && z >= -40 ? 1 : 0);
  const site = siteMechaWindow({
    height: (_x, z) => (z < -40 ? -1 : 4),
    slope: slopeOf,
  }, [
    anchor("west", 40, 40),
    anchor("mid", 52, 40),
    anchor("north", 40, 52),
  ]);
  open(site);
  const state = createMatch({
    preset: "covers_sparse_mid",
    script: "siege",
    covers: [],
    terrain: site!.terrain,
    heights: site!.heights,
    buildings: site!.buildings.map((building) => ({ id: building.id, cells: building.cells })),
    raiders: site!.raiders,
    mechs: site!.mechs,
    boss: site!.boss,
  });
  for (let y = 0; y < 10; y += 1) {
    for (let x = 0; x < 10; x += 1) {
      const at = cellWorld(site!, { x, y });
      const face = at.y < 0.05 ? "water" : slopeOf(at.x, at.z) > 0.9 ? "mountain" : "land";
      assert.equal(site!.terrain[y]![x], face, `${x},${y}`);
      if (face !== "water") continue;
      const from = { x: x === 0 ? 1 : x - 1, y };
      if (site!.terrain[from.y]![from.x] !== "land") continue;
      assert.equal(pathDistance(state, from, { x, y }, "Assault"), null);
    }
  }
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

test("a carriageway through a land cell is marked road", () => {
  const anchors = [anchor("a", 0, 8), anchor("b", 16, 8), anchor("c", 8, 24)];
  const terrain = { height: (_x: number, z: number) => (z < 0 ? -3 : 4) };
  const bare = siteMechaWindow(terrain, anchors);
  assert.ok(bare);
  let hit: { x: number; y: number } | null = null;
  for (let y = 0; y < 10 && !hit; y += 1) {
    for (let x = 0; x < 10; x += 1) {
      if (bare.terrain[y]![x] === "land") {
        hit = { x, y };
        break;
      }
    }
  }
  assert.ok(hit);
  const at = cellWorld(bare, hit);
  const site = siteMechaWindow(terrain, anchors, [{
    id: "lane",
    from: "a",
    to: "b",
    width: 12,
    kind: "arterial",
    points: [{ x: at.x - 30, z: at.z }, { x: at.x + 30, z: at.z }],
  }]);
  assert.equal(site!.terrain[hit.y]![hit.x], "road");
  const farY = hit.y >= 2 ? hit.y - 2 : hit.y + 2;
  if (bare.terrain[farY]![hit.x] === "land") assert.equal(site!.terrain[farY]![hit.x], "land");
  for (let y = 0; y < 10; y += 1) {
    for (let x = 0; x < 10; x += 1) {
      if (cellWorld(site!, { x, y }).y < 0.05) assert.equal(site!.terrain[y]![x], "water");
    }
  }
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

function faces(site: NonNullable<ReturnType<typeof siteMechaWindow>>) {
  const counts = { land: 0, water: 0, mountain: 0, road: 0 };
  for (const row of site.terrain) for (const cell of row) counts[cell] += 1;
  return counts;
}

test("the flat window stays inland when a shore and a ridge also fit", () => {
  const anchors = [
    anchor("in-a", 400, 400),
    anchor("in-b", 412, 400),
    anchor("in-c", 404, 412),
    anchor("shore-a", 10, 24),
    anchor("shore-b", 22, 24),
    anchor("shore-c", 14, 36),
    anchor("ridge-a", 10, 240),
    anchor("ridge-b", 22, 240),
    anchor("ridge-c", 14, 252),
  ];
  const terrain = {
    height: (_x: number, z: number) => (z < 4 ? -1 : 4),
    slope: (x: number, z: number) => (x < 4 && z > 200 ? 1 : 0),
  };
  const shapes = siteFightShapes(terrain, anchors);
  const flat = siteMechaWindow(terrain, anchors);
  assert.ok(shapes.flat);
  assert.ok(flat);
  assert.equal(shapes.flat.originX, flat.originX);
  assert.equal(shapes.flat.originZ, flat.originZ);
  assert.equal(faces(shapes.flat).water, 0);
  assert.equal(faces(shapes.flat).mountain, 0);
  assert.ok(shapes.shore);
  assert.ok(faces(shapes.shore).water >= 8);
  assert.ok(faces(shapes.shore).water <= 30);
  assert.ok(faces(shapes.shore).land >= 50);
  open(shapes.shore);
  assert.ok(shapes.ridge);
  assert.ok(faces(shapes.ridge).mountain >= 4);
  assert.ok(faces(shapes.ridge).mountain <= 20);
  open(shapes.ridge);
});

test("a junction fillet outside every carriageway band is still road", () => {
  const anchors = [anchor("a", 0, 8), anchor("b", 16, 8), anchor("c", 8, 24)];
  const terrain = { height: () => 4 };
  const bare = siteMechaWindow(terrain, anchors);
  assert.ok(bare);
  let hit: { x: number; y: number } | null = null;
  for (let y = 0; y < 10 && !hit; y += 1) {
    for (let x = 0; x < 10; x += 1) {
      if (bare.terrain[y]![x] === "land") {
        hit = { x, y };
        break;
      }
    }
  }
  assert.ok(hit);
  const at = cellWorld(bare, hit);
  // (7, 7) sits outside both half-width 6 bands and inside the corner arc.
  const node = { x: at.x - 7, z: at.z - 7 };
  const roads = [
    { id: "east", from: "n", to: "e", width: 12, kind: "arterial" as const, points: [node, { x: node.x + 80, z: node.z }] },
    { id: "south", from: "n", to: "s", width: 12, kind: "arterial" as const, points: [node, { x: node.x, z: node.z + 80 }] },
  ];
  assert.ok(groundRoadClearance(roads, at.x, at.z) < 0);
  const site = siteMechaWindow(terrain, anchors, roads);
  assert.equal(site!.terrain[hit.y]![hit.x], "road");
});

test("an alley is the road between two rows of buildings", () => {
  const w = CELL_LOTS * LOT.width;
  const d = CELL_LOTS * LOT.depth;
  const anchors: SiteAnchor[] = [];
  for (const col of [0, 2, 4, 6]) {
    anchors.push(anchor(`n${col}`, col * w, 0));
    anchors.push(anchor(`s${col}`, col * w, 2 * d));
  }
  const bare = siteMechaWindow({ height: () => 4 }, anchors);
  assert.ok(bare);
  const idAt = (x: number, y: number) => bare.buildings.find((building) => building.cells.some((cell) => cell.x === x && cell.y === y))?.id ?? null;
  const canyon: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < 10; y += 1) {
    for (let x = 0; x < 10; x += 1) {
      const north = y > 0 ? idAt(x, y - 1) : null;
      const south = y + 1 < 10 ? idAt(x, y + 1) : null;
      const west = x > 0 ? idAt(x - 1, y) : null;
      const east = x + 1 < 10 ? idAt(x + 1, y) : null;
      if ((north && south && north !== south) || (west && east && west !== east)) canyon.push({ x, y });
    }
  }
  assert.ok(canyon.length >= 4);
  const roads = canyon.slice(0, 4).map((cell, index) => {
    const at = cellWorld(bare, cell);
    return {
      id: `lane-${index}`,
      from: `a${index}`,
      to: `b${index}`,
      width: 12,
      kind: "arterial" as const,
      points: [{ x: at.x - 40, z: at.z }, { x: at.x + 40, z: at.z }],
    };
  });
  const shapes = siteFightShapes({ height: () => 4 }, anchors, roads);
  assert.ok(shapes.alley);
  assert.ok(faces(shapes.alley).road >= 4);
});
