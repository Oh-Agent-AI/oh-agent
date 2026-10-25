/**
 * Places the 10×10 tactics board on a real city window.
 * One cell covers two session lots: 2 × LOT.width along the street and
 * 2 × LOT.depth inward, the same yaw as the building mesh. A block may spread
 * those centers a little farther apart than the rectangle; the cell is twice
 * that pitch, so the square and the units read twice as large. Streets stay
 * the empty ground between lots. A lot turned 90° still shares the axes. A lot
 * on a different angle blocks cells and is not a rules target. Feet sit on
 * terrain.height. Meshes are drawn at the same 2× in CityMechaWorld.
 * Roads stay walkable: `buildable` means "a parcel can go here", and that
 * would erase the streets the fight is supposed to stand on. A land cell whose
 * center sits on the ground carriageway — band or junction fillet — is marked
 * road after the window is chosen, so the paint does not choose the window.
 * Bridges and decks stay off the board. Water and cliffs cannot be spawned on.
 * The city plan is not edited.
 * Flat, shore, ridge, and alley are four windows over the same city. The flat
 * window is the one `siteMechaWindow` already returned. The other three exist
 * only when that shape's cells are really there.
 */
import type { RoadEdge } from "../../engine/cityLayout";
import { groundRoadClearance } from "../../engine/surface/roadClearance";
import { LOT } from "../../engine/worldScale";
import { BOARD, FLAT_SPAWN_MAX_DELTA, type Cell, type MechId, type TerrainKind } from "./rules";

/** Lot module. A block's window may step a little wider; see pitchOf. */
export const CELL_W = LOT.width;
export const CELL_D = LOT.depth;
/** One tactics cell is this many lots on a side. */
export const CELL_LOTS = 2;
/** Frontage slack tops out just under 1.5 lots when a row holds two parcels. */
const PITCH_SLACK = 1.55;
const BOARD_REACH = Math.hypot(CELL_W * PITCH_SLACK * CELL_LOTS * BOARD, CELL_D * PITCH_SLACK * CELL_LOTS * BOARD) + 16;
/** World-space anchor buckets. The fight grid itself is the lot, not this square. */
const BUCKET = 8;
/** A lot that lands on the line by a rounding hair does not claim the next cell. */
const CELL_EDGE = 1e-3;
/** 靠岸：水格够形成一条边，又没有把棋盘淹掉。 */
export const SHORE_WATER_MIN = 8;
export const SHORE_WATER_MAX = 30;
/** 翻山：山地够形成一道坎，出生仍在平地上。 */
export const RIDGE_MOUNTAIN_MIN = 4;
export const RIDGE_MOUNTAIN_MAX = 20;
/** 靠岸和翻山都要留下一半以上的平地。 */
export const FEATURE_LAND_MIN = 50;
/** 巷战：楼与楼对望的格子里，至少这么多格被涂成路。 */
export const ALLEY_ROAD_MIN = 4;

export type FightShape = "flat" | "shore" | "ridge" | "alley";
export type FightCatalog = Record<FightShape, CityMechaSite | null>;

type Step = { w: number; d: number };

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
  /** Board-local cell step. Twice the lot pitch, along the street and inward. */
  cellW: number;
  cellD: number;
  heights: number[][];
  /** 和水、山地同一套词。选址用它挡出生，对局用它改移动和射击。 */
  terrain: TerrainKind[][];
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
  const at = boardToWorld(site, (cell.x + 0.5) * site.cellW, (cell.y + 0.5) * site.cellD);
  return { x: at.x, y: site.heights[cell.y]?.[cell.x] ?? 0, z: at.z };
}

type Occupant = "empty" | "blocked" | "building";

type Window = {
  originX: number;
  originZ: number;
  yaw: number;
  step: Step;
  heights: number[][];
  terrain: TerrainKind[][];
  kind: Occupant[][];
  building: Array<Array<string | null>>;
  score: number;
  spawnSpread: number;
  boss: Cell;
  mechs: Array<{ id: MechId; pos: Cell }>;
  raiders: Array<{ id: string; pos: Cell }>;
  rules: CityMechaBuilding[];
  water: number;
  mountain: number;
  land: number;
  /** 贴着楼的空格。巷战要求其中至少 4 格被涂成路。 */
  canyon: Cell[];
};

type TerrainGate = "strict" | "open";

