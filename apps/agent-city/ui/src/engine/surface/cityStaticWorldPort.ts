/** Road-neutral immutable identity and reader for the currently displayed static city. */
import type { CityLayout } from "../cityLayout";
import type { CityStaticSceneSource } from "../cityParts";
import { compileStaticStructureObstacles, type StructureObstacle } from "./compileSurface";
import { copyRenderedSolids, type RenderedSolid } from "./renderedSolidTypes";
import type { SolidInput } from "../../game/driving/CollisionIndex";
import { sha256SurfaceBytes } from "./surfaceDigest";
import { CITY_SOLID_COMPILER_VERSION, isValidMountableHeight } from "../../game/driving/staticSolidContracts";
import { canonicalCityWorldBytes } from "./citySurfacePort";
import { CITY_SOLID_BUILD_BUDGET } from "./compileCitySolidInputs";

export type CityStaticWorldData = Readonly<{
  revision: string;
  worldRevision: string;
  layout: CityLayout;
  obstacles: readonly StructureObstacle[];
  renderedSolids: readonly RenderedSolid[];
  sceneSolids: readonly SolidInput[];
  obstacleCoverage: "structures-only" | "structures-and-scene-proxies" | "structures-and-buildings" | "structures-and-buildings-and-scene-proxies";
  compilerVersion: number;
}>;
export type ReadyCityStaticWorldCapture = Readonly<{
  status: "ready";
  revision: string;
  worldRevision: string;
  compilerVersion: number;
  coverage: CityStaticWorldData["obstacleCoverage"];
  isLeaseCurrent(): boolean;
  verifyCurrent(): boolean;
  readWorld(): CityStaticWorldData | null;
  release(): void;
}>;
export type CityStaticWorldCapture = ReadyCityStaticWorldCapture | Readonly<{ status: "cancelled" | "unavailable" | "stale"; reason?: string }>;

function copyObstacles(obstacles: readonly StructureObstacle[]): readonly StructureObstacle[] {
  return Object.freeze(obstacles.map((obstacle) => obstacle.shape === "box"
    ? Object.freeze({ ...obstacle, corners: Object.freeze(obstacle.corners.map((point) => Object.freeze({ ...point }))) })
    : Object.freeze({ ...obstacle, ring: Object.freeze(obstacle.ring.map((point) => Object.freeze({ ...point }))) })));
}
function copySceneSolids(solids: readonly SolidInput[]): readonly SolidInput[] {
  return Object.freeze(solids.map((solid) => solid.kind === "box"
    ? Object.freeze({ ...solid, center: Object.freeze({ ...solid.center }), halfAxes: Object.freeze(solid.halfAxes.map((axis) => Object.freeze({ ...axis }))) as unknown as typeof solid.halfAxes })
    : Object.freeze({ ...solid, ring: Object.freeze(solid.ring.map((point) => Object.freeze({ ...point }))) })));
}
const STATIC_CANONICAL_MAX_BYTES = 64 * 1024 * 1024;
const STATIC_LAYOUT_MAX_BYTES = 8 * 1024 * 1024;
const TERRAIN_GRID = 33;

/** Clone the source graph before exposing it. Maps/Sets get immutable method guards;
 * functions are retained as behavior closures, while all captured data is copied. */
function immutableCopy<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  const previous = seen.get(value as object);
  if (previous) return previous as T;
  if (value instanceof Map) {
    const copy = new Map(); seen.set(value, copy);
    for (const [key, entry] of value) copy.set(immutableCopy(key, seen), immutableCopy(entry, seen));
    const proxy = new Proxy(copy, { get(target, key) {
      if (key === "set" || key === "delete" || key === "clear") return () => { throw new TypeError("immutable-city-layout"); };
      const member = Reflect.get(target, key, target); return typeof member === "function" ? member.bind(target) : member;
    } });
    seen.set(value, proxy); return proxy as T;
  }
  if (value instanceof Set) {
    const copy = new Set(); seen.set(value, copy);
    for (const entry of value) copy.add(immutableCopy(entry, seen));
    const proxy = new Proxy(copy, { get(target, key) {
      if (key === "add" || key === "delete" || key === "clear") return () => { throw new TypeError("immutable-city-layout"); };
      const member = Reflect.get(target, key, target); return typeof member === "function" ? member.bind(target) : member;
    } });
    seen.set(value, proxy); return proxy as T;
  }
  if (ArrayBuffer.isView(value)) return (value as unknown as { slice(): unknown }).slice() as T;
  const copy = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
  seen.set(value as object, copy);
  for (const key of Reflect.ownKeys(value as object)) {
    const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
    if (!descriptor || !("value" in descriptor)) continue;
    Object.defineProperty(copy, key, { value: immutableCopy(descriptor.value, seen), enumerable: descriptor.enumerable, configurable: false, writable: false });
  }
  return Object.freeze(copy) as T;
}

