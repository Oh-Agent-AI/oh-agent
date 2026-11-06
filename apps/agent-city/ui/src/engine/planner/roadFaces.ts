/** Accepted ground-road topology, never a grid or a snapping operation. */
import { DetMath as Math } from "../detMath";
import type { RoadEdge, Vec2 } from "../cityLayout";

/** Rings close implicitly from last point to first; boundary CCW, holes CW. */
export type RoadFace = { id: string; boundary: Vec2[]; holes: Vec2[][]; edgeIds: string[]; area: number };
export type RoadFaceResult = { faces: RoadFace[]; issues: string[]; excludedEdgeIds: string[] };
type Segment = { a: string; b: string; edgeIds: string[] };
const pointKey = (p: Vec2) => `${p.x}:${p.z}`;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const directedKey = (a: string, b: string) => JSON.stringify([a, b]);
const cross = (a: Vec2, b: Vec2, c: Vec2) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
const areaOf = (points: Vec2[]) => points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p.x * q.z - q.x * p.z; }, 0) / 2;
const inside = (p: Vec2, ring: Vec2[]) => {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > p.z) !== (b.z > p.z) && p.x < (b.x - a.x) * (p.z - a.z) / (b.z - a.z) + a.x) hit = !hit;
  }
  return hit;
};

