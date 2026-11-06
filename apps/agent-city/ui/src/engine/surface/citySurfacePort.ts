/** Host-local snapshots of the CURRENT rendered static city. No IPC, uploads or disk I/O.
 * Surface geometry and structural obstacles are captured together. A handle is a lease on
 * one host generation: even identical content after rebuild cannot revive an old handle. */
import type { CityLayout } from "../cityLayout";
import { compileCitySurface, type CitySurfaceCompilation } from "./compileSurface";
import type { CompiledGroundRoadSurface } from "./groundRoadCompiler";
import { SurfaceStore, type SurfaceHasher } from "./SurfaceStore";
import { sha256SurfaceBytes } from "./surfaceDigest";
import type { CompiledCitySurface } from "./types";
import { checkStructureGeometry, type StructureCheckOptions, type StructureCheckReport } from "./structureChecks";
import { buildSurfaceIndex, type SurfaceIndexBuild, type SurfacePointQuery, type SurfaceQueryResult } from "./SurfaceIndex";
import { checkLandingSeams, type LandingSeamOptions, type LandingSeamReport } from "./landingSeams";
import { assertRenderedSolidBudget, copyRenderedSolids, type RenderedSolid, type RenderedSolidSource } from "./renderedSolidTypes";
import type { SolidInput } from "../../game/driving/CollisionIndex";
import { isValidMountableHeight } from "../../game/driving/staticSolidContracts";

export type CitySurfaceSource = Readonly<{ layout: CityLayout; ground: CompiledGroundRoadSurface; rendered?: RenderedSolidSource; solids?: () => readonly SolidInput[];
  /** Optional O(1) lease check when scene solids are already frozen by their host. */ solidsCurrent?: () => boolean;
  /** Deep source comparison for audit boundaries; never call this in a frame loop. */ verifySolidsCurrent?: () => boolean }>;
type StructureMetadata = Pick<CitySurfaceCompilation, "obstacles" | "landings" | "counts">;
export type CityDrivingSnapshot = StructureMetadata & Readonly<{
  revision: string;
  surface: CompiledCitySurface;
  /** Coverage is explicit: this identity must not be used as the complete AuditKey base hash
   * until building/landmark obstacles and the frozen legal graph are included. */
  obstacleCoverage: "structures-only" | "structures-and-rendered-buildings";
  /** Exact visible geometry of the registered building/landmark/civic/context layer.
   * Does not include all street furniture, vegetation, traffic or the legal graph. */
  renderedSolids: readonly RenderedSolid[];
  /** Whitelisted scene bounding proxies, sampled with the same world. These are
   * conservative proxies, not the precise architectural render triangles above. */
  sceneSolids: readonly SolidInput[];
}>;
export type ReadyCitySurfaceCapture = Readonly<{
  status: "ready";
  revision: string;
  worldRevision: string;
  /** Deep source check retained for readers that need immediate freshness semantics. */
  isCurrent: () => boolean;
  /** O(1) lease/revision check for the explicitly frozen runtime frame loop. */
  isLeaseCurrent: () => boolean;
  /** Expensive deep comparison for audit boundaries and session entry. */
  verifyCurrent: () => boolean;
  /** Defensive copies; both reads fail once the host generation changes. */
  read: () => CompiledCitySurface | null;
  readWorld: () => CityDrivingSnapshot | null;
  checkStructures: (options: StructureCheckOptions) => StructureCheckReport | null;
  checkLandings: (options: LandingSeamOptions) => LandingSeamReport | null;
  querySurface: (request: SurfacePointQuery) => CitySurfaceQuery;
}>;
export type CitySurfaceQuery =
  | Readonly<{ status: "current"; worldRevision: string; result: SurfaceQueryResult }>
  | Readonly<{ status: "unresolved"; worldRevision: string; reason: Extract<SurfaceIndexBuild, { status: "unresolved" }>["reason"] }>
  | Readonly<{ status: "stale" }>;
export type CitySurfaceCapture = ReadyCitySurfaceCapture | Readonly<{ status: "stale" | "cancelled" | "unavailable" }>;

function copyMetadata(input: StructureMetadata): StructureMetadata {
  return Object.freeze({
    obstacles: Object.freeze(input.obstacles.map((obstacle) => obstacle.shape === "box"
      ? Object.freeze({ ...obstacle, corners: Object.freeze(obstacle.corners.map((p) => Object.freeze({ ...p }))) })
      : Object.freeze({ ...obstacle, ring: Object.freeze(obstacle.ring.map((p) => Object.freeze({ ...p }))) }))),
    landings: Object.freeze(input.landings.map((landing) => Object.freeze({ ...landing,
      seam: Object.freeze({ a: Object.freeze({ ...landing.seam.a }), b: Object.freeze({ ...landing.seam.b }) }) }))),
    counts: Object.freeze({ ...input.counts }),
  });
}

