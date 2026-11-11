/** Pure structure descriptors shared by the road renderer and the driving surface.
 * CPU-only: no THREE, DOM, host or layout runtime (type-only CityLayout import).
 *
 * 桥面、高架、桁架、渠化口、尽端回车圈原来各自在 roadSystem 里边算边往 THREE 实例矩阵里写，
 * 驾驶要么另算一份（第二份几何，迟早与渲染分叉），要么凭 highways 折线补造路面（spec §3 明令禁止）。
 * 现在几何只在这里算一次：渲染按描述符原样组矩阵（有版本化渲染基线守卫），驾驶取同一描述符
 * 的 BOX 顶面——按实例的缩放、Euler 旋转（XYZ / YZX / YXZ，与 THREE.Euler 同公式）和平移变换，
 * 不按 deckHeights + 厚度猜曲面。护栏、桥墩、桁架是静态障碍，不是可行驶面。 */
import type { CityLayout, RoadEdge, Vec2 } from "../cityLayout";
import { renderRoadEdges } from "../cityRoadJunctions";
import { channelizedTPlan, type ChannelizedArm } from "../cityRoadPaint";
import { EXPRESSWAY_DECK_THICKNESS, EXPRESSWAY_DECK_WIDTH, EXPRESSWAY_DECK_Y, EXPRESSWAY_RAMP, expresswayDeckHeights } from "./structureProfiles";
import { terrainSurfaceHeight } from "./terrainSampling";
import { groundRoadClearance } from "./roadClearance";
import { platformAt, platformSurfaceAt, type PlatformLayout } from "./landmarkPlatforms";

/** Road surface lift (same constant as groundRoadCompiler.ROAD_SURFACE_LIFT; kept here to avoid a cycle). */
const ROAD_LIFT = 0.04;

export type EulerOrder = "XYZ" | "YZX" | "YXZ";
export type StructureRole = "bridge-deck" | "bridge-railing" | "bridge-lane-line" | "bridge-dash" | "bridge-pier"
  | "expressway-pier" | "expressway-deck" | "expressway-lane-line" | "expressway-rail" | "truss"
  | "ramp-deck" | "ramp-rail" | "ramp-lane-line" | "ramp-pier";
/** One unit-BOX instance (BOX = BoxGeometry(1,1,1) translated so its base is at local y=0). */
export type BoxPart = Readonly<{
  x: number; y: number; z: number; sx: number; sy: number; sz: number;
  rx: number; ry: number; rz: number; order: EulerOrder; color: string; role: StructureRole;
}>;
type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

/** Row-major rotation matrix, same formulas as THREE.Matrix4.makeRotationFromEuler. */
export function eulerMatrix(x: number, y: number, z: number, order: EulerOrder): Mat3 {
  const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y), e = Math.cos(z), f = Math.sin(z);
  if (order === "XYZ") {
    const ae = a * e, af = a * f, be = b * e, bf = b * f;
    return [c * e, -c * f, d, af + be * d, ae - bf * d, -b * c, bf - ae * d, be + af * d, a * c];
  }
  if (order === "YZX") {
    const ac = a * c, ad = a * d, bc = b * c, bd = b * d;
    return [c * e, bd - ac * f, bc * f + ad, f, a * e, -b * e, -d * e, ad * f + bc, ac - bd * f];
  }
  const ce = c * e, cf = c * f, de = d * e, df = d * f;
  return [ce + df * b, de * b - cf, a * d, a * f, a * e, -b, cf * b - de, df + ce * b, a * c];
}
/** World position of a local unit-BOX point (x,z ∈ [−½,½], y ∈ [0,1]). */
export function boxPoint(part: BoxPart, lx: number, ly: number, lz: number): { x: number; y: number; z: number } {
  const m = eulerMatrix(part.rx, part.ry, part.rz, part.order);
  const px = lx * part.sx, py = ly * part.sy, pz = lz * part.sz;
  return { x: part.x + m[0] * px + m[1] * py + m[2] * pz, y: part.y + m[3] * px + m[4] * py + m[5] * pz, z: part.z + m[6] * px + m[7] * py + m[8] * pz };
}
/** The eight corners (obstacle hull) of a BOX instance. */
export function boxCorners(part: BoxPart) {
  return [-0.5, 0.5].flatMap((lx) => [0, 1].flatMap((ly) => [-0.5, 0.5].map((lz) => boxPoint(part, lx, ly, lz))));
}
/** Drivable top face: local y = 1, laterally inset to `innerHalf` world units from the centreline. */
export function boxTopFace(part: BoxPart, innerHalf = part.sz / 2) {
  const lz = Math.min(0.5, innerHalf / part.sz);
  return [boxPoint(part, -0.5, 1, -lz), boxPoint(part, 0.5, 1, -lz), boxPoint(part, 0.5, 1, lz), boxPoint(part, -0.5, 1, lz)];
}

type Terrain = Pick<CityLayout, "terrain">["terrain"];
type BridgeLayoutInput = Pick<CityLayout, "terrain" | "extent" | "roadEdges"> & PlatformLayout;
const part = (x: number, y: number, z: number, sx: number, sy: number, sz: number, color: string, role: StructureRole, ry = 0, rz = 0, order: EulerOrder = "XYZ", rx = 0): BoxPart =>
  Object.freeze({ x, y, z, sx, sy, sz, rx, ry, rz, order, color, role });

/** Endpoints of ordinary (non-deck) render road edges, cached per road array. */
const groundEnds = new WeakMap<object, Vec2[]>();
function landsOnRoad(layout: BridgeLayoutInput, p: Vec2): boolean {
  if (!Array.isArray(layout.roadEdges)) return false; // no road data: nothing to land on (old level deck)
  let ends = groundEnds.get(layout.roadEdges);
  if (!ends) { ends = renderRoadEdges(layout.roadEdges).filter((e) => !e.bridge && e.structure !== "deck").flatMap((e) => [e.points[0], e.points[e.points.length - 1]]); groundEnds.set(layout.roadEdges, ends); }
  return ends.some((q) => Math.abs(q.x - p.x) < 0.01 && Math.abs(q.z - p.z) < 0.01);
}
/** Seam fit only where the road rises above the deck end by more than this. Elsewhere the deck is left
 * exactly as before — byte for byte — so only the seams that fail get a different deck. */
const SEAM_FIT_THRESHOLD = 0.08;
const NO_SEAM_FIT = Object.freeze({ dy: 0, dlean: 0 });
/**
 * 桥头接缝的横截面拟合（2026-10-22）：桥面末段是一块不能扭的箱体，端头取「中线贴路面、两侧取路面横坡」。
 * 陡岸上地形格（5.7–9.9）里的三角面折痕正好压在引道下，接缝横截面成 V 形（1703310796/2：中线 0.35、两侧 0.47 / 0.52），
 * 路面在桥面两侧冒出 0.12–0.23 > surfaceRegions 的 aliasTolerance 0.1——桥面与引道分属两个区域，车压到接缝即
 * ambiguous-region（30 个海滨规划里 3 座桥 4 个桥头，正是那 3 座「桥头过陡」的桥）。
 *
 * 判据是**单侧**的：桥面遮住比它低的地面（surfaceRegions：路面低于桥面不算冲突，1703294958/2 的 141.66 桥头桥面高出
 * 路面 0.19 照样连通），只有路面**高出**桥面才断开。第一版做对称（切比雪夫）拟合，把这座本来连通的桥头往下压，
 * 路面反冒出 0.117，接缝断开——修一个坏一个。
 *
 * 修法：只在接缝外伸带（桥面伸出节点 0.25 盖住路面的那条）里路面高出桥面超过 SEAM_FIT_THRESHOLD 时，扫一遍横坡取
 * 「路面减桥面」极差最小的一条，把端头抬到路面上包络（路面处处不高于桥面、上包络处恰好接上），以 dy / dlean 只加在
 * 该端的落地过渡区里。模型是箱体的真实几何：端头那段箱体的横坡是该段**中点**的横坡，纵坡是该段两端的高差；横向只取
 * 两块路面真正重叠的一段（bridgeDrivableHalf 与引道半宽取小）——取到桥宽边缘会把陡岸在路边骤降处也算进来。
 */
function seamFit(road: (p: Vec2) => number, lean: (p: Vec2) => number, end: Vec2, out: Vec2, nx: number, nz: number, half: number, section: number): { dy: number; dlean: number } {
  if (!(half > 0) || !(section > 0)) return NO_SEAM_FIT;
  const centre = road(end);
  const lean0 = lean({ x: end.x - out.x * section / 2, z: end.z - out.z * section / 2 });
  // 外伸带里桥面沿端头那段箱体的纵坡外推（落地过渡区内箱体两端跟着路面中线走）。
  const pitchOut = (centre - road({ x: end.x - out.x * section, z: end.z - out.z * section })) / section;
  const samples: Array<{ s: number; r: number }> = [];
  for (let i = 0; i <= 4; i++) {
    const a = 0.0625 * i;
    for (let j = 0; j <= 32; j++) {
      const s = -half + (2 * half * j) / 32;
      samples.push({ s, r: road({ x: end.x + out.x * a + nx * s, z: end.z + out.z * a + nz * s }) - centre - pitchOut * a });
    }
  }
  /** 路面减桥面（桥面横坡 b、端头不抬）的上下包络。 */
  const envelope = (b: number) => {
    let lo = Infinity, hi = -Infinity;
    for (const { s, r } of samples) { const e = r - b * s; if (e < lo) lo = e; if (e > hi) hi = e; }
    return { lo, hi };
  };
  if (envelope(lean0).hi <= SEAM_FIT_THRESHOLD) return NO_SEAM_FIT;
  let best = { b: lean0, ...envelope(lean0) };
  for (let k = -40; k <= 40; k++) {
    const b = lean0 + k * 0.005; const fit = envelope(b);
    if (fit.hi - fit.lo < best.hi - best.lo - 1e-12) best = { b, ...fit };
  }
  return { dy: best.hi, dlean: best.b - lean0 };
}
/** Half-width of the widest ordinary road that ends at p (0 if none). */
function landingRoadHalf(layout: BridgeLayoutInput, p: Vec2): number {
  if (!Array.isArray(layout.roadEdges)) return 0;
  let half = 0;
  for (const e of renderRoadEdges(layout.roadEdges)) {
    if (e.bridge || e.structure === "deck") continue;
    const a = e.points[0], b = e.points[e.points.length - 1];
    if ((Math.abs(a.x - p.x) < 0.01 && Math.abs(a.z - p.z) < 0.01) || (Math.abs(b.x - p.x) < 0.01 && Math.abs(b.z - p.z) < 0.01)) half = Math.max(half, e.width / 2);
  }
  return half;
}
/** Bridge deck top profile: each end that lands on a road meets the RENDERED road surface there
 * (terrain triangulation + road lift); an end with no road keeps the landed end's height (an end
 * over open water must not dip into it); with no landing at all the old level deck remains.
 * 曾是一块平板，顶面取两岸 terrain.height 真值的较大者：低岸一端高出引道 0.1–1.1，引道坡度又可达 ~6°，
 * 桥头路面不是戳出桥面就是一道台阶（十五城 28 座桥没有一座两端都接得上）。 */
