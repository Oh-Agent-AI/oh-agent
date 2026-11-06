/**
 * 路端语义判定（CITY_NETWORK_FIRST_CODE_DESIGN §2 / 迁移批次 1）：度为 1 的路端是「计划内终点」还是「松断头」。
 *
 * 旧判据用 height ≥ 2.5 当「内陆」代理——本意是豁免靠水断头（滨海/河岸路按设计停在岸边），
 * 副作用是整座平岛的内陆断头对检测与修复全部隐形（2026-10-08 实测：普查四档 75–90% 的岛
 * 至少藏 1 个真断头；t1 的 753 个盲区端里 186 个不属于任何合法豁免类）。
 * 本模块把豁免从地形代理改为语义分类，高度不再参与判定。
 *
 * 合法地面度1节点（不计松断头）：
 *  - 连续桥头：同一实际节点接有桥边和地面边，是道路的结构转换，不是尽端；
 *  - 滨海大道端点：海滨景观带按设计在无效样本（河口、陡岸、港区缺口）处断开、不跨接（citySeaside 段规则）；
 *  - 用地门前终点：主干道到岸边用地门口为止，那一段就是它的入口路；
 *  - 沿海/河岸路的 run 端点：遇主干道/桥头/预留地按设计断开，段端以 T 路口接入路网；
 *  - 近水终止（离海或河道折线 ≤ WATER_STOP_MARGIN）：路到水边自然停止的近似带，
 *    覆盖 run 端邻域、河口与小的合法尽端。
 * 其余度为 1 的路端 = 松断头（looseInlandRoadEnds），与地形高度无关。
 *
 * 批次 1（2026-10-08）：检测（constraints.looseInlandRoadEnds）与修复
 * （networkRepairs 的 pruneShortSpurs / joinNearMissEnds）同批切换到本谓词——只改检测会让
 * 「检测语义化、修复剪地形」两套口径并存，且 solve 守卫的逐约束单调在删边制造平地短枝时
 * 立即打架（实测 seed 1703318715/t2、1703429581/t5）。修复效果：普查松断头
 * t1 45→29 / t3 26→8 / t5 18→8 / t10 7→2，回归 30 岛 65→16。剩余断头由统一连接器批次接手。
 */
import type { RoadEdge, Vec2 } from "../cityLayout";

/** 只有同一真实节点同时接桥边与地面边，才是连续桥头；空间邻近不算。 */
export function bridgeLandingNodes(edges: readonly RoadEdge[]): Set<string> {
  const ground = new Set(edges.filter((edge) => !edge.bridge).flatMap((edge) => [edge.from, edge.to]));
  return new Set(edges.filter((edge) => edge.bridge).flatMap((edge) => [edge.from, edge.to]).filter((id) => ground.has(id)));
}

type IslandGateOwner = Vec2 & { yaw: number; radius?: number; shore?: Vec2;
  access?: { role?: string; nodeId?: string; ownerX?: number; ownerZ?: number; ownerYaw?: number } };

/** An island-side causeway may terminate at its declared owner's gate. This
 * is not a landing or a proximity exemption; callers must first prove that
 * the actual endpoint node exists in the graph. */
export function isOwnedIslandGate(nodeId: string, sites: readonly IslandGateOwner[]): boolean {
  return sites.some((site) => site.shore && Number.isFinite(site.shore.x) && Number.isFinite(site.shore.z)
    && [site.x, site.z, site.yaw, site.radius].every(Number.isFinite) && (site.radius ?? 0) > 0
    && site.access?.role === "plot-gate" && site.access.nodeId === nodeId
    && site.access.ownerX === site.x && site.access.ownerZ === site.z && site.access.ownerYaw === site.yaw);
}

/** 近水终止带宽：沿海/河岸路中心线离水 14–22，端头与 run 端邻域再放宽。 */
export const WATER_STOP_MARGIN = 40;

