/**
 * Places the 10×10 tactics board on a real city window.
 * One cell is 16 world units (32 m), twice the old 16 m cell. A normal session
 * lot is 7.2 × 8 (about 16 m), so one cell now holds about two lots on a side.
 * Feet sit on terrain.height. Combat meshes are drawn at the same 2× in
 * CityMechaWorld; the lineup canvas keeps the 16 m model scale.
 * The board uses the seed parcel's yaw, the same Y rotation as the building
 * mesh, so the grid runs with that street. A lot turned 90° still shares the
 * axes. A lot on a different angle blocks cells and is not a rules target.
 * Roads stay walkable: `buildable` means "a parcel can go here", and that
 * would erase the streets the fight is supposed to stand on. Water and cliffs
 * are the cells that cannot be spawned on. The city plan is not edited.
 */
import { BOARD, FLAT_SPAWN_MAX_DELTA, type Cell, type MechId } from "./rules";

export const CITY_CELL = 16;
const SPAN = CITY_CELL * BOARD;

export type SiteAnchor = {
  id: string;
  x: number;
  z: number;
  /** Half width and half depth in the parcel frame, not world X/Z. */
  halfX: number;
  halfZ: number;
  /** Same angle the building mesh uses. Omitted means axis-aligned. */
  yaw?: number;
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
  yaw: number;
  ground: number;
  height: number;
};

export type CityMechaSite = {
  originX: number;
  originZ: number;
  /** Parcel yaw. Cell +x is the building's width axis. */
  yaw: number;
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
    slots: Map<string, { x: number; z: number; width: number; depth: number; yaw?: number }>;
    grounds: Map<string, number>;
  }>;
  contextBuildings: Array<{ id: string; x: number; z: number; y: number; yaw?: number; width: number; depth: number; height: number }>;
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
        yaw: slot.yaw ?? 0,
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
      yaw: building.yaw ?? 0,
      ground: building.y,
      height: building.height,
    });
  }
  anchors.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return anchors;
}

/** Board-local meters to world. Matches the building mesh Y rotation. */
export function boardToWorld(site: { originX: number; originZ: number; yaw: number }, lx: number, lz: number): { x: number; z: number } {
  const c = Math.cos(site.yaw);
  const s = Math.sin(site.yaw);
  return {
    x: site.originX + lx * c + lz * s,
    z: site.originZ - lx * s + lz * c,
  };
}

export function cellWorld(site: CityMechaSite, cell: Cell): { x: number; y: number; z: number } {
  const at = boardToWorld(site, (cell.x + 0.5) * CITY_CELL, (cell.y + 0.5) * CITY_CELL);
  return { x: at.x, y: site.heights[cell.y]?.[cell.x] ?? 0, z: at.z };
}

type Occupant = "empty" | "blocked" | "building";