export function bridgeDeckProfile(layout: BridgeLayoutInput, from: Vec2, to: Vec2, width = 0, levelFloor = -Infinity) {
  const level = Math.max(levelFloor, layout.terrain.height(from.x, from.z), layout.terrain.height(to.x, to.z));
  // 落地：接到普通路面的路端，或落进可行驶的地标平台（海上歌剧院 / 机场岛，landmarkPlatforms）。
  // 平台端的「路面」是平台顶面（平的），桥面落到它上面；曾经平台不算落地，桥面停在半空、尽头加横栏。
  const padFrom = platformAt(layout, from.x, from.z), padTo = platformAt(layout, to.x, to.z);
  const fromLands = landsOnRoad(layout, from) || padFrom !== null;
  const toLands = landsOnRoad(layout, to) || padTo !== null;
  const road = (p: Vec2) => terrainSurfaceHeight(layout, p.x, p.z) + ROAD_LIFT;
  const length = Math.hypot(to.x - from.x, to.z - from.z);
  // Cross slope: the landed road surfaces lean sideways; a level-across deck left their edges
  // 0.11–0.15 above it. A box cannot twist, so it takes the mean lean of its landed ends.
  const nx = -(to.z - from.z) / length; const nz = (to.x - from.x) / length; const half = width / 2;
  const lean = (p: Vec2) => half > 0 ? (road({ x: p.x + nx * half, z: p.z + nz * half }) - road({ x: p.x - nx * half, z: p.z - nz * half })) / width : 0;
  // 端头那段箱体的长度 = 落地过渡区按 0.5 切出的一格（bridgeDeckSplitParts 的 blendSteps）。
  const blendLength = Math.min(3, length / 3); const section = blendLength / Math.max(1, Math.ceil(blendLength / 0.5));
  // 平台端：平台路面从桥端一直伸到桥下——堤道斜着进平台时伸得更远（42/2 的机场堤道：平台在桥下 8 以上）。
  // 桥面在整段重叠上必须平贴平台（同层：桥下高出 / 低于平台都会让两块路面分属两个区域，车压到交界即
  // ambiguous-region），过了重叠再用一个普通落地区缓回跨中的弦。只看平台，不采样平台外的海底地形。
  const padFlat = (pad: typeof padFrom, end: Vec2, inward: Vec2) => {
    if (!pad) return 0;
    let covered = 0;
    for (let d = 0; d <= length; d += 0.5) {
      const cx = end.x + inward.x * d, cz = end.z + inward.z * d;
      if ([0, -1, 1].some((k) => pad.contains(cx + nx * half * k, cz + nz * half * k))) covered = d + 0.5;
    }
    return covered;
  };
  const flatFrom = padFlat(padFrom, from, { x: (to.x - from.x) / length, z: (to.z - from.z) / length });
  const flatTo = padFlat(padTo, to, { x: (from.x - to.x) / length, z: (from.z - to.z) / length });
  // 平台端落地区取 0.5 的整数倍：落地区每 0.5 一刀，非整倍时末刀与跨中刀挨得极近，切出 0.01 长的护栏碎段
  // （seed 7 的歌剧院堤道：退化箱体，碰撞索引 invalid-input）。
  const halfSteps = (v: number) => Math.max(0.5, Math.floor(v / 0.5) * 0.5);
  const zoneFrom = padFrom ? halfSteps(Math.min(flatFrom + 3, length / 2)) : blendLength;
  const zoneTo = padTo ? halfSteps(Math.min(flatTo + 3, length / 2)) : blendLength;
  const surfaceOf = (pad: typeof padFrom) => (p: Vec2) => pad ? pad.y : road(p);
  const leanOf = (pad: typeof padFrom) => (p: Vec2) => pad ? 0 : lean(p);
  const overlapHalf = (p: Vec2) => Math.min(half - 0.3, landingRoadHalf(layout, p)); // = bridgeDrivableHalf ∩ 引道
  const fitFrom = fromLands && !padFrom ? seamFit(road, lean, from, { x: -(to.x - from.x) / length, z: -(to.z - from.z) / length }, nx, nz, overlapHalf(from), section) : NO_SEAM_FIT;
  const fitTo = toLands && !padTo ? seamFit(road, lean, to, { x: (to.x - from.x) / length, z: (to.z - from.z) / length }, nx, nz, overlapHalf(to), section) : NO_SEAM_FIT;
  const ya = fromLands ? surfaceOf(padFrom)(from) + fitFrom.dy : toLands ? surfaceOf(padTo)(to) + fitTo.dy : level;
  const yb = toLands ? surfaceOf(padTo)(to) + fitTo.dy : fromLands ? surfaceOf(padFrom)(from) + fitFrom.dy : level;
  const pitch = Math.atan2(yb - ya, length);
  const leans = [fromLands ? leanOf(padFrom)(from) + fitFrom.dlean : null, toLands ? leanOf(padTo)(to) + fitTo.dlean : null].filter((v): v is number => v !== null);
  const crossSlope = leans.length ? leans.reduce((n, v) => n + v, 0) / leans.length : 0;
  const leanFrom = fromLands ? leanOf(padFrom)(from) + fitFrom.dlean : crossSlope, leanTo = toLands ? leanOf(padTo)(to) + fitTo.dlean : crossSlope;
  // A bridge end can overlap the road's junction fan for up to LANDING_ZONE. A single plane
  // between the endpoint heights then sits below the rising ground fan (notably on steep banks),
  // making the same-layer road/deck pair disconnected. Follow the rendered terrain surface only
  // within a bounded landing zone, then ease back to the span chord. No-ground ends keep the old
  // chord and never sample the terrain profile. A platform end stays flat over the platform first.
  const falloff = (distance: number, zone: number, flat: number) => {
    if (distance <= flat) return 1;
    const t = Math.max(0, Math.min(1, (distance - flat) / (zone - flat)));
    return 1 - t * t * (3 - 2 * t);
  };
  const baseAt = (t: number) => ya + (yb - ya) * t;
  const baseLeanAt = (t: number) => leanFrom + (leanTo - leanFrom) * t;
  const positionAt = (t: number) => ({ x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t });
  // The seam fit (if any) of the end whose landing zone t lies in rides on top of the road profile.
  const endAt = (t: number) => {
    const distance = Math.max(0, Math.min(length, t * length));
    if (fromLands && distance < zoneFrom) return { blend: falloff(distance, zoneFrom, flatFrom), fit: fitFrom, surface: surfaceOf(padFrom), lean: leanOf(padFrom) };
    if (toLands && length - distance < zoneTo) return { blend: falloff(length - distance, zoneTo, flatTo), fit: fitTo, surface: surfaceOf(padTo), lean: leanOf(padTo) };
    return null;
  };
  const at = (t: number) => {
    const base = baseAt(t), end = endAt(t);
    if (!end || end.blend === 0) return base;
    const p = positionAt(t);
    return base + (end.surface(p) + end.fit.dy - base) * end.blend;
  };
  const leanAt = (t: number) => {
    const base = baseLeanAt(t), end = endAt(t);
    if (!end || end.blend === 0) return base;
    return base + (end.lean(positionAt(t)) + end.fit.dlean - base) * end.blend;
  };
  return Object.freeze({ ya, yb, length, pitch, crossSlope, leanFrom, leanTo, fromLands, toLands, blendLength, blendFrom: zoneFrom, blendTo: zoneTo,
    onPlatform: padFrom !== null || padTo !== null,
    slant: Math.hypot(length, yb - ya), at, leanAt });
}
/** Edge bridge (straight span): deck slab, railings, lane lines, dashes, piers — the parts
 * buildInfrastructure draws, in its order, all standing on the slab's actual top face. */
export function bridgeDeckParts(edge: RoadEdge, layout: BridgeLayoutInput): BoxPart[] {
  const [a,b]=edge.points,profile=bridgeDeckProfile(layout,a,b,edge.width);
  const change=Math.abs(profile.leanTo-profile.leanFrom)*edge.width;
  const needsProfileSections = profile.fromLands || profile.toLands;
  const parts: BoxPart[] = trimLandedRailings(edge, layout, needsProfileSections || change>0.08 ? bridgeDeckSplitParts(edge,layout,profile) : bridgeDeckSectionParts(edge,layout,profile));
  appendDeadEndBarriers(edge, layout, parts, profile);
  return parts;
}

/** Railing centreline must stay this far outside every ground carriageway (railings are 0.3 wide). */
export const RAILING_ROAD_CLEARANCE = 0.2;
/** 落地端护栏退让（2026-10-19）：护栏铺满整个桥面（还随桥面板外伸 0.25），而桥头节点上的地面路从桥端直接分出——
 * 0/7 的 115.26:-210.98/409.02:-210.98 桥头有一条 12 宽、96.5° 折返的引道，它的车道盖住了 +z 侧护栏最后约 6，
 * 出生路线在这里转弯时车身扫上护栏（continuous-collision:prefix:solid）。占路诊断按角色跳过 bridge-railing，
 * 所以一直没报。现按与道路编译器相同的地面路面（渲染边 + 路口扇面，groundRoadClearance）逐侧从落地端向内
 * 0.5 一步退，直到护栏线离路面 ≥ RAILING_ROAD_CLEARANCE，最多退到 1/3 跨。只看落地端：桥下穿过的地面路
 * 在 XZ 上也「相交」，不能因此剪掉跨中护栏。 */