/** 桥头残桩上限：贴在桥头节点上、比这还短的断头边不是任何人的入口路，只是桥接残留。 */
export const BRIDGEHEAD_STUB_MAX = 6;
/** 桥头残桩的断头端（2026-10-20）：度为 1 的地面边短于 BRIDGEHEAD_STUB_MAX、另一端是连续桥头且该桥头还有
 *  ≥2 条别的地面边。它们会落进「用地门前 r+12 / 近水」等豁免圈而被当成计划内终点——7/2 桥
 *  -16.57:295.97/58.1:308.1 桥尾正前方 2.0 长的残桩就是这样留下的：直行下桥 3 个单位压上人行道，
 *  审计规划器选「最对齐的引道」也选中它。检测（constraints.looseInlandRoadEnds）与删除（pruneShortSpurs）
 *  同用本集合；接驳/延长类修复不传它，免得把残桩反向接长。 */
export function bridgeheadStubEnds(edges: readonly RoadEdge[]): Set<string> {
  const ground = new Map<string, RoadEdge[]>();
  for (const edge of edges) if (!edge.bridge) for (const id of [edge.from, edge.to]) (ground.get(id) ?? ground.set(id, []).get(id)!).push(edge);
  const landings = bridgeLandingNodes(edges);
  const out = new Set<string>();
  for (const [id, list] of ground) {
    if (list.length !== 1) continue;
    const edge = list[0]; const other = edge.from === id ? edge.to : edge.from;
    if (!landings.has(other) || (ground.get(other)?.length ?? 0) < 3) continue;
    let length = 0; for (let k = 1; k < edge.points.length; k += 1) length += Math.hypot(edge.points[k].x - edge.points[k - 1].x, edge.points[k].z - edge.points[k - 1].z);
    if (length < BRIDGEHEAD_STUB_MAX) out.add(id);
  }
  return out;
}

export type PlannedEndInputs = {
  bridgeLandings?: ReadonlySet<string>;
  /** bridgeheadStubEnds：这些断头端不享受任何计划内终点豁免（只有检测与 pruneShortSpurs 传入）。 */
  bridgeheadStubs?: ReadonlySet<string>;
  sites: Array<{ x: number; z: number; radius: number }>;
  /** 滨海大道合法断点（plan.seaside.samples[].boulevard，仅 valid 采样）。 */
  boulevardEnds: Vec2[];
  /** 沿海/河岸路各 run 的首尾点。 */
  coastRoadRunEnds: Vec2[];
  coast: Vec2[];
  river: Vec2[] | null;
  /** 内水岸线（geography.waterEdges：海湾两岸 + 湾内岛轮廓）；缺省视为无。 */
  waterEdges?: Vec2[][];
};

const segDistance = (p: Vec2, a: Vec2, b: Vec2): number => {
  const dx = b.x - a.x; const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
  return Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z);
};

const polylineDistance = (pts: Vec2[], p: Vec2): number => {
  let d = Infinity;
  for (let k = 1; k < pts.length; k += 1) d = Math.min(d, segDistance(p, pts[k - 1], pts[k]));
  return d;
};

/** 度为 1 的路端是否属于计划内终点（见模块头）。除 node 外全部是只读数据，无随机。 */
export function isPlannedRoadEnd(node: Vec2 & { id?: string }, world: PlannedEndInputs): boolean {
  if (world.bridgeheadStubs?.has(node.id ?? `${node.x}:${node.z}`)) return false;
  if (world.bridgeLandings?.has(node.id ?? `${node.x}:${node.z}`)) return true;
  if (world.boulevardEnds.some((b) => Math.hypot(b.x - node.x, b.z - node.z) < 1)) return true;
  if (world.sites.some((s) => Math.hypot(s.x - node.x, s.z - node.z) < s.radius + 12)) return true;
  if (world.coastRoadRunEnds.some((c) => Math.hypot(c.x - node.x, c.z - node.z) < 1)) return true;
  if (polylineDistance(world.coast, node) <= WATER_STOP_MARGIN) return true;
  if (world.river && polylineDistance(world.river, node) <= WATER_STOP_MARGIN) return true;
  if (world.waterEdges?.some((edge) => polylineDistance(edge, node) <= WATER_STOP_MARGIN)) return true;
  return false;
}
