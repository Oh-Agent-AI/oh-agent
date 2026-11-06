/**
 * 尽端环路（lollipop service loop）专用遍（G 批 2026-10-08，CITY_NETWORK_FIRST_CODE_DESIGN §4.1 形态档）。
 *
 * 对象：「包含/紧邻用地服务环的孤立分量」——体育场/公园类的环形服务路不接主网、通向用地的
 * 路断头（用户截图 ②）。统一连接器的孤立分量阶梯（direct、merge、detour、A*、bridge）按「成员离
 * 主干最近」选起点，对环状分量不保证入口落在环上、也不约束入口与环的夹角；本遍在连接器之后
 * 收口残余：以**单入口**（一根入口路）把服务环接入主网，环保持闭环——尽端环路（lollipop）形态。
 *
 * 判据（版本化 LOOP_CONFIG，禁散落默认数值）：
 *   1. 分量仍孤立（不在主网分量内）且非桥边数 ≥ minComponentEdges；
 *   2. 「服务环签名」二选一：
 *     a. 分量内有度=2 闭环（诱导子图上封闭链，即纯环——环上每点恰好两条环边），且环上某点
 *        距某预留地中心 ≤ radius + siteProximity；
 *     b. 分量非桥边全部为窄服务路（宽 < 8，无主干级），且分量某点距某预留地中心 ≤ radius + siteProximity。
 *
 * 入口路（stick）：入口候选按（到主网节点距离, 节点 id）确定性排序，逐个经统一连接器的
 * direct-projection 提议——落点为主网最近边（中段落点 split 成 T 口，属性继承），走廊过
 * corridorFailure 地面校验（水/坡/用地/交叉，§5A-1 安全优先于连通）；环侧入口角 ≥ entryAngleDeg
 * 由本遍在提议后复核（连接器的 endpointClear 是 35° 历史口径，lollipop 收紧到 60°）。
 * 提议与提交分离（propose → 角度复核 → commit）：角度不过不提交，换下一候选。
 * 全部候选失败 → connectionLog 记原因（water-span/junction-angle/...），不静默（§4.3）。
 *
 * 确定性：无随机、无墙钟；分量按 root id、候选按 (距离, id) 排序；失败零副作用（§5A-7）。
 */
import { roadWidthFor } from "../roadStandard";
import { DetMath as Math } from "../detMath";
import { roadNodeId } from "../roadGeometry";
import type { RoadEdge, RoadNode, Vec2 } from "../cityLayout";
import { keyOf, type Network } from "./network";
import { commitConnection, proposeConnection, type ConnectionAttempt, type ConnectorWorld } from "./connect";
import { districtDemands } from "./intent";

/** 版本化尽端环路配置（数值在守卫合成场景中标定）。 */
export const LOOP_CONFIG = {
  version: 1,
  minComponentEdges: 6,   // 孤立分量 ≥6 边才可能是服务环（更小的是碎枝，归断头收尾管）
  siteProximity: 40,      // 服务环/窄路网距用地中心 ≤ radius+40（体育场/公园服务环的邻接带）
  entryAngleDeg: 60,      // 环侧入口角下限（主网侧由 minAngleDeg 同档；守卫断言两侧 ≥60°）
  maxEntryLength: 300,    // 入口路长上限（与孤立分量严格档 220/放宽档 400 同量级）
  entryCandidates: 12,    // 每分量入口候选上限（环通常 ≤12 点；全窄分量按距主网取头部）
};

/** 度=2 闭环检测：分量内度=2 节点的诱导子图，连通块内每点恰有两个度=2 邻居 = 封闭环。
 *  返回闭环的节点 id 列表（按 id 排序，确定性）。纯环（体育场服务环）满足；带枝的环不满足
 *  （枝根度 ≥3）——那是「全窄」分支的管辖。 */