function trimLandedRailings(edge: RoadEdge, layout: BridgeLayoutInput, parts: BoxPart[]): BoxPart[] {
  const [a, b] = edge.points;
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  if (!(len > 0) || !Array.isArray(layout.roadEdges)) return parts;
  const ux = (b.x - a.x) / len, uz = (b.z - a.z) / len, nx = -uz, nz = ux;
  const lateral = edge.width / 2 - 0.15;
  const clear = (s: number, side: number) => groundRoadClearance(layout.roadEdges, a.x + ux * s + nx * side * lateral, a.z + uz * s + nz * side * lateral) >= RAILING_ROAD_CLEARANCE;
  const setback = (fromA: boolean, side: number) => {
    if (!landsOnRoad(layout, fromA ? a : b)) return 0;
    let sb = 0; while (sb < len / 3 && !clear(fromA ? sb : len - sb, side)) sb += 0.5;
    return Math.min(sb, len / 3);
  };
  const range = new Map([-1, 1].map((side) => [side, [setback(true, side), len - setback(false, side)]] as const));
  const out: BoxPart[] = [];
  for (const p of parts) {
    if (p.role !== "bridge-railing") { out.push(p); continue; }
    const e0 = boxPoint(p, -0.5, 0, 0), e1 = boxPoint(p, 0.5, 0, 0);
    const s0 = (e0.x - a.x) * ux + (e0.z - a.z) * uz, s1 = (e1.x - a.x) * ux + (e1.z - a.z) * uz;
    const side = ((p.x - a.x) * nx + (p.z - a.z) * nz) >= 0 ? 1 : -1;
    const [lo, hi] = range.get(side)!;
    if (Math.min(s0, s1) >= lo && Math.max(s0, s1) <= hi) { out.push(p); continue; }
    // Local fraction along the part's own axis for an along-span distance (e0 ↔ −0.5, e1 ↔ +0.5).
    const frac = (s: number) => -0.5 + (s - s0) / (s1 - s0);
    const f0 = Math.max(-0.5, Math.min(frac(lo), frac(hi))), f1 = Math.min(0.5, Math.max(frac(lo), frac(hi)));
    if ((f1 - f0) * p.sx < 0.3) continue;
    const c = boxPoint(p, (f0 + f1) / 2, 0, 0);
    out.push(part(c.x, c.y, c.z, p.sx * (f1 - f0), p.sy, p.sz, p.color, p.role, p.ry, p.rz, p.order, p.rx));
  }
  return out;
}

/** A rigid slab cannot meet opposite bank leans. Short overlapping slabs
 * distribute the roll change; the worst lateral seam step is bounded by 0.02. */
function bridgeDeckSplitParts(edge: RoadEdge, layout: BridgeLayoutInput, profile: ReturnType<typeof bridgeDeckProfile>): BoxPart[] {
  const [a,b]=edge.points;
  const roll=Math.abs(profile.leanTo-profile.leanFrom)*edge.width;
  const count=Math.min(256,Math.max(2,Math.ceil(profile.length/8),Math.ceil(roll/0.04)));
  const stations = new Set(Array.from({ length: count + 1 }, (_, i) => i / count));
  // 落地区每 0.5 一刀（平台端的落地区更长：平贴平台的整段 + 普通落地区）。普通路端与以前逐刀相同。
  const stepsFrom = Math.ceil(profile.blendFrom / 0.5), stepsTo = Math.ceil(profile.blendTo / 0.5);
  if (profile.fromLands) for (let i = 0; i <= stepsFrom; i++) stations.add((profile.blendFrom * i / stepsFrom) / profile.length);
  if (profile.toLands) for (let i = 0; i <= stepsTo; i++) stations.add(1 - (profile.blendTo * i / stepsTo) / profile.length);
  const sortedStations = [...stations].sort((x, y) => x - y);
  const cuts: number[] = [];
  // 落在平台上的桥：落地区很长，与跨中刀（每 ≤ 8）挨近的刀合并（< 0.1 的段是碎片，护栏成退化箱体）。
  // 普通路对路桥保持原门槛，逐字节不变。
  const minSection = profile.onPlatform ? 0.1 : 1e-6;
  for (const t of sortedStations) {
    if (!cuts.length || (t - cuts[cuts.length - 1]) * profile.length > minSection) cuts.push(t);
    else if (t === 1) cuts[cuts.length - 1] = 1;
  }
  const parts:BoxPart[]=[];
  for(let i=0;i<cuts.length-1;i++){
    const t0=cuts[i],t1=cuts[i+1],point=(t:number)=>({x:a.x+(b.x-a.x)*t,z:a.z+(b.z-a.z)*t});
    const ya=profile.at(t0),yb=profile.at(t1),length=profile.length*(t1-t0);
    const crossSlope=profile.leanAt((t0+t1)/2);
    parts.push(...bridgeDeckSectionParts({...edge,points:[point(t0),point(t1)]},layout,
      {...profile,ya,yb,length,crossSlope,pitch:Math.atan2(yb-ya,length),leanFrom:profile.leanAt(t0),leanTo:profile.leanAt(t1),slant:Math.hypot(length,yb-ya),at:(t:number)=>ya+(yb-ya)*t}).filter(p=>p.role!=="bridge-pier"));
  }
  parts.push(...bridgeDeckSectionParts(edge,layout,profile).filter(p=>p.role==="bridge-pier"));
  return parts;
}

/** 断头端封闭（视觉诚实化，2026-10-18）：无接地引道的桥端在桥面尽头加一道横栏。
 * 视觉不再承诺一条驾驶面拒绝的引道；compileSurface 把 bridge-railing 转成固体障碍，
 * 碰撞层把车挡在驾驶面真实的终点——两层说同一句话（演示城悬索桥 to 端 no-ground 实测）。 */
function appendDeadEndBarriers(edge: RoadEdge, layout: BridgeLayoutInput, parts: BoxPart[], profile: ReturnType<typeof bridgeDeckProfile>): void {
  const [a, b] = edge.points;
  const yaw = -Math.atan2(b.z - a.z, b.x - a.x);
  for (const end of [a, b] as const) {
    if (landsOnRoad(layout, end) || platformSurfaceAt(layout, end.x, end.z) !== null) continue;
    parts.push(part(end.x, profile.at(end === a ? 0 : 1) + 0.45, end.z, 0.3, 0.9, Math.max(1, edge.width - 0.6), "#b9bcb2", "bridge-railing", yaw));
  }
}
function bridgeDeckSectionParts(edge: RoadEdge, layout: BridgeLayoutInput, profile: ReturnType<typeof bridgeDeckProfile>): BoxPart[] {
  const parts: BoxPart[] = [];
  const [a, b] = edge.points;
  const { length, pitch } = profile;
  const yaw = -Math.atan2(b.z - a.z, b.x - a.x);
  // Roll about the span axis (local x, applied first in YZX) so +lateral (local +z) rises by crossSlope.
  // Local +z maps to (sin yaw, cos yaw) = the deck's +n side used by the profile (n = (−uz, ux)).
  // Rx(roll) turns local +z toward −y for roll > 0, so the +n side rises by crossSlope at roll = −atan.
  const roll = -Math.atan(profile.crossSlope);
  const x = (a.x + b.x) / 2; const z = (a.z + b.z) / 2; const yTop = profile.at(0.5);
  // Slab: place it so its top-face centre is exactly on the profile at mid-span.
  const draft = part(0, 0, 0, profile.slant + 0.5, 0.4, edge.width, "#6a7071", "bridge-deck", yaw, pitch, "YZX", roll);
  const top0 = boxPoint(draft, 0, 1, 0);
  const slab = part(x - top0.x, yTop - top0.y, z - top0.z, profile.slant + 0.5, 0.4, edge.width, "#6a7071", "bridge-deck", yaw, pitch, "YZX", roll);
  parts.push(slab);
  /** A part standing on the slab top at along-fraction t (0 = from end, 1 = to end) and lateral offset w. */
  const onDeck = (t: number, w: number, lift: number, sx: number, sy: number, sz: number, color: string, role: StructureRole) => {
    const p = boxPoint(slab, ((t - 0.5) * profile.slant) / (profile.slant + 0.5), 1, w / edge.width);
    return part(p.x, p.y + lift, p.z, sx, sy, sz, color, role, yaw, pitch, "YZX", roll);
  };
  for (const side of [-1, 1]) {
    // Lateral sign: the old code offset by (sin yaw, cos yaw)·offset, i.e. local +z.
    parts.push(onDeck(0.5, side * (edge.width / 2 - 0.15), 0, profile.slant, 0.65, 0.3, "#b9bcb2", "bridge-railing"));
    parts.push(onDeck(0.5, side * (edge.width / 2 - 0.65), 0.015, profile.slant, 0.025, 0.12, "#e4dfc9", "bridge-lane-line"));
  }
  for (let distance = 2; distance < length - 1; distance += 6) {
    const t = (distance + 1) / length;
    parts.push(onDeck(t, 0, 0.015, Math.min(2, length - distance), 0.025, 0.14, "#dfd1a5", "bridge-dash"));
  }
  for (let distance = 16; distance < length - 12; distance += 32) {
    const t = distance / length;
    const px = a.x + (b.x - a.x) * t; const pz = a.z + (b.z - a.z) * t;
    const bed = layout.terrain.height(px, pz);
    // The pier top is flat but the slab is rolled to the (interpolated) bank lean: on the low side the slab
    // underside drops by lean × half-width. A centreline top poked through the deck on rolled/split bridges
    // (7/1: 1.58 above the carriageway — road obstruction guard).
    const lean = Number.isFinite(profile.leanFrom) && Number.isFinite(profile.leanTo) ? profile.leanFrom + (profile.leanTo - profile.leanFrom) * t : profile.crossSlope;
    const drop = Math.max(Math.abs(lean), Math.abs(profile.crossSlope)) * (edge.width - 0.6) / 2;
    parts.push(part(px, bed, pz, 1.6, Math.max(0.1, profile.at(t) - 0.35 - drop - bed), edge.width - 0.6, "#a9aaa0", "bridge-pier", yaw));
  }
  return parts;
}
/** Railing inner face, measured from the deck centreline (railings are 0.3 wide at width/2 − 0.15). */
export const bridgeDrivableHalf = (edge: RoadEdge) => edge.width / 2 - 0.3;

/** Rendered road-surface top at a point that lies on an ordinary ground road (within half its
 * width of a non-bridge render edge), else null. Expressway ramp ends land on it. */
