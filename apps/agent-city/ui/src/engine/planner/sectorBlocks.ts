import { atLeast } from "../roadStandard";
import { DetMath as Math } from "../detMath";
/**
 * 扇区街网（R5 步 6b）：自 cityPlan.ts::buildPlan 逐字迁出的「分区判定 + 扇区街区网格」工序段。
 *
 * 相邻两条主干道之间铺一张街网（u 轴沿起始主干道），每个格子过地形/保留带/预留地/高架净空检查，
 * 通过后由 commitFixedLink 事务提交四条边界街道，再登记街区与延迟生成地块的 buildParcels。
 *
 * 对外部世界的读写（原为 buildPlan 闭包变量，现显式传入）：
 *   读：R、core、trunks、random()、seaside、buildable、coastDistance、reservations、key、
 *       trunkIndex / ringIndex / coastRoadIndex（SegmentIndex，只查询）、network.edges（惰性主干索引与现有路网）
 *   原地改：network（经 commitFixedLink(connectorWorld, …) 加边，与原段相同的调用与顺序）
 *   新产生并返回：zoneFor（闭包带惰性 primaryIndexCache，首次调用时才扫 edges——与原行为相同）、
 *       blocks、roadGenerationDiagnostics、parcelBuilders、frontNodes（后续「横街接入主干道」读它）
 * random 键（du/dv/grid:…）与调用顺序不变。
 */
import type { CityBlock, Parcel, Vec2, Zone } from "../cityLayout";
import { clearsHighways, polygonDistance, SegmentIndex, segmentDistance } from "../roadGeometry";
import { seasideStripContains, type SeasideBand } from "../citySeaside";
import { commitFixedLink, type ConnectorWorld } from "./connect";
import { roadCandidateCrowding } from "./roadAdmission";
import type { Network } from "./network";

export type SectorBlocksWorld = {
  R: number;
  core: Vec2;
  /** 主干道（只读 .angle）。 */
  trunks: Array<{ angle: number }>;
  random: (key: string) => number;
  network: Network;
  connectorWorld: ConnectorWorld;
  seaside: SeasideBand | null;
  buildable: (x: number, z: number) => boolean;
  coastDistance: (x: number, z: number) => number;
  reservations: () => Array<Vec2 & { radius: number }>;
  key: (p: Vec2) => Vec2;
  trunkIndex: SegmentIndex;
  ringIndex: SegmentIndex;
  coastRoadIndex: SegmentIndex;
};

