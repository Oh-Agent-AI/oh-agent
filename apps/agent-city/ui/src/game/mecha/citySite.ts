/**
 * Places the 10×10 tactics board on a real city window.
 * One cell is 8 world units (16 m). Feet sit on terrain.height.
 * Roads stay walkable: `buildable` means "a parcel can go here", and that
 * would erase the streets the fight is supposed to stand on. Water and cliffs
 * are the cells that cannot be spawned on. The city plan is not edited.
 */
import { BOARD, FLAT_SPAWN_MAX_DELTA, type Cell, type MechId } from "./rules";

export const CITY_CELL = 8;
const SPAN = CITY_CELL * BOARD;

export type SiteAnchor = {
  id: string;
  x: number;
  z: number;
  halfX: number;
  halfZ: number;
  ground: number;
  height: number;
};

export type CitySiteTerrain = {
  height: (x: number, z: number) => number;
  slope?: (x: number, z: number) => number;
};

export type CityMechaBuilding = {
  id: string;
  cells: Cell[];
  /** World centroid and roof, for the HP bar. */
  x: number;
  z: number;
  ground: number;
  height: number;
};

export type CityMechaSite = {
  originX: number;
  originZ: number;
  heights: number[][];
  buildings: CityMechaBuilding[];
  mechs: Array<{ id: MechId; pos: Cell }>;
  boss: Cell;
  raiders: Array<{ id: string; pos: Cell }>;
  spawnSpread: number;
};

type CityAnchorLayout = {
  terrain: CitySiteTerrain;
  districts: Array<{
    slots: Map<string, { x: number; z: number; width: number; depth: number }>;
    grounds: Map<string, number>;
  }>;
  contextBuildings: Array<{ id: string; x: number; z: number; y: number; width: number; depth: number; height: number }>;
};

type CityAnchorModel = {
  buildings: Array<{ id: string; footprint: number; height: number }>;
};

export function anchorsFromCity(layout: CityAnchorLayout, model: CityAnchorModel): SiteAnchor[] {
  const byId = new Map(model.buildings.map((building) => [building.id, building]));
  const anchors: SiteAnchor[] = [];
  for (const district of layout.districts) {
    for (const [id, slot] of district.slots) {
      const building = byId.get(id);
      const footprint = building?.footprint ?? Math.min(slot.width, slot.depth);
      const halfX = Math.max(slot.width, footprint) / 2;
      const halfZ = Math.max(slot.depth, footprint) / 2;
      anchors.push({
        id,
        x: slot.x,
        z: slot.z,
        halfX,
        halfZ,
        ground: district.grounds.get(id) ?? layout.terrain.height(slot.x, slot.z),
        height: building?.height ?? 6,
      });
    }
  }
  for (const building of layout.contextBuildings) {
    anchors.push({
      id: building.id,
      x: building.x,
      z: building.z,
      halfX: building.width / 2,
      halfZ: building.depth / 2,
      ground: building.y,
      height: building.height,
    });
  }
  anchors.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return anchors;
}

export function cellWorld(site: CityMechaSite, cell: Cell): { x: number; y: number; z: number } {
  return {
    x: site.originX + (cell.x + 0.5) * CITY_CELL,
    y: site.heights[cell.y]?.[cell.x] ?? 0,
    z: site.originZ + (cell.y + 0.5) * CITY_CELL,
  };
}

type Occupant = "empty" | "blocked" | "building";

type Window = {
  originX: number;
  originZ: number;
  heights: number[][];
  kind: Occupant[][];
  building: Array<Array<string | null>>;
  score: number;
  spawnSpread: number;
  boss: Cell;
  mechs: Array<{ id: MechId; pos: Cell }>;
  raiders: Array<{ id: string; pos: Cell }>;
  rules: CityMechaBuilding[];
};