export function groundRoadTopAt(layout: BridgeLayoutInput, x: number, z: number): number | null {
  if (!Array.isArray(layout.roadEdges) || !Number.isFinite(layout.extent)) return null;
  for (const edge of renderRoadEdges(layout.roadEdges)) {
    if (edge.bridge || edge.structure === "deck") continue;
    for (let i = 1; i < edge.points.length; i += 1) {
      const a = edge.points[i - 1]; const b = edge.points[i];
      const dx = b.x - a.x; const dz = b.z - a.z; const ll = dx * dx + dz * dz;
      const t = ll === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / ll));
      if (Math.hypot(x - a.x - dx * t, z - a.z - dz * t) <= edge.width / 2) return terrainSurfaceHeight(layout, x, z) + ROAD_LIFT;
    }
  }
  return null;
}
/** Longest deck piece inside a ramp zone: the eased ramp profile is sampled at least this densely. */
export const EXPRESSWAY_RAMP_PIECE = 10;
type ExpresswayLayout = Pick<CityLayout, "terrain"> & Partial<Pick<CityLayout, "extent" | "roadEdges">>;
/** The drawn expressway run: polyline segments that reach into a ramp zone are split into ≤ RAMP_PIECE
 * collinear pieces, and each point gets its deck-bottom height (ends landed on the rendered road).
 * Renderer, night lamps and the driving surface all read this one run.
 * 规划给的高架在两端各有一条 137–280 长的单段支线，与环线成 ~30° 锐角汇入。只按折线点取高时 ease
 * 剖面一次也没被采样：支线是一整块直坡板，汇入处比环线桥面低 0.6–1.1、从侧面插进环线板里，
 * 驾驶面因此在汇入楔形区高差冲突，上了匝道也到不了桥面。 */
export function expresswayRun(layout: ExpresswayLayout, run: ReadonlyArray<{ x: number; z: number }>): { points: Vec2[]; heights: number[] } {
  const closed = run.length > 1 && Math.hypot(run[0].x - run[run.length - 1].x, run[0].z - run[run.length - 1].z) < 0.01;
  let total = 0; for (let i = 1; i < run.length; i += 1) total += Math.hypot(run[i].x - run[i - 1].x, run[i].z - run[i - 1].z);
  const points: Vec2[] = run.length ? [{ x: run[0].x, z: run[0].z }] : [];
  let along = 0;
  for (let i = 1; i < run.length; i += 1) {
    const a = run[i - 1]; const b = run[i]; const length = Math.hypot(b.x - a.x, b.z - a.z);
    const inRamp = !closed && (along < EXPRESSWAY_RAMP || along + length > total - EXPRESSWAY_RAMP);
    const pieces = inRamp ? Math.max(1, Math.ceil(length / EXPRESSWAY_RAMP_PIECE)) : 1;
    for (let k = 1; k < pieces; k += 1) points.push({ x: a.x + (b.x - a.x) * (k / pieces), z: a.z + (b.z - a.z) * (k / pieces) });
    points.push({ x: b.x, z: b.z });
    along += length;
  }
  const hold = closed || points.length < 2 ? { from: 0, to: 0 } : { from: rampHold(layout, points), to: rampHold(layout, [...points].reverse()) };
  const heights = points.length ? expresswayDeckHeights(points, (x, z) => layout.terrain.height(x, z), (x, z) => groundRoadTopAt(layout as BridgeLayoutInput, x, z), hold) : [];
  return { points, heights };
}

/** Longest flush stretch a ramp end may hold at road height before it starts to climb. */
export const EXPRESSWAY_RAMP_HOLD_MAX = 24;
/** 匝道分岔贴路段（2026-10-19）：0/42 的高架 0 从路口 50.63:-73.24 起步，与 5 宽路成约 25° 分出，
 * 按 ease 剖面头 8 就比路面高 0.12–0.2（> aliasTolerance）。车沿路走被支撑抬上桥面（取较高面），到分岔处桥面
 * 侧边是 closed，挡住——出生路线 pilot-failed。现量出从落地端起、桥面侧边（±可驶半宽）仍压在一条「中线不在其上」
 * 的地面路里的最远沿程，在这段内桥面保持路面高度（与路面差 ≤ aliasTolerance，侧边按区域规则开放），过了才爬升。
 * 沿宿主路落地的匝道中线与侧边在同一条路上，hold = 0，不受影响。上限 EXPRESSWAY_RAMP_HOLD_MAX，爬升坡度
 * 最多从 1.5·Δh/90 变到 1.5·Δh/66。 */
function rampHold(layout: ExpresswayLayout, points: readonly Vec2[]): number {
  if (!Array.isArray(layout.roadEdges)) return 0;
  const roads = renderRoadEdges(layout.roadEdges).filter((e) => !e.bridge && e.structure !== "deck");
  const inside = (x: number, z: number) => {
    const ids = new Set<string>();
    for (const e of roads) for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1], b = e.points[i], dx = b.x - a.x, dz = b.z - a.z, ll = dx * dx + dz * dz;
      const t = ll === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / ll));
      if (Math.hypot(x - a.x - dx * t, z - a.z - dz * t) <= e.width / 2) { ids.add(e.id); break; }
    }
    return ids;
  };
  let hold = 0, along = 0;
  for (let i = 1; i < points.length && along < EXPRESSWAY_RAMP_HOLD_MAX; i++) {
    const a = points[i - 1], b = points[i], length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < 1e-6) continue;
    const ux = (b.x - a.x) / length, uz = (b.z - a.z) / length;
    for (let s = 0; s <= length && along + s <= EXPRESSWAY_RAMP_HOLD_MAX; s += 0.5) {
      const cx = a.x + ux * s, cz = a.z + uz * s; const centre = inside(cx, cz);
      for (const side of [-1, 1]) {
        const hits = inside(cx - uz * side * EXPRESSWAY_DRIVABLE_HALF, cz + ux * side * EXPRESSWAY_DRIVABLE_HALF);
        if ([...hits].some((id) => !centre.has(id))) hold = along + s;
      }
    }
    along += length;
  }
  return hold;
}

export type ExpresswayPiece = BoxPart & Readonly<{ highway: number; segment: number }>;
/** A portal bent leaves the full ground-road corridor between its columns. Support stations
 * may move along the same deck to avoid crossing roads; the cap stays above vehicle clearance.
 * These are real boxes shared by rendering and collision, never collision-only exclusions. */
function expresswaySupport(layout: ExpresswayLayout, points: Vec2[], heights: number[], station: number): BoxPart[] {
  type Corridor = { a: Vec2; b: Vec2; half: number; ya?: number; yb?: number };
  // Include junction shoulders and other expressway ramps: a column clear of the ground
  // centreline can otherwise emerge through a neighbouring, lower ramp.
  const roads: Corridor[] = renderRoadEdges(layout.roadEdges ?? []).filter(e => !e.bridge && e.structure !== "deck")
    .flatMap(e => e.points.slice(1).map((b, i) => ({ a: e.points[i], b, half: e.width / 2 + 1.5 })));
  for (const run of (layout as Partial<Pick<CityLayout,"highways">>).highways ?? []) {
    const other = expresswayRun(layout, run);
    other.points.slice(1).forEach((b,i) => roads.push({a:other.points[i],b,half:EXPRESSWAY_DECK_WIDTH/2,
      ya:other.heights[i]+EXPRESSWAY_DECK_THICKNESS,yb:other.heights[i+1]+EXPRESSWAY_DECK_THICKNESS}));
  }
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  const distance = (x: number, z: number, a: Vec2, b: Vec2) => {
    const dx = b.x - a.x, dz = b.z - a.z, ll = dx * dx + dz * dz;
    const t = ll > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / ll)) : 0;
    return { gap: Math.hypot(x - a.x - t * dx, z - a.z - t * dz), x: a.x + t * dx, z: a.z + t * dz, t };
  };
  let fallback: BoxPart[] = [];
  for (const offset of [4.65, 6.65, 8.65, 10.65, 12.65]) for (const shift of [0, -4, 4, -8, 8, -12, 12, -16, 16, -24, 24, -34, 34]) {
    const at = station + shift;
    if (at < 0 || at > lengths[lengths.length - 1]) continue;
    let i = 1; while (i < lengths.length - 1 && lengths[i] < at) i++;
    if (!points[i] || lengths[i] - lengths[i - 1] < 6) continue;
    const a = points[i - 1], b = points[i], length = lengths[i] - lengths[i - 1], t = (at - lengths[i - 1]) / length;
    const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    const nx = -(b.z - a.z) / length, nz = (b.x - a.x) / length, yaw = -Math.atan2(b.z - a.z, b.x - a.x);
    // Match the underside of the tilted slab at this station, including its lateral edge.
    const top = heights[i - 1] + (heights[i] - heights[i - 1]) * t + 0.05;
    const capHeight = 0.65, width = 1.1, depth = 1.8;
    const columns = [-offset, offset].map(side => {
      const cx = x + nx * side, cz = z + nz * side, ground = Math.max(-3, layout.terrain.height(cx, cz));
      return part(cx, ground, cz, depth, top - capHeight - ground, width, "#a9aaa0", "expressway-pier", yaw, 0, "YZX");
    });
    if (columns.some(c => c.sy < 0.85)) continue;
    const cap = part(x, top - capHeight, z, depth, capHeight, 2 * offset + width, "#a9aaa0", "expressway-pier", yaw, 0, "YZX");
    const support = [...columns, cap];
    if (!fallback.length) fallback = support;
    const radius = Math.hypot(depth, width) / 2 + 0.3;
    const roadTop = (r: Corridor, q: ReturnType<typeof distance>) => r.ya === undefined
      ? (Number.isFinite(layout.extent) ? terrainSurfaceHeight(layout as BridgeLayoutInput,q.x,q.z) : layout.terrain.height(q.x,q.z))+ROAD_LIFT
      : r.ya+(r.yb!-r.ya)*q.t;
    if (columns.some(c => roads.some(r => {
      const q=distance(c.x,c.z,r.a,r.b), y=roadTop(r,q);
      return q.gap<=r.half+radius && c.y<y+1.5 && c.y+c.sy>y-0.05;
    }))) continue;
    // Conservative cap bounding circle: if it can cover a road, preserve 1.5 units headroom.
    const capRadius = Math.hypot(depth, cap.sz) / 2;
    if (roads.some(r => {
      const q = distance(x, z, r.a, r.b);
      const y=roadTop(r,q);
      return q.gap <= r.half + capRadius && cap.y < y + 1.5 && top > y - 0.05;
    })) continue;
    return support;
  }
  // No road-free station: no support here (the span runs on to the next pier). A fallback support stood
  // on a road under a low ramp — its 1.0-high crossbeam blocked every car (0/42, 90/42); the deck itself
  // left room to drive under. Kept as a reference for diagnostics only.
  void fallback;
  return [];
}
/** District expressways: piers, then per segment deck + lane lines + rails (buildDistrictExpressways order).
 * Segments shorter than 6 are not drawn — and therefore not driveable. */