function canonical(layout: CityLayout, obstacles: readonly StructureObstacle[], rendered: readonly RenderedSolid[], scene: readonly SolidInput[]): Uint8Array {
  if (obstacles.length + scene.length > CITY_SOLID_BUILD_BUDGET) throw new Error("static-solids-budget");
  let pointCount = 0, identityChars = 0;
  for (const obstacle of obstacles) {
    if (!isValidMountableHeight(obstacle.mountableHeight)) throw new Error("invalid-mountable-height");
    identityChars += obstacle.id.length + obstacle.role.length;
    pointCount += obstacle.shape === "box" ? obstacle.corners.length : obstacle.ring.length;
  }
  for (const solid of scene) {
    if (!isValidMountableHeight(solid.mountableHeight)) throw new Error("invalid-mountable-height");
    identityChars += solid.id.length + solid.role.length;
    pointCount += solid.kind === "box" ? 3 : solid.ring.length;
  }
  if (pointCount > 250_000) throw new Error("static-geometry-point-budget");
  if (identityChars > 2 * 1024 * 1024) throw new Error("static-identity-budget");
  // This revision identifies the captured collision world, not every planner or
  // renderer detail in CityLayout. Keep only the stable city/terrain identity
  // here; collision geometry (including mountableHeight) is encoded exactly once
  // in `structure` below. Serializing the full layout duplicated large arrays
  // and repeated solid IDs, making valid large cities fail the 8 MiB header cap.
  const layoutFacts = [layout.seed, layout.scaleTier, layout.biome, layout.extent, layout.islandRadius];
  const extent = layout.extent;
  if (!Number.isFinite(extent) || extent <= 0) throw new Error("invalid-static-terrain-extent");
  const terrainSamples: number[] = [];
  for (let zi = 0; zi < TERRAIN_GRID; zi++) for (let xi = 0; xi < TERRAIN_GRID; xi++) {
    const x = -extent + 2 * extent * xi / (TERRAIN_GRID - 1), z = -extent + 2 * extent * zi / (TERRAIN_GRID - 1);
    const y = layout.terrain.height(x, z);
    if (!Number.isFinite(y)) throw new Error("invalid-static-terrain-sample");
    terrainSamples.push(Object.is(y, -0) ? 0 : y);
  }
  for (const mountain of layout.decorMountains ?? []) {
    const y = mountain.terrain.height(mountain.center.x, mountain.center.z);
    if (!Number.isFinite(y)) throw new Error("invalid-static-mountain-terrain");
    terrainSamples.push(y);
  }
  if (![layout.seed, layout.scaleTier, layout.islandRadius].every(Number.isFinite) || typeof layout.biome !== "string") throw new Error("invalid-static-layout-identity");
  const layoutHeader = new TextEncoder().encode(JSON.stringify(["city-static-v4", CITY_SOLID_COMPILER_VERSION, layoutFacts, terrainSamples]));
  if (layoutHeader.length > STATIC_LAYOUT_MAX_BYTES) throw new Error("static-layout-byte-budget");
  const structure = canonicalCityWorldBytes("road-neutral-static", { obstacles, landings: [], counts: { bridges: 0,
    expresswaySegments: 0, flares: 0, islands: 0, culDeSacs: 0 } }, rendered, scene);
  const total = 8 + layoutHeader.length + structure.length;
  if (total > STATIC_CANONICAL_MAX_BYTES) throw new Error("static-canonical-byte-budget");
  const bytes = new Uint8Array(total), view = new DataView(bytes.buffer);
  view.setUint32(0, layoutHeader.length, true); bytes.set(layoutHeader, 4);
  view.setUint32(4 + layoutHeader.length, structure.length, true); bytes.set(structure, 8 + layoutHeader.length);
  return bytes;
}

export class CityStaticWorldPort {
  constructor(private readonly hash: (bytes: Uint8Array) => Promise<string> = sha256SurfaceBytes) {}

  async capture(source: CityStaticSceneSource, releaseSource: () => void, signal?: AbortSignal): Promise<CityStaticWorldCapture> {
    let active = true;
    const release = () => { if (!active) return; active = false; releaseSource(); };
    if (signal?.aborted) { release(); return Object.freeze({ status: "cancelled" }); }
    try {
      const layout = immutableCopy(source.layout);
      const obstacles = copyObstacles(compileStaticStructureObstacles(layout));
      if (obstacles.length + source.solids.length > CITY_SOLID_BUILD_BUDGET) throw new Error("static-solids-budget");
      const rendered = copyRenderedSolids(source.rendered.solids);
      const scene = copySceneSolids(source.solids);
      if (!source.isCurrent() || !source.verifyCurrent()) { release(); return Object.freeze({ status: "stale" }); }
      const bytes = canonical(layout, obstacles, rendered, scene);
      const digest = await this.hash(bytes);
      if (signal?.aborted) { release(); return Object.freeze({ status: "cancelled" }); }
      if (!active || !source.isCurrent() || !source.verifyCurrent()) { release(); return Object.freeze({ status: "stale" }); }
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid-static-world-digest");
      const worldRevision = `city-static-v4:sha256:${digest}`;
      const isLeaseCurrent = () => active && source.isCurrent();
      const verifyCurrent = () => active && source.isCurrent() && source.verifyCurrent();
      const coverage = obstacles.length > 0
        ? (rendered.length > 0 ? (scene.length > 0 ? "structures-and-buildings-and-scene-proxies" : "structures-and-buildings")
          : (scene.length > 0 ? "structures-and-scene-proxies" : "structures-only"))
        : (rendered.length > 0 ? (scene.length > 0 ? "structures-and-buildings-and-scene-proxies" : "structures-and-buildings")
          : (scene.length > 0 ? "structures-and-scene-proxies" : "structures-only"));
      const readWorld = (): CityStaticWorldData | null => {
        if (!isLeaseCurrent()) return null;
        return Object.freeze({ revision: worldRevision, worldRevision, layout, obstacles: copyObstacles(obstacles),
          renderedSolids: copyRenderedSolids(rendered), sceneSolids: copySceneSolids(scene), obstacleCoverage: coverage,
          compilerVersion: CITY_SOLID_COMPILER_VERSION });
      };
      return Object.freeze({ status: "ready", revision: worldRevision, worldRevision, compilerVersion: CITY_SOLID_COMPILER_VERSION,
        coverage, isLeaseCurrent, verifyCurrent, readWorld, release });
    } catch (error) {
      release();
      const reason = error instanceof Error ? error.message.slice(0, 120) : "static-capture-failed";
      return Object.freeze({ status: signal?.aborted ? "cancelled" : "unavailable", reason });
    }
  }
}