export function siteMechaWindow(terrain: CitySiteTerrain, anchors: readonly SiteAnchor[]): CityMechaSite | null {
  if (anchors.length === 0) return null;
  const index = bucketAnchors(anchors);
  const seeds = anchorSeeds(anchors);
  const slot: { best: Window | null } = { best: null };
  for (const limit of [FLAT_SPAWN_MAX_DELTA, 2]) {
    for (const seed of seeds) {
      for (let by = 0; by < BOARD; by += 1) {
        for (let bx = 0; bx < BOARD; bx += 1) {
          const originX = seed.x - (bx + 0.5) * CITY_CELL;
          const originZ = seed.z - (by + 0.5) * CITY_CELL;
          const found = evaluateWindow(terrain, index, originX, originZ, limit);
          if (found && better(found, slot.best)) slot.best = found;
        }
      }
    }
    if (slot.best && slot.best.spawnSpread <= FLAT_SPAWN_MAX_DELTA) break;
  }
  const best = slot.best;
  if (!best) return null;
  return {
    originX: best.originX,
    originZ: best.originZ,
    heights: best.heights,
    buildings: best.rules,
    mechs: best.mechs,
    boss: best.boss,
    raiders: best.raiders,
    spawnSpread: best.spawnSpread,
  };
}

function anchorSeeds(anchors: readonly SiteAnchor[]): SiteAnchor[] {
  const usable = anchors.filter((anchor) => anchor.halfX <= 16 && anchor.halfZ <= 16);
  const step = Math.max(1, Math.ceil(usable.length / 80));
  return usable.filter((_, index) => index % step === 0);
}

function bucketAnchors(anchors: readonly SiteAnchor[]): Map<string, SiteAnchor[]> {
  const buckets = new Map<string, SiteAnchor[]>();
  for (const anchor of anchors) {
    const x0 = Math.floor((anchor.x - anchor.halfX) / CITY_CELL);
    const x1 = Math.floor((anchor.x + anchor.halfX) / CITY_CELL);
    const z0 = Math.floor((anchor.z - anchor.halfZ) / CITY_CELL);
    const z1 = Math.floor((anchor.z + anchor.halfZ) / CITY_CELL);
    for (let x = x0; x <= x1; x += 1) {
      for (let z = z0; z <= z1; z += 1) {
        const key = `${x}:${z}`;
        const list = buckets.get(key);
        if (list) list.push(anchor);
        else buckets.set(key, [anchor]);
      }
    }
  }
  return buckets;
}

function nearby(index: Map<string, SiteAnchor[]>, originX: number, originZ: number): SiteAnchor[] {
  const seen = new Set<string>();
  const list: SiteAnchor[] = [];
  const x0 = Math.floor((originX - CITY_CELL) / CITY_CELL);
  const x1 = Math.floor((originX + SPAN + CITY_CELL) / CITY_CELL);
  const z0 = Math.floor((originZ - CITY_CELL) / CITY_CELL);
  const z1 = Math.floor((originZ + SPAN + CITY_CELL) / CITY_CELL);
  for (let x = x0; x <= x1; x += 1) {
    for (let z = z0; z <= z1; z += 1) {
      for (const anchor of index.get(`${x}:${z}`) ?? []) {
        if (seen.has(anchor.id)) continue;
        seen.add(anchor.id);
        list.push(anchor);
      }
    }
  }
  list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return list;
}