export function expresswayPieces(layout: Pick<CityLayout, "highways" | "terrain"> & Partial<Pick<CityLayout, "extent" | "roadEdges" | "highwayRamps">>): ExpresswayPiece[] {
  const pieces: ExpresswayPiece[] = [];
  // 匝道合流口：主桥护栏与匝道分流段（前 40%）相交的 6 单位护栏片不画，否则匝道接上桥面后被护栏横截。
  // 与 rampRailRuns（高架两端落地处贴近地面路的开口）是两回事，两者叠加。
  const mergeHeads = (layout.highwayRamps ?? []).map((ramp) => ({ width: ramp.width, points: ramp.points.slice(0, Math.ceil(ramp.points.length * 0.4) + 1) }));
  const nearSegment = (p: Vec2, a: Vec2, b: Vec2) => {
    const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
    const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
    return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
  };
  const merging = (from: Vec2, to: Vec2) => mergeHeads.some((ramp) => ramp.points.some((point) => nearSegment(point, from, to) < ramp.width / 2 + 0.5));
  /** rampRailRuns 给出的护栏区间再扣掉匝道合流口：区间按 ≤6 单位分片，相交的片丢掉。 */
  const mergeRuns = (runs: Array<[number, number]>, a: Vec2, b: Vec2, ox: number, oz: number, length: number): Array<[number, number]> => {
    if (!mergeHeads.length) return runs;
    const at = (t: number) => ({ x: a.x + (b.x - a.x) * t + ox, z: a.z + (b.z - a.z) * t + oz });
    const out: Array<[number, number]> = [];
    for (const [t0, t1] of runs) {
      const steps = Math.max(1, Math.ceil(((t1 - t0) * length) / 6));
      for (let k = 0; k < steps; k += 1) {
        const s0 = t0 + ((t1 - t0) * k) / steps, s1 = t0 + ((t1 - t0) * (k + 1)) / steps;
        if (!merging(at(s0), at(s1))) out.push([s0, s1]);
      }
    }
    return out;
  };
  (layout.highways ?? []).forEach((run, highway) => {
    const push = (p: BoxPart, segment: number) => pieces.push(Object.freeze({ ...p, highway, segment }));
    const { points, heights } = expresswayRun(layout, run);
    // Piers every ~34 units by mileage, anchored into the terrain or riverbed
    // (over water the pier reaches below the surface — a real bridge span).
    let accumulated = 0;
    let nextPier = 0;
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      if (index > 0) accumulated += Math.hypot(point.x - points[index - 1].x, point.z - points[index - 1].z);
      if (accumulated >= nextPier) {
        nextPier = accumulated + 34;
        const groundY = Math.max(-3, layout.terrain.height(point.x, point.z));
        // 墩顶止于桥面底面（咬合 0.05）。BOX 以底面为原点：y 是墩底而不是中心。
        const pierTop = heights[index] + 0.05;
        if (pierTop - groundY < 1.5) continue; // 匝道落地段不需要桥墩
        for (const support of expresswaySupport(layout, points, heights, accumulated)) push(support, -1);
      }
    }
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1];
      const b = points[index];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      // Exit curves contain valid short segments; omitting them opens holes in
      // both the rendered deck and its shared collision/support geometry.
      if (length < 1e-3) continue;
      const yaw = -Math.atan2(b.z - a.z, b.x - a.x);
      const mx = (a.x + b.x) / 2;
      const mz = (a.z + b.z) / 2;
      const ya = heights[index - 1];
      const yb = heights[index];
      const my = (ya + yb) / 2;
      const pitch = Math.atan2(yb - ya, length);
      const slant = Math.hypot(length, yb - ya);
      const top = my + EXPRESSWAY_DECK_THICKNESS;
      push(part(mx, my, mz, slant + 0.5, EXPRESSWAY_DECK_THICKNESS, EXPRESSWAY_DECK_WIDTH, "#6a7071", "expressway-deck", yaw, pitch, "YZX"), index);
      const sideX = Math.sin(yaw);
      const sideZ = Math.cos(yaw);
      for (const offset of [-3.6, 0, 3.6]) push(part(mx + sideX * offset, top, mz + sideZ * offset, slant, 0.05, 0.3, "#c6c6bb", "expressway-lane-line", yaw, pitch, "YZX"), index);
      for (const offset of [-5.1, 5.1]) for (const [t0, t1] of mergeRuns(rampRailRuns(layout, a, b, ya, yb, sideX * offset, sideZ * offset, length), a, b, sideX * offset, sideZ * offset, length)) {
        const tm = (t0 + t1) / 2;
        push(part(a.x + (b.x - a.x) * tm + sideX * offset, ya + (yb - ya) * tm + EXPRESSWAY_DECK_THICKNESS, a.z + (b.z - a.z) * tm + sideZ * offset,
          slant * (t1 - t0), 0.55, 0.3, "#b9bcb2", "expressway-rail", yaw, pitch, "YZX"), index);
      }
    }
  });
  return pieces;
}
/** 立交匝道（planner/highwayRamps.ts）的共享几何（2026-10-20）：渲染、驾驶面、碰撞读同一份。曾只在
 * roadSystem.buildHighwayRamps 里画盒子——驾驶世界里没有它：车开不上匝道，也会径直穿过匝道末端与墩柱。
 * 高度：匝道起点压在所属高架中线上、与桥面同高（EXPRESSWAY_DECK_Y，立交只建在完全抬起的路段）；整个横截面
 * 离开主桥幅后才沿剩余路程 smoothstep 降下。落地端对齐渲染路面顶（groundRoadTopAt），否则 T 口处是一道台阶。 */
export type HighwayRampPiece = BoxPart & Readonly<{ ramp: number; highway: number; segment: number }>;
/** Ramp rail inner face from the ramp centreline (rails 0.3 wide at width/2 − 0.15). */
export const rampDrivableHalf = (width: number) => width / 2 - 0.3;
type RampLayout = Pick<CityLayout, "terrain"> & Partial<Pick<CityLayout, "extent" | "roadEdges" | "highways">>;
const pointSegmentDistance = (p: Vec2, a: Vec2, b: Vec2) => {
  const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
  const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
};
export function highwayRampRun(layout: RampLayout, ramp: Readonly<{ points: readonly Vec2[]; width: number }>) {
  const pts = ramp.points.map((p) => ({ x: p.x, z: p.z }));
  const along: number[] = [0];
  for (let i = 1; i < pts.length; i += 1) along.push(along[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  const total = along[along.length - 1] || 1;
  const runs = layout.highways ?? [];
  const highwayDistance = (point: Vec2) => { let nearest = Infinity; for (const run of runs) for (let i = 1; i < run.length; i += 1) nearest = Math.min(nearest, pointSegmentDistance(point, run[i - 1], run[i])); return nearest; };
  let highway = -1, best = Infinity;
  runs.forEach((run, h) => { for (let i = 1; i < run.length; i += 1) { const d = pointSegmentDistance(pts[0], run[i - 1], run[i]); if (d < best) { best = d; highway = h; } } });
  // 整个匝道横截面离开主桥之后才开始下降，不能按固定百分比提前钻入桥面。
  const clearIndex = runs.length ? pts.findIndex((p) => highwayDistance(p) >= (EXPRESSWAY_DECK_WIDTH + ramp.width) / 2 + 0.5) : -1;
  const mergeEnd = clearIndex >= 0 ? along[clearIndex] : total * 0.4;
  const groundAt = (x: number, z: number) => Math.max(0, layout.terrain.height(x, z));
  const end = pts[pts.length - 1];
  const roadTop = Array.isArray(layout.roadEdges) && Number.isFinite(layout.extent) ? groundRoadTopAt(layout as BridgeLayoutInput, end.x, end.z) : null;
  const shift = roadTop === null ? 0 : roadTop - EXPRESSWAY_DECK_THICKNESS - (groundAt(end.x, end.z) + 0.3 - EXPRESSWAY_DECK_THICKNESS);
  const heights = pts.map((p, i) => {
    const t = Math.max(0, (along[i] - mergeEnd) / Math.max(1, total - mergeEnd)), e = t * t * (3 - 2 * t);
    const ground = groundAt(p.x, p.z) + 0.3 - EXPRESSWAY_DECK_THICKNESS + shift;
    return EXPRESSWAY_DECK_Y + (ground - EXPRESSWAY_DECK_Y) * e;
  });
  return { points: pts, heights, along, total, mergeEnd, highway, highwayDistance };
}
/** Ramp boxes in render order per segment: deck, rails, lane lines, then piers. Piers that would stand on a
 * ground carriageway are left out (they are real solids now, not a picture). */
export function highwayRampPieces(layout: RampLayout & Partial<Pick<CityLayout, "highwayRamps">>): HighwayRampPiece[] {
  const pieces: HighwayRampPiece[] = [];
  (layout.highwayRamps ?? []).forEach((ramp, index) => {
    const { points: pts, heights, along, total, mergeEnd, highway, highwayDistance } = highwayRampRun(layout, ramp);
    const push = (p: BoxPart, segment: number) => pieces.push(Object.freeze({ ...p, ramp: index, highway, segment }));
    let nextPier = 9;
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1], b = pts[i];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 1e-3) continue;
      const yaw = -Math.atan2(b.z - a.z, b.x - a.x);
      const ya = heights[i - 1], yb = heights[i];
      const pitch = Math.atan2(yb - ya, length);
      const slant = Math.hypot(length, yb - ya);
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, my = (ya + yb) / 2;
      push(part(mx, my, mz, slant + 0.4, EXPRESSWAY_DECK_THICKNESS, ramp.width, "#6a7071", "ramp-deck", yaw, pitch, "YZX"), i);
      const sideX = Math.sin(yaw), sideZ = Math.cos(yaw);
      // 两端留出开放的分流/地面 T 口，护栏不伸进主桥或横穿干道（低处压在地面车道上的段照高架同一规则断开）。
      if (along[i - 1] >= mergeEnd && total - along[i] >= 10) {
        for (const offset of [-(ramp.width / 2 - 0.15), ramp.width / 2 - 0.15]) for (const [t0, t1] of rampRailRuns(layout, a, b, ya, yb, sideX * offset, sideZ * offset, length)) {
          const tm = (t0 + t1) / 2;
          push(part(a.x + (b.x - a.x) * tm + sideX * offset, ya + (yb - ya) * tm + EXPRESSWAY_DECK_THICKNESS, a.z + (b.z - a.z) * tm + sideZ * offset,
            slant * (t1 - t0), 0.55, 0.3, "#b9bcb2", "ramp-rail", yaw, pitch, "YZX"), i);
        }
      }
      for (const offset of [-(ramp.width / 2 - 0.7), ramp.width / 2 - 0.7]) {
        const point = { x: mx + sideX * offset, z: mz + sideZ * offset };
        // 重叠桥幅内沿用主线标线；匝道边线不能横穿主线车道。
        if (highwayDistance(point) <= EXPRESSWAY_DECK_WIDTH / 2 + 0.4) continue;
        push(part(point.x, my + EXPRESSWAY_DECK_THICKNESS, point.z, slant, 0.05, 0.18, "#e4dfc9", "ramp-lane-line", yaw, pitch, "YZX"), i);
      }
      while (nextPier <= along[i]) {
        const t = (nextPier - along[i - 1]) / length;
        const px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t, py = ya + (yb - ya) * t;
        const bed = Math.max(-3, layout.terrain.height(px, pz));
        nextPier += 18;
        if (py - bed < 1.5) continue;
        const pier = part(px, bed, pz, 1.4, py - bed + 0.05, ramp.width - 1.5, "#a9aaa0", "ramp-pier", yaw, 0);
        if (boxCorners(pier).some((c) => groundRoadClearance(layout.roadEdges, c.x, c.z) < 0.3)) continue;
        push(pier, i);
      }
    }
  });
  return pieces;
}
type Tri = readonly [RibbonPoint, RibbonPoint, RibbonPoint];
export type DeckRibbonMesh = Readonly<{ deck: readonly Tri[]; decorations: Readonly<Record<string, readonly Tri[]>> }>;
/**
 * 桥面板连续网格（2026-10-21，用户截图：弯道匝道一块块桥板之间张开楔形裂口、护栏和标线跟着断）。
 * 旧画法逐段一个旋转盒子、只加长 0.4–0.5：弯内侧重叠、弯外侧张开（15 个规划的 8 条匝道、2 条高架在弯道外角共漏 229 个探针）；
 * 驾驶面早已用 ribbonFaces 斜接成一条带，画面与车脚下的路面是两份几何。这里用同一个 ribbonFaces（同一组接缝、同一套退路
 * 规则）铺桥面板（顶、底、两侧、两端），护栏与标线按各自的盒子还原横向偏移 / 宽 / 高 / 段内区间，在两条半宽的斜接带之间
 * 截条带——缺口规则（rampRailRuns、匝道合流口）不变，接缝处与桥面同一条斜接线。
 * `deck` 是一条连续桥面的盒子（按段序），`decorations` 是落在这些段上的护栏/标线盒子（segment 同号）。
 */
