/** Consume transaction evidence, never guess a replacement by spatial proximity. */
import type { Vec2 } from "../cityLayout";
import type { RepairContext } from "./context";
import { keyOf, type Network, type NetworkRemap } from "./network";

const idOf = (p: Vec2) => { const at = keyOf(p); return `${at.x}:${at.z}`; };

export function remapRoadPath(path: readonly Vec2[], remap: NetworkRemap, network: Network): Vec2[] | null {
  const point = (p: Vec2): Vec2 | null => {
    const id = idOf(p);
    if (!(id in remap.nodes)) return { ...p };
    const next = remap.nodes[id], node = next ? remap.positions[next] ?? network.nodes.get(next) : null;
    return node ? { x: node.x, z: node.z } : null;
  };
  const routes = new Map<string, Vec2[] | null>();
  const put = (a: Vec2, b: Vec2, shape: Vec2[] | null) => {
    routes.set(`${idOf(a)}/${idOf(b)}`, shape);
    routes.set(`${idOf(b)}/${idOf(a)}`, shape ? [...shape].reverse() : null);
  };
  for (const change of remap.paths) {
    put(change.before[0], change.before[change.before.length - 1], change.after);
    for (let i = 1; i < change.before.length; i += 1) {
      const a = point(change.before[i - 1]), b = point(change.before[i]);
      const start = a ? change.after?.findIndex((p) => idOf(p) === idOf(a)) ?? -1 : -1;
      const end = b ? change.after?.findIndex((p) => idOf(p) === idOf(b)) ?? -1 : -1;
      put(change.before[i - 1], change.before[i], start >= 0 && end >= start ? change.after!.slice(start, end + 1) : null);
    }
  }
  const first = path.length ? point(path[0]) : null;
  if (path.length && !first) return null;
  const out: Vec2[] = first ? [first] : [];
  // A replaced curved edge may lose its old interior bends. Match only an
  // explicit, complete ordered lineage span (forward or reverse), never infer
  // a partial route from proximity to the new geometry.
  const spans = remap.paths.filter(change => change.before.length > 2).flatMap(change => [change,
    { before: [...change.before].reverse(), after: change.after ? [...change.after].reverse() : null }])
    .sort((a, b) => b.before.length - a.before.length);
  for (let i = 1; i < path.length; i += 1) {
    if (spans.length) {
      const matches = spans.filter(change => i - 1 + change.before.length <= path.length
        && change.before.every((point, offset) => idOf(point) === idOf(path[i - 1 + offset])));
      const span = matches[0];
      if (span) {
        if (matches.some(change => change.before.length === span.before.length &&
          (change.after === null || span.after === null ? change.after !== span.after : change.after.length !== span.after.length
            || change.after.some((point, index) => point.x !== span.after![index].x || point.z !== span.after![index].z)))) return null;
        if (!span.after) return null;
        for (const point of span.after) if (!out.length || idOf(out[out.length - 1]) !== idOf(point)) out.push({ ...point });
        i += span.before.length - 2;
        continue;
      }
    }
    const key = `${idOf(path[i - 1])}/${idOf(path[i])}`;
    const replacement = routes.has(key) ? routes.get(key) : [point(path[i - 1]), point(path[i])];
    if (!replacement || replacement.some((p) => !p)) return null;
    for (const p of replacement as Vec2[]) if (!out.length || idOf(out[out.length - 1]) !== idOf(p)) out.push({ ...p });
  }
  return out;
}

/** Called on the isolated solve draft before acceptance; any lost reference vetoes it. */
export function applyNetworkReferences(ctx: RepairContext, remaps: readonly NetworkRemap[]): string | null {
  for (const remap of remaps) {
    for (const site of [...ctx.publicSites, ...ctx.landmarks]) if (site.access && site.access.nodeId in remap.nodes) {
      const next = remap.nodes[site.access.nodeId];
      if (!next) return `required gate removed: ${site.id}`;
      site.access.nodeId = next;
    }
    if (ctx.primaryAnchorNodeId && ctx.primaryAnchorNodeId in remap.nodes) {
      const next = remap.nodes[ctx.primaryAnchorNodeId];
      if (!next) return "required primary anchor removed";
      ctx.primaryAnchorNodeId = next;
    }
    for (const runs of [ctx.carPaths, ctx.trunkRuns ?? [], ctx.coastRoadRuns, ctx.riverRoadRuns]) for (let i = 0; i < runs.length; i += 1) {
      const next = remapRoadPath(runs[i], remap, ctx.network);
      if (!next) return "referenced road removed without a replacement path";
      runs[i] = next;
    }
    for (let i = 0; i < ctx.coastRoadRunEnds.length; i += 1) {
      const end = remapRoadPath([ctx.coastRoadRunEnds[i]], { ...remap, paths: [] }, ctx.network);
      if (!end?.length) return "declared coast endpoint removed";
      ctx.coastRoadRunEnds[i] = end[0];
    }
    for (const block of ctx.blocks) {
      if (!block.polygon.length) continue;
      const next = remapRoadPath([...block.polygon, block.polygon[0]], remap, ctx.network);
      if (!next) return `block boundary removed without a replacement: ${block.id}`;
      block.polygon = next.slice(0, -1);
    }
    for (const bridge of ctx.bridges) {
      const next = remapRoadPath([bridge.from, bridge.to], { ...remap, paths: [] }, ctx.network);
      if (!next || next.length !== 2) return "registered bridge endpoint removed";
      bridge.from = next[0]; bridge.to = next[1];
    }
  }
  return null;
}
