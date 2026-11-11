/**
 * 路网原语（CITY_PLANNER_V2_SPEC §5.1 / 步 2b-lite）：节点/边表与加边、坐标规范化键的唯一实现。
 *
 * 从 buildPlan 逐字迁出（行为由基线哈希证明）。v2 终态是 network 阶段持有它并对外只暴露
 * 纯函数；本步先让 buildPlan 与 RepairContext 共享同一个 Network 对象，替代 addEdge/key 闭包成员
 * （spec D5：闭包杂物袋 → 数据引用）。
 */
import { roadWidthFor } from "../roadStandard";
import { roadNodeId } from "../roadGeometry";
import type { RoadEdge, RoadNode, Vec2 } from "../cityLayout";
import { classifyRoadSegments } from "./relations";
import { spendPlanningWork, checkPlanningWork, hasPlanningWorkLedger } from "./operationBudget";

export type Network = {
  nodes: Map<string, RoadNode>;
  edges: Map<string, RoadEdge>;
  /** 事务版本号：每次 commitNetwork / commitNetworkPatch 递增；缺省语义恒为 0（旧代码 `version ?? 0`）。 */
  version: number;
  /** Scoped transaction evidence; the solver consumes and clears this journal. */
  patchRemaps?: NetworkRemap[];
};

export type NetworkRemap = {
  nodes: Record<string, string | null>;
  edges: Record<string, string[]>;
  paths: Array<{ before: Vec2[]; after: Vec2[] | null }>;
  positions: Record<string, Vec2>;
};

export const emptyNetwork = (): Network => ({ nodes: new Map(), edges: new Map(), version: 0 });
/** Input guard for the new quadratic self-contact check; not the whole-plan
 * candidate/terrain/clone/cancellation ledger required by U5. */
export const NETWORK_RELINE_CONFIG = { version: 1, maxEdgesPerPatch: 16, maxPointsPerEdge: 256 } as const;

/** 坐标取整到 0.01（路网节点的规范化键）。 */
export const keyOf = (p: Vec2) => ({ x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100 });

/** 加一条路段（端点取整、同 id 不重复）。 */
export function addNetworkEdge(network: Network, a0: Vec2, b0: Vec2, arterial: boolean, bridge = false, primary = false): void {
  const a = keyOf(a0); const b = keyOf(b0);
  const from = roadNodeId(a); const to = roadNodeId(b); if (from === to) return;
  const id = [from, to].sort().join("/");
  network.nodes.set(from, { ...a, id: from }); network.nodes.set(to, { ...b, id: to });
  const approachesDeck = [...network.edges.values()].some((edge) => edge.bridge && [edge.from, edge.to].some((node) => node === from || node === to));
  if (!network.edges.has(id)) network.edges.set(id, { id, from, to, width: roadWidthFor(primary ? "arterial" : arterial ? "collector" : "local"), kind: arterial ? "arterial" : "local", points: [a, b], bridge, structure: bridge ? "deck" : approachesDeck ? "ground-approach" : "ground-road" });
  if (network.edges.get(id)?.bridge) for (const edge of network.edges.values()) if (!edge.bridge && [edge.from, edge.to].some((node) => node === from || node === to)) edge.structure = "ground-approach";
}

// ── 网络优先批次 3：事务式 NetworkPatch（设计 §4.3 / §5B）─────────────────────────────
// 补丁 = 在 baseVersion 之上的一组原子操作（加边、删边、拆边成 T 口）。提交流程：
// 草稿（深拷贝）上应用 → 校验 → 版本匹配 → 一次替换正式网络；任一步失败丢弃草稿，
// 正式网络零改动（失败无副作用，设计 §5A-7）。本批只提供原语与守卫证明，
// connectToNetwork 等调用方的迁移随后分批（迁移期间基线必须保持不变）。