function sceneSolidValues(solids: readonly SolidInput[]): unknown[] {
  if (solids.length > 20000) throw new Error("scene-solids-budget");
  const ids = new Set<string>(); let points = 0;
  return [...solids].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((s) => {
    if (!s.id || ids.has(s.id) || s.id.length > 512 || !s.role || s.role.length > 512 || !isValidMountableHeight(s.mountableHeight)) throw new Error("invalid-scene-solid"); ids.add(s.id);
    const vertices = s.kind === "box" ? [s.center, ...s.halfAxes] : s.ring;
    points += vertices.length;
    if (points > 200000) throw new Error("scene-solids-budget");
    if (vertices.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.z) || ("y" in p && !Number.isFinite(p.y)))) throw new Error("invalid-scene-solid");
    if (s.kind === "box") {
      if (s.halfAxes.length !== 3) throw new Error("invalid-scene-solid");
      return [s.id, s.role, s.kind, [s.center.x,s.center.y,s.center.z], s.halfAxes.map((p) => [p.x,p.y,p.z]), s.mountableHeight ?? null];
    }
    if (s.ring.length < 3 || !Number.isFinite(s.yMin) || !Number.isFinite(s.yMax) || s.yMin > s.yMax) throw new Error("invalid-scene-solid");
    return [s.id,s.role,s.kind,s.ring.map((p) => [p.x,p.z]),s.yMin,s.yMax,s.mountableHeight ?? null];
  });
}
function copySceneSolids(solids: readonly SolidInput[]): readonly SolidInput[] {
  sceneSolidValues(solids);
  return Object.freeze(solids.map((s): SolidInput => s.kind === "box"
    ? Object.freeze({ ...s, center: Object.freeze({ ...s.center }), halfAxes: Object.freeze(s.halfAxes.map((p) => Object.freeze({ ...p }))) as unknown as typeof s.halfAxes })
    : Object.freeze({ ...s, ring: Object.freeze(s.ring.map((p) => Object.freeze({ ...p }))) })));
}

/** Canonical structural payload; the surface revision already covers meshes and topology.
 * Sorting removes incidental caller order; malformed identities/numbers fail before hashing. */