type Window = {
  originX: number;
  originZ: number;
  yaw: number;
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
          const yaw = seed.yaw ?? 0;
          const lx = (bx + 0.5) * CITY_CELL;
          const lz = (by + 0.5) * CITY_CELL;
          const c = Math.cos(yaw);
          const s = Math.sin(yaw);
          const originX = seed.x - (lx * c + lz * s);
          const originZ = seed.z - (-lx * s + lz * c);
          const found = evaluateWindow(terrain, index, originX, originZ, yaw, limit);
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
    yaw: best.yaw,
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
    const pad = anchor.halfX + anchor.halfZ;
    const x0 = Math.floor((anchor.x - pad) / CITY_CELL);
    const x1 = Math.floor((anchor.x + pad) / CITY_CELL);
    const z0 = Math.floor((anchor.z - pad) / CITY_CELL);
    const z1 = Math.floor((anchor.z + pad) / CITY_CELL);
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

function nearby(index: Map<string, SiteAnchor[]>, originX: number, originZ: number, yaw: number): SiteAnchor[] {
  const seen = new Set<string>();
  const list: SiteAnchor[] = [];
  const reach = SPAN * (Math.abs(Math.cos(yaw)) + Math.abs(Math.sin(yaw))) + CITY_CELL * 2;
  const x0 = Math.floor((originX - reach) / CITY_CELL);
  const x1 = Math.floor((originX + reach) / CITY_CELL);
  const z0 = Math.floor((originZ - reach) / CITY_CELL);
  const z1 = Math.floor((originZ + reach) / CITY_CELL);
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
  yaw: number,
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
      const at = boardToWorld({ originX, originZ, yaw }, (x + 0.5) * CITY_CELL, (y + 0.5) * CITY_CELL);
      const h = terrain.height(at.x, at.z);
      const slope = terrain.slope?.(at.x, at.z) ?? 0;
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
  // 12 units of relief across 160 is the same slope the old 80-unit window
  // allowed at 6. The cell doubled; the hill did not get steeper.
  if (blocked > 18 || hi - lo > 12) return null;

  const claimed = new Set<string>();
  const around = nearby(index, originX, originZ, yaw);
  for (const anchor of around) {
    const aligned = axesOf(anchor, yaw);
    const covered = aligned
      ? alignedCells(originX, originZ, yaw, anchor, aligned.alongX, aligned.alongZ)
      : rotatedCells(originX, originZ, yaw, anchor);
    if (covered.length === 0) continue;
    const scenery = !aligned || anchor.halfX > 16 || anchor.halfZ > 16 || covered.length > 4;
    if (scenery || claimed.has(anchor.id)) {
      for (const cell of covered) {
        if (kind[cell.y]![cell.x] === "empty") kind[cell.y]![cell.x] = "blocked";
      }
      continue;
    }
    const center = cellOf(originX, originZ, yaw, anchor.x, anchor.z);
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

  const rules = buildingsOf(around, building);
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
  return { originX, originZ, yaw, heights, kind, building, score, spawnSpread, boss, mechs, raiders, rules };
}

function axesOf(anchor: SiteAnchor, boardYaw: number): { alongX: number; alongZ: number } | null {
  const quarter = Math.PI / 2;
  const rel = wrapAngle((anchor.yaw ?? 0) - boardYaw);
  const steps = Math.round(rel / quarter);
  if (Math.abs(rel - steps * quarter) > 0.12) return null;
  const swap = Math.abs(steps) % 2 === 1;
  return swap
    ? { alongX: anchor.halfZ, alongZ: anchor.halfX }
    : { alongX: anchor.halfX, alongZ: anchor.halfZ };
}

function alignedCells(
  originX: number, originZ: number, yaw: number, anchor: SiteAnchor, alongX: number, alongZ: number,
): Cell[] {
  const local = worldToLocal(originX, originZ, yaw, anchor.x, anchor.z);
  const cells: Cell[] = [];
  for (let y = 0; y < BOARD; y += 1) {
    for (let x = 0; x < BOARD; x += 1) {
      const x0 = x * CITY_CELL;
      const z0 = y * CITY_CELL;
      const overlaps = local.lx + alongX > x0 && local.lx - alongX < x0 + CITY_CELL
        && local.lz + alongZ > z0 && local.lz - alongZ < z0 + CITY_CELL;
      if (overlaps) cells.push({ x, y });
    }
  }
  return cells;
}

function rotatedCells(originX: number, originZ: number, boardYaw: number, anchor: SiteAnchor): Cell[] {
  const rel = (anchor.yaw ?? 0) - boardYaw;
  const c = Math.cos(rel);
  const s = Math.sin(rel);
  const center = worldToLocal(originX, originZ, boardYaw, anchor.x, anchor.z);
  const corners: Array<[number, number]> = [
    [anchor.halfX, anchor.halfZ], [anchor.halfX, -anchor.halfZ],
    [-anchor.halfX, anchor.halfZ], [-anchor.halfX, -anchor.halfZ],
  ].map(([bx, bz]) => [center.lx + bx * c + bz * s, center.lz - bx * s + bz * c]);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of corners) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const cells: Cell[] = [];
  const xStart = Math.max(0, Math.floor(minX / CITY_CELL));
  const xEnd = Math.min(BOARD - 1, Math.floor(maxX / CITY_CELL));
  const yStart = Math.max(0, Math.floor(minZ / CITY_CELL));
  const yEnd = Math.min(BOARD - 1, Math.floor(maxZ / CITY_CELL));
  for (let y = yStart; y <= yEnd; y += 1) {
    for (let x = xStart; x <= xEnd; x += 1) {
      if (quadHitsCell(x * CITY_CELL, y * CITY_CELL, corners)) cells.push({ x, y });
    }
  }
  return cells;
}

function quadHitsCell(x0: number, z0: number, quad: Array<[number, number]>): boolean {
  const rect: Array<[number, number]> = [[x0, z0], [x0 + CITY_CELL, z0], [x0 + CITY_CELL, z0 + CITY_CELL], [x0, z0 + CITY_CELL]];
  const edge = (a: [number, number], b: [number, number]) => [-(b[1] - a[1]), b[0] - a[0]] as [number, number];
  const axes: Array<[number, number]> = [[1, 0], [0, 1], edge(quad[0], quad[1]), edge(quad[0], quad[2])];
  for (const [ax, az] of axes) {
    let rMin = Infinity;
    let rMax = -Infinity;
    let qMin = Infinity;
    let qMax = -Infinity;
    for (const [x, z] of rect) {
      const p = x * ax + z * az;
      if (p < rMin) rMin = p;
      if (p > rMax) rMax = p;
    }
    for (const [x, z] of quad) {
      const p = x * ax + z * az;
      if (p < qMin) qMin = p;
      if (p > qMax) qMax = p;
    }
    if (rMax <= qMin || qMax <= rMin) return false;
  }
  return true;
}

function cellOf(originX: number, originZ: number, yaw: number, x: number, z: number): Cell | null {
  const local = worldToLocal(originX, originZ, yaw, x, z);
  const cx = Math.floor(local.lx / CITY_CELL);
  const cy = Math.floor(local.lz / CITY_CELL);
  if (cx < 0 || cy < 0 || cx >= BOARD || cy >= BOARD) return null;
  return { x: cx, y: cy };
}

function worldToLocal(originX: number, originZ: number, yaw: number, x: number, z: number): { lx: number; lz: number } {
  const dx = x - originX;
  const dz = z - originZ;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { lx: c * dx - s * dz, lz: s * dx + c * dz };
}

function wrapAngle(angle: number): number {
  const turned = (angle + Math.PI) % (Math.PI * 2);
  return (turned < 0 ? turned + Math.PI * 2 : turned) - Math.PI;
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
    rules.push({ id, cells, x: anchor.x, z: anchor.z, yaw: anchor.yaw ?? 0, ground: anchor.ground, height: anchor.height });
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
