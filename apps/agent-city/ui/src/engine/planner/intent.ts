/**
 * 网络优先设计批次 2（CITY_NETWORK_FIRST_CODE_DESIGN §3 / 迁移批次 2）：意图层只读诊断。
 *
 * 本批只建立「该连谁」的检测：ConnectionDemand（哪些区域/设施必须互通）、EndpointRole
 * （每个度为 1 的路端属于谁/为什么合法）、主网定义（primaryComponentId = 含 civic/plaza
 * 骨架节点的连通分量）。「怎么合法连接」属于批次 3+ 的统一连接器——本模块**不改动任何
 * 网络状态**（守卫用前后深比较证明），unmet 只进诊断，不触发补路。
 *
 * 生产用地承诺在骨架前声明，求解器持续保留需求目录及显式重绑证据。未迁移调用方仍能
 * 后验派生；街区/必要走廊/冗余的先验声明尚待完整迁移。诊断本身保持只读。
 */
import type { Vec2 } from "../cityLayout";
import type { CityPlan } from "./constraints";
import { bridgeLandingNodes, isPlannedRoadEnd, WATER_STOP_MARGIN } from "./endpoints";
import { polylineDistance } from "./footprint";
import type { NetworkRemap } from "./network";

/** 度为 1 路端的角色（设计 §3：角色携带所有权或需求引用）。 */
export type EndpointRole =
  | { kind: "bridge-landing"; bridgeIds: string[] }
  | { kind: "site-access"; ownerId: string }
  | { kind: "cul-de-sac"; reason: "coast" | "planned-local" | "terrain" }
  | { kind: "must-connect"; demandId: string };

/** 必须互通的需求（设计 §3 ConnectionDemand 的诊断子集；corridor/redundancy 留给批次 4+）。 */
export type ConnectionDemand = {
  id: string;
  class: "district-access" | "site-access" | "coastal-link" | "endpoint-access";
  required: boolean;
  /** 需求锚点（分量 id / 用地 id / 沿海路段序号），仅供诊断输出定位。 */
  anchor: string;
  /** Original binding evidence; identity remains id when an explicit remap moves it. */
  originAnchor?: string;
};

export type EndpointDiagnostic = { node: string; at: Vec2; role: EndpointRole };
export type DemandDiagnostic = { demand: ConnectionDemand; satisfied: boolean; reason?: string };
export type NetworkDiagnostics = {
  primaryComponentId: string;
  demands: DemandDiagnostic[];
  endpoints: EndpointDiagnostic[];
  /** 未满足的 required 需求（影子指标：不 gating 质量，gating 检测本身完整）。 */
  unmet: Array<{ demandId: string; reason: string }>;
};

type Site = { id?: string; kind: string; x: number; z: number; radius: number };

/** 意图诊断实际消费的 plan 结构子集（structural typing）：createCityPlan 的完整产物满足，
 *  cityPlan 组装中的中间产物（尚未补 scaleTier/biome 等外层字段）也满足——形态批 §5-3
 *  在 buildPlan 末尾直接取 cul-de-sac 端点而无需等外层包装。 */
export type NetworkIntentPlan = Pick<CityPlan, "roadNodes" | "roadEdges" | "publicSites" | "landmarks" | "seaside" | "coastRoads" | "riverRoadRuns" | "coast" | "river" | "core"> & { waterEdges?: Vec2[][]; primaryAnchorNodeId?: string | null; siteObligations?: Array<{ ownerId: string; placed: boolean; reason?: string }>; demandCatalogue?: readonly ConnectionDemand[] };

/** 连通分量（桥计入连通——车能过桥）。返回 node id → 分量 id（复用 roadNodeId 作分量代表）。 */
export function componentOf(plan: NetworkIntentPlan): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; let c = x; while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; } return r; };
  for (const n of plan.roadNodes) parent.set(n.id, n.id);
  for (const e of plan.roadEdges) { const ra = find(e.from); const rb = find(e.to); if (ra !== rb) parent.set(ra, rb); }
  const comp = new Map<string, string>();
  for (const n of plan.roadNodes) comp.set(n.id, find(n.id));
  return comp;
}

/** 主网 = 含 civic/plaza 骨架节点的分量：取离核心最近的路端（环岛节点围绕核心，半径 52；
 *  无任何路端时返回 null —— civic 骨架缺失，按设计属于规划失败，这里只作诊断输出）。 */