/** 格子中心在地面车行道或路口扇面里才算路。桥面和桥头不改格子。水与山不改涂。 */
function paintRoads(win: Window, roads: readonly RoadEdge[]) {
  for (let y = 0; y < BOARD; y += 1) {
    const row = win.terrain[y];
    if (!row) continue;
    for (let x = 0; x < BOARD; x += 1) {
      if (row[x] !== "land") continue;
      const at = boardToWorld(win, (x + 0.5) * win.step.w, (y + 0.5) * win.step.d);
      if (groundRoadClearance(roads, at.x, at.z) < 0) row[x] = "road";
    }
  }
}

function toSite(win: Window): CityMechaSite {
  return {
    originX: win.originX,
    originZ: win.originZ,
    yaw: win.yaw,
    cellW: win.step.w,
    cellD: win.step.d,
    heights: win.heights,
    terrain: win.terrain,
    buildings: win.rules,
    mechs: win.mechs,
    boss: win.boss,
    raiders: win.raiders,
    spawnSpread: win.spawnSpread,
  };
}

function publish(win: Window, roads?: readonly RoadEdge[]): CityMechaSite {
  const copy = structuredClone(win);
  if (roads && roads.length > 0) paintRoads(copy, roads);
  return toSite(copy);
}

function searchWindows(
  terrain: CitySiteTerrain,
  anchors: readonly SiteAnchor[],
  open: boolean,
  each: (win: Window, gate: TerrainGate) => void,
): void {
  if (anchors.length === 0) return;
  const index = bucketAnchors(anchors);
  const seeds = anchorSeeds(anchors);
  for (const limit of [FLAT_SPAWN_MAX_DELTA, 2]) {
    let flatEnough = false;
    for (const seed of seeds) {
      const step = pitchOf(seed, anchors);
      for (let by = 0; by < BOARD; by += 1) {
        for (let bx = 0; bx < BOARD; bx += 1) {
          const yaw = seed.yaw ?? 0;
          const lx = (bx + 0.5) * step.w;
          const lz = (by + 0.5) * step.d;
          const c = Math.cos(yaw);
          const s = Math.sin(yaw);
          const originX = seed.x - (lx * c + lz * s);
          const originZ = seed.z - (-lx * s + lz * c);
          const strict = evaluateWindow(terrain, index, originX, originZ, yaw, step, limit, "strict");
          if (strict) {
            each(strict, "strict");
            if (strict.spawnSpread <= FLAT_SPAWN_MAX_DELTA) flatEnough = true;
          }
          if (!open) continue;
          const featured = evaluateWindow(terrain, index, originX, originZ, yaw, step, limit, "open");
          if (featured) each(featured, "open");
        }
      }
    }
    if (flatEnough) break;
  }
}

export function siteMechaWindow(terrain: CitySiteTerrain, anchors: readonly SiteAnchor[], roads?: readonly RoadEdge[]): CityMechaSite | null {
  let best: Window | null = null;
  searchWindows(terrain, anchors, false, (win, gate) => {
    if (gate === "strict" && better(win, best)) best = win;
  });
  return best ? publish(best, roads) : null;
}

function rememberAlley(pool: Window[], win: Window) {
  if (win.canyon.length < ALLEY_ROAD_MIN) return;
  pool.push(win);
  pool.sort((a, b) => b.canyon.length - a.canyon.length || (better(a, b) ? -1 : 1));
  if (pool.length > 8) pool.length = 8;
}

function roadCanyon(site: CityMechaSite, canyon: readonly Cell[]): number {
  let roads = 0;
  for (const cell of canyon) {
    if (site.terrain[cell.y]?.[cell.x] === "road") roads += 1;
  }
  return roads;
}