export function deckRibbonMesh(deck: readonly (BoxPart & { segment: number })[], decorations: readonly (BoxPart & { segment: number })[], overhang: number): DeckRibbonMesh {
  const lift = (p: RibbonPoint, dy: number): RibbonPoint => ({ x: p.x, y: p.y + dy, z: p.z });
  const quadTris = (a: RibbonPoint, b: RibbonPoint, c: RibbonPoint, d: RibbonPoint): Tri[] => [[a, b, c], [a, c, d]];
  const lerp = (p: RibbonPoint, q: RibbonPoint, t: number): RibbonPoint => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, z: p.z + (q.z - p.z) * t });
  // 顶面四边形 [start −side, end −side, end +side, start +side] 拉成实体：顶、底、两侧、两端。
  const solid = (faces: readonly (readonly RibbonPoint[])[], down: number, up: number): Tri[] => {
    const tris: Tri[] = [];
    faces.forEach((f, i) => {
      const t = f.map((p) => lift(p, up)), b = f.map((p) => lift(p, down));
      tris.push(...quadTris(t[0], t[3], t[2], t[1]), ...quadTris(b[0], b[1], b[2], b[3]), ...quadTris(b[0], t[0], t[1], b[1]), ...quadTris(b[3], b[2], t[2], t[3]));
      if (i === 0) tris.push(...quadTris(b[0], b[3], t[3], t[0]));
      if (i === faces.length - 1) tris.push(...quadTris(b[1], t[1], t[2], b[2]));
    });
    return tris;
  };
  if (!deck.length) return Object.freeze({ deck: Object.freeze([]), decorations: Object.freeze({}) });
  const ribbons = new Map<number, RibbonPoint[][]>();
  const ribbon = (half: number) => { const key = Math.round(half * 1000) / 1000; let r = ribbons.get(key); if (!r) { r = ribbonFaces(deck, key, overhang); ribbons.set(key, r); } return r; };
  const deckTris = solid(ribbon(deck[0].sz / 2), -deck[0].sy, 0);
  const bySegment = new Map(deck.map((piece, k) => [piece.segment, k] as const));
  const decor: Record<string, Tri[]> = {};
  for (const d of decorations) {
    const k = bySegment.get(d.segment); if (k === undefined) continue;
    const slab = deck[k];
    // 装饰盒子在这段上的位置：段轴向（水平）区间 [t0, t1]、横向偏移、宽、高——全从盒子本身还原。
    const c0 = boxPoint(slab, 0, 0, 0), ax = boxPoint(slab, 0.5, 0, 0), sd = boxPoint(slab, 0, 0, 0.5);
    let ux = ax.x - c0.x, uz = ax.z - c0.z; const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
    let nx = sd.x - c0.x, nz = sd.z - c0.z; const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
    const run = (slab.sx - overhang) * Math.cos(slab.rz); // 这段真长的水平投影
    const dc = boxPoint(d, 0, 0, 0); const along = (dc.x - c0.x) * ux + (dc.z - c0.z) * uz; const offset = (dc.x - c0.x) * nx + (dc.z - c0.z) * nz;
    const half = (d.sx * Math.cos(d.rz)) / 2;
    const t0 = Math.max(0, 0.5 + (along - half) / run), t1 = Math.min(1, 0.5 + (along + half) / run);
    if (t1 - t0 < 1e-6) continue;
    const inner = Math.abs(offset) - d.sz / 2, outer = Math.abs(offset) + d.sz / 2;
    let f: RibbonPoint[];
    if (inner <= 1e-6) { // 跨中线（中央标线）：整条窄带
      const g = ribbon(outer)[k]; f = [lerp(g[0], g[1], t0), lerp(g[0], g[1], t1), lerp(g[3], g[2], t1), lerp(g[3], g[2], t0)];
    } else {
      const gi = ribbon(inner)[k], go = ribbon(outer)[k];
      const edge = (g: RibbonPoint[]) => (offset < 0 ? [g[0], g[1]] : [g[3], g[2]]);
      const [i0, i1] = edge(gi), [o0, o1] = edge(go);
      f = offset < 0 ? [lerp(o0, o1, t0), lerp(o0, o1, t1), lerp(i0, i1, t1), lerp(i0, i1, t0)] : [lerp(i0, i1, t0), lerp(i0, i1, t1), lerp(o0, o1, t1), lerp(o0, o1, t0)];
    }
    (decor[d.role] ??= []).push(...solid([f], 0, d.sy));
  }
  return Object.freeze({ deck: Object.freeze(deckTris), decorations: Object.freeze(Object.fromEntries(Object.entries(decor).map(([k, v]) => [k, Object.freeze(v)]))) });
}

/** 匝道的连续网格：deckRibbonMesh 套在 highwayRampPieces 上（墩柱仍是盒子；碰撞仍读盒子——碰撞体只支持平行六面体，
 *  桥面板是驾驶带下面可越过的板）。 */
export function highwayRampMeshes(layout: RampLayout & Partial<Pick<CityLayout, "highwayRamps">>): Array<DeckRibbonMesh & { ramp: number }> {
  const pieces = highwayRampPieces(layout);
  return (layout.highwayRamps ?? []).map((_, ramp) => {
    const own = pieces.filter((p) => p.ramp === ramp);
    return { ramp, ...deckRibbonMesh(own.filter((p) => p.role === "ramp-deck").sort((a, b) => a.segment - b.segment), own.filter((p) => p.role === "ramp-rail" || p.role === "ramp-lane-line"), 0.4) };
  }).filter((m) => m.deck.length > 0);
}

/** 高架（区界高架与编辑器画的高架）的连续网格：同一个 deckRibbonMesh（桥墩/盖梁仍是盒子）。 */
export function expresswayMeshes(layout: Parameters<typeof expresswayPieces>[0]): Array<DeckRibbonMesh & { highway: number }> {
  const pieces = expresswayPieces(layout);
  return (layout.highways ?? []).map((_, highway) => {
    const own = pieces.filter((p) => p.highway === highway && p.segment >= 0);
    return { highway, ...deckRibbonMesh(own.filter((p) => p.role === "expressway-deck").sort((a, b) => a.segment - b.segment), own.filter((p) => p.role === "expressway-rail" || p.role === "expressway-lane-line"), 0.5) };
  }).filter((m) => m.deck.length > 0);
}

/** Lift of an expressway ribbon's interior seams above the higher slab top (keeps slabs below the drivable surface). */
export const RIBBON_LIFT = 0.03;
type RibbonPoint = { x: number; y: number; z: number };
/** 自 compileSurface 搬来（2026-10-21）：渲染层（buildHighwayRamps）与驾驶面共用同一条斜接带——两边各算一份，接缝就会对不上。 */
/** Drivable ribbon over a run of deck slabs (expressways and interchange ramps): interior seams are shared
 * between neighbours — the higher of both slab tops at the true segment end, lifted RIBBON_LIFT where the
 * pitch changes — and mitred sideways; the run's two end edges stay the first/last slab's full top edge. */