export function primaryComponentId(plan: NetworkIntentPlan, comp: Map<string, string>): string | null {
  // 新生产产物必须消费骨架锚点；显式缺失/已删除不退回最近支路。
  if (plan.primaryAnchorNodeId !== undefined) return plan.primaryAnchorNodeId ? comp.get(plan.primaryAnchorNodeId) ?? null : null;
  let best: { id: string; d: number } | null = null;
  for (const n of plan.roadNodes) {
    const d = Math.hypot(n.x - plan.core.x, n.z - plan.core.z);
    if (!best || d < best.d || (d === best.d && n.id < best.id)) best = { id: n.id, d };
  }
  return best ? (comp.get(best.id) ?? null) : null;
}

/** 后验派生需求：非主网分量要接主网（district-access）、每个用地要有门前路（site-access）、
 *  每段沿海/河岸路要挂进主网（coastal-link）。id 稳定（分量代表 id / 用地 id / 段序号）。 */
export function districtDemands(comp: Map<string, string>, primary: string): ConnectionDemand[] {
  return [...new Set(comp.values())].filter((c) => c !== primary).sort().map((c) => ({ id: `district:${c}`, class: "district-access", required: true, anchor: c }));
}

export function deriveDemands(plan: NetworkIntentPlan, comp: Map<string, string>, primary: string): ConnectionDemand[] {
  const demands: ConnectionDemand[] = districtDemands(comp, primary);
  const sites = [...plan.publicSites, ...plan.landmarks].filter((s) => s.radius) as Site[];
  for (const s of sites) demands.push({ id: `site:${s.id ?? s.kind}`, class: "site-access", required: true, anchor: s.id ?? s.kind });
  for (const obligation of plan.siteObligations ?? []) if (!sites.some((s) => s.id === obligation.ownerId)) demands.push({ id: `site:${obligation.ownerId}`, class: "site-access", required: true, anchor: obligation.ownerId });
  [...(plan.coastRoads ?? []), ...(plan.riverRoadRuns ?? [])].forEach((_run, i) => demands.push({ id: `coastal:${i}`, class: "coastal-link", required: true, anchor: `run ${i}` }));
  for (const endpoint of classifyEndpoints(plan, comp, primary)) if (endpoint.role.kind === "must-connect"
    && endpoint.role.demandId.startsWith("endpoint:")) demands.push({ id: endpoint.role.demandId,
      class: "endpoint-access", required: true, anchor: endpoint.node });
  return demands;
}

/** 需求满足判定（与现有约束同口径，避免第二套标准）：
 *  district-access = 分量并入主网；site-access = siteWithoutDoorRoad 同判据（最近路含桥，
 *  离占地边缘 ≤ 20——岸边地标门口直接起桥也算，sail-opera 的堤道即此类）；
 *  coastal-link = 海段（plan.coastRoads 仅含海段）任一端挂进主网；河岸段端由近水豁免兜底
 *  （宽河超 40 的分歧记为批次 3 债务：coastRoads 与修复期 coastRoadRunEnds 的切片口径要统一）。 */
