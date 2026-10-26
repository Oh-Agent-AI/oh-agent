import assert from "node:assert/strict";
import { test } from "node:test";
import { LOT } from "../apps/agent-city/ui/src/engine/worldScale.ts";
import { bossPrepare, createMatch, FLAT_SPAWN_MAX_DELTA, pathDistance, RELAXED_SPAWN_MAX_DELTA, spawnsAreOpenGround, validateAndApplyPlan } from "../apps/agent-city/ui/src/game/mecha/rules.ts";
import { matchFromSite } from "../apps/agent-city/ui/src/game/mecha/matchFromSite.ts";
import { groundRoadClearance } from "../apps/agent-city/ui/src/engine/surface/roadClearance.ts";
import { CELL_LOTS, cellWorld, prepareFightTerrain, searchPrepared, searchPreparedAsync, siteFightShapes, siteFightShapesAsync, siteMechaWindow, type SiteAnchor } from "../apps/agent-city/ui/src/game/mecha/citySite.ts";

function anchor(id: string, x: number, z: number, height = 8): SiteAnchor {
  return { id, x, z, halfX: 3, halfZ: 3, ground: 4, height };
}

function open(site: ReturnType<typeof siteMechaWindow>) {
  assert.ok(site);
  const state = matchFromSite(site, { preset: "covers_sparse_mid", script: "siege" });
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

test("a one-sided frontage road is still an alley", () => {
  const w = CELL_LOTS * LOT.width;
  const anchors = [0, 2, 4, 6].map((col) => anchor(`n${col}`, col * w, 0));
  const bare = siteMechaWindow({ height: () => 4 }, anchors);
  assert.ok(bare);
  const frontage: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < 10; y += 1) {
    for (let x = 0; x < 10; x += 1) {
      if (bare.terrain[y]![x] !== "land") continue;
      const beside = bare.buildings.some((building) => building.cells.some((cell) => Math.abs(cell.x - x) + Math.abs(cell.y - y) === 1));
      if (beside) frontage.push({ x, y });
    }
  }
  assert.ok(frontage.length >= 4);
  const roads = frontage.slice(0, 4).map((cell, index) => {
    const at = cellWorld(bare, cell);
    return {
      id: `front-${index}`,
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

test("water stays water under a carriageway, and a deck does not paint the land beneath it", () => {
  const anchors = [
    anchor("in-a", 400, 400),
    anchor("in-b", 412, 400),
    anchor("in-c", 404, 412),
    anchor("shore-a", 10, 24),
    anchor("shore-b", 22, 24),
    anchor("shore-c", 14, 36),
  ];
  const terrain = { height: (_x: number, z: number) => (z < 4 ? -1 : 4) };
  const bare = siteFightShapes(terrain, anchors).shore;
  assert.ok(bare);
  let waterCell: { x: number; y: number } | null = null;
  let landCell: { x: number; y: number } | null = null;
  for (let y = 0; y < 10; y += 1) {
    for (let x = 0; x < 10; x += 1) {
      if (!waterCell && bare.terrain[y]![x] === "water") waterCell = { x, y };
      if (!landCell && bare.terrain[y]![x] === "land") landCell = { x, y };
    }
  }
  assert.ok(waterCell);
  assert.ok(landCell);
  const span = (at: { x: number; z: number }, extra: { bridge?: boolean; structure?: "deck" }) => [{
    id: "span",
    from: "a",
    to: "b",
    width: 12,
    kind: "arterial" as const,
    points: [{ x: at.x - 40, z: at.z }, { x: at.x + 40, z: at.z }],
    ...extra,
  }];
  const waterAt = cellWorld(bare, waterCell);
  const landAt = cellWorld(bare, landCell);
  const wet = siteFightShapes(terrain, anchors, span(waterAt, {})).shore;
  assert.ok(wet);
  assert.equal(wet.terrain[waterCell.y]![waterCell.x], "water");
  const deckRoads = span(landAt, { bridge: true, structure: "deck" });
  assert.ok(groundRoadClearance(deckRoads, landAt.x, landAt.z) >= 0);
  const deck = siteFightShapes(terrain, anchors, deckRoads).shore;
  assert.ok(deck);
  assert.equal(deck.terrain[landCell.y]![landCell.x], "land");
  const paved = siteFightShapes(terrain, anchors, span(landAt, {})).shore;
  assert.ok(paved);
  assert.equal(paved.terrain[landCell.y]![landCell.x], "road");
});

// A city large enough that the search spans several 1 ms slices. The same
// anchors/terrain are used by the equality, determinism and cancellation tests.
function variedCity(): SiteAnchor[] {
  const anchors: SiteAnchor[] = [];
  for (let r = 0; r < 12; r += 1) {
    for (let c = 0; c < 14; c += 1) {
      const t = (r * 31 + c * 17) % 7;
      anchors.push({
        id: `v${r}-${c}`,
        x: c * 23 + (t % 3) * 1.5,
        z: r * 25 + (t % 4),
        halfX: 2.5 + (t % 3),
        halfZ: 2.5 + ((t + 1) % 3),
        yaw: (t % 4) * Math.PI / 2,
        ground: 4,
        height: 6 + (t % 5) * 3,
      });
    }
  }
  anchors.sort((a, b) => (a.id < b.id ? -1 : 1));
  return anchors;
}
const variedTerrain = {
  height: (x: number, z: number) => 4 + Math.sin(x / 90) * 3 + Math.cos(z / 70) * 2.5 + (z < 4 ? -5 : 0),
};

test("the async search yields to the host and matches the sync catalog", async () => {
  const anchors = variedCity();
  const expected = siteFightShapes(variedTerrain, anchors);
  let hostTurn = false;
  const turn = setTimeout(() => { hostTurn = true; }, 0);
  const actual = await siteFightShapesAsync(variedTerrain, anchors, undefined, { sliceMs: 1 });
  clearTimeout(turn);
  assert.equal(hostTurn, true, "the search must give the host a turn between slices");
  assert.deepEqual(actual, expected);
});

test("repeating the battlefield search is byte-identical", () => {
  const anchors = variedCity();
  assert.deepEqual(siteFightShapes(variedTerrain, anchors), siteFightShapes(variedTerrain, anchors));
});

test("the async search stops promptly when the request is cancelled", async () => {
  const controller = new AbortController();
  const started = performance.now();
  const timer = setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    siteFightShapesAsync(variedTerrain, variedCity(), undefined, { signal: controller.signal, sliceMs: 1 }),
    (reason: unknown) => (reason as Error).name === "AbortError",
  );
  clearTimeout(timer);
  assert.ok(performance.now() - started < 500, "cancellation should be acknowledged within 500 ms");
});

test("the worker snapshot is structured-cloneable and searches to the same catalog", () => {
  const anchors = variedCity();
  const snapshot = prepareFightTerrain(variedTerrain, anchors, 7);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.revision, 7);
  assert.match(snapshot.fingerprint, /^[0-9a-f]{8}$/);
  // structuredClone is the exact boundary a worker postMessage crosses: a closure,
  // an engine reference or a live Map anywhere in the snapshot would throw here.
  const cloned = structuredClone(snapshot);
  assert.deepEqual(searchPrepared(cloned), siteFightShapes(variedTerrain, anchors));
});

test("the snapshot fingerprint follows the sampled terrain", () => {
  const anchors = variedCity();
  const dry = prepareFightTerrain(variedTerrain, anchors);
  const wet = prepareFightTerrain({ height: (x, z) => variedTerrain.height(x, z) + (z < 4 ? 0 : 1) }, anchors);
  assert.notEqual(dry.fingerprint, wet.fingerprint);
});

test("the worker message protocol runs the prepared search", async () => {
  type Scope = { postMessage?: (message: unknown) => void; onmessage?: (event: unknown) => void };
  const scope = globalThis as unknown as Scope;
  const previousPost = scope.postMessage;
  const messages: Array<{ type: string; requestId: string; catalog?: unknown }> = [];
  scope.postMessage = (message: unknown) => { messages.push(message as never); };
  try {
    await import("../apps/agent-city/ui/src/game/mecha/fightWorker.ts");
    const snapshot = prepareFightTerrain(variedTerrain, variedCity());
    scope.onmessage?.({ data: { type: "search", requestId: "req-1", snapshot, roads: [] } });
    const result = messages.find((message) => message.type === "result");
    assert.ok(result, "the worker must post a result");
    assert.equal(result!.requestId, "req-1");
    assert.deepEqual(result!.catalog, searchPrepared(snapshot, []));
  } finally {
    scope.postMessage = previousPost;
  }
});

test("a relaxed spawn window is bounded and observable", () => {
  // Checkerboard 4 / 5.5 makes every 2×2 boss footprint span 1.5, so the strict
  // limit of 1 cannot pass and the documented relaxed pass must be what returns.
  const anchors: SiteAnchor[] = [];
  for (let r = 0; r < 8; r += 1) {
    for (let c = 0; c < 8; c += 1) anchors.push(anchor(`r${r}c${c}`, c * 14.4 + 7.2, r * 16 + 8));
  }
  anchors.sort((a, b) => (a.id < b.id ? -1 : 1));
  const height = (x: number, z: number) => 4 + ((Math.floor(x / 14.4) + Math.floor(z / 16)) % 2) * 1.5;
  const site = siteMechaWindow({ height }, anchors);
  assert.ok(site);
  assert.ok(site!.spawnSpread > FLAT_SPAWN_MAX_DELTA);
  assert.ok(site!.spawnSpread <= RELAXED_SPAWN_MAX_DELTA);
});

test("the sliced fallback yields between invalid candidates", async () => {
  // Every cell is a cliff: `evaluateWindow` returns null for every attempt. A
  // generator that only yields valid windows would scan the whole search space
  // inside one `next()` and never give the host a turn.
  const snapshot = prepareFightTerrain({ height: () => 4, slope: () => 2 }, variedCity());
  let hostTurn = false;
  const timer = setTimeout(() => { hostTurn = true; }, 0);
  const catalog = await searchPreparedAsync(snapshot, undefined, { sliceMs: 1 });
  clearTimeout(timer);
  assert.equal(catalog.flat, null);
  assert.equal(hostTurn, true, "invalid candidates must still yield between attempts");
});

test("the fingerprint covers anchor identity, ground and height", () => {
  const anchors = variedCity();
  const base = prepareFightTerrain(variedTerrain, anchors).fingerprint;
  const variants: Array<(a: SiteAnchor) => SiteAnchor> = [
    (a) => ({ ...a, id: `${a.id}-renamed` }),
    (a) => ({ ...a, ground: a.ground + 1 }),
    (a) => ({ ...a, height: a.height + 1 }),
  ];
  for (const mutate of variants) {
    const changed = anchors.map((a, index) => index === 0 ? mutate(a) : a);
    assert.notEqual(prepareFightTerrain(variedTerrain, changed).fingerprint, base);
  }
});

function tiltedSite() {
  const tilted: SiteAnchor = { id: "tilt", x: 52, z: 52, halfX: 3, halfZ: 3, yaw: 0.6, ground: 4, height: 8 };
  const site = siteMechaWindow({ height: () => 4 }, [anchor("west", 40, 40), anchor("mid", 52, 40), anchor("north", 40, 52), tilted]);
  assert.ok(site);
  return site;
}

test("a tilted lot inside the window is not walkable ground in the match", () => {
  const site = tiltedSite();
  const state = matchFromSite(site, { preset: "covers_sparse_mid", script: "siege" });
  // 斜放的楼落在 (9,9)：城里画着楼的格子，规则里不该能走进去。
  assert.equal(pathDistance(state, site.mechs[2]!.pos, { x: 9, y: 9 }, "Support"), null);
});

test("blocked cells are exported: land only, sorted, covered by the tilted anchor", () => {
  const site = tiltedSite();
  assert.ok(site.blocked.length > 0);
  assert.ok(site.blocked.some((c) => c.x === 9 && c.y === 9));
  for (const c of site.blocked) assert.equal(site.terrain[c.y]![c.x], "land");
  const owned = new Set(site.buildings.flatMap((b) => b.cells.map((c) => `${c.x},${c.y}`)));
  for (const c of site.blocked) assert.equal(owned.has(`${c.x},${c.y}`), false);
  const sorted = [...site.blocked].sort((a, b) => a.y - b.y || a.x - b.x);
  assert.deepEqual(site.blocked, sorted);
  const state = matchFromSite(site, { preset: "covers_sparse_mid", script: "siege" });
  assert.deepEqual(state.obstacles, site.blocked);
});

test("matchFromSite reproduces the hand-built createMatch args, with buildings in every script (D2)", () => {
  const site = tiltedSite();
  for (const script of ["siege", "cadence_ssw"] as const) {
    const old = createMatch({
      preset: "covers_sparse_mid", script, covers: [],
      terrain: site.terrain.map((row) => row.slice()),
      heights: site.heights.map((row) => row.slice()),
      // D2 = b：以前 cadence_ssw 在城里没有楼，机甲能穿楼而过；现在每个脚本都带楼、都守楼。
      buildings: site.buildings.map((b) => ({ id: b.id, cells: b.cells.map((c) => ({ ...c })) })),
      raiders: script === "siege" ? site.raiders.map((r) => ({ id: r.id, pos: { ...r.pos } })) : [],
      mechs: site.mechs.map((m) => ({ id: m.id, pos: { ...m.pos } })),
      boss: { ...site.boss },
      stake: "all",
    });
    const now = matchFromSite(site, { preset: "covers_sparse_mid", script, stake: "all" });
    const { obstacles, ...rest } = now;
    const { obstacles: none, ...oldRest } = old;
    assert.deepEqual(rest, oldRest);
    assert.deepEqual(none, []);
    assert.ok(obstacles.length > 0);
    assert.ok(now.buildings.length > 0);
  }
});

test("a city cadence_ssw match is lost when every staked building falls (D2)", () => {
  const state = matchFromSite(tiltedSite(), { preset: "covers_sparse_mid", script: "cadence_ssw" });
  assert.ok(state.buildings.length > 0);
  bossPrepare(state);
  for (const building of state.buildings) building.hp = 0;
  const hold = { revision: state.revision, items: state.mechs.map((m) => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })) };
  validateAndApplyPlan(state, hold);
  assert.equal(state.outcome, "defeat_buildings");
});