export function canonicalCityWorldBytes(surfaceRevision: string, metadata: StructureMetadata, renderedSolids?: readonly RenderedSolid[], sceneSolids?: readonly SolidInput[]): Uint8Array {
  if (!surfaceRevision) throw new Error("invalid-world-surface-revision");
  const ids = new Set<string>();
  const obstacles = [...metadata.obstacles].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((o) => {
    if (!o.id || ids.has(o.id)) throw new Error("invalid-world-obstacle-id");
    if (!isValidMountableHeight(o.mountableHeight)) throw new Error("invalid-world-obstacle-mountable-height");
    ids.add(o.id);
    const points = o.shape === "box" ? o.corners : o.ring;
    if ((o.shape === "box" && points.length !== 8) || points.length < 3 ||
      points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.z) || ("y" in p && !Number.isFinite(p.y)))) throw new Error("invalid-world-obstacle");
    if (o.shape === "prism" && (!Number.isFinite(o.yMin) || !Number.isFinite(o.yMax) || o.yMin > o.yMax)) throw new Error("invalid-world-obstacle");
    return o.shape === "box" ? [o.id, o.role, o.shape, o.surfacePatchId ?? null, o.corners.map((p) => [p.x, p.y, p.z]), o.mountableHeight ?? null]
      : [o.id, o.role, o.shape, o.ring.map((p) => [p.x, p.z]), o.yMin, o.yMax, o.mountableHeight ?? null];
  });
  const landingIds = new Set<string>();
  const landings = [...metadata.landings].sort((a, b) => a.structureId < b.structureId ? -1 : a.structureId > b.structureId ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : 0).map((l) => {
    const id = JSON.stringify([l.structureId, l.end]);
    if (!l.structureId || !l.layerId || !l.patchId || !l.seam || ![l.seam.a.x,l.seam.a.y,l.seam.a.z,l.seam.b.x,l.seam.b.y,l.seam.b.z].every(Number.isFinite) || landingIds.has(id) || ![l.x, l.z, l.outX, l.outZ, l.deckY].every(Number.isFinite) ||
      (l.groundY !== null && !Number.isFinite(l.groundY)) || (l.step !== null && !Number.isFinite(l.step))) throw new Error("invalid-world-landing");
    landingIds.add(id);
    return [l.structureId, l.end, l.layerId, l.patchId, [l.seam.a.x,l.seam.a.y,l.seam.a.z], [l.seam.b.x,l.seam.b.y,l.seam.b.z], l.x, l.z, l.outX, l.outZ, l.deckY, l.groundY, l.step, l.status];
  });
  const counts = [metadata.counts.bridges, metadata.counts.expresswaySegments, metadata.counts.flares, metadata.counts.islands, metadata.counts.culDeSacs];
  if (!counts.every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error("invalid-world-counts");
  const renderedIds = new Set<string>();
  assertRenderedSolidBudget(renderedSolids ?? []);
  let renderedBytes = 0;
  const rendered = [...(renderedSolids ?? [])].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((s) => {
    if (!s.id || s.id.length > 512 || renderedIds.has(s.id) || !["building", "landmark", "civic", "context", "massing"].includes(s.role) ||
      s.positions.length % 3 || s.indices.length % 3 || s.transforms.length % 16 ||
      !s.positions.every(Number.isFinite) || !s.transforms.every(Number.isFinite) ||
      !s.indices.every((i) => Number.isSafeInteger(i) && i >= 0 && i < s.positions.length / 3)) throw new Error("invalid-world-rendered-solid");
    for (let at = 0; at < s.transforms.length; at += 16) if (s.transforms[at+3] !== 0 || s.transforms[at+7] !== 0 || s.transforms[at+11] !== 0 || s.transforms[at+15] !== 1) throw new Error("invalid-world-rendered-solid-transform");
    renderedIds.add(s.id);
    renderedBytes += s.positions.byteLength + s.indices.byteLength + s.transforms.byteLength;
    return s;
  });
  const header = new TextEncoder().encode(JSON.stringify(["city-driving-world", 2, renderedSolids ? "structures-and-rendered-buildings" : "structures-only", surfaceRevision, obstacles, landings, counts,
    ...(renderedSolids ? [rendered.map((s) => [s.id, s.role, s.positions.length, s.indices.length, s.transforms.length])] : []),
    ...(sceneSolids ? [["scene-proxies", sceneSolidValues(sceneSolids)]] : [])]));
  if (!renderedSolids) return header;
  // Binary payload avoids JSON expansion of millions of numeric values. A length-prefixed
  // UTF-8 header plus explicitly little-endian arrays is deterministic on every host.
  const bytes = new Uint8Array(4 + header.length + renderedBytes), view = new DataView(bytes.buffer);
  view.setUint32(0, header.length, true); bytes.set(header, 4); let at = 4 + header.length;
  for (const s of rendered) {
    for (const n of s.positions) { view.setFloat32(at, n, true); at += 4; }
    for (const n of s.indices) { view.setUint32(at, n, true); at += 4; }
    for (const n of s.transforms) { view.setFloat64(at, n, true); at += 8; }
  }
  return bytes;
}

export class CitySurfacePort {
  private readonly store: SurfaceStore;
  private generation = 0;
  private source: CitySurfaceSource | null = null;
  private cached: ReadyCitySurfaceCapture | null = null;
  private pending: { generation: number; promise: Promise<CitySurfaceCapture> } | null = null;
  private releaseIndex: (() => void) | null = null;
  constructor(private readonly hash: SurfaceHasher = sha256SurfaceBytes) { this.store = new SurfaceStore(hash); }

  invalidate(): void {
    this.generation++; this.source = null; this.cached = null; this.pending = null;
    this.releaseIndex?.(); this.releaseIndex = null; this.store.clear();
  }

  /** Release the final display freeze without allowing an old lease to evict a newer world. */
  releaseFrozenSource(source: CitySurfaceSource): void {
    if (source.rendered && this.source?.layout === source.layout && this.source.ground === source.ground &&
      this.source.rendered === source.rendered && !source.rendered.isCurrent()) this.invalidate();
  }

  async capture(source: CitySurfaceSource | null, signal?: AbortSignal): Promise<CitySurfaceCapture> {
    if (!source) { this.invalidate(); return Object.freeze({ status: signal?.aborted ? "cancelled" : "unavailable" }); }
    if (this.source?.layout !== source.layout || this.source?.ground !== source.ground || this.source?.rendered !== source.rendered || this.source?.solids !== source.solids || this.source?.solidsCurrent !== source.solidsCurrent || this.source?.verifySolidsCurrent !== source.verifySolidsCurrent) {
      this.invalidate(); this.source = Object.freeze({ layout: source.layout, ground: source.ground, rendered: source.rendered, solids: source.solids, solidsCurrent: source.solidsCurrent, verifySolidsCurrent: source.verifySolidsCurrent });
    }
    if (signal?.aborted) return Object.freeze({ status: "cancelled" });
    if (this.cached?.isCurrent()) return this.cached;
    if (!this.pending) {
      const generation = this.generation;
      const promise = this.prepare(source, generation);
      this.pending = { generation, promise };
      // Both success and failure release only THIS pending generation.
      const clear = () => { if (this.pending?.promise === promise) this.pending = null; };
      void promise.then(clear, clear);
    }
    const result = await this.pending.promise;
    return signal?.aborted ? Object.freeze({ status: "cancelled" }) : result;
  }