export type NetworkPatch = {
  /** 基于的正式网络版本（乐观锁：提交时 network.version 必须相等）。 */
  baseVersion: number;
  addEdges: Array<{ a: Vec2; b: Vec2; arterial: boolean; bridge?: boolean; primary?: boolean }>;
  removeEdgeIds: string[];
  /** 顺带清掉因此无任何关联边的孤立节点（重锚/裁断的合并残点；桥头落地环批次）。
   *  提交时该节点必须已是草稿里的孤立点（应用全部操作后无任何边引用），否则拒绝。 */
  removeNodeIds?: string[];
  /** 把一条边在 t 点拆成两段（T 口）：保留原边等级/宽度/桥标记，属性继承不丢失。 */
  splits: Array<{ edgeId: string; at: Vec2 }>;
  /** 联合定线后拆边：保持原端点/属性；新形状与拆分必须在同一补丁。 */
  relineSplits?: Array<{ edgeId: string; at: Vec2 }>;
  /** Endpoint-preserving ground corridor replacement. Attributes and edge
   * identity remain unchanged; actual old/new polylines enter the journal. */
  relineEdges?: Array<{ edgeId: string; points: readonly Vec2[] }>;
  /** 微小近接节点合并到已在册节点，重绑全部关联边并保留折线/属性。 */
  rebindNodes?: Array<{ from: string; to: string; targetAt?: Vec2;
    /** 显式合流：只允许同端点直线 ground-road，保留最大路幅与更高等级。 */
    coalesceStraightGround?: boolean }>;
};

export type PatchResult = { ok: true; version: number; remap: NetworkRemap } | { ok: false; reason: "stale-base" | "unknown-edge" | "validation" | "self-loop" | "off-line-split" | "node-in-use"; detail?: string };

// clone 不继承 version：草稿的版本号旧代码里是 undefined（读作 0），显式写 0 保持同一读数。
const clone = (network: Network): Network => {
  if (hasPlanningWorkLedger()) spendPlanningWork("network:clone", { cloneRow: 1 + network.nodes.size + network.edges.size
    + [...network.edges.values()].reduce((total, edge) => total + edge.points.length, 0) });
  return {
    version: 0,
    nodes: new Map([...network.nodes].map(([k, n]) => [k, { ...n }])),
    edges: new Map([...network.edges].map(([k, e]) => [k, { ...e, points: e.points.map((p) => ({ ...p })) }])),
  };
};