function evaluateWindow(
  terrain: CitySiteTerrain,
  index: Map<string, SiteAnchor[]>,
  originX: number,
  originZ: number,
  spawnLimit: number,
): Window | null {
  const heights: number[][] = [];
  const kind: Occupant[][] = [];
  const building: Array<Array<string | null>> = [];
  let blocked = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let y = 0; y < BOARD; y += 1) {
    heights.push([]);
    kind.push([]);
    building.push([]);
    for (let x = 0; x < BOARD; x += 1) {
      const cx = originX + (x + 0.5) * CITY_CELL;
      const cz = originZ + (y + 0.5) * CITY_CELL;
      const h = terrain.height(cx, cz);
      const slope = terrain.slope?.(cx, cz) ?? 0;
      const water = h < 0.05 || slope > 0.9;
      heights[y]!.push(h);
      kind[y]!.push(water ? "blocked" : "empty");
      building[y]!.push(null);
      if (water) blocked += 1;
      else {
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
  }
  if (blocked > 18 || hi - lo > 6) return null;

  const claimed = new Set<string>();
  for (const anchor of nearby(index, originX, originZ)) {
    const covered = coveredCells(originX, originZ, anchor);
    if (covered.length === 0) continue;
    const scenery = anchor.halfX > 16 || anchor.halfZ > 16 || covered.length > 4;
    if (scenery || claimed.has(anchor.id)) {
      for (const cell of covered) {
        if (kind[cell.y]![cell.x] === "empty") kind[cell.y]![cell.x] = "blocked";
      }
      continue;
    }
    const center = cellOf(originX, originZ, anchor.x, anchor.z);
    if (!center || covered.every((cell) => cell.x !== center.x || cell.y !== center.y)) {
      for (const cell of covered) {
        if (kind[cell.y]![cell.x] === "empty") kind[cell.y]![cell.x] = "blocked";
      }
      continue;
    }
    if (covered.some((cell) => building[cell.y]![cell.x] && building[cell.y]![cell.x] !== anchor.id)) continue;
    claimed.add(anchor.id);
    for (const cell of covered) {
      kind[cell.y]![cell.x] = "building";
      building[cell.y]![cell.x] = anchor.id;
    }
  }

  const rules = buildingsOf(nearby(index, originX, originZ), building);
  if (rules.length < 2) return null;
  const boss = pickBoss(kind, heights, rules, spawnLimit);
  if (!boss) return null;
  const reserved = new Set<string>(footprintKeys(boss));
  const mechs = pickMechs(kind, heights, reserved, spawnLimit);
  if (!mechs) return null;
  for (const mech of mechs) reserved.add(key(mech.pos));
  const raiders = pickRaiders(kind, heights, rules, reserved, spawnLimit);
  if (!raiders) return null;
  const samples = [
    ...footprintOf(boss).map((cell) => heights[cell.y]![cell.x]!),
    ...mechs.map((mech) => heights[mech.pos.y]![mech.pos.x]!),
    ...raiders.map((raider) => heights[raider.pos.y]![raider.pos.x]!),
  ];
  const spawnSpread = Math.max(...samples) - Math.min(...samples);
  if (spawnSpread > spawnLimit) return null;
  // Three to five buildings is a readable siege. A packed window still works, it just scores lower.
  const count = rules.length;
  const fullness = count >= 3 && count <= 5 ? 80 : count === 2 || count === 6 ? 40 : 40 - (count - 6) * 12;
  const score = fullness - spawnSpread * 20 - (hi - lo) * 5 - blocked * 3;
  return { originX, originZ, heights, kind, building, score, spawnSpread, boss, mechs, raiders, rules };
}

function coveredCells(originX: number, originZ: number, anchor: SiteAnchor): Cell[] {
  const cells: Cell[] = [];
  for (let y = 0; y < BOARD; y += 1) {
    for (let x = 0; x < BOARD; x += 1) {
      const x0 = originX + x * CITY_CELL;
      const z0 = originZ + y * CITY_CELL;
      const overlaps = anchor.x + anchor.halfX > x0 && anchor.x - anchor.halfX < x0 + CITY_CELL
        && anchor.z + anchor.halfZ > z0 && anchor.z - anchor.halfZ < z0 + CITY_CELL;
      if (overlaps) cells.push({ x, y });
    }
  }
  return cells;
}

function cellOf(originX: number, originZ: number, x: number, z: number): Cell | null {
  const cx = Math.floor((x - originX) / CITY_CELL);
  const cy = Math.floor((z - originZ) / CITY_CELL);
  if (cx < 0 || cy < 0 || cx >= BOARD || cy >= BOARD) return null;
  return { x: cx, y: cy };
}

function buildingsOf(anchors: readonly SiteAnchor[], building: Array<Array<string | null>>): CityMechaBuilding[] {
  const byId = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  const groups = new Map<string, Cell[]>();
  for (let y = 0; y < BOARD; y += 1) {
    for (let x = 0; x < BOARD; x += 1) {
      const id = building[y]![x];
      if (!id) continue;
      const list = groups.get(id);
      if (list) list.push({ x, y });
      else groups.set(id, [{ x, y }]);
    }
  }
  const rules: CityMechaBuilding[] = [];
  for (const [id, cells] of groups) {
    const anchor = byId.get(id);
    if (!anchor) continue;
    rules.push({ id, cells, x: anchor.x, z: anchor.z, ground: anchor.ground, height: anchor.height });
  }
  rules.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rules;
}

function pickBoss(kind: Occupant[][], heights: number[][], buildings: CityMechaBuilding[], limit: number): Cell | null {
  let best: Cell | null = null;
  let bestY = Infinity;
  let bestNear = Infinity;
  let bestX = Infinity;
  for (let y = 0; y <= 5; y += 1) {
    for (let x = 0; x <= BOARD - 2; x += 1) {
      const cells = footprintOf({ x, y });
      if (cells.some((cell) => kind[cell.y]![cell.x] !== "empty")) continue;
      const samples = cells.map((cell) => heights[cell.y]![cell.x]!);
      if (Math.max(...samples) - Math.min(...samples) > limit) continue;
      const cx = x + 1;
      const cy = y + 1;
      let near = Infinity;
      for (const building of buildings) {
        for (const cell of building.cells) near = Math.min(near, Math.abs(cell.x - cx) + Math.abs(cell.y - cy));
      }
      const closer = y < bestY || (y === bestY && near < bestNear) || (y === bestY && near === bestNear && x < bestX);
      if (closer) {
        best = { x, y };
        bestY = y;
        bestNear = near;
        bestX = x;
      }
    }
  }
  return best;
}

function pickMechs(
  kind: Occupant[][],
  heights: number[][],
  reserved: Set<string>,
  limit: number,
): Array<{ id: MechId; pos: Cell }> | null {
  const open: Cell[] = [];
  for (let y = 6; y < BOARD; y += 1) {
    for (let x = 0; x < BOARD; x += 1) {
      if (kind[y]![x] === "empty" && !reserved.has(`${x},${y}`)) open.push({ x, y });
    }
  }
  open.sort((a, b) => b.y - a.y || a.x - b.x);
  const chosen: Cell[] = [];
  for (const cell of open) {
    if (chosen.some((other) => Math.max(Math.abs(other.x - cell.x), Math.abs(other.y - cell.y)) < 2)) continue;
    const samples = [...chosen, cell].map((item) => heights[item.y]![item.x]!);
    if (chosen.length > 0 && Math.max(...samples) - Math.min(...samples) > limit) continue;
    chosen.push(cell);
    if (chosen.length === 3) break;
  }
  if (chosen.length < 3) return null;
  const ordered = [...chosen].sort((a, b) => a.x - b.x || a.y - b.y);
  const ids: MechId[] = ["Assault", "Gunner", "Support"];
  return ids.map((id, index) => ({ id, pos: ordered[index]! }));
}

function pickRaiders(
  kind: Occupant[][],
  heights: number[][],
  buildings: CityMechaBuilding[],
  reserved: Set<string>,
  limit: number,
): Array<{ id: string; pos: Cell }> | null {
  const open: Cell[] = [];
  for (let y = 2; y <= 7; y += 1) {
    for (let x = 0; x < BOARD; x += 1) {
      if (kind[y]![x] === "empty" && !reserved.has(`${x},${y}`)) open.push({ x, y });
    }
  }
  const gap = (cell: Cell) => {
    let near = Infinity;
    for (const building of buildings) {
      for (const other of building.cells) near = Math.min(near, Math.abs(other.x - cell.x) + Math.abs(other.y - cell.y));
    }
    return near;
  };
  const west = open.filter((cell) => cell.x <= 4).sort((a, b) => gap(a) - gap(b) || a.x - b.x || a.y - b.y);
  const east = open.filter((cell) => cell.x >= 5).sort((a, b) => gap(a) - gap(b) || b.x - a.x || a.y - b.y);
  for (const left of west) {
    for (const right of east) {
      if (left.x === right.x && left.y === right.y) continue;
      const samples = [heights[left.y]![left.x]!, heights[right.y]![right.x]!];
      if (Math.max(...samples) - Math.min(...samples) > limit) continue;
      return [{ id: "raider-w", pos: left }, { id: "raider-e", pos: right }];
    }
  }
  return null;
}

function footprintOf(anchor: Cell): Cell[] {
  return [
    { x: anchor.x, y: anchor.y },
    { x: anchor.x + 1, y: anchor.y },
    { x: anchor.x, y: anchor.y + 1 },
    { x: anchor.x + 1, y: anchor.y + 1 },
  ];
}

function footprintKeys(anchor: Cell): string[] {
  return footprintOf(anchor).map(key);
}

function key(cell: Cell): string {
  return `${cell.x},${cell.y}`;
}

function better(next: Window, best: Window | null): boolean {
  if (!best) return true;
  if (next.score !== best.score) return next.score > best.score;
  if (next.spawnSpread !== best.spawnSpread) return next.spawnSpread < best.spawnSpread;
  if (next.originX !== best.originX) return next.originX < best.originX;
  if (next.originZ !== best.originZ) return next.originZ < best.originZ;
  return next.boss.x < best.boss.x || (next.boss.x === best.boss.x && next.boss.y < best.boss.y);
}