export function degreeTwoCycles(members: RoadNode[], compEdges: RoadEdge[]): string[][] {
  const deg = new Map<string, number>();
  for (const e of compEdges) for (const id of [e.from, e.to]) deg.set(id, (deg.get(id) ?? 0) + 1);
  const adj = new Map<string, string[]>();
  const ring = members.filter((m) => deg.get(m.id) === 2).map((m) => m.id).sort();
  const inRing = new Set(ring);
  for (const e of compEdges) {
    if (!inRing.has(e.from) || !inRing.has(e.to)) continue;
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
    (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e.from);
  }
  const seen = new Set<string>();
  const cycles: string[][] = [];
  for (const start of ring) {
    if (seen.has(start)) continue;
    const block: string[] = [start]; seen.add(start);
    for (let i = 0; i < block.length; i += 1) for (const next of adj.get(block[i]) ?? []) {
      if (!seen.has(next)) { seen.add(next); block.push(next); }
    }
    if (block.every((id) => (adj.get(id)?.length ?? 0) === 2)) cycles.push(block.sort());
  }
  return cycles;
}

/** 源点处入口角：toward 方向与该点每条非桥边的夹角 ≥ minDeg（lollipop 棒与环的夹角下限）。 */
function entryAngleAt(network: Network, source: Vec2, toward: Vec2, minDeg: number): boolean {
  const id = roadNodeId(keyOf(source));
  const ux = toward.x - source.x; const uz = toward.z - source.z; const ul = Math.hypot(ux, uz) || 1;
  for (const edge of network.edges.values()) {
    if (edge.bridge || (edge.from !== id && edge.to !== id)) continue;
    const other = edge.from === id ? edge.points[edge.points.length - 1] : edge.points[0];
    const vx = other.x - source.x; const vz = other.z - source.z; const vl = Math.hypot(vx, vz) || 1;
    if ((ux * vx + uz * vz) / (ul * vl) > Math.cos((minDeg * Math.PI) / 180)) return false;
  }
  return true;
}

/** 服务环签名：判据 2a（度=2 闭环且贴近某用地）或 2b（全窄服务路且贴近某用地）。 */
function serviceLoopSignature(
  members: RoadNode[],
  compEdges: RoadEdge[],
  sites: Array<{ x: number; z: number; radius: number }>,
): { entryPool: string[]; kind: "ring" | "narrow" } | null {
  const nearSite = (id: string) => {
    const n = members.find((m) => m.id === id)!;
    return sites.some((site) => Math.hypot(n.x - site.x, n.z - site.z) <= site.radius + LOOP_CONFIG.siteProximity);
  };
  for (const cycle of degreeTwoCycles(members, compEdges)) {
    if (cycle.some(nearSite)) return { entryPool: cycle, kind: "ring" };
  }
  if (compEdges.length && compEdges.every((e) => e.width < roadWidthFor("collector")) && members.some((m) => nearSite(m.id))) {
    return { entryPool: members.map((m) => m.id), kind: "narrow" };
  }
  return null;
}

/**
 * 尽端环路遍：连接器孤立分量处理之后的专用收口。返回接入数；失败进 log（不静默）。
 * world.network 就地事务提交（commitNetworkPatch：草稿验证 → 版本匹配 → 一次替换）。
 */