/** 同一座城里四种战场。没有那种格子时该键是 null，不造假地形。 */
export function siteFightShapes(terrain: CitySiteTerrain, anchors: readonly SiteAnchor[], roads?: readonly RoadEdge[]): FightCatalog {
  let flat: Window | null = null;
  let shore: Window | null = null;
  let ridge: Window | null = null;
  const alleyPool: Window[] = [];
  searchWindows(terrain, anchors, true, (win, gate) => {
    if (gate === "strict") {
      if (better(win, flat)) flat = win;
      rememberAlley(alleyPool, win);
      return;
    }
    if (win.water >= SHORE_WATER_MIN && better(win, shore)) shore = win;
    if (win.mountain >= RIDGE_MOUNTAIN_MIN && better(win, ridge)) ridge = win;
  });
  let alley: CityMechaSite | null = null;
  let alleyRoads = 0;
  for (const win of alleyPool) {
    const site = publish(win, roads);
    const hits = roadCanyon(site, win.canyon);
    if (hits >= ALLEY_ROAD_MIN && (hits > alleyRoads || (hits === alleyRoads && alley === null))) {
      alley = site;
      alleyRoads = hits;
    }
  }
  return {
    flat: flat ? publish(flat, roads) : null,
    shore: shore ? publish(shore, roads) : null,
    ridge: ridge ? publish(ridge, roads) : null,
    alley,
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
    const x0 = Math.floor((anchor.x - pad) / BUCKET);
    const x1 = Math.floor((anchor.x + pad) / BUCKET);
    const z0 = Math.floor((anchor.z - pad) / BUCKET);
    const z1 = Math.floor((anchor.z + pad) / BUCKET);
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
  const reach = BOARD_REACH + BUCKET * 2;
  const x0 = Math.floor((originX - reach) / BUCKET);
  const x1 = Math.floor((originX + reach) / BUCKET);
  const z0 = Math.floor((originZ - reach) / BUCKET);
  const z1 = Math.floor((originZ + reach) / BUCKET);
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

function pitchOf(seed: SiteAnchor, anchors: readonly SiteAnchor[]): Step {
  const yaw = seed.yaw ?? 0;
  const along: number[] = [];
  const inward: number[] = [];
  for (const anchor of anchors) {
    if (anchor.id === seed.id || !axesOf(anchor, yaw)) continue;
    const local = worldToLocal(seed.x, seed.z, yaw, anchor.x, anchor.z);
    if (Math.abs(local.lz) <= 1 && Math.abs(local.lx) > 1) along.push(Math.abs(local.lx));
    if (Math.abs(local.lx) <= 1 && Math.abs(local.lz) > 1) inward.push(Math.abs(local.lz));
  }
  return { w: stablePitch(along, CELL_W) * CELL_LOTS, d: stablePitch(inward, CELL_D) * CELL_LOTS };
}

function stablePitch(gaps: number[], module: number): number {
  const near = gaps.filter((gap) => gap >= module * 0.98 && gap <= module * PITCH_SLACK).sort((a, b) => a - b);
  if (near.length === 0) return module;
  const mid = near[Math.floor((near.length - 1) / 2)]!;
  const close = near.filter((gap) => Math.abs(gap - mid) <= 0.15);
  if (close.length * 2 < near.length) return module;
  const pitch = close.reduce((sum, gap) => sum + gap, 0) / close.length;
  return Math.max(module, pitch);
}

function terrainGateAllows(gate: TerrainGate, water: number, mountain: number, land: number, relief: number): boolean {
  if (!(relief <= 12)) return false;
  if (gate === "strict") return water + mountain <= 18;
  return water <= SHORE_WATER_MAX && mountain <= RIDGE_MOUNTAIN_MAX && land >= FEATURE_LAND_MIN && (water >= SHORE_WATER_MIN || mountain >= RIDGE_MOUNTAIN_MIN);
}

function canyonCells(kind: Occupant[][], building: Array<Array<string | null>>): Cell[] {
  const out: Cell[] = [];
  for (let y = 0; y < BOARD; y += 1) {
    for (let x = 0; x < BOARD; x += 1) {
      if (kind[y]![x] !== "empty") continue;
      const north = y > 0 ? building[y - 1]![x] : null;
      const south = y + 1 < BOARD ? building[y + 1]![x] : null;
      const west = x > 0 ? building[y]![x - 1] : null;
      const east = x + 1 < BOARD ? building[y]![x + 1] : null;
      // 楼贴着的空格。对望是巷，单侧贴楼的路也是巷：真城的楼距经常超过一格。
      if (north || south || west || east) out.push({ x, y });
    }
  }
  return out;
}

function evaluateWindow(
  terrain: CitySiteTerrain,
  index: Map<string, SiteAnchor[]>,
  originX: number,
  originZ: number,
  yaw: number,
  step: Step,
  spawnLimit: number,
  gate: TerrainGate,
): Window | null {
  const heights: number[][] = [];
  const ground: TerrainKind[][] = [];
  const kind: Occupant[][] = [];
  const building: Array<Array<string | null>> = [];
  let water = 0;
  let mountain = 0;
  let land = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let y = 0; y < BOARD; y += 1) {
    heights.push([]);
    ground.push([]);
    kind.push([]);
    building.push([]);
    for (let x = 0; x < BOARD; x += 1) {
      const at = boardToWorld({ originX, originZ, yaw }, (x + 0.5) * step.w, (y + 0.5) * step.d);
      const h = terrain.height(at.x, at.z);
      const slope = terrain.slope?.(at.x, at.z) ?? 0;
      // 水面先于悬崖。坡度只把还露在水上的陡壁算成山地。
      const face: TerrainKind = h < 0.05 ? "water" : slope > 0.9 ? "mountain" : "land";
      heights[y]!.push(h);
      ground[y]!.push(face);
      kind[y]!.push(face === "land" ? "empty" : "blocked");
      building[y]!.push(null);
      if (face === "water") water += 1;
      else if (face === "mountain") mountain += 1;
      else {
        land += 1;
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
  }
  // Two lots per cell makes the window about 144 × 160. Twelve units of relief
  // is the same slope the first 80-unit window allowed at 6.
  // 平地窗仍拒绝超过 18 格的水与山。靠岸/翻山用更宽的上限，并且要求这块地形真的在。
  const relief = land === 0 ? Infinity : hi - lo;
  if (!terrainGateAllows(gate, water, mountain, land, relief)) return null;
  const blocked = water + mountain;

  const claimed = new Set<string>();
  const around = nearby(index, originX, originZ);
  for (const anchor of around) {
    const aligned = axesOf(anchor, yaw);
    const covered = aligned
      ? alignedCells(originX, originZ, yaw, anchor, aligned.alongX, aligned.alongZ, step)
      : rotatedCells(originX, originZ, yaw, anchor, step);
    if (covered.length === 0) continue;
    const scenery = !aligned || anchor.halfX > 16 || anchor.halfZ > 16 || covered.length > 4;
    if (scenery || claimed.has(anchor.id)) {
      for (const cell of covered) {
        if (kind[cell.y]![cell.x] === "empty") kind[cell.y]![cell.x] = "blocked";
      }
      continue;
    }
    const center = cellOf(originX, originZ, yaw, anchor.x, anchor.z, step);
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
  // A lot that straddles a line is the grid missing the block. Prefer the pitch that holds each lot in one cell.
  const extra = rules.reduce((sum, building) => sum + building.cells.length - 1, 0);
  const score = fullness - extra * 30 - spawnSpread * 20 - (hi - lo) * 5 - blocked * 3;
  return {
    originX, originZ, yaw, step, heights, terrain: ground, kind, building, score, spawnSpread, boss, mechs, raiders, rules,
    water, mountain, land, canyon: canyonCells(kind, building),
  };
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
  originX: number, originZ: number, yaw: number, anchor: SiteAnchor, alongX: number, alongZ: number, step: Step,
): Cell[] {
  const local = worldToLocal(originX, originZ, yaw, anchor.x, anchor.z);
  const cells: Cell[] = [];
  for (let y = 0; y < BOARD; y += 1) {
    for (let x = 0; x < BOARD; x += 1) {
      const x0 = x * step.w;
      const z0 = y * step.d;
      const overlaps = local.lx + alongX > x0 + CELL_EDGE && local.lx - alongX < x0 + step.w - CELL_EDGE
        && local.lz + alongZ > z0 + CELL_EDGE && local.lz - alongZ < z0 + step.d - CELL_EDGE;
      if (overlaps) cells.push({ x, y });
    }
  }
  return cells;
}

function rotatedCells(originX: number, originZ: number, boardYaw: number, anchor: SiteAnchor, step: Step): Cell[] {
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
  const xStart = Math.max(0, Math.floor(minX / step.w));
  const xEnd = Math.min(BOARD - 1, Math.floor(maxX / step.w));
  const yStart = Math.max(0, Math.floor(minZ / step.d));
  const yEnd = Math.min(BOARD - 1, Math.floor(maxZ / step.d));
  for (let y = yStart; y <= yEnd; y += 1) {
    for (let x = xStart; x <= xEnd; x += 1) {
      if (quadHitsCell(x * step.w, y * step.d, corners, step)) cells.push({ x, y });
    }
  }
  return cells;
}

function quadHitsCell(x0: number, z0: number, quad: Array<[number, number]>, step: Step): boolean {
  const rect: Array<[number, number]> = [[x0, z0], [x0 + step.w, z0], [x0 + step.w, z0 + step.d], [x0, z0 + step.d]];
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

function cellOf(originX: number, originZ: number, yaw: number, x: number, z: number, step: Step): Cell | null {
  const local = worldToLocal(originX, originZ, yaw, x, z);
  const cx = Math.floor(local.lx / step.w);
  const cy = Math.floor(local.lz / step.d);
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