export function ribbonFaces(deck: readonly BoxPart[], half: number, overhang: number): RibbonPoint[][] {
  const tops = deck.map((piece) => boxTopFace(piece, half));
  // Centre of the top face at the piece's true segment end: slabs are `overhang` longer than their segment
  // (expressways slant + 0.5, ramps slant + 0.4) so neighbouring render slabs close their gaps.
  const endAt = (i: number, sign: number) => { const piece = deck[i]; const f = sign * Math.max(0, (piece.sx - overhang) / 2) / piece.sx; return boxPoint(piece, f, 1, 0); };
  const sideOf = (i: number) => { const t = tops[i]; const sx = t[3].x - t[0].x, sz = t[3].z - t[0].z; const l = Math.hypot(sx, sz) || 1; return { x: sx / l, z: sz / l }; };
  const seamAt = (i: number): [RibbonPoint, RibbonPoint] | null => {
    const lift = Math.abs(deck[i - 1].rz - deck[i].rz) > 1e-9 ? RIBBON_LIFT : 0;
    const a = endAt(i - 1, 1), b = endAt(i, -1); const c = { x: (a.x + b.x) / 2, y: Math.max(a.y, b.y) + lift, z: (a.z + b.z) / 2 };
    const s0 = sideOf(i - 1), s1 = sideOf(i); let mx = s0.x + s1.x, mz = s0.z + s1.z; const ml = Math.hypot(mx, mz);
    if (ml < 1e-9) return null; mx /= ml; mz /= ml;
    const cos = mx * s0.x + mz * s0.z; if (cos < 0.5) return null; // sharper than 120°: keep the slab tops there
    const w = half / cos;
    return [{ x: c.x - mx * w, y: c.y, z: c.z - mz * w }, { x: c.x + mx * w, y: c.y, z: c.z + mz * w }];
  };
  const seams = deck.map((_, i) => (i === 0 ? null : seamAt(i)));
  // boxTopFace order: [start −side, end −side, end +side, start +side].
  const faceOf = (i: number): RibbonPoint[] => {
    const t = tops[i]; const start = seams[i], end = i + 1 < deck.length ? seams[i + 1] : null;
    return [start ? start[0] : t[0], end ? end[0] : t[1], end ? end[1] : t[2], start ? start[1] : t[3]];
  };
  // 斜接不得把短段折叠（2026-10-20）：弯内侧的斜接点比接缝中心后退 half·tan(θ/2)，短段（高架落地处 1.9–2.4 长、
  // 紧接 ~65° 转弯）上它越过了这段另一端的接缝，面片自交成蝴蝶结，边界提取失败 → 面片 boundary-unresolved 被排除，
  // 1000/7、1000/65537 的 expressway:0 from 端落地后第一块驾驶面不存在（structure:expressway:0:from:* 无法连通）。
  // 侧边恒平行于段轴，未折叠的四边形必为凸——非凸即折叠：该段两端的接缝退回板顶（与 >120° 的退路相同），直到全部为凸。
  const convex = (q: readonly RibbonPoint[]) => {
    let sign = 0;
    for (let k = 0; k < 4; k++) {
      const a = q[k], b = q[(k + 1) % 4], c = q[(k + 2) % 4];
      const cr = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
      if (Math.abs(cr) < 1e-9) return false;
      if (sign === 0) sign = Math.sign(cr); else if (Math.sign(cr) !== sign) return false;
    }
    return true;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < deck.length; i++) {
      if (convex(faceOf(i))) continue;
      if (seams[i]) { seams[i] = null; changed = true; }
      if (i + 1 < deck.length && seams[i + 1]) { seams[i + 1] = null; changed = true; }
    }
  }
  return deck.map((_, i) => faceOf(i));
}

/** A ramp rail lower than this above the terrain is a solid on whatever ground road it lies on. */
export const RAMP_RAIL_HEADROOM = 2.6;
/** 匝道落地端护栏退让（2026-10-19）：匝道在地面路中间落地，0/65537 的最后一段（8.24→10.2）与 12 宽的南北向
 * 宿主路垂直相交，侧护栏（y 1.24–1.80）横躺在宿主路车道里，沿路行驶的车撞上（0/2026 同形）。占路诊断跳过
 * expressway-rail，所以没报。护栏只在「XZ 落在地面车道内且离地低于 RAMP_RAIL_HEADROOM」的样本处断开；
 * 高架跨过地面路处离地高，照常保留。没有被剪的护栏返回 [[0, 1]]，与旧几何逐字节相同。 */
function rampRailRuns(layout: Partial<Pick<CityLayout, "roadEdges">> & Pick<CityLayout, "terrain">, a: Vec2, b: Vec2, ya: number, yb: number,
  ox: number, oz: number, length: number): Array<[number, number]> {
  if (!Array.isArray(layout.roadEdges)) return [[0, 1]];
  const n = Math.max(1, Math.ceil(length / 0.5));
  const blocked: boolean[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = a.x + (b.x - a.x) * t + ox, z = a.z + (b.z - a.z) * t + oz;
    blocked.push(ya + (yb - ya) * t + EXPRESSWAY_DECK_THICKNESS < layout.terrain.height(x, z) + RAMP_RAIL_HEADROOM &&
      groundRoadClearance(layout.roadEdges, x, z) < RAILING_ROAD_CLEARANCE);
  }
  if (!blocked.some(Boolean)) return [[0, 1]];
  const runs: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) {
    if (blocked[i]) continue;
    let j = i; while (j + 1 <= n && !blocked[j + 1]) j++;
    if ((j - i) / n * length >= 0.3) runs.push([i / n, j / n]);
    i = j;
  }
  return runs;
}
/** Rail inner face from the expressway centreline (rails 0.3 wide at ±5.1). */
export const EXPRESSWAY_DRIVABLE_HALF = 5.1 - 0.15;

/** Red through-truss bars: [x, y, z, len, thick, rotY, tilt, vertical]; tilt is the diagonal lean of a
 * vertical member or the span pitch of a chord (both a local-z rotation in YXZ order). */
export function trussBars(layout: Pick<CityLayout, "landmarks" | "bridges" | "terrain" | "extent" | "roadEdges">): Array<[number, number, number, number, number, number, number, number]> {
  const suspension = (layout.landmarks ?? []).find((l) => l.kind === "suspension-bridge");
  const bridges = (layout.bridges ?? []).filter((b) => b.length >= 40 && b.length <= 160
    && !(suspension && Math.hypot(b.from.x - suspension.x, b.from.z - suspension.z) < 1));
  const bars: Array<[number, number, number, number, number, number, number, number]> = [];
  for (const bridge of bridges) {
    const dx = bridge.to.x - bridge.from.x; const dz = bridge.to.z - bridge.from.z; const len = Math.hypot(dx, dz);
    const ux = dx / len; const uz = dz / len; const nx = -uz; const nz = ux;
    const yaw = -Math.atan2(dz, dx);
    // Follows the same pitched deck as bridgeDeckParts (chords pitched along the span, posts on the deck).
    const profile = bridgeDeckProfile(layout, bridge.from, bridge.to);
    const deckAt = (t: number) => profile.at(t / len);
    // Keep the low truss members inside the span: bank junction fans can cross
    // behind a side girder even though the bridge centreline itself is clear.
    // The truss planes stand OUTSIDE the deck slab: a wide bridge's drivable deck (width/2 − 0.3) reached past
    // the fixed ±6.6, so the bottom chord lay across the carriageway 0.2 above it (road obstruction guard).
    const deckEdge = renderRoadEdges(layout.roadEdges ?? []).find((e) => e.bridge && e.points.length === 2 &&
      ((Math.hypot(e.points[0].x - bridge.from.x, e.points[0].z - bridge.from.z) < 0.01 && Math.hypot(e.points[1].x - bridge.to.x, e.points[1].z - bridge.to.z) < 0.01) ||
       (Math.hypot(e.points[1].x - bridge.from.x, e.points[1].z - bridge.from.z) < 0.01 && Math.hypot(e.points[0].x - bridge.to.x, e.points[0].z - bridge.to.z) < 0.01)));
    const lateral = Math.max(6.6, (deckEdge?.width ?? 0) / 2 + 0.6);
    // Per-end setback: at least min(8, len/4), then walked inward until both truss lines are clear of every
    // ground carriageway — a bank approach road leaving the bridgehead diagonally still ran under the low
    // members 8 into the span (0/2026). Capped at len/3 per end (the truss always keeps its middle third).
    const base = Math.min(8, len / 4);
    const lineClear = (t: number) => [-1, 1].every((side) => groundRoadClearance(layout.roadEdges,
      bridge.from.x + ux * t + nx * side * lateral, bridge.from.z + uz * t + nz * side * lateral) >= TRUSS_ROAD_CLEARANCE);
    const endSetback = (fromEnd: boolean) => {
      let sb = base;
      while (sb < len / 3 && !lineClear(fromEnd ? sb : len - sb)) sb += 0.5;
      return Math.min(sb, len / 3);
    };
    const sFrom = endSetback(true), sTo = endSetback(false);
    const setback = sFrom, trussLength = len - sFrom - sTo, centre = sFrom + trussLength / 2;
    const H = 7; const panels = Math.max(4, Math.round(trussLength / 9)); const step = trussLength / panels;
    for (const side of [-1, 1]) {
      const ox = nx * side * lateral; const oz = nz * side * lateral;
      const at = (t: number) => ({ x: bridge.from.x + ux * t + ox, z: bridge.from.z + uz * t + oz });
      const mid = at(centre);
      const chordLength = trussLength / Math.cos(profile.pitch);
      bars.push([mid.x, deckAt(centre) + H, mid.z, chordLength, 0.6, yaw, profile.pitch, 0]);          // 上弦
      bars.push([mid.x, deckAt(centre) + 0.2, mid.z, chordLength, 0.6, yaw, profile.pitch, 0]);        // 下弦
      for (let i = 0; i <= panels; i += 1) {
        const station = setback + i * step, p = at(station);
        bars.push([p.x, deckAt(station), p.z, 0.45, H, yaw, 0, 1]);                 // 竖杆
        if (i < panels) {
          const q = at(station + step / 2);
          bars.push([q.x, deckAt(station + step / 2), q.z, 0.4, Math.hypot(step, H), yaw, (i % 2 ? 1 : -1) * Math.atan2(step, H), 1]); // 斜腹杆
        }
      }
    }
    // 顶部横撑（每两格一根），让桁架从远处读成「穿式」而不是两片护栏。
    for (let i = 0; i <= panels; i += 2) {
      const t = setback + i * step; const x = bridge.from.x + ux * t; const z = bridge.from.z + uz * t;
      bars.push([x, deckAt(t) + H, z, 2 * lateral, 0.5, yaw + Math.PI / 2, 0, 0]);
    }
  }
  return bars;
}
/** Clearance the truss lines keep from any ground carriageway (bar half-width 0.3 + body margin). */
export const TRUSS_ROAD_CLEARANCE = 1.0;
/** A truss bar as the BOX instance the renderer composes (YXZ, horizontal bars centred on y). */
export function trussBarPart([x, y, z, a, b, rotY, tilt, vertical]: [number, number, number, number, number, number, number, number]): BoxPart {
  return vertical ? part(x, y, z, a, b, a, "#a8322a", "truss", rotY, tilt, "YXZ") : part(x, y - b / 2, z, a, b, b, "#a8322a", "truss", rotY, tilt, "YXZ");
}

