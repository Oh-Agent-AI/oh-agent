/** One compile of the whole drivable city surface: ground roads + channelised mouths +
 * cul-de-sac discs + bridge decks + expressway decks, from the SAME descriptors the
 * renderer draws. CPU-only; type-only CityLayout import.
 *
 * 层的规则（spec §5.1）：layerId 是几何高度层。地面路、喇叭、回车圈、渠化岛在 "ground"。
 * 桥面若除两端落地区外不压任何地面车行面（跨河），就放进 "ground"——两端与路面的叠置由
 * surfaceRegions 的 alias 规则判：高差 ≤ aliasTolerance 即接通，否则是 conflict/step，关闭；
 * 这就是同层落地的「portal」，不另造连接。压着地面路（立交）的桥面与全部高架各自成层，
 * 跨层入口需通过实际端边及二维重叠走廊验证才能产生显式 portal；不满足者保持关闭。
 * portal 是几何连接证据，车辆净空、碰撞和连续运动仍需独立验证。 */
import type { CityLayout, Vec2 } from "../cityLayout";
import { renderRoadEdges } from "../cityRoadJunctions";
import { buildGroundSurfaceSnapshot } from "./buildGroundSnapshot";
import { assertGroundRoadSurfaceMatches, compileGroundRoadSurface, type CompiledGroundRoadSurface } from "./groundRoadCompiler";
import { buildLandingPortals, DEFAULT_LANDING_PORTAL_OPTIONS } from "./landingPortals";
import { extractMeshBoundaries } from "./meshBoundaries";
import { buildSurfaceIndex } from "./SurfaceIndex";
import { landmarkPlatforms } from "./landmarkPlatforms";
import {
  boxCorners, boxPoint, boxTopFace, bridgeDeckParts, bridgeDrivableHalf, channelizedGeometry, culDeSacDiscs, culDeSacTopCap,
  EXPRESSWAY_DRIVABLE_HALF, expresswayPieces, FLARE_LIFT, flareTriangles, highwayRampPieces, rampDrivableHalf, ribbonFaces, trussBarPart, trussBars, type BoxPart,
} from "./structureCompiler";
import { conformMesh, terrainFit } from "./terrainClip";
import type { SurfaceRegionsBuild } from "./surfaceRegions";
import type { CompiledCitySurface, SurfaceCompileIssue, SurfaceKind, SurfacePatch, SurfacePortal } from "./types";

/** Bump when any patch, layer or obstacle rule here changes (AuditKey.surfaceVersion input). */
export const CITY_SURFACE_GEOMETRY_VERSION = 16;
/** Along-span distance from a bridge end treated as its landing (not an overpass). */
const LANDING_ZONE = 3;

type P3 = { x: number; y: number; z: number };
export type StructureObstacle =
  | Readonly<{ id: string; role: BoxPart["role"]; shape: "box"; corners: readonly P3[]; surfacePatchId?: string; mountableHeight?: number }>
  | Readonly<{ id: string; role: "island"; shape: "prism"; ring: readonly Vec2[]; yMin: number; yMax: number;
    /** 可越预算：障碍顶面高出车底 ≤ 此值时不产生法向阻挡，支撑取 max(路面, 顶面)。
     *  无标注 = blocking。见 docs/CITY_DRIVING_MOUNTABLE_OBSTACLES.md。 */
    mountableHeight?: number }>;
export type StructureLanding = Readonly<{
  structureId: string; end: "from" | "to"; layerId: string; x: number; z: number;
  patchId: string;
  /** Actual inset top-face end edge, not a centre probe or a guessed road width. */
  seam: Readonly<{ a: Readonly<P3>; b: Readonly<P3> }>;
  /** Unit vector along the span, pointing from the deck outward past this end. */
  outX: number; outZ: number;
  deckY: number; groundY: number | null; step: number | null;
  /** aligned: same layer and |step| within tolerance; step: too high/low; no-ground: nothing to land on;
   *  layered: deck is on its own layer — no cross-layer portal exists yet. */
  status: "aligned" | "step" | "no-ground" | "layered";
}>;
export type CitySurfaceCompilation = Readonly<{
  surface: CompiledCitySurface;
  ground: CompiledGroundRoadSurface;
  obstacles: readonly StructureObstacle[];
  landings: readonly StructureLanding[];
  counts: Readonly<{ bridges: number; expresswaySegments: number; flares: number; islands: number; culDeSacs: number }>;
}>;
export type CitySurfaceLayout = Pick<CityLayout, "roadEdges" | "extent" | "terrain" | "highways" | "bridges" | "landmarks" | "culDeSacEnds"> & Partial<Pick<CityLayout, "highwayRamps" | "airport">>;