export function evaluateDemands(plan: NetworkIntentPlan, comp: Map<string, string>, primary: string, demands: ConnectionDemand[]): DemandDiagnostic[] {
  const sites = [...plan.publicSites, ...plan.landmarks].filter((s) => s.radius) as Site[];
  return demands.map((d) => {
    if (d.class === "endpoint-access") {
      const degree = plan.roadEdges.filter((edge) => !edge.bridge && (edge.from === d.anchor || edge.to === d.anchor)).length;
      const satisfied = degree >= 2 && comp.get(d.anchor) === primary;
      return { demand: d, satisfied, reason: satisfied ? undefined : "required road endpoint has no accepted continuation on the primary network" };
    }
    if (d.class === "district-access") {
      const satisfied = comp.get(d.anchor) === primary;
      return { demand: d, satisfied, reason: satisfied ? undefined : "component not merged into the primary network" };
    }
    if (d.class === "site-access") {
      const s = sites.find((x) => (x.id ?? x.kind) === d.anchor)!;
      if (!s) return { demand: d, satisfied: false, reason: plan.siteObligations?.find((o) => o.ownerId === d.anchor)?.reason ?? "required site unplaced" };
      const access = (s as Site & { access?: import("./jointSite").PlotAccess }).access;
      if (access) {
        const unchanged = s.x === access.ownerX && s.z === access.ownerZ && (s as Site & { yaw?: number }).yaw === access.ownerYaw;
        const attached = unchanged && comp.get(access.nodeId) === primary;
        return { demand: d, satisfied: attached, reason: attached ? undefined : "declared plot entrance moved or detached from primary network" };
      }
      // 评审 P1-2：近旁有路 ≠ 可达——必须绑定到主网分量（含桥，门口起桥也是门前有路；
      // 车站旁只有孤立环路时曾误报满足）。
      let best: { d: number; onPrimary: boolean } | null = null;
      for (const e of plan.roadEdges) {
        const d0 = polylineDistance([e.points], s);
        const onPrimary = comp.get(e.from) === primary || comp.get(e.to) === primary;
        // 主网道路独立取最小距离；孤立近路不能掩盖稍远但合格的主网接入。
        if (!best || (onPrimary && !best.onPrimary) || (onPrimary === best.onPrimary && d0 < best.d)) best = { d: d0, onPrimary };
      }
      const near = best?.d ?? Infinity;
      const satisfied = near <= s.radius + 20 && !!best?.onPrimary;
      return { demand: d, satisfied, reason: satisfied ? undefined : best?.onPrimary ? `no road within radius+20 of the plot edge (nearest centre distance ${Math.round(near)})` : `nearest road is not on the primary network (d ${Math.round(near)})` };
    }
    const run = [...(plan.coastRoads ?? []), ...(plan.riverRoadRuns ?? [])][Number(d.anchor.replace("run ", ""))] ?? [];
    // 挂接判定按几何邻接（run 折线点与节点 id 的浮点键不稳定）：任一端 1 单位内有主网分量节点。
    const primaryNodes = plan.roadNodes.filter((n) => comp.get(n.id) === primary);
    const attached = [run[0], run[run.length - 1]].some((end: Vec2 | undefined) => end && primaryNodes.some((n) => Math.hypot(n.x - end.x, n.z - end.z) < 1));
    return { demand: d, satisfied: attached, reason: attached ? undefined : "coastal run end not attached to the primary network" };
  });
}

/** Rebind evidence, not identity. Only explicit transaction journals authorize
 * replacing an old node; spatial proximity and new component IDs do not. */
export function remapDemandNode(id: string, remaps: readonly NetworkRemap[]): string | null {
  let current: string | null = id;
  for (const remap of remaps) {
    if (current === null) break;
    if (Object.prototype.hasOwnProperty.call(remap.nodes, current)) current = remap.nodes[current];
  }
  return current;
}

/** All old required obligations survive an individual repair, including unmet
 * ones. This is transaction-boundary retention, not the prior demand catalogue. */
export function retainRepairDemands(before: NetworkIntentPlan, after: NetworkIntentPlan, remaps: readonly NetworkRemap[] = []): {
  demands: DemandDiagnostic[]; reason?: string;
} {
  const previous = diagnoseNetwork(before);
  if (!previous) return { demands: [], reason: "required primary network evidence missing" };
  const comp = componentOf(after), primary = primaryComponentId(after, comp);
  if (!primary) return { demands: [], reason: "required primary network evidence lost" };
  const retained: ConnectionDemand[] = [];
  for (const { demand } of previous.demands) {
    if (!demand.required) continue;
    let anchor = demand.anchor;
    if (demand.class === "endpoint-access" || demand.class === "district-access") {
      const next = remapDemandNode(anchor, remaps);
      if (!next || !comp.has(next)) return { demands: [], reason: `required demand binding removed: ${demand.id}` };
      anchor = next;
    } else if (demand.class === "site-access") {
      const exists = [...after.publicSites, ...after.landmarks].some((site) => (site.id ?? site.kind) === anchor && site.radius)
        || after.siteObligations?.some((obligation) => obligation.ownerId === anchor);
      if (!exists) return { demands: [], reason: `required demand owner removed: ${demand.id}` };
    } else {
      const run = [...(after.coastRoads ?? []), ...(after.riverRoadRuns ?? [])][Number(anchor.replace("run ", ""))];
      if (!run?.length) return { demands: [], reason: `required coastal run removed: ${demand.id}` };
    }
    retained.push({ ...demand, anchor });
  }
  return { demands: evaluateDemands(after, comp, primary, retained) };
}