  private async prepare(source: CitySurfaceSource, generation: number): Promise<CitySurfaceCapture> {
    const compilation = compileCitySurface(source.layout, { ground: source.ground });
    // Hash/read payloads are owned; no compiler/source references escape through the handle.
    const metadata = copyMetadata(compilation);
    const renderedSolids = copyRenderedSolids(source.rendered?.solids ?? []);
    const sceneSolids = copySceneSolids(source.solids?.() ?? []);
    const sceneIdentity = JSON.stringify(sceneSolidValues(sceneSolids));
    let sourceValid = true;
    const sourceCurrent = () => {
      if (!sourceValid) return false;
      try { return sourceValid = (!source.rendered || source.rendered.isCurrent()) &&
        (source.solidsCurrent ? source.solidsCurrent() : !source.solids || JSON.stringify(sceneSolidValues(source.solids())) === sceneIdentity); }
      catch { return sourceValid = false; }
    };
    const verifySourceCurrent = () => {
      if (!sourceCurrent()) return false;
      try {
        const rendered = source.rendered ? (source.rendered.verifyCurrent?.() ?? source.rendered.isCurrent()) : true;
        const scene = source.verifySolidsCurrent ? source.verifySolidsCurrent()
          : source.solidsCurrent ? source.solidsCurrent() : !source.solids || JSON.stringify(sceneSolidValues(source.solids())) === sceneIdentity;
        return sourceValid = rendered && scene;
      } catch { return sourceValid = false; }
    };
    const publication = await this.store.publish(compilation.surface);
    if (generation !== this.generation || publication.status !== "published" || !verifySourceCurrent()) return Object.freeze({ status: "stale" });
    const revision = publication.revision;
    const digest = await this.hash(canonicalCityWorldBytes(revision, metadata, source.rendered ? renderedSolids : undefined, source.solids ? sceneSolids : undefined));
    if (generation !== this.generation || this.store.revision !== revision || !verifySourceCurrent()) return Object.freeze({ status: "stale" });
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid-world-digest");
    const worldRevision = `city-world-v2:sha256:${digest}`;
    const leaseCurrent = () => generation === this.generation && this.store.revision === revision && sourceCurrent();
    const verifyCurrent = () => generation === this.generation && this.store.revision === revision && verifySourceCurrent();
    const isCurrent = verifyCurrent;
    const read = () => isCurrent() ? this.store.read(revision) : null;
    const readWorld = (): CityDrivingSnapshot | null => {
      const surface = read();
      return surface ? Object.freeze({ ...copyMetadata(metadata), surface, revision: worldRevision,
        obstacleCoverage: source.rendered ? "structures-and-rendered-buildings" : "structures-only", renderedSolids: copyRenderedSolids(renderedSolids), sceneSolids: copySceneSolids(sceneSolids) }) : null;
    };
    const checkStructures = (options: StructureCheckOptions): StructureCheckReport | null => {
      const snapshot = readWorld();
      return snapshot ? checkStructureGeometry(snapshot, options) : null;
    };
    const checkLandings = (options: LandingSeamOptions): LandingSeamReport | null => {
      const snapshot = readWorld();
      return snapshot ? checkLandingSeams(snapshot, options) : null;
    };
    let index: SurfaceIndexBuild | null = null;
    this.releaseIndex = () => { index = null; };
    const querySurface = (request: SurfacePointQuery): CitySurfaceQuery => {
      if (!isCurrent()) return Object.freeze({ status: "stale" });
      if (!index) {
        const snapshot = read();
        if (!snapshot) return Object.freeze({ status: "stale" });
        index = buildSurfaceIndex(snapshot);
      }
      return index.status === "ready"
        ? Object.freeze({ status: "current", worldRevision, result: index.query(request) })
        : Object.freeze({ status: "unresolved", worldRevision, reason: index.reason });
    };
    const capture: ReadyCitySurfaceCapture = Object.freeze({ status: "ready", revision, worldRevision, isCurrent, isLeaseCurrent: leaseCurrent,
      verifyCurrent, read, readWorld, checkStructures, checkLandings, querySurface });
    this.cached = capture;
    return capture;
  }
}