/** Road-compiler-independent static collision descriptors shared by plane and car. */
export function compileStaticStructureObstacles(layout: CitySurfaceLayout): readonly StructureObstacle[] {
  const obstacles: StructureObstacle[] = [];
  for (const island of channelizedGeometry(layout).islands) obstacles.push(Object.freeze({ id: `island:${island.mouth}`, role: "island", shape: "prism",
    ring: island.ring, yMin: Math.min(...island.ring.map((p) => layout.terrain.height(p.x, p.z) - 0.18)),
    yMax: Math.max(...island.ring.map((p) => layout.terrain.height(p.x, p.z) + 0.22)), mountableHeight: 0.25 }));
  for (const edge of renderRoadEdges(layout.roadEdges)) {
    if (!edge.bridge || edge.points.length !== 2) continue;
    const source = { kind: "structure" as const, id: `bridge:${edge.id}` };
    const parts = bridgeDeckParts(edge, layout), decks = parts.filter((p) => p.role === "bridge-deck");
    decks.forEach((deck, i) => {
      const corners = boxCorners(deck), topYs = [corners[2].y, corners[3].y, corners[6].y, corners[7].y];
      const rise = Math.max(...topYs) - Math.min(...topYs), budget = Math.min(0.9, Math.round((rise + 0.3) * 100) / 100);
      obstacles.push(Object.freeze({ id: decks.length === 1 ? `${source.id}:slab` : `${source.id}:slab:${i}`, role: "bridge-deck", shape: "box",
        corners: Object.freeze(corners), mountableHeight: budget }));
    });
    for (const part of parts) if (part.role === "bridge-railing" || part.role === "bridge-pier")
      obstacles.push(Object.freeze({ id: `${source.id}:${part.role}:${obstacles.length}`, role: part.role, shape: "box", corners: Object.freeze(boxCorners(part)) }));
  }
  for (const bar of trussBars(layout)) {
    const part = trussBarPart(bar);
    obstacles.push(Object.freeze({ id: `truss:${obstacles.length}`, role: "truss", shape: "box", corners: Object.freeze(boxCorners(part)) }));
  }
  for (const piece of expresswayPieces(layout)) {
    if (piece.role === "expressway-rail" || piece.role === "expressway-pier") {
      obstacles.push(Object.freeze({ id: `expressway:${piece.highway}:${piece.role}:${obstacles.length}`, role: piece.role, shape: "box", corners: Object.freeze(boxCorners(piece)) }));
    } else if (piece.role === "expressway-deck") {
      const id = `expressway:${piece.highway}:${String(piece.segment).padStart(4, "0")}`;
      // The top face is also compiled as the driveable elevated-road surface.
      // On pitched segments the box's global top edge can protrude above the local
      // road plane and behave like a wall at segment seams. Allow only that bounded
      // top-edge envelope to be mounted; the underside and sides still collide.
      const corners = boxCorners(piece);
      const topYs = [corners[2].y, corners[3].y, corners[6].y, corners[7].y];
      const rise = Math.max(...topYs) - Math.min(...topYs);
      const mountableHeight = Math.min(0.9, Math.round((rise + 0.3) * 100) / 100);
      obstacles.push(Object.freeze({ id: `${id}:slab`, role: "expressway-deck", shape: "box", corners: Object.freeze(corners), mountableHeight }));
    }
  }
  // 立交匝道：护栏与墩柱是实体；桥面板与高架桥面同一规则（只允许越过坡度错台那一点顶边）。
  for (const piece of highwayRampPieces(layout)) {
    if (piece.role === "ramp-rail" || piece.role === "ramp-pier") {
      obstacles.push(Object.freeze({ id: `ramp:${piece.ramp}:${piece.role}:${obstacles.length}`, role: piece.role, shape: "box", corners: Object.freeze(boxCorners(piece)) }));
    } else if (piece.role === "ramp-deck") {
      const corners = boxCorners(piece);
      const topYs = [corners[2].y, corners[3].y, corners[6].y, corners[7].y];
      // At a ramp grade the car body is pitched along the top face. The
      // conservative swept body bottom can sit slightly below the road plane,
      // while the far end of this long slab is higher than the car center.
      // 0.9 clipped that combined envelope (e.g. 0.985 on seed 42), so the
      // ramp's own support slab became a wall and reset uphill speed to zero.
      // Keep the exemption bounded; deep overlap and the underside still collide.
      const mountableHeight = Math.min(1.1, Math.round((Math.max(...topYs) - Math.min(...topYs) + 0.3) * 100) / 100);
      obstacles.push(Object.freeze({ id: `ramp:${piece.ramp}:${String(piece.segment).padStart(4, "0")}:slab`, role: "ramp-deck", shape: "box", corners: Object.freeze(corners), mountableHeight }));
    }
  }
  return Object.freeze(obstacles);
}

