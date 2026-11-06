/**
 * 断头路收尾（R5 第 2 道，CITY_PLANNER_REFACTOR_SPEC §4）：从 buildPlan 逐字迁出，行为由基线哈希证明。
 *
 * 读：network.nodes / network.edges（原地改写，迭代序保持）、publicSites 与 landmarks（只读 x/z/radius）、
 *     coastDistance / inRiver（地理谓词，纯函数）、connectToNetwork（buildPlan 的接入路闭包，原样传入；
 *     它自带 connectSeq 计数器并写同一个 network——调用次数与顺序就是原来的，计数器由闭包持有，不外移）。
 * 写：仅 network.nodes / network.edges（显式原地修改传入的 network，不拷贝、不换对象）；
 *     经 connectToNetwork 的写入同样落在这个 network 上。
 * 无随机、无返回值。
 */
import { atLeast } from "../roadStandard";
import { DetMath as Math } from "../detMath";
import type { PublicSite, RoadEdge, Vec2 } from "../cityLayout";
import type { Network } from "./network";

export type DeadEndParams = {
  publicSites: readonly PublicSite[];
  landmarks: readonly (Vec2 & { radius: number })[];
  coastDistance: (x: number, z: number) => number;
  inRiver: (x: number, z: number) => boolean;
  connectToNetwork: (endpoint: Vec2, maxDistance: number, arterial: boolean, exclude?: (edge: RoadEdge) => boolean, minAngle?: number) => boolean;
};

// ── 断头路收尾（30 岛实测 ~390 个断头，多为环岛/河岸路段端与被切断的碎段）：
// 每个非入口、非岸边自然终点的断头：沿其悬挂链走到最近的路口，先尝试按 localConstraints 接回路网，
// 接不上且整条悬挂链很短（主干 <40、其余 <30）就删掉——不留通往空地的小尾巴。
export function finishDeadEnds(network: Network, { publicSites, landmarks, coastDistance, inRiver, connectToNetwork }: DeadEndParams): void {
  const { nodes, edges } = network;
  const sitesForGate = [...publicSites, ...landmarks].filter((site) => site.radius);
  const degree = () => { const d = new Map<string, number>(); for (const e of edges.values()) for (const n of [e.from, e.to]) d.set(n, (d.get(n) ?? 0) + 1); return d; };
  for (let pass = 0; pass < 3; pass += 1) {
    const deg = degree();
    const ends = [...nodes.values()].filter((n) => deg.get(n.id) === 1);
    for (const end of ends) {
      if (!nodes.has(end.id) || degree().get(end.id) !== 1) continue;
      if (sitesForGate.some((site) => Math.hypot(site.x - end.x, site.z - end.z) < site.radius + 60)) continue; // 用地入口（门前接入点可能内移到岸滩以外，60 内都算）
      if (coastDistance(end.x, end.z) < 30 || inRiver(end.x, end.z)) continue;                              // 通到海边/河边的自然终点
      // 悬挂链：从断头一路走到度 ≠ 2 的节点。
      const chain: RoadEdge[] = []; let cursor = end.id; let length = 0; const d2 = degree();
      for (let guard = 0; guard < 64; guard += 1) {
        const next = [...edges.values()].find((e) => (e.from === cursor || e.to === cursor) && !chain.includes(e));
        if (!next) break;
        chain.push(next); length += Math.hypot(next.points[1].x - next.points[0].x, next.points[1].z - next.points[0].z);
        cursor = next.from === cursor ? next.to : next.from;
        if (d2.get(cursor) !== 2) break;
      }
      const wide = chain.some((e) => atLeast(e, "arterial"));
      if (connectToNetwork(end, wide ? 120 : 60, false, (edge) => chain.includes(edge), 45)) continue;
      if (chain.some((e) => e.bridge || [...edges.values()].some((b) => b.bridge && [b.from, b.to].some((id) => id === e.from || id === e.to))) || length >= (wide ? 40 : 30)) continue;
      for (const e of chain) edges.delete(e.id);
      nodes.delete(end.id);
    }
  }
  for (const id of [...nodes.keys()]) if (![...edges.values()].some((e) => e.from === id || e.to === id)) nodes.delete(id);
}