/** 每个度为 1 的非桥路端一个角色（与 endpoints.isPlannedRoadEnd 同一豁免口径）：
 *  门前终点 → site-access（带 ownerId）；滨海大道断点 → cul-de-sac(planned-local)（海滨段规则：
 *  无效样本处断开、不跨接）；沿海/河岸路段端 → must-connect（挂对应 coastal-link 需求）；
 *  近水终止 → cul-de-sac(coast)；其余 → must-connect（挂所在分量的 district-access 需求）。 */
export function classifyEndpoints(plan: NetworkIntentPlan, comp: Map<string, string>, primary: string): EndpointDiagnostic[] {
  const deg = new Map<string, number>();
  for (const e of plan.roadEdges) if (!e.bridge) for (const id of [e.from, e.to]) deg.set(id, (deg.get(id) || 0) + 1);
  const nodes = new Map(plan.roadNodes.map((n) => [n.id, n]));
  const sites = [...plan.publicSites, ...plan.landmarks].filter((s) => s.radius) as Site[];
  const boulevardEnds = (plan.seaside?.samples ?? []).filter((s: { valid: boolean; boulevard?: Vec2 }) => s.valid && s.boulevard).map((s: { boulevard?: Vec2 }) => s.boulevard!);
  const coastRoadRuns = [...(plan.coastRoads ?? []), ...(plan.riverRoadRuns ?? [])];
  const out: EndpointDiagnostic[] = [];
  const landings = bridgeLandingNodes(plan.roadEdges);
  for (const [id, d] of deg) {
    if (d !== 1) continue;
    const q = nodes.get(id);
    if (!q) continue;
    let role: EndpointRole;
    const site = sites.find((s) => Math.hypot(s.x - q.x, s.z - q.z) < s.radius + 12);
    const coastRunEnd = coastRoadRuns.findIndex((run) => [run[0], run[run.length - 1]]
      .some((end) => end && Math.hypot(end.x - q.x, end.z - q.z) < 1));
    if (landings.has(id)) role = { kind: "bridge-landing", bridgeIds: plan.roadEdges.filter((edge) => edge.bridge && (edge.from === id || edge.to === id)).map((edge) => edge.id).sort() };
    else if (site) role = { kind: "site-access", ownerId: site.id ?? site.kind };
    else if (boulevardEnds.some((b) => Math.hypot(b.x - q.x, b.z - q.z) < 1)) role = { kind: "cul-de-sac", reason: "planned-local" };
    else if (coastRunEnd >= 0) role = { kind: "must-connect", demandId: `coastal:${coastRunEnd}` };
    else if (isPlannedRoadEnd(q, { sites, boulevardEnds, coastRoadRunEnds: [], coast: plan.coast ?? [], river: plan.river ?? null, waterEdges: plan.waterEdges ?? [] })) role = { kind: "cul-de-sac", reason: "coast" };
    else role = { kind: "must-connect", demandId: `endpoint:${id}` };
    out.push({ node: id, at: { x: q.x, z: q.z }, role });
  }
  return out;
}

/** 汇总诊断（只读：不触碰 plan 的任何字段）。 */
export function diagnoseNetwork(plan: NetworkIntentPlan): NetworkDiagnostics | null {
  const comp = componentOf(plan);
  const primary = primaryComponentId(plan, comp);
  if (!primary) return null;
  const demands = collectDemandCatalogue(plan, comp, primary);
  const evaluated = evaluateDemands(plan, comp, primary, demands);
  return {
    primaryComponentId: primary,
    demands: evaluated,
    endpoints: classifyEndpoints(plan, comp, primary),
    unmet: evaluated.filter((d) => d.demand.required && !d.satisfied).map((d) => ({ demandId: d.demand.id, reason: d.reason ?? "unmet" })),
  };
}

/** Retained commitments precede new observations. Binding deduplication avoids
 * inventing a second endpoint demand after a legitimate node remap. */
export function collectDemandCatalogue(plan: NetworkIntentPlan, comp: Map<string, string>, primary: string): ConnectionDemand[] {
  const demands = (plan.demandCatalogue ?? []).map((demand) => ({ ...demand }));
  for (const demand of deriveDemands(plan, comp, primary)) if (!demands.some((old) => old.id === demand.id
    || (old.class === demand.class && old.anchor === demand.anchor)
    || (old.class === "district-access" && demand.class === "district-access" && comp.has(old.anchor)
      && comp.get(old.anchor) === comp.get(demand.anchor)))) demands.push({ ...demand, originAnchor: demand.anchor });
  return demands;
}

export { WATER_STOP_MARGIN };