/** Upward (SurfaceIndex convention: negative XZ signed area) triangle mesh, welded by Float32 XYZ. */
function meshOf(triangles: readonly (readonly [P3, P3, P3])[]): { vertices: Float32Array; indices: Uint32Array } {
  const keys = new Map<string, number>(); const positions: number[] = []; const indices: number[] = [];
  const at = (p: P3) => {
    const x = Math.fround(p.x), y = Math.fround(p.y), z = Math.fround(p.z); const key = `${x},${y},${z}`;
    let i = keys.get(key); if (i === undefined) { i = positions.length / 3; keys.set(key, i); positions.push(x, y, z); } return i;
  };
  for (const [a, b, c] of triangles) {
    const area = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    if (Math.abs(area) < 1e-9) continue;
    const ia = at(a), ib = at(b), ic = at(c);
    if (ia === ib || ib === ic || ia === ic) continue;
    if (area < 0) indices.push(ia, ib, ic); else indices.push(ia, ic, ib);
  }
  return { vertices: new Float32Array(positions), indices: new Uint32Array(indices) };
}
const quad = (c: readonly P3[]): [P3, P3, P3][] => [[c[0], c[1], c[2]], [c[0], c[2], c[3]]];
const seamOf = (top: readonly P3[], end: StructureLanding["end"]) => {
  const owned = (p: P3) => Object.freeze({ x: Math.fround(p.x), y: Math.fround(p.y), z: Math.fround(p.z) });
  return Object.freeze({ a: owned(end === "from" ? top[0] : top[1]), b: owned(end === "from" ? top[3] : top[2]) });
};