export function buildSectorBlocks(w: SectorBlocksWorld) {
  const { R, core, trunks, random, network, connectorWorld, seaside, buildable, coastDistance, reservations, key, trunkIndex, ringIndex, coastRoadIndex } = w;
  const { edges } = network;
  let primaryIndexCache: SegmentIndex | null = null;
  const primaryRoadIndex = () => (primaryIndexCache ??= new SegmentIndex([...edges.values()].filter((edge) => atLeast(edge, "arterial") && !edge.bridge).map((edge) => edge.points)));
  const zoneFor = (center: Vec2): Zone => {
    // 分区由地理与骨架决定：核心附近 downtown、临海 waterfront、主干道两侧 commercial、其余 residential。
    // 实测 380 栋会话楼 97% 落在 residential、0 栋商业：downtown 半径 0.24R 几乎被市政广场与用地占满，
    // commercial 只认放射主干道。改为 0.3R，且临任意宽路（环岛滨海路、河岸路、海滨大道）也算商业街。
    if (Math.hypot(center.x - core.x, center.z - core.z) < 0.3 * R) return "downtown";
    if (coastDistance(center.x, center.z) < 90) return "waterfront";
    if (trunkIndex.closerThan(center, 80) || primaryRoadIndex().closerThan(center, 60)) return "commercial"; // 主干道 80 / 宽路 60：曾 60/45，商业仅 ~9%
    return "residential";
  };

  // 扇区街网：相邻两条主干道之间，网格 u 轴沿扇区起始那条主干道（街区沿主干道排开、横街以 T 路口接入主干道），
  // v 轴垂直指向扇区内部。曾沿扇区平分线：街网与两侧主干道都斜交、隔 10 单位空地带浮着（审计 R3 前的第一步）。
  const blocks: CityBlock[] = [];
  const roadGenerationDiagnostics = { crowdedBlockCandidates: 0, examples: [] as string[] };
  const parcelBuilders = new Map<string, (block: CityBlock) => Parcel[]>();
  const angleBetween = (a: number, lo: number, hi: number) => {
    const span = ((hi - lo) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) || Math.PI * 2;
    const off = ((a - lo) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    return off > 0 && off < span;
  };
  const primarySegments = [...edges.values()].filter((edge) => atLeast(edge, "arterial") && !edge.bridge).map((edge) => edge.points);
  const parallelPrimaryGap = (a: Vec2, b: Vec2) => {
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    const angle = Math.atan2(b.z - a.z, b.x - a.x);
    let gap = Infinity;
    for (const [c, d] of primarySegments) {
      let delta = Math.abs(angle - Math.atan2(d.z - c.z, d.x - c.x)) % Math.PI;
      delta = Math.min(delta, Math.PI - delta);
      if (delta < (15 * Math.PI) / 180) gap = Math.min(gap, segmentDistance(mid, c, d));
    }
    return gap;
  };
  const frontNodes: Vec2[] = []; // 首排街区贴主干道的角点：街网生成后以 T 路口接入主干道
  const sectors = trunks.length ? trunks.map((trunk, i) => ({ lo: trunk.angle, hi: trunks[(i + 1) % trunks.length].angle })) : [{ lo: 0, hi: Math.PI * 2 }];
  sectors.forEach((sector, sectorIndex) => {
    const span = ((sector.hi - sector.lo) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) || Math.PI * 2;
    // 宽扇区（>135°，常因指向山脊的主干道被省略）贴一侧主干道铺不满：退回平分线朝向、两侧都铺。
    const aligned = span <= Math.PI * 0.75;
    const theta = aligned ? sector.lo : sector.lo + span / 2;
    const u = { x: Math.cos(theta), z: Math.sin(theta) };
    const TRUNK_GAP = 8; // 首排街区离主干道中线 8（路幅半宽 6 + 路缘）
    const v = { x: -u.z, z: u.x };
    const du = 44 + random(`du${sectorIndex}`) * 10;
    const dv = 40 + random(`dv${sectorIndex}`) * 12;
    // A shared, seed-keyed displacement at every grid junction breaks the
    // perfect Manhattan checkerboard without opening cracks between blocks.
    // Keep it below 12% of the narrowest block span so junctions become organic
    // at aerial scale without folding adjacent block quads.
    const nodeOffsets = new Map<string, Vec2>();
    const at = (i: number, j: number): Vec2 => {
      const id = `${i}:${j}`;
      let offset = nodeOffsets.get(id);
      if (!offset) {
        const amplitude = aligned && j === 0 ? 0 : 5.2; // 贴主干道的首排不抖动，免得角点压进路面
        offset = {
          x: (random(`grid:${sectorIndex}:${id}:x`) - 0.5) * amplitude * 2,
          z: (random(`grid:${sectorIndex}:${id}:z`) - 0.5) * amplitude * 2,
        };
        nodeOffsets.set(id, offset);
      }
      const gap = aligned ? TRUNK_GAP : 0;
      return { x: core.x + u.x * i * du + v.x * (j * dv + gap) + offset.x, z: core.z + u.z * i * du + v.z * (j * dv + gap) + offset.z };
    };
    const reachCells = Math.ceil((R * 1.6) / Math.min(du, dv));
    for (let i = 1; i < reachCells; i += 1) for (let j = aligned ? 0 : -reachCells; j < reachCells; j += 1) {
      let polygon = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      let center = at(i + 0.5, j + 0.5);
      const centerAngle = Math.atan2(center.z - core.z, center.x - core.x);
      if (!angleBetween(centerAngle, sector.lo, sector.hi)) continue;
      // 四角都在本扇区内（不和相邻扇区的街网重叠）、可建、离主干道与环线高架留出路幅。
      // S4「街区形状由大地块决定」：跨出扇区的格子不再整格丢弃（曾留下锯齿边、主干道两侧空一圈），
      // 而是沿扇区两条边界射线（内收 10）裁切——斜向主干道旁的街区成为三角形/梯形，一直排到路边。
      let clipped = false;
      let onClipLine: (p: Vec2) => boolean = () => false; // 裁切线上的边是临主干道的界面，不修成街道
      if (polygon.some((p) => !angleBetween(Math.atan2(p.z - core.z, p.x - core.x), sector.lo, sector.hi))) {
        const lo = { x: Math.cos(sector.lo), z: Math.sin(sector.lo) }; const hi = { x: Math.cos(sector.hi), z: Math.sin(sector.hi) };
        const insideLo = (p: Vec2) => lo.x * (p.z - core.z) - lo.z * (p.x - core.x) - 10;   // 逆时针侧为正
        const insideHi = (p: Vec2) => -(hi.x * (p.z - core.z) - hi.z * (p.x - core.x)) - 10; // 顺时针侧为正
        const clip = (poly: Vec2[], f: (p: Vec2) => number) => {
          const out: Vec2[] = [];
          for (let k = 0; k < poly.length; k += 1) {
            const a = poly[k]; const b = poly[(k + 1) % poly.length];
            const fa = f(a); const fb = f(b);
            if (fa >= 0) out.push(a);
            if ((fa >= 0) !== (fb >= 0)) { const t = fa / (fa - fb); out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }); }
          }
          return out;
        };
        polygon = clip(clip(polygon, insideLo), insideHi);
        onClipLine = (p: Vec2) => Math.abs(insideLo(p)) < 0.01 || Math.abs(insideHi(p)) < 0.01;
        if (polygon.length < 3) continue;
        let area = 0; for (let k = 0; k < polygon.length; k += 1) { const a = polygon[k]; const b = polygon[(k + 1) % polygon.length]; area += a.x * b.z - b.x * a.z; }
        if (Math.abs(area) / 2 < 350) continue;
        // 尖角 <50° 的裁切块不要：它的街道会在尖角处相交成锐角路口（初版 30 岛锐角 2 → 45）。保留梯形与钝形块。
        let minAngle = Math.PI;
        for (let k = 0; k < polygon.length; k += 1) {
          const prev = polygon[(k + polygon.length - 1) % polygon.length]; const cur = polygon[k]; const next = polygon[(k + 1) % polygon.length];
          const ux = prev.x - cur.x; const uz = prev.z - cur.z; const vx = next.x - cur.x; const vz = next.z - cur.z;
          const lu = Math.hypot(ux, uz); const lv = Math.hypot(vx, vz);
          if (lu < 1e-6 || lv < 1e-6) continue;
          minAngle = Math.min(minAngle, Math.acos(Math.max(-1, Math.min(1, (ux * vx + uz * vz) / (lu * lv)))));
        }
        if (minAngle < (50 * Math.PI) / 180) continue;
        center = { x: polygon.reduce((t, p) => t + p.x, 0) / polygon.length, z: polygon.reduce((t, p) => t + p.z, 0) / polygon.length };
        if (!angleBetween(Math.atan2(center.z - core.z, center.x - core.x), sector.lo, sector.hi)) continue;
        clipped = true;
      }
      if (polygon.some((p) => !buildable(p.x, p.z))) continue;
      // 海滨保留带（水线→带外缘）内不生成街区：沙滩/步道/酒店排用地。
      if (seaside && polygon.some((p) => seasideStripContains(seaside, p, 4))) continue;
      if (polygon.some((p, k) => { const q = polygon[(k + 1) % polygon.length]; return !buildable((p.x + q.x) / 2, (p.z + q.z) / 2); })) continue;
      if ([center, ...polygon].some((p) => trunkIndex.closerThan(p, 7))) continue;
      if ([center, ...polygon].some((p) => ringIndex.closerThan(p, 9))) continue;
      if ([center, ...polygon].some((p) => coastRoadIndex.closerThan(p, 7))) continue;
      // 压到预留地的格子整格不生成（曾只是不放地块、四条边照样成路——支路穿过公园/广场）。
      if (reservations().some((site) => polygonDistance(site, polygon) > -site.radius)) continue;
      const zone = zoneFor(center);
      const id = `plan:${sectorIndex}:${i}:${j}`;
      const wasClipped = clipped;
      const buildParcels = (block: CityBlock): Parcel[] => {
      // Derive addresses only after accepted road/site repairs. Split nodes on a
      // straight boundary do not turn a quadrilateral into a clipped block.
      const polygon = block.polygon.filter((p, k, points) => {
        const a = points[(k + points.length - 1) % points.length], b = points[(k + 1) % points.length];
        return Math.abs((p.x - a.x) * (b.z - p.z) - (p.z - a.z) * (b.x - p.x)) > 0.001;
      });
      if (polygon.length < 3) return [];
      const clipped = wasClipped || polygon.length !== 4;
      const center = { x: polygon.reduce((sum, p) => sum + p.x, 0) / polygon.length, z: polygon.reduce((sum, p) => sum + p.z, 0) / polygon.length };
      const parcels: Parcel[] = [];
      // 裁切出的三角/梯形街区：沿最长边排一排临街地块（内收朝多边形内侧）。
      let front = 0;
      if (clipped) for (let k = 1; k < polygon.length; k += 1) {
        const len = (q: number) => Math.hypot(polygon[(q + 1) % polygon.length].x - polygon[q].x, polygon[(q + 1) % polygon.length].z - polygon[q].z);
        if (len(k) > len(front)) front = k;
      }
      const sideLength = clipped ? Math.hypot(polygon[(front + 1) % polygon.length].x - polygon[front].x, polygon[(front + 1) % polygon.length].z - polygon[front].z)
        : Math.hypot(polygon[1].x - polygon[0].x, polygon[1].z - polygon[0].z);
      const columnCount = Math.max(clipped ? 1 : 3, Math.floor((sideLength - 14) / 7.2));
      for (let side = 0; side < (clipped ? 1 : 2); side += 1) for (let index = 0; index < columnCount; index += 1) {
        const a = clipped ? polygon[front] : polygon[side === 0 ? 0 : 3]; const b = clipped ? polygon[(front + 1) % polygon.length] : polygon[side === 0 ? 1 : 2];
        const length = Math.hypot(b.x - a.x, b.z - a.z); const dx = (b.x - a.x) / length; const dz = (b.z - a.z) / length;
        const t = (index + 0.5) / columnCount;
        let inset = side === 0 ? 12 : -12;
        if (clipped) { const mx = (a.x + b.x) / 2; const mz = (a.z + b.z) / 2; if (-dz * (center.x - mx) + dx * (center.z - mz) < 0) inset = -12; }
        const p = { x: a.x + dx * (7 + (length - 14) * t) - dz * inset, z: a.z + dz * (7 + (length - 14) * t) + dx * inset };
        // Warped corners can leave an interior parcel inside the curved beach
        // reserve even when all four block corners are outside it.
        if (seaside && seasideStripContains(seaside, p, 1)) continue;
        if (polygonDistance(p, polygon) < 3.6 + 5) continue;
        if (reservations().some((site) => Math.hypot(p.x - site.x, p.z - site.z) < site.radius + 9)) continue;
        if (!clearsHighways(p, 7.2, 8, ringIndex)) continue;
        parcels.push({ ...p, id: `${id}/${side}:${index}`, blockId: id, yaw: -Math.atan2(dz, dx), zone, width: Math.min(7.2, (length - 14) / columnCount), depth: 8 });
      }
      return parcels;
      };
      const k = (p: Vec2) => key(p);
      const roadCandidates: Array<{ a: Vec2; b: Vec2; arterial: boolean }> = [];
      // 每 3 条网格线一条主干级街道（宽 8），其余为支路。
      polygon.forEach((p, e) => {
        const q = polygon[(e + 1) % polygon.length];
        // 贴着主干道的那条边不再单修一条平行支路：主干道本身就是这排街区的临街道路。
        if (trunkIndex.closerThan(p, 12) && trunkIndex.closerThan(q, 12)) { frontNodes.push(p, q); return; }
        // 裁切线上的边：不修街道（曾在没有主干道的扇区边界上与相邻扇区街网斜交成锐角路口，30 岛 2 → 39）。
        if (onClipLine(p) && onClipLine(q)) { frontNodes.push(p, q); return; }
        // 与主干道/滨海大道近乎平行（<15°）且很近：≤12 视为同一条路不修，≤25 降为支路——不再并排出现两条大路。
        const parallel = parallelPrimaryGap(p, q);
        if (parallel <= 12) { frontNodes.push(p, q); return; }
        roadCandidates.push({ a: p, b: q, arterial: parallel > 25 && (e % 2 === 0 ? j % 3 === 0 : i % 3 === 0) });
      });
      // 地块不能先发布、随后再接受穿设施/落水的街道；拒绝整个边界候选，无部分加边。
      const crowded = roadCandidateCrowding([...edges.values()], roadCandidates);
      if (crowded) {
        roadGenerationDiagnostics.crowdedBlockCandidates += 1;
        if (roadGenerationDiagnostics.examples.length < 4) roadGenerationDiagnostics.examples.push(`${id}/${crowded.candidateIndex} against ${crowded.hostId}`);
        continue; // Neither roads nor block/parcels have been published; no width downgrade.
      }
      if (roadCandidates.length && !commitFixedLink(connectorWorld, roadCandidates).ok) continue;
      blocks.push({ id, districtId: "", ...center, width: du, depth: dv, zone, parcels: [], polygon: polygon.map(k) });
      parcelBuilders.set(id, buildParcels);
    }
  });
  return { zoneFor, blocks, roadGenerationDiagnostics, parcelBuilders, frontNodes };
}
