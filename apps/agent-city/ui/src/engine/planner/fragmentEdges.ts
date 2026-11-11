/**
 * 碎边合并（R5 第 1 道，CITY_PLANNER_REFACTOR_SPEC §4）：从 buildPlan 逐字迁出，行为由基线哈希证明。
 *
 * 读：network.nodes / network.edges（原地改写，迭代序保持）、publicSites（只读 access.nodeId）、
 *     primaryAnchorNodeIds（只读）。addEdge = addNetworkEdge(network, …)，与 buildPlan 里的薄包装同义。
 * 写：仅 network.nodes / network.edges（显式原地修改传入的 network，不拷贝、不换对象）。
 * 无随机、无返回值。
 */
import { atLeast, roadWidthFor } from "../roadStandard";
import { DetMath as Math } from "../detMath";
import type { PublicSite, Vec2 } from "../cityLayout";
import { addNetworkEdge, type Network } from "./network";

export type FragmentEdgeParams = {
  publicSites: readonly PublicSite[];
  primaryAnchorNodeIds: readonly string[];
};

// ── 碎边合并：长度 <5 的非桥路段把两端并成一个节点。接入路吸附到离已有路口几单位处时会留下 0–4 长的碎边，
// 与广场环路等形成 <30° 的「锐角路口」（30 岛中 10 个锐角全部是这种形状）。
export function mergeFragmentEdges(network: Network, { publicSites, primaryAnchorNodeIds }: FragmentEdgeParams): void {
  const { nodes, edges } = network;
  const addEdge = (a0: Vec2, b0: Vec2, arterial: boolean, bridge = false, primary = false) => addNetworkEdge(network, a0, b0, arterial, bridge, primary);
  const sliverSkip = new Set<string>();
  const declaredEntranceNodes = new Set(publicSites.flatMap((site) => site.access ? [site.access.nodeId] : []));
  for (let pass = 0; pass < 50; pass += 1) {
    // 宽 12 的骨架（海滨大道按 ~15 细分、段间可能 <5）不合并：并掉会打断大道的车流回路（seaside 守卫）。
    const sliver = [...edges.values()].find((e) => !sliverSkip.has(e.id) && !declaredEntranceNodes.has(e.from) && !declaredEntranceNodes.has(e.to) && !e.bridge && e.width < roadWidthFor("arterial") && Math.hypot(e.points[1].x - e.points[0].x, e.points[1].z - e.points[0].z) < 5);
    if (!sliver) break;
    // 保留挂着骨架（宽 12）的那一端：并掉海滨大道端点会让大道车流回路引用不存在的节点（seaside 守卫 10 档）。
    const touchesPrimary = (id: string) => [...edges.values()].some((e) => e !== sliver && atLeast(e, "arterial") && (e.from === id || e.to === id));
    const fromPrimary = touchesPrimary(sliver.from); const toPrimary = touchesPrimary(sliver.to);
    const fromPinned = primaryAnchorNodeIds.includes(sliver.from); const toPinned = primaryAnchorNodeIds.includes(sliver.to);
    const touchesBridge = (id: string) => [...edges.values()].some((e) => e.bridge && (e.from === id || e.to === id));
    const fromBridge = touchesBridge(sliver.from); const toBridge = touchesBridge(sliver.to);
    if ((fromPrimary && toPrimary) || ((fromPinned || fromBridge) && (toPinned || toBridge))) { sliverSkip.add(sliver.id); continue; }
    edges.delete(sliver.id);
    // Rebinding a deck endpoint shifts the bridge geometry while its bridge registry remains fixed.
    // Keep the primary anchor first, then a bridge endpoint; otherwise use the established trunk rule.
    const keepId = fromPinned ? sliver.from : toPinned ? sliver.to
      : fromBridge ? sliver.from : toBridge ? sliver.to
        : toPrimary ? sliver.to : sliver.from;
    const keepNode = nodes.get(keepId)!; const dropId = keepId === sliver.from ? sliver.to : sliver.from;
    for (const e of [...edges.values()]) {
      if (e.from !== dropId && e.to !== dropId) continue;
      edges.delete(e.id);
      const other = e.from === dropId ? e.points[1] : e.points[0];
      addEdge(keepNode, other, e.kind === "arterial", e.bridge ?? false, atLeast(e, "arterial"));
    }
    nodes.delete(dropId);
  }
}