/** Centreline faces only: parcel insets, buildability and entrances are separate proofs. */
export function extractRoadFaces(edges: readonly RoadEdge[]): RoadFaceResult {
  const issues: string[] = [], excludedEdgeIds: string[] = [], points = new Map<string, Vec2>(), segments = new Map<string, Segment>();
  const register = (id: string, p: Vec2) => {
    const old = points.get(id);
    if (old && pointKey(old) !== pointKey(p)) issues.push(`inconsistent-node:${id}`);
    else points.set(id, { ...p });
  };
  for (const edge of [...edges].sort((a, b) => compare(a.id, b.id))) {
    if (edge.bridge || edge.structure === "deck") { excludedEdgeIds.push(edge.id); continue; }
    if (!edge.from || !edge.to || edge.points.length < 2 || edge.points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.z))) { issues.push(`invalid-road:${edge.id}`); continue; }
    const forward = JSON.stringify([edge.from, edge.to, edge.points.map(pointKey)]), reverse = JSON.stringify([edge.to, edge.from, [...edge.points].reverse().map(pointKey)]);
    const canonical = forward < reverse ? forward : reverse;
    const ids = edge.points.map((p, i) => i === 0 ? `node:${edge.from}` : i === edge.points.length - 1 ? `node:${edge.to}` : `shape:${canonical}:${forward < reverse ? i : edge.points.length - 1 - i}`);
    for (let i = 0; i < ids.length; i++) register(ids[i], edge.points[i]);
    for (let i = 1; i < ids.length; i++) {
      if (pointKey(edge.points[i - 1]) === pointKey(edge.points[i])) { issues.push(`zero-segment:${edge.id}`); continue; }
      const pair = [ids[i - 1], ids[i]].sort(), key = JSON.stringify(pair), old = segments.get(key);
      if (old) old.edgeIds.push(edge.id);
      else segments.set(key, { a: pair[0], b: pair[1], edgeIds: [edge.id] });
    }
  }
  const list = [...segments.values()];
  // Do not manufacture graph junctions where geometry crosses without a shared node.
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const s = list[i], t = list[j], a = points.get(s.a)!, b = points.get(s.b)!, c = points.get(t.a)!, d = points.get(t.b)!;
    if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x)
      || Math.max(a.z, b.z) < Math.min(c.z, d.z) || Math.max(c.z, d.z) < Math.min(a.z, b.z)) continue;
    const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
    const on = (p: Vec2, u: Vec2, v: Vec2) => cross(u, v, p) === 0 && p.x >= Math.min(u.x, v.x) && p.x <= Math.max(u.x, v.x) && p.z >= Math.min(u.z, v.z) && p.z <= Math.max(u.z, v.z);
    const shared = s.a === t.a || s.a === t.b || s.b === t.a || s.b === t.b;
    const proper = abC * abD < 0 && cdA * cdB < 0;
    const contacts = [[s.a, a, t.a, c], [s.a, a, t.b, d], [s.b, b, t.a, c], [s.b, b, t.b, d]] as const;
    const unjoined = contacts.some(([u, p, v, q]) => pointKey(p) === pointKey(q) && u !== v);
    const interior = (!shared && (on(a, c, d) || on(b, c, d) || on(c, a, b) || on(d, a, b)))
      || (shared && ((on(c, a, b) && pointKey(c) !== pointKey(a) && pointKey(c) !== pointKey(b)) || (on(d, a, b) && pointKey(d) !== pointKey(a) && pointKey(d) !== pointKey(b))
        || (on(a, c, d) && pointKey(a) !== pointKey(c) && pointKey(a) !== pointKey(d)) || (on(b, c, d) && pointKey(b) !== pointKey(c) && pointKey(b) !== pointKey(d))));
    if (proper || unjoined || interior) issues.push(`unjoined-or-overlapping:${s.edgeIds[0]}:${t.edgeIds[0]}`);
  }
  if (issues.length) return { faces: [], issues: [...new Set(issues)].sort(), excludedEdgeIds: excludedEdgeIds.sort() };
  const adjacency = new Map<string, { to: string; segment: number }[]>();
  list.forEach((s, i) => { for (const [from, to] of [[s.a, s.b], [s.b, s.a]]) { const out = adjacency.get(from) ?? []; out.push({ to, segment: i }); adjacency.set(from, out); } });
  // Iterative Tarjan: cut edges (including hanging branches) do not bound land.
  const discovery = new Map<string, number>(), low = new Map<string, number>(), bridges = new Set<number>(); let tick = 0;
  for (const root of [...adjacency.keys()].sort()) {
    if (discovery.has(root)) continue;
    discovery.set(root, ++tick); low.set(root, tick);
    const stack = [{ node: root, parent: "", edge: -1, cursor: 0 }];
    while (stack.length) {
      const f = stack[stack.length - 1], next = adjacency.get(f.node)![f.cursor++];
      if (next) {
        if (next.segment === f.edge) continue;
        if (discovery.has(next.to)) low.set(f.node, Math.min(low.get(f.node)!, discovery.get(next.to)!));
        else { discovery.set(next.to, ++tick); low.set(next.to, tick); stack.push({ node: next.to, parent: f.node, edge: next.segment, cursor: 0 }); }
      } else {
        stack.pop();
        if (f.edge >= 0) { low.set(f.parent, Math.min(low.get(f.parent)!, low.get(f.node)!)); if (low.get(f.node)! > discovery.get(f.parent)!) bridges.add(f.edge); }
      }
    }
  }
  for (const [id, out] of adjacency) { const p = points.get(id)!; adjacency.set(id, out.filter((x) => !bridges.has(x.segment)).sort((a, b) => {
    const pa = points.get(a.to)!, pb = points.get(b.to)!;
    return Math.atan2(pa.z - p.z, pa.x - p.x) - Math.atan2(pb.z - p.z, pb.x - p.x) || compare(a.to, b.to);
  })); }
  const visited = new Set<string>(), faces: RoadFace[] = [];
  for (const start of [...adjacency.keys()].sort()) for (const first of adjacency.get(start)!) {
    if (visited.has(directedKey(start, first.to))) continue;
    const ring: Vec2[] = [], owners = new Set<string>(); let from = start, to = first.to;
    do {
      visited.add(directedKey(from, to)); ring.push(points.get(from)!);
      const out = adjacency.get(to)!, reverse = out.findIndex((x) => x.to === from), next = out[(reverse + out.length - 1) % out.length];
      for (const id of list[out[reverse].segment].edgeIds) owners.add(id);
      from = to; to = next.to;
    } while (from !== start || to !== first.to);
    const area = areaOf(ring);
    if (area <= 0) continue;
    let pivot = 0; for (let i = 1; i < ring.length; i++) if (pointKey(ring[i]) < pointKey(ring[pivot])) pivot = i;
    const boundary = [...ring.slice(pivot), ...ring.slice(0, pivot)].map((p) => ({ ...p }));
    faces.push({ id: `face:${boundary.map(pointKey).join("/")}`, boundary, holes: [], edgeIds: [...owners].sort(), area });
  }
  faces.sort((a, b) => compare(a.id, b.id));
  for (const child of faces) {
    const parent = faces.filter((f) => f !== child && f.area > child.area && child.boundary.every((p) => inside(p, f.boundary))).sort((a, b) => a.area - b.area || compare(a.id, b.id))[0];
    if (parent) parent.holes.push(child.boundary.map((p) => ({ ...p })).reverse());
  }
  for (const face of faces) { face.holes.sort((a, b) => compare(pointKey(a[0]), pointKey(b[0]))); face.area -= face.holes.reduce((sum, hole) => sum + Math.abs(areaOf(hole)), 0); }
  return { faces, issues: [], excludedEdgeIds: excludedEdgeIds.sort() };
}