/** 在草稿上应用补丁操作（只动草稿）。 */
function applyOps(draft: Network, patch: NetworkPatch, remap: NetworkRemap): PatchResult {
  const replace = (old: string, next: string[]) => {
    for (const id of Object.keys(remap.edges)) remap.edges[id] = remap.edges[id].flatMap((part) => part === old ? next : [part]);
  };
  for (const id of patch.removeEdgeIds) {
    if (!draft.edges.has(id)) return { ok: false, reason: "unknown-edge", detail: id };
    draft.edges.delete(id);
    replace(id, []);
  }
  const relined = new Set<string>();
  if ((patch.relineEdges?.length ?? 0) > NETWORK_RELINE_CONFIG.maxEdgesPerPatch)
    return { ok: false, reason: "validation", detail: "ground corridor replacement edge budget exhausted" };
  for (const replacement of patch.relineEdges ?? []) {
    const host = draft.edges.get(replacement.edgeId);
    if (!host) return { ok: false, reason: "unknown-edge", detail: replacement.edgeId };
    if (Array.isArray(replacement.points) && replacement.points.length > NETWORK_RELINE_CONFIG.maxPointsPerEdge)
      return { ok: false, reason: "validation", detail: "ground corridor replacement point budget exhausted" };
    if (relined.has(host.id) || patch.splits.some(split => split.edgeId === host.id)
      || patch.relineSplits?.some(split => split.edgeId === host.id) || host.bridge || host.structure !== "ground-road"
      || !Number.isFinite(host.width) || host.width <= 0 || host.points.length < 2
      || host.points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.z))
      || !Array.isArray(replacement.points) || replacement.points.length < 2
      || replacement.points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.z)))
      return { ok: false, reason: "validation", detail: "invalid ground corridor replacement" };
    const points = replacement.points.map(keyOf);
    const same = (a: Vec2, b: Vec2) => a.x === b.x && a.z === b.z;
    if (!same(points[0], host.points[0]) || !same(points[points.length - 1], host.points[host.points.length - 1])
      || points.some((point, index) => index > 0 && same(point, points[index - 1])))
      return { ok: false, reason: "validation", detail: "corridor replacement endpoint or zero-length mismatch" };
    for (let i = 1; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
      const relation = classifyRoadSegments(points[i - 1], points[i], points[j - 1], points[j], 0).kind;
      if (relation === "invalid" || relation === "collinear-overlap" || (j > i + 1 &&
        ["interior-crossing", "endpoint-contact", "endpoint-on-edge"].includes(relation)))
        return { ok: false, reason: "validation", detail: "self-contacting corridor replacement" };
    }
    relined.add(host.id);
    host.points = points;
  }
  for (const s of patch.relineSplits ?? []) {
    const host = draft.edges.get(s.edgeId);
    if (!host) return { ok: false, reason: "unknown-edge", detail: s.edgeId };
    if (relined.has(s.edgeId) || patch.splits.some((split) => split.edgeId === s.edgeId)
      || host.bridge || host.structure !== "ground-road" || host.points.length !== 2
      || !Number.isFinite(s.at.x) || !Number.isFinite(s.at.z)) {
      return { ok: false, reason: "validation", detail: "invalid ground reline split" };
    }
    relined.add(s.edgeId);
    host.points = [{ ...host.points[0] }, keyOf(s.at), { ...host.points[1] }];
  }
  for (const s of [...patch.splits, ...(patch.relineSplits ?? [])]) {
    const host = draft.edges.get(s.edgeId);
    if (!host) return { ok: false, reason: "unknown-edge", detail: s.edgeId };
    const at = keyOf(s.at);
    if (roadNodeId(at) === host.from || roadNodeId(at) === host.to) return { ok: false, reason: "self-loop", detail: `split at endpoint of ${s.edgeId}` };
    // 定位实际折线段，不能把首尾弦线当作宿主；拆分后保留全部原转折点。
    let segment = -1; let nearest = Infinity;
    for (let i = 0; i < host.points.length - 1; i += 1) {
      const a = host.points[i]; const b = host.points[i + 1];
      const dx = b.x - a.x; const dz = b.z - a.z; const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.z - a.z) * dz) / l2));
      const off = Math.hypot(a.x + dx * t - at.x, a.z + dz * t - at.z);
      if (off < nearest) { nearest = off; segment = i; }
    }
    if (segment < 0 || nearest > 0.05) return { ok: false, reason: "off-line-split", detail: `split point off ${s.edgeId}` };
    draft.edges.delete(s.edgeId);
    // 属性完整继承（评审 P1-4）：直接按宿主原值构造两半，不走 addNetworkEdge 的 {5,8,12} 宽度映射
    // （宽度 9 曾被重建为 8）。节点注册沿用规范化键。
    const halves: string[] = [];
    const half = (points: Vec2[]) => {
      const u = points[0]; const v = points[points.length - 1];
      const uf = keyOf(u); const vf = keyOf(v);
      const id = [roadNodeId(uf), roadNodeId(vf)].sort().join("/");
      draft.nodes.set(roadNodeId(uf), { ...uf, id: roadNodeId(uf) });
      draft.nodes.set(roadNodeId(vf), { ...vf, id: roadNodeId(vf) });
      if (draft.edges.has(id)) return false;
      const shape = points.map((p) => ({ ...p })); shape[0] = uf; shape[shape.length - 1] = vf;
      draft.edges.set(id, { ...host, id, from: roadNodeId(uf), to: roadNodeId(vf), points: shape });
      halves.push(id);
      return true;
    };
    const same = (p: Vec2) => Math.hypot(p.x - at.x, p.z - at.z) <= 0.000001;
    const left = host.points.slice(0, segment + 1); if (!same(left[left.length - 1])) left.push(at);
    const right = host.points.slice(segment + 1); if (!same(right[0])) right.unshift(at);
    if (!half(left) || !half(right)) return { ok: false, reason: "validation", detail: "split edge identity collision" };
    replace(s.edgeId, halves);
  }
  for (const e of patch.addEdges) {
    addNetworkEdge(draft, e.a, e.b, e.arterial, e.bridge ?? false, e.primary ?? false);
  }
  for (const binding of patch.rebindNodes ?? []) {
    if (binding.targetAt) {
      if (!Number.isFinite(binding.targetAt.x) || !Number.isFinite(binding.targetAt.z)) return { ok: false, reason: "validation", detail: "non-finite relocation target" };
      const at = keyOf(binding.targetAt);
      if (roadNodeId(at) !== binding.to) return { ok: false, reason: "validation", detail: "relocation target identity mismatch" };
      if (!draft.nodes.has(binding.to)) draft.nodes.set(binding.to, { ...at, id: binding.to });
    }
    const source = draft.nodes.get(binding.from), target = draft.nodes.get(binding.to);
    if (!source || !target || binding.from === binding.to) return { ok: false, reason: "node-in-use", detail: "invalid node binding" };
    const incident = [...draft.edges.values()].filter((edge) => edge.from === binding.from || edge.to === binding.from);
    const joinsDeck = [...draft.edges.values()].some((edge) => edge.bridge && (edge.from === binding.to || edge.to === binding.to));
    for (const edge of incident) draft.edges.delete(edge.id);
    for (const edge of incident) {
      const from = edge.from === binding.from ? binding.to : edge.from;
      const to = edge.to === binding.from ? binding.to : edge.to;
      if (from === to) return { ok: false, reason: "self-loop", detail: "node binding collapses an edge" };
      const id = [from, to].sort().join("/");
      const points = edge.points.map((point) => ({ ...point }));
      if (edge.from === binding.from) points[0] = { x: target.x, z: target.z };
      if (edge.to === binding.from) points[points.length - 1] = { x: target.x, z: target.z };
      const rebound = { ...edge, id, from, to, points, structure: edge.bridge ? "deck" as const : joinsDeck ? "ground-approach" as const : edge.structure };
      const existing = draft.edges.get(id);
      if (existing) {
        const straightGround = (road: RoadEdge) => !road.bridge && road.structure === "ground-road" && road.points.length === 2
          && Number.isFinite(road.width) && road.width > 0;
        if (!binding.coalesceStraightGround || !straightGround(existing) || !straightGround(rebound) || existing.purpose !== rebound.purpose
          || !rebound.points.every((point, index) => {
            const other = existing.from === rebound.from ? existing.points[index] : existing.points[1 - index];
            return point.x === other.x && point.z === other.z;
          })) return { ok: false, reason: "validation", detail: "node binding edge identity collision" };
        // Both original lineages now resolve to this physical corridor. Never
        // silently downgrade either original width/class, including width 9.
        draft.edges.set(id, { ...rebound, width: Math.max(existing.width, rebound.width),
          kind: existing.kind === "arterial" || rebound.kind === "arterial" ? "arterial" : "local" });
      } else draft.edges.set(id, rebound);
      replace(edge.id, [id]);
    }
    draft.nodes.delete(binding.from);
    for (const id of Object.keys(remap.nodes)) if (remap.nodes[id] === binding.from) remap.nodes[id] = binding.to;
  }
  // 节点清除放在全部操作之后：此刻仍被引用的节点不许删（调用方对合并残点的判断错了就如实拒绝）。
  for (const id of patch.removeNodeIds ?? []) {
    if (!draft.nodes.has(id)) return { ok: false, reason: "node-in-use", detail: `missing node ${id}` };
    let used = false;
    for (const e of draft.edges.values()) if (e.from === id || e.to === id) { used = true; break; }
    if (used) return { ok: false, reason: "node-in-use", detail: `node ${id} still has edges` };
    draft.nodes.delete(id);
    for (const original of Object.keys(remap.nodes)) if (remap.nodes[original] === id) remap.nodes[original] = null;
  }
  return { ok: true, version: 0, remap };
}