export function compileCitySurface(layout: CitySurfaceLayout, options: { ground?: CompiledGroundRoadSurface; aliasTolerance?: number } = {}): CitySurfaceCompilation {
  const tolerance = options.aliasTolerance ?? 0.1;
  const ground = options.ground ?? compileGroundRoadSurface(layout);
  assertGroundRoadSurfaceMatches(ground, layout);
  const groundSnapshot = buildGroundSurfaceSnapshot(ground);
  const issues: SurfaceCompileIssue[] = groundSnapshot.report.issues.filter((issue) => issue.reason !== "unsupported");
  const patches: SurfacePatch[] = [...groundSnapshot.patches];
  const landings: StructureLanding[] = [];
  const portals: SurfacePortal[] = [];
  /** Portal candidate: `upper`'s loop segment nearest the seam point ↔ `lower`'s outer loop. */
  const portal = (upper: SurfacePatch, lowerId: string, seam: Vec2) => {
    const lower = patches.find((p) => p.id === lowerId);
    const upperLoop = upper.boundaryLoops.findIndex((l) => !l.hole); const lowerLoop = lower ? lower.boundaryLoops.findIndex((l) => !l.hole) : -1;
    if (!lower || upperLoop < 0 || lowerLoop < 0 || (lower.kind !== "carriageway" && lower.kind !== "junction")) return;
    const loop = upper.boundaryLoops[upperLoop].vertices; let best = 0; let bestD = Infinity;
    loop.forEach((p, i) => { const q = loop[(i + 1) % loop.length]; const d = Math.hypot((p.x + q.x) / 2 - seam.x, (p.z + q.z) / 2 - seam.z); if (d < bestD) { bestD = d; best = i; } });
    const id = `portal:${upper.id}:${lowerId}`;
    if (portals.some((x) => x.id === id)) return;
    portals.push(Object.freeze({ id, fromPatch: upper.id, toPatch: lowerId,
      fromBoundary: Object.freeze({ loop: upperLoop, firstSegment: best, segmentCount: 1 }),
      toBoundary: Object.freeze({ loop: lowerLoop, firstSegment: 0, segmentCount: lower.boundaryLoops[lowerLoop].vertices.length }),
      permittedDirection: "both", clearance: 2.2, maxHeightMismatch: tolerance, validated: false }));
  };
  const add = (id: string, kind: SurfaceKind, layerId: string, source: SurfacePatch["source"], triangles: readonly (readonly [P3, P3, P3])[]) => {
    const { vertices, indices } = meshOf(triangles);
    if (!indices.length) { issues.push({ source, reason: "degenerate", detail: "empty" }); return null; }
    const boundary = extractMeshBoundaries(vertices, indices);
    if (boundary.status !== "complete") issues.push({ source, reason: boundary.reason === "budget" ? "budget" : "open-boundary", detail: boundary.reason === "none" ? undefined : boundary.reason });
    const patch: SurfacePatch = Object.freeze({ id, kind, layerId, vertices, indices, boundaryLoops: boundary.loops, source: Object.freeze(source) });
    patches.push(patch); return patch;
  };

  // ── Channelised mouths: flares follow the rendered terrain exactly like the renderer; islands are curb holes.
  const channel = channelizedGeometry(layout);
  const flareFit = terrainFit(layout, FLARE_LIFT);
  for (const flare of channel.flares) {
    const triangles = conformMesh(flareFit, FLARE_LIFT / 2, flareTriangles(flare)).triangles
      .map((t) => t.map((p) => ({ x: p.x, y: flareFit.heightAt(p.x, p.z), z: p.z })) as [P3, P3, P3]);
    add(`flare:${flare.mouth}:${flare.arm}`, "junction", "ground", { kind: "junction", id: `channel:${flare.mouth}` }, triangles);
  }
  for (const island of channel.islands) {
    const top = island.ring.map((p) => ({ x: p.x, y: layout.terrain.height(p.x, p.z) + 0.22, z: p.z }));
    const centroid = { x: top.reduce((n, p) => n + p.x, 0) / top.length, y: top.reduce((n, p) => n + p.y, 0) / top.length, z: top.reduce((n, p) => n + p.z, 0) / top.length };
    add(`island:${island.mouth}`, "island", "ground", { kind: "junction", id: `channel:${island.mouth}` }, top.map((p, k) => [p, top[(k + 1) % top.length], centroid] as const));
  }
  // ── Cul-de-sac discs: the cylinder's top cap as the renderer tilts it.
  const discs = culDeSacDiscs(layout);
  for (const disc of discs) {
    const { center, rim } = culDeSacTopCap(disc);
    add(`culdesac:${disc.x}:${disc.z}`, "junction", "ground", { kind: "junction", id: `culdesac:${disc.x}:${disc.z}` }, rim.map((p, k) => [center, p, rim[(k + 1) % rim.length]] as const));
  }

  // ── Landmark platforms (sea opera islet, airport island): a flat drivable top the causeway lands on.
  //    Same layer as the roads; the deck landing on it is aligned by construction (bridgeDeckProfile).
  const platforms = landmarkPlatforms(layout);
  for (const platform of platforms) {
    const n = platform.outline.length;
    const centre = platform.outline.reduce((acc, p) => ({ x: acc.x + p.x / n, y: platform.y, z: acc.z + p.z / n }), { x: 0, y: platform.y, z: 0 });
    const rim = platform.outline.map((p) => ({ x: p.x, y: platform.y, z: p.z }));
    add(platform.id, "junction", "ground", { kind: "junction", id: platform.id }, rim.map((p, k) => [centre, p, rim[(k + 1) % n]] as const));
  }

  // Ground-only index decides whether a bridge deck may share the ground layer.
  const groundIndex = buildSurfaceIndex({ ...groundSnapshot, revision: "layering", patches: Object.freeze([...patches]) });
  const groundY = (x: number, z: number): number | null => {
    if (groundIndex.status !== "ready") return null;
    const r = groundIndex.query({ x, z, layerId: "ground" });
    if (r.status === "hit") return r.hit.point.y;
    if (r.status === "ambiguous") return Math.max(...r.candidates.map((c) => c.point.y));
    return null;
  };

  const groundPatchesAt = (x: number, z: number): string[] => {
    if (groundIndex.status !== "ready") return [];
    const r = groundIndex.query({ x, z, layerId: "ground" });
    return r.status === "hit" ? [r.hit.patchId] : r.status === "ambiguous" ? r.candidates.map((c) => c.patchId) : [];
  };
  /** Ground patch id → road nodes it touches (road pieces: both ends; junction pieces: the node). */
  const landingOf = new Map<string, string[]>(ground.pieces.map((piece) => [piece.id, piece.source.kind === "road" ? [piece.source.fromNode, piece.source.toNode] : [piece.source.id]]));
  // ── Edge bridges.
  let bridges = 0;
  for (const edge of renderRoadEdges(layout.roadEdges)) {
    if (!edge.bridge) continue;
    const source = { kind: "structure" as const, id: `bridge:${edge.id}` };
    if (edge.points.length !== 2) { issues.push({ source, reason: "unsupported", detail: "invalid-mesh" }); continue; }
    bridges++;
    const parts = bridgeDeckParts(edge, layout);
    const decks = parts.filter((p) => p.role === "bridge-deck");
    const tops = decks.map(p => boxTopFace(p, bridgeDrivableHalf(edge)));
    const [a, b] = edge.points; const len = Math.hypot(b.x - a.x, b.z - a.z); const ux = (b.x - a.x) / len; const uz = (b.z - a.z) / len;
    // Any ground carriageway under the span that does not belong to the two landing nodes → own layer
    // (the bridgehead junction fans legitimately reach 1.5–2.3 into the span; they are the landing).
    // Within LANDING_ZONE of an end, overlaps of other nearby fans are left to the alias rule
    // (aligned → connected, otherwise conflict → closed): fail-closed either way.
    let overpass = false;
    const half = bridgeDrivableHalf(edge);
    // 落进地标平台的桥：平台路面就是它的落地面（深入桥下几米，不是从桥下穿过的路）。
    const landedPlatforms = new Set(platforms.filter((pl) => pl.contains(a.x, a.z) || pl.contains(b.x, b.z)).map((pl) => pl.id));
    const landingPatch = (id: string) => landedPlatforms.has(id) || (landingOf.get(id) ?? []).some((node) => node === edge.from || node === edge.to);
    for (let s = 0; s <= len && !overpass; s += 0.5) for (let w = -half; w <= half + 1e-9 && !overpass; w += Math.max(0.5, half / 4)) {
      overpass = groundPatchesAt(a.x + ux * s - uz * w, a.z + uz * s + ux * w).some((id) => !landingPatch(id) && s > LANDING_ZONE && s < len - LANDING_ZONE);
    }
    const layerId = overpass ? `bridge:${edge.id}` : "ground";
    const deckPatches = tops.map((top,i) => add(decks.length===1?`bridge:${edge.id}`:`bridge:${edge.id}:${String(i).padStart(3,"0")}`, "bridge-deck", layerId, source, quad(top)));
    // Overpass: portal candidates to the landing nodes' ground pieces under each end zone.
    if (overpass) for (const [s0, s1, seam, deckPatch] of [[-0.5, LANDING_ZONE, a,deckPatches[0]], [len - LANDING_ZONE, len + 0.5, b,deckPatches[deckPatches.length-1]]] as const) {
      if(!deckPatch)continue;
      const ids = new Set<string>();
      for (let s = s0; s <= s1 + 1e-9; s += 0.5) for (let w = -half; w <= half + 1e-9; w += Math.max(0.5, half / 4)) {
        for (const id of groundPatchesAt(a.x + ux * s - uz * w, a.z + uz * s + ux * w)) if (landingPatch(id)) ids.add(id);
      }
      for (const id of [...ids].sort()) portal(deckPatch, id, seam);
    }
    for (const [end, p, out] of [["from", a, -1], ["to", b, 1]] as const) {
      const section=end==="from"?0:tops.length-1,top=tops[section];
      // The seam is the deck's end edge, 0.25 past the node: compare the ground just outside it with
      // the deck top extrapolated along its pitch to the same point.
      const slope = (top[1].y - top[0].y) / Math.hypot(top[1].x - top[0].x, top[1].z - top[0].z);
      const nodeY = end === "from" ? (top[0].y + top[3].y) / 2 + slope * 0.25 : (top[1].y + top[2].y) / 2 - slope * 0.25;
      const deckY = nodeY + slope * out * 0.3;
      const g = groundY(p.x + ux * out * 0.3, p.z + uz * out * 0.3);
      const step = g === null ? null : deckY - g;
      const status = overpass ? "layered" : g === null ? "no-ground" : Math.abs(step!) <= tolerance ? "aligned" : "step";
      const seam = seamOf(top, end);
      landings.push(Object.freeze({ structureId: source.id, end, layerId, patchId: deckPatches[section]?.id??`bridge:${edge.id}`, seam, x: p.x, z: p.z, outX: ux * out, outZ: uz * out, deckY, groundY: g, step, status }));
    }
  }
  // ── District expressways: one layer per highway; segment decks are aliased by surfaceRegions.
  let expresswaySegments = 0;
  const pieces = expresswayPieces(layout);
  // 驾驶面是一条首尾相接的带（2026-10-19）：曾直接取每块桥面板的顶面，而板长 slant + 0.5（为渲染补缝，两头各伸 0.25），
  // 弯道内侧相邻两块的重叠楔里按各自坡度算高，差到 0.16 > aliasTolerance，surfaceRegions 判 height-conflict，
  // 匝道在落地后约 9 处断成两个区域（0/1、0/2026、500/42 等的结构连接用例 topology-disconnected）。
  // 现内部顶点取两块板顶在真实分段端点的中线点、斜接（mitre）横向，相邻面片共用同一条接缝；整条匝道的两个端边
  // 仍是首/末块板的完整顶面端边——落地接缝（seamOf）与门户候选不变。渲染与碰撞的板块不变。
  const deckByHighway = new Map<number, typeof pieces>();
  for (const piece of pieces) if (piece.role === "expressway-deck") deckByHighway.set(piece.highway, [...(deckByHighway.get(piece.highway) ?? []), piece]);
  for (const [highway, deck] of [...deckByHighway].sort((a, b) => a[0] - b[0])) {
    deck.sort((x, y) => x.segment - y.segment);
    ribbonFaces(deck, EXPRESSWAY_DRIVABLE_HALF, 0.5).forEach((face, i) => {
      const piece = deck[i];
      expresswaySegments++;
      const patchId = `expressway:${highway}:${String(piece.segment).padStart(4, "0")}`;
      add(patchId, Math.abs(piece.rz) > 1e-4 ? "ramp" : "expressway-deck",
        `expressway:${highway}`, { kind: "structure", id: `expressway:${highway}` }, quad(face));
    });
  }
  // 立交匝道（可驾驶，2026-10-20）：与所属高架同一层——起点压在高架桥面上、同高，两者在同层叠置处直接并为一个
  // 区域（分流不需要门户）；地面端像高架落地一样，按端部范围内的地面车道给门户候选，并登记为落地点
  // （结构过渡审计 structure:ramp:<i>:to:onto/off）。
  const rampPieces = highwayRampPieces(layout);
  const rampDecks = new Map<number, typeof rampPieces>();
  for (const piece of rampPieces) if (piece.role === "ramp-deck" && piece.highway >= 0) rampDecks.set(piece.ramp, [...(rampDecks.get(piece.ramp) ?? []), piece]);
  const rampEnds: Array<{ ramp: number; highway: number; patchId: string; top: P3[]; half: number }> = [];
  for (const [ramp, deck] of [...rampDecks].sort((a, b) => a[0] - b[0])) {
    deck.sort((x, y) => x.segment - y.segment);
    const width = (layout.highwayRamps ?? [])[ramp].width, half = rampDrivableHalf(width);
    ribbonFaces(deck, half, 0.4).forEach((face, i) => {
      const piece = deck[i];
      add(`ramp:${ramp}:${String(piece.segment).padStart(4, "0")}`, "ramp", `expressway:${piece.highway}`, { kind: "structure", id: `ramp:${ramp}` }, quad(face));
    });
    const last = deck[deck.length - 1];
    rampEnds.push({ ramp, highway: last.highway, patchId: `ramp:${ramp}:${String(last.segment).padStart(4, "0")}`, top: boxTopFace(last, half), half });
  }
  const patchById = new Map(patches.map((p) => [p.id, p]));
  (layout.highways ?? []).forEach((points, highway) => {
    const closed = Math.hypot(points[0].x - points[points.length - 1].x, points[0].z - points[points.length - 1].z) < 0.01;
    if (closed) return;
    for (const [end, index] of [["from", 0], ["to", points.length - 1]] as const) {
      const deck = pieces.filter((p) => p.highway === highway && p.role === "expressway-deck").sort((x, y) => x.segment - y.segment);
      const piece = end === "from" ? deck[0] : deck[deck.length - 1];
      if (!piece) continue;
      const top = boxTopFace(piece, EXPRESSWAY_DRIVABLE_HALF); const p = points[index];
      const y = end === "from" ? (top[0].y + top[3].y) / 2 : (top[1].y + top[2].y) / 2;
      const g = groundY(p.x, p.z);
      const q = points[end === "from" ? 1 : points.length - 2]; const l = Math.hypot(p.x - q.x, p.z - q.z) || 1;
      const seam = seamOf(top, end);
      landings.push(Object.freeze({ structureId: `expressway:${highway}`, end, layerId: `expressway:${highway}`, patchId: `expressway:${highway}:${String(piece.segment).padStart(4, "0")}`, seam, x: p.x, z: p.z, outX: (p.x - q.x) / l, outZ: (p.z - q.z) / l, deckY: y, groundY: g, step: g === null ? null : y - g, status: "layered" }));
      // Ramp end: portal candidates to every ground carriageway under the end zone of the deck.
      const deckPatch = patchById.get(`expressway:${highway}:${String(piece.segment).padStart(4, "0")}`);
      if (!deckPatch) continue;
      const ids = new Set<string>();
      for (let s = -0.25; s <= 3 + 1e-9; s += 0.5) for (let w = -EXPRESSWAY_DRIVABLE_HALF; w <= EXPRESSWAY_DRIVABLE_HALF + 1e-9; w += EXPRESSWAY_DRIVABLE_HALF / 4) {
        for (const id of groundPatchesAt(p.x - ((p.x - q.x) / l) * s - ((p.z - q.z) / l) * w, p.z - ((p.z - q.z) / l) * s + ((p.x - q.x) / l) * w)) ids.add(id);
      }
      for (const id of [...ids].sort()) portal(deckPatch, id, p);
    }
  });

  for (const end of rampEnds) {
    const pts = (layout.highwayRamps ?? [])[end.ramp].points;
    const p = pts[pts.length - 1], q = pts[pts.length - 2]; const l = Math.hypot(p.x - q.x, p.z - q.z) || 1;
    const ux = (p.x - q.x) / l, uz = (p.z - q.z) / l;
    const y = (end.top[1].y + end.top[2].y) / 2, g = groundY(p.x, p.z);
    landings.push(Object.freeze({ structureId: `ramp:${end.ramp}`, end: "to" as const, layerId: `expressway:${end.highway}`, patchId: end.patchId, seam: seamOf(end.top, "to"),
      x: p.x, z: p.z, outX: ux, outZ: uz, deckY: y, groundY: g, step: g === null ? null : y - g, status: "layered" as const }));
    const deckPatch = patchById.get(end.patchId);
    if (!deckPatch) continue;
    const ids = new Set<string>();
    for (let s = -0.25; s <= 3 + 1e-9; s += 0.5) for (let w = -end.half; w <= end.half + 1e-9; w += end.half / 4) {
      for (const id of groundPatchesAt(p.x - ux * s - uz * w, p.z - uz * s + ux * w)) ids.add(id);
    }
    for (const id of [...ids].sort()) portal(deckPatch, id, p);
  }

  const surface: CompiledCitySurface = Object.freeze({
    revision: "unpublished", geometryVersion: CITY_SURFACE_GEOMETRY_VERSION,
    patches: Object.freeze(patches), portals: Object.freeze([]), renderBatches: groundSnapshot.renderBatches,
    report: Object.freeze({ candidateLength: groundSnapshot.report.candidateLength, geometricallyEligibleLength: 0,
      issues: Object.freeze([...issues]) }),
  });
  const connections = buildLandingPortals({surface,landings},{...DEFAULT_LANDING_PORTAL_OPTIONS,aliasTolerance:tolerance});
  const proven = connections.status === "ready" ? connections.surface : surface;
  // Preserve candidates for entries inside ground patches, without asserting the
  // stronger facing-boundary proof. Regions and full-body motion revalidate them.
  const connectedSurface = Object.freeze({...proven,portals:Object.freeze([...proven.portals,...portals.filter((candidate)=>
    !proven.portals.some((p)=>p.fromPatch===candidate.fromPatch&&p.toPatch===candidate.toPatch))])});
  // Keep unsupported diagnostics for every closed/unresolved layered entry. A geometric
  // portal is not a vehicle release, and does not implicitly merge height-layer regions.
  const connectionIssues: SurfaceCompileIssue[] = connections.status !== "ready" || connections.decisions.some((d)=>d.status==="closed")
    ? [{source:{kind:"structure",id:"cross-layer-portals"},reason:"unsupported"}] : [];
  const publishedSurface: CompiledCitySurface = Object.freeze({...connectedSurface,
    report:Object.freeze({...connectedSurface.report,issues:Object.freeze([...issues,...connectionIssues])})});
  return Object.freeze({ surface: publishedSurface, ground, obstacles: compileStaticStructureObstacles(layout), landings: Object.freeze(landings),
    counts: Object.freeze({ bridges, expresswaySegments, flares: channel.flares.length, islands: channel.islands.length, culDeSacs: discs.length }) });
}

/** Authoritative landing connectivity: the deck just inside its end and the ground road just past it
 * must be the SAME drivable region under the region rules (the one-point step above is a diagnostic;
 * a flat deck over a sloping approach can measure aligned at its probe yet conflict elsewhere). */
export function landingConnectivity(compilation: CitySurfaceCompilation, regions: SurfaceRegionsBuild) {
  if (regions.status !== "ready") return compilation.landings.map((landing) => Object.freeze({ landing, connected: false, reason: "regions-unresolved" as const }));
  return compilation.landings.map((landing) => {
    const inside = regions.classify(landing.x - landing.outX * 1.5, landing.z - landing.outZ * 1.5, landing.layerId);
    const outside = regions.classify(landing.x + landing.outX * 1.5, landing.z + landing.outZ * 1.5, "ground");
    const connected = inside.status === "drivable" && outside.status === "drivable" && inside.regionId === outside.regionId;
    const reason = connected ? "connected" as const : inside.status !== "drivable" ? "deck-end-blocked" as const : outside.status !== "drivable" ? "ground-blocked" as const : "different-region" as const;
    return Object.freeze({ landing, connected, reason });
  });
}