/** 尽端回车圈半径（形态批 §5-3）：所在路段半宽 + 2.5，夹在 6–9。守夜灯同用此口径。 */
export function culDeSacBulbRadius(roadWidth: number): number {
  return Math.max(6, Math.min(9, roadWidth / 2 + 2.5));
}
export type CulDeSacDisc = Readonly<{ x: number; z: number; radius: number; base: number; gx: number; gz: number }>;
/** Cul-de-sac discs: centre, radius, base height and the central-difference slope the renderer tilts by. */
/** Disc top above the rendered road top at its centre: above it (no z-fighting with the road ribbon) but well
 * inside the surface alias tolerance 0.1 so the bulb and its road are one drivable region. */
export const CUL_DE_SAC_TOP_LIFT = 0.04;
/** Cylinder: bottom at base + 0.02, height 0.12 (roadSystem.buildCulDeSacBulbs, culDeSacTopCap). */
const CUL_DE_SAC_TOP_ABOVE_BASE = 0.14;
export function culDeSacDiscs(layout: Pick<CityLayout, "culDeSacEnds" | "roadEdges" | "terrain"> & Partial<Pick<CityLayout, "extent">>): CulDeSacDisc[] {
  const ends = layout.culDeSacEnds ?? [];
  const widthAt = new Map<string, number>();
  for (const edge of renderRoadEdges(layout.roadEdges)) {
    if (edge.bridge) continue;
    for (const id of [edge.from, edge.to]) widthAt.set(id, Math.max(widthAt.get(id) ?? 0, edge.width));
  }
  const height = layout.terrain.height;
  return ends.map((end: Vec2) => {
    const radius = culDeSacBulbRadius(widthAt.get(`${end.x}:${end.z}`) ?? 9);
    // 回车圈顶面对齐路面（2026-10-20）：曾取 terrain.height 真值为基准，顶面 = 地形 + 0.14，而路面 = 地形三角化 + ROAD_LIFT(0.04)，
    // 两者差 ≈0.10，正卡在 surfaceRegions 的别名容差 0.1 上——七城 25 个回车圈有 10 个与宿主路判成两个区域，重叠处
    // ambiguous-region 封闭，车开到圈边就停（1000/7 桥头引道 structure:bridge:*:off pilot-failed）。现以渲染路面顶为准。
    const roadTop = Number.isFinite(layout.extent) ? terrainSurfaceHeight(layout as Pick<CityLayout, "extent" | "terrain">, end.x, end.z) + ROAD_LIFT : null;
    const base = roadTop === null ? Math.max(0, height(end.x, end.z)) : roadTop + CUL_DE_SAC_TOP_LIFT - CUL_DE_SAC_TOP_ABOVE_BASE;
    // 倾斜同样要贴合它覆盖的那段路面（2026-10-20）：按 terrain.height 真值做 ±radius 中心差分，0/42 的 247.03:388.68
    // 尽端外地形下坡 0.5 而路一侧是平的，平均出的 −0.03 倾斜让圆盘离圆心 6 处比路面高 0.22，仍与路判成两个区域。
    // 现以宿主路为准：沿路方向只取路一侧的单边差分（尽端以外不是路），横向在路宽内做中心差分，都用路面的高度函数。
    let gx: number, gz: number;
    const host = roadTop === null ? undefined : renderRoadEdges(layout.roadEdges).find((e) => !e.bridge && e.structure !== "deck" && (e.from === `${end.x}:${end.z}` || e.to === `${end.x}:${end.z}`));
    if (host && roadTop !== null) {
      const surfaceAt = (x: number, z: number) => terrainSurfaceHeight(layout as Pick<CityLayout, "extent" | "terrain">, x, z);
      const pts = host.from === `${end.x}:${end.z}` ? host.points : [...host.points].reverse();
      const q = pts[1]; const l = Math.hypot(q.x - end.x, q.z - end.z) || 1; const ux = (q.x - end.x) / l, uz = (q.z - end.z) / l, nx = -uz, nz = ux;
      const r = Math.min(radius, l), w = Math.min(radius, host.width / 2);
      const along = (surfaceAt(end.x + ux * r, end.z + uz * r) - surfaceAt(end.x, end.z)) / r;
      const across = (surfaceAt(end.x + nx * w, end.z + nz * w) - surfaceAt(end.x - nx * w, end.z - nz * w)) / (2 * w);
      gx = along * ux + across * nx; gz = along * uz + across * nz;
    } else {
      gx = (height(end.x + radius, end.z) - height(end.x - radius, end.z)) / (2 * radius);
      gz = (height(end.x, end.z + radius) - height(end.x, end.z - radius)) / (2 * radius);
    }
    return Object.freeze({ x: end.x, z: end.z, radius, base, gx, gz });
  });
}
/** Disc top cap (20 segments like the renderer's CylinderGeometry): centre then rim, world XYZ.
 * Rotation = shortest arc from +Y to normalize(−gx, 1, −gz), as Quaternion.setFromUnitVectors. */
export function culDeSacTopCap(disc: CulDeSacDisc): { center: { x: number; y: number; z: number }; rim: { x: number; y: number; z: number }[] } {
  const len = Math.hypot(disc.gx, 1, disc.gz); const n = [-disc.gx / len, 1 / len, -disc.gz / len];
  // Rodrigues rotation about axis (up × n) by angle acos(n.y).
  const ax = n[2], az = -n[0]; const s = Math.hypot(ax, az); const c = n[1];
  const rotate = (x: number, y: number, z: number) => {
    if (s < 1e-12) return [x, y, z];
    const kx = ax / s, kz = az / s; // ky = 0
    const dot = kx * x + kz * z; const crossX = -kz * y, crossY = kz * x - kx * z, crossZ = kx * y; // k × v with ky=0
    return [x * c + crossX * s + kx * dot * (1 - c), y * c + crossY * s, z * c + crossZ * s + kz * dot * (1 - c)];
  };
  const at = (lx: number, lz: number) => { const [x, y, z] = rotate(lx * disc.radius, 0.12, lz * disc.radius); return { x: disc.x + x, y: disc.base + 0.02 + y, z: disc.z + z }; };
  return { center: at(0, 0), rim: Array.from({ length: 20 }, (_, k) => { const theta = (k / 20) * Math.PI * 2; return at(Math.sin(theta), Math.cos(theta)); }) };
}

export type ChannelFlare = Readonly<{ mouth: number; arm: "stem" | "host"; color: string; left: readonly Vec2[]; right: readonly Vec2[] }>;
export type ChannelIsland = Readonly<{ mouth: number; ring: readonly Vec2[] }>;
const asphaltOf = (edge: { kind: string }) => (edge.kind === "arterial" ? "#505b60" : "#646c6b");
/** 喇叭渐变与水滴分流岛的平面几何（buildChannelizedJunctions 原样）：喇叭从口部（d0，半宽 w/2+extra）
 *  线性收到正常路幅，沿边按 ~4.5 单位切片；岛是口部一侧圆头、向内收尖的低多边形。高度由消费方取。 */
export function channelizedGeometry(layout: Pick<CityLayout, "roadEdges">): { flares: ChannelFlare[]; islands: ChannelIsland[] } {
  const mouths = channelizedTPlan(renderRoadEdges(layout.roadEdges));
  const flares: ChannelFlare[] = []; const islands: ChannelIsland[] = [];
  const flare = (arm: ChannelizedArm, x: number, z: number, mouth: number, name: "stem" | "host") => {
    const width = arm.edge.width;
    const extra = Math.min(2.3, 0.45 * width);
    const d0 = 2.2;
    const length = 9 + width * 0.55;
    const slices = Math.max(1, Math.ceil(length / 4.5));
    const nx = -arm.dir.z; const nz = arm.dir.x;
    const at = (d: number, half: number, sign: number) => ({ x: x + arm.dir.x * d + nx * half * sign, z: z + arm.dir.z * d + nz * half * sign });
    const left: Vec2[] = []; const right: Vec2[] = [];
    for (let s = 0; s <= slices; s += 1) {
      const t = s / slices;
      const half = width / 2 + extra * (1 - t);
      left.push(at(d0 + length * t, half, 1));
      right.push(at(d0 + length * t, half, -1));
    }
    flares.push(Object.freeze({ mouth, arm: name, color: asphaltOf(arm.edge), left: Object.freeze(left), right: Object.freeze(right) }));
  };
  const ISLAND_PROFILE = [
    { d: 0.0, w: 1.0 }, { d: 0.16, w: 1.14 }, { d: 0.58, w: 0.55 }, { d: 1.0, w: 0.0 },
    { d: 0.58, w: -0.55 }, { d: 0.16, w: -1.14 }, { d: 0.0, w: -1.0 },
  ];
  const island = (arm: ChannelizedArm, x: number, z: number, mouth: number) => {
    const extra = Math.min(2.3, 0.45 * arm.edge.width);
    const start = 2.2 + 2.2;
    const length = 4.4 + arm.edge.width * 0.3;
    const half = Math.min(0.8, extra * 0.4);
    const nx = -arm.dir.z; const nz = arm.dir.x;
    islands.push(Object.freeze({ mouth, ring: Object.freeze(ISLAND_PROFILE.map((point) => ({
      x: x + arm.dir.x * (start + length * point.d) + nx * half * point.w,
      z: z + arm.dir.z * (start + length * point.d) + nz * half * point.w,
    }))) }));
  };
  mouths.forEach((mouth, index) => {
    flare(mouth.stem, mouth.x, mouth.z, index, "stem");
    flare(mouth.host, mouth.x, mouth.z, index, "host");
    island(mouth.stem, mouth.x, mouth.z, index);
  });
  return { flares, islands };
}
/** Flare paint lift (0.02–0.05 band; below the road surface lift 0.04). */
export const FLARE_LIFT = 0.035;
/** Flare triangles per slice in the renderer's order: (left s, left s+1, right s+1), (left s, right s+1, right s). */
export function flareTriangles(flare: ChannelFlare): [Vec2, Vec2, Vec2][] {
  const out: [Vec2, Vec2, Vec2][] = [];
  for (let s = 0; s + 1 < flare.left.length; s += 1) {
    const a = flare.left[s]; const b = flare.left[s + 1]; const c = flare.right[s + 1]; const e = flare.right[s];
    out.push([a, b, c], [a, c, e]);
  }
  return out;
}