/**
 * 事务提交：baseVersion 不匹配（stale-base）或校验不过 → 正式网络保持原样。
 * validate 在草稿上跑（连通/净空等调用方语义）；拆边保留原边属性是原语承诺。
 */
export function commitNetworkPatch(
  network: Network,
  patch: NetworkPatch,
  validate?: (draft: Network) => string | null,
): PatchResult {
  spendPlanningWork("network:patch", { transaction: 1 });
  if (network.version !== patch.baseVersion) return { ok: false, reason: "stale-base", detail: `base ${patch.baseVersion} != current ${network.version}` };
  const draft = clone(network);
  const remap: NetworkRemap = {
    nodes: Object.fromEntries([...network.nodes.keys()].map((id) => [id, id])),
    edges: Object.fromEntries([...network.edges.keys()].map((id) => [id, [id]])), paths: [], positions: {},
  };
  const applied = applyOps(draft, patch, remap);
  if (!applied.ok) return applied;
  for (const [id, original] of network.edges) {
    const parts = remap.edges[id];
    const unchanged = draft.edges.get(id);
    if (parts.length === 1 && parts[0] === id && unchanged?.points.length === original.points.length
      && unchanged.points.every((point, index) => point.x === original.points[index].x && point.z === original.points[index].z)) continue;
    let cursor = remap.nodes[original.from];
    const points: Vec2[] = [];
    for (const part of parts) {
      const edge = draft.edges.get(part)!;
      const shape = edge.from === cursor ? edge.points : [...edge.points].reverse();
      if (edge.from !== cursor && edge.to !== cursor) return { ok: false, reason: "validation", detail: "disconnected edge remap" };
      points.push(...shape.slice(points.length ? 1 : 0)); cursor = edge.from === cursor ? edge.to : edge.from;
    }
    if (parts.length && cursor !== remap.nodes[original.to]) return { ok: false, reason: "validation", detail: "edge remap endpoint mismatch" };
    const collapsed = remap.nodes[original.from] && remap.nodes[original.from] === remap.nodes[original.to]
      ? draft.nodes.get(remap.nodes[original.from]!) : null;
    remap.paths.push({ before: original.points.map((p) => ({ ...p })), after: parts.length ? points.map((p) => ({ ...p })) : collapsed ? [{ x: collapsed.x, z: collapsed.z }] : null });
  }
  remap.nodes = Object.fromEntries(Object.entries(remap.nodes).filter(([id, next]) => id !== next));
  for (const next of Object.values(remap.nodes)) if (next) {
    const node = draft.nodes.get(next)!; remap.positions[next] = { x: node.x, z: node.z };
  }
  remap.edges = Object.fromEntries(Object.entries(remap.edges).filter(([id, next]) => next.length !== 1 || next[0] !== id));
  const problem = validate?.(draft) ?? null;
  if (problem) return { ok: false, reason: "validation", detail: problem };
  // §4.3「版本匹配后一次替换」：交换前复核（validate 回调不得重入提交同一网络——契约见函数头）。
  if (network.version !== patch.baseVersion) return { ok: false, reason: "stale-base", detail: "version changed during validation" };
  // 批次 4-2：就地清写而非换 Map——buildPlan 顶部解构的 { nodes, edges } 引用在事务提交后仍指向正式网络。
  checkPlanningWork("network:publication");
  network.nodes.clear(); for (const [k, n] of draft.nodes) network.nodes.set(k, n);
  network.edges.clear(); for (const [k, e] of draft.edges) network.edges.set(k, e);
  network.version = network.version + 1;
  network.patchRemaps?.push(remap);
  return { ok: true, version: network.version, remap };
}

/**
 * 暂存网络整体提交：就地清写 nodes/edges（先清 nodes 再填、再清 edges 再填，Map 迭代序与逐项手写完全一致——
 * 确定性 I2），再把 version 加一。就地而非换 Map：buildPlan 顶部解构的 { nodes, edges } 引用提交后仍指向正式网络。
 * 不碰 patchRemaps，也不复核 baseVersion（那是 commitNetworkPatch 的职责）。
 */
export function commitNetwork(network: Network, staged: Network): void {
  network.nodes.clear(); for (const [id, node] of staged.nodes) network.nodes.set(id, node);
  network.edges.clear(); for (const [id, edge] of staged.edges) network.edges.set(id, edge);
  network.version += 1;
}

/** Apply the identical transaction rules without publishing or recording a journal. */
export function previewNetworkPatch(network: Network, patch: NetworkPatch):
  { ok: true; network: Network } | Exclude<PatchResult, { ok: true }> {
  if (network.version !== patch.baseVersion) return { ok: false, reason: "stale-base" };
  const draft = clone(network);
  const result = applyOps(draft, patch, { nodes: {}, edges: {}, paths: [], positions: {} });
  return result.ok ? { ok: true, network: draft } : result;
}