export function connectServiceLoops(opts: {
  world: ConnectorWorld;
  core: Vec2;
  primaryAnchorNodeId?: string | null;
  log?: ConnectionAttempt[];
}): number {
  const { world, core, log } = opts;
  const { network } = world;
  const sites = world.reservations();
  const nodeOf = (id: string) => network.nodes.get(id);
  // 分量快照 + 主网锚点（与 buildPlan 孤立分量段同规则：主网 = 离核心最近节点所在分量）。
  const snapshot = () => {
    const parent = new Map<string, string>();
    const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; let c = x; while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; } return r; };
    for (const id of network.nodes.keys()) parent.set(id, id);
    for (const edge of network.edges.values()) { const ra = find(edge.from); const rb = find(edge.to); if (ra !== rb) parent.set(ra, rb); }
    let primaryNodeId: string | null = opts.primaryAnchorNodeId ?? null; let primaryDist = Infinity;
    if (opts.primaryAnchorNodeId === undefined) for (const node of network.nodes.values()) { const d = Math.hypot(node.x - core.x, node.z - core.z); if (d < primaryDist || (d === primaryDist && node.id < primaryNodeId!)) { primaryDist = d; primaryNodeId = node.id; } }
    if (primaryNodeId && !network.nodes.has(primaryNodeId)) primaryNodeId = null;
    return { find, primaryRoot: primaryNodeId ? find(primaryNodeId) : null };
  };
  let state = snapshot();
  if (!state.primaryRoot) return 0;
  // 分量按 root id 排序（确定性；root 是分量内某节点 id，Map 迭代序不参与判定）。
  const groups = new Map<string, RoadNode[]>();
  for (const node of network.nodes.values()) { const r = state.find(node.id); const list = groups.get(r); if (list) list.push(node); else groups.set(r, [node]); }
  const required = new Set(districtDemands(new Map([...network.nodes.keys()].map((id) => [id, state.find(id)])), state.primaryRoot).filter((d) => d.required).map((d) => d.anchor));
  let connected = 0;
  for (const [root, members] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!required.has(root)) continue;
    if (state.find(members[0].id) === state.primaryRoot) continue; // 此前候选的提交已把它并入主网
    const memberSet = new Set(members.map((m) => m.id));
    const compEdges = [...network.edges.values()].filter((e) => memberSet.has(e.from) && memberSet.has(e.to) && !e.bridge);
    if (compEdges.length < LOOP_CONFIG.minComponentEdges) continue;
    const signature = serviceLoopSignature(members, compEdges, sites);
    if (!signature) continue; // 非服务环形态（混合等级的街区残片等）：不属于本遍，不接、不记
    const primaryNodes = [...network.nodes.values()].filter((n) => state.find(n.id) === state.primaryRoot);
    const candidates = signature.entryPool
      .map((id) => {
        const node = nodeOf(id)!;
        let d = Infinity;
        for (const p of primaryNodes) d = Math.min(d, Math.hypot(node.x - p.x, node.z - p.z));
        return { id, node, d };
      })
      .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1))
      .slice(0, LOOP_CONFIG.entryCandidates);
    for (const cand of candidates) {
      const request = {
        id: `loop:${root}:${cand.id}`,
        source: cand.node,
        target: { kind: "primary", isPrimaryNode: (id: string) => state.find(id) === state.primaryRoot },
        purpose: "district-access",
        allowBridge: false,
        maxLength: LOOP_CONFIG.maxEntryLength,
        roadClass: "local",
        minAngleDeg: LOOP_CONFIG.entryAngleDeg,
      } as const;
      const attempt = (ok: boolean, over: Partial<ConnectionAttempt> = {}) => { if (log) log.push({ id: request.id, purpose: "district-access", ok, strategy: ok ? "direct-projection" : undefined, ...over }); };
      const proposed = proposeConnection(request, world, { strategies: ["direct-projection"] });
      if (!proposed.ok) { attempt(false, { reason: proposed.reason, detail: `${signature.kind}: ${proposed.detail ?? ""}` }); continue; }
      // 环侧入口角 ≥60°（复核在提交前：角度不过不提交，换下一候选——提议与提交分离）。
      const stick = proposed.patch.addEdges[0];
      if (!entryAngleAt(network, cand.node, stick.b, LOOP_CONFIG.entryAngleDeg)) { attempt(false, { reason: "junction-angle", detail: `${signature.kind}: stick meets the service loop under ${LOOP_CONFIG.entryAngleDeg}deg` }); continue; }
      const committed = commitConnection(world, proposed);
      if (!committed.ok) { attempt(false, { reason: committed.reason === "stale-base" ? "stale-base" : "projection-loss", detail: `commit: ${committed.reason}: ${committed.detail ?? ""}` }); continue; }
      attempt(true);
      connected += 1;
      state = snapshot(); // 提交改了图：并查集/主网重算（后续分量按新图判定「仍孤立」）
      break; // 单入口：一个分量只接一根入口路（lollipop），接上即止
    }
  }
  return connected;
}
