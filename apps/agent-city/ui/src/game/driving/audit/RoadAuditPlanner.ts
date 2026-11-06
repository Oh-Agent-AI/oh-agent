/** RoadAuditPlanner (Agent D, D1): the frozen mandatory manifest of one captured city, and its execution
 * through the B audit into the release policy. Pure CPU; no THREE/DOM/host.
 *
 * 分母先于试跑冻结（spec §11.2/§11.3）：从冻结世界的路网与结构落地点生成全部必测单元——每条边的两个
 * 方向、每个节点上每一对合法「入边→出边」（不含掉头）、每个结构落地点的上/下两个方向、每个审计用出生点
 * 的端到端可达——生成不了用例的单元进 exclusions 并写明原因，**不从分母里消失**。每个单元恰有一个用例，
 * 用例只覆盖它自己的单元：出生端到端路线路过的边和路口不因此计数（只有 observer 记录了单元的进入/离开
 * 才能计数，首版不做组合覆盖）。manifestHash 由单元、排除与用例几何的规范 JSON 计算，随 key 进入每条结论。
 *
 * 不做的事：不生成开放图（ReleasedDrivingGraph 在后续批次），不改判定规则（三种结论仍完全来自 B 的审计），
 * 不把审计用出生点宣称为正式玩家出生区。 */
import type { StructureLanding } from "../../../engine/surface/compileSurface";
import { initialDrivingState } from "../../DrivingSimulation";
import { DRIVING_FOOTPRINT } from "../vehicleFootprint";
import { evaluateAuditRelease, type AuditReleaseDecision } from "./AuditReleasePolicy";
import type { AuditKey, AuditManifest, AuditUnit, AuditUnitKind, RoadAuditCase } from "./contracts";
import { ROUTE_PILOT_CONTROLLER_VERSION, routePilotFactory } from "./RoutePilot";
import { auditRoute, type PassabilityOptions, type PassabilityResult, type PassabilityRoute, type PassabilityWorld } from "./RoadPassabilityAudit";

export const ROAD_AUDIT_PLANNER_VERSION = 6; // 2: deck end layers; 3: real host roads; 4: mid-host-edge landings; 5: structure centrelines; 6: bidirectional whole elevated spans

type P = Readonly<{ x: number; z: number }>;
export type PlannerEdge = Readonly<{ id: string; from: string; to: string; width: number; points: readonly P[]; bridge?: boolean; structure?: string }>;
/** Audit-only start candidates (not official player spawns). */
export type AuditSpawn = Readonly<{ id: string; edgeId: string; x: number; z: number }>;
export type PlannerInput = Readonly<{
  worldRevision: string;
  roadEdges: readonly PlannerEdge[];
  landings: readonly StructureLanding[];
  spawns?: readonly AuditSpawn[];
  /** Structure centrelines keyed by structureId, ordered from its "from" end to its "to" end
   * (`expressway:<i>` → layout.highways[i], `ramp:<i>` → layout.highwayRamps[i].points). Optional: without
   * one the deck side runs straight along the landing's span axis (edge bridges are straight anyway). */
  structurePaths?: Readonly<Record<string, readonly P[]>>;
}>;
export type PlannerParams = Readonly<{
  /** Directed edges: trimmed off the node fans at both ends. */
  edgeTrim: number; minEdgeRun: number; edgeMargin: number;
  /** Turns: approach/leave length along each edge, minimum usable, corridor slack over the wider road. */
  turnReach: number; minTurnLeg: number; turnMargin: number;
  /** Structure transitions: length on the ground side and on the deck side of the landing. */
  groundReach: number; deckReach: number; structureMargin: number;
  spawnMargin: number;
  /** Corner fillet radius of turn/spawn centrelines (clamped by the legs), and its sampling step. */
  filletRadius: number; filletStep: number;
  /** Directed edges: context through degree-2 continuations before entering / after leaving the edge. */
  edgeContextBack: number; edgeContextAhead: number;
}>;
export const DEFAULT_PLANNER_PARAMS: PlannerParams = Object.freeze({ edgeTrim: 6, minEdgeRun: 8, edgeMargin: 0.5,
  turnReach: 15, minTurnLeg: 5, turnMargin: 1.0, groundReach: 10, deckReach: 12, structureMargin: 0.5, spawnMargin: 1.0, filletRadius: 5, filletStep: 1, edgeContextBack: 8, edgeContextAhead: 6 });

export type PlannedRoute = PassabilityRoute & Readonly<{ kind: AuditUnitKind; /** Road units: the member edges. */ edgeIds?: readonly string[] }>;
export type AuditPlan = Readonly<{
  worldRevision: string; plannerVersion: number; manifestHash: string;
  units: readonly AuditUnit[];
  exclusions: readonly Readonly<{ unitId: string; reason: string }>[];
  routes: readonly PlannedRoute[];
  counts: Readonly<Record<AuditUnitKind, Readonly<{ units: number; excluded: number }>>>;
}>;

// ── Polyline helpers ──
const lengthsOf = (pts: readonly P[]) => { const L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)); return L; };
function pointAt(pts: readonly P[], L: readonly number[], s: number): P {
  let i = 1; while (i < pts.length - 1 && L[i] < s) i++;
  const u = Math.max(0, Math.min(1, (s - L[i - 1]) / ((L[i] - L[i - 1]) || 1)));
  return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * u, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * u };
}
/** Sub-polyline between arc lengths s0 < s1 (inner vertices kept). */
function slice(pts: readonly P[], s0: number, s1: number): P[] {
  const L = lengthsOf(pts);
  return [pointAt(pts, L, s0), ...pts.filter((_, i) => L[i] > s0 + 1e-9 && L[i] < s1 - 1e-9), pointAt(pts, L, s1)];
}
/** Replace each bend sharper than 10° by a tangent circular arc (radius clamped to 45% of both legs).
 * A corridor centreline is the planner's choice: a point turn at a node is not a drivable line. */
function fillet(pts: readonly P[], radius: number, step: number): P[] {
  if (pts.length < 3 || !(radius > 0)) return [...pts];
  const out: P[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
    const l1 = Math.hypot(b.x - a.x, b.z - a.z), l2 = Math.hypot(c.x - b.x, c.z - b.z);
    if (l1 < 1e-9 || l2 < 1e-9) continue;
    const u = { x: (b.x - a.x) / l1, z: (b.z - a.z) / l1 }, v = { x: (c.x - b.x) / l2, z: (c.z - b.z) / l2 };
    const turn = Math.atan2(u.x * v.z - u.z * v.x, u.x * v.x + u.z * v.z);
    if (Math.abs(turn) < (10 * Math.PI) / 180) { out.push(b); continue; }
    const half = Math.abs(turn) / 2; let r = radius; let t = r * Math.tan(half);
    const maxT = 0.45 * Math.min(l1, l2); if (t > maxT) { t = maxT; r = t / Math.tan(half); }
    const p1 = { x: b.x - u.x * t, z: b.z - u.z * t };
    const side = Math.sign(turn); const n = { x: -u.z * side, z: u.x * side };
    const center = { x: p1.x + n.x * r, z: p1.z + n.z * r };
    const a0 = Math.atan2(p1.z - center.z, p1.x - center.x);
    const k = Math.max(2, Math.ceil((r * Math.abs(turn)) / step));
    out.push(p1);
    for (let j = 1; j <= k; j++) { const ang = a0 + turn * (j / k); out.push({ x: center.x + Math.cos(ang) * r, z: center.z + Math.sin(ang) * r }); }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
const dedupe = (pts: readonly P[]) => pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) > 1e-6);
/** FNV-1a 64-bit of a string, hex. Deterministic manifest identity (not a security hash). */
function fnv64(text: string): string {
  let h = 0xcbf29ce484222325n; const p = 0x100000001b3n; const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) { h ^= BigInt(text.charCodeAt(i)); h = (h * p) & mask; }
  return h.toString(16).padStart(16, "0");
}

/** Freeze the mandatory manifest of one world. Deterministic for the same input. */
export function planRoadAudit(input: PlannerInput, params: PlannerParams = DEFAULT_PLANNER_PARAMS): AuditPlan {
  const units: AuditUnit[] = []; const exclusions: { unitId: string; reason: string }[] = []; const routes: PlannedRoute[] = [];
  const unit = (id: string, kind: AuditUnitKind) => units.push(Object.freeze({ id, kind }));
  const exclude = (id: string, kind: AuditUnitKind, reason: string) => { unit(id, kind); exclusions.push(Object.freeze({ unitId: id, reason })); };
  const edges = [...input.roadEdges].filter((e) => e.points.length >= 2).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // 起止层：路线没有显式给层时，按它首/末点所在的边取——落在有自己层的桥面上就从桥面层起步/出门。
  // 曾一律按 ground：0/42 的出生点在一座独立成层的长桥中点，起步就 start:no-surface（桥面上的方向/转向用例同理）。
  const deckLayers = new Map(input.landings.filter((l) => l.structureId.startsWith("bridge:")).map((l) => [l.structureId.slice(7), l.layerId] as const));
  const layerAt = (p: P): string => {
    let best: PlannerEdge | null = null, bd = Infinity;
    for (const e of edges) for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1], b = e.points[i], dx = b.x - a.x, dz = b.z - a.z, ll = dx * dx + dz * dz;
      const u = ll ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / ll)) : 0;
      const d = Math.hypot(p.x - a.x - dx * u, p.z - a.z - dz * u);
      if (d < bd - 1e-9) { bd = d; best = e; }
    }
    return (best && deckLayers.get(best.id)) ?? "ground";
  };
  const route = (id: string, kind: AuditUnitKind, path: readonly P[], halfWidth: number, extra: Partial<PassabilityRoute> = {}) => {
    const pts = dedupe(path);
    const layers: { startLayer?: string; exitLayer?: string } = {};
    if (extra.startLayer === undefined && pts.length) { const l = layerAt(pts[0]); if (l !== "ground") layers.startLayer = l; }
    if (extra.exitLayer === undefined && pts.length) { const l = layerAt(pts[pts.length - 1]); if (l !== "ground") layers.exitLayer = l; }
    unit(id, kind); routes.push(Object.freeze({ id, kind, units: Object.freeze([id]), path: Object.freeze(pts.map((p) => Object.freeze({ x: p.x, z: p.z }))), halfWidth, ...layers, ...extra }));
  };

  // Road network edges are short segments chained through degree-2 nodes (in real cities 230 of 264 nodes).
  // A degree-2 node is a continuation, not a junction: the audited road is the maximal chain between
  // junctions/dead ends, traversed both ways; turns exist only where three or more edges meet.
  const incident = new Map<string, { edge: PlannerEdge; atStart: boolean }[]>();
  for (const e of edges) for (const [node, atStart] of [[e.from, true], [e.to, false]] as const) {
    let list = incident.get(node); if (!list) incident.set(node, list = []); list.push({ edge: e, atStart });
  }
  const degree = (n: string) => incident.get(n)?.length ?? 0;
  const chains = roadChains(edges, incident);

  // ── directed-edge: every graph edge in both directions, with context ──
  // A unit is one edge traversed fully in one direction. Its case extends through degree-2 continuations
  // (8 back, 6 ahead) so a short segment is runnable, and trims at junctions/dead ends (their fans).
  // Coarser road-chain units were tried: one local defect failed a 600-long chain and was reported far away.
  void chains;
  for (const e of edges) for (const dir of ["fwd", "rev"] as const) {
    const id = `edge:${e.id}:${dir}`;
    const [entry, exit] = dir === "fwd" ? [e.from, e.to] : [e.to, e.from];
    const own = dir === "fwd" ? [...e.points] : [...e.points].reverse();
    const ownLen = lengthsOf(own).at(-1)!;
    const before = degree(entry) === 2 ? context(incident, entry, e, params.edgeContextBack) : null;
    const after = degree(exit) === 2 ? context(incident, exit, e, params.edgeContextAhead) : null;
    const trimIn = before ? 0 : Math.min(params.edgeTrim, ownLen / 4), trimOut = after ? 0 : Math.min(params.edgeTrim, ownLen / 4);
    const core = slice(own, trimIn, ownLen - trimOut);
    const path = [...(before ? [...before].reverse().slice(0, -1) : []), ...core, ...(after ? after.slice(1) : [])];
    const runLen = lengthsOf(dedupe(path)).at(-1)!;
    if (ownLen - trimIn - trimOut < 1 || runLen < params.minEdgeRun) { exclude(id, "directed-edge", `edge-too-short:${ownLen.toFixed(2)}`); continue; }
    route(id, "directed-edge", fillet(dedupe(path), params.filletRadius, params.filletStep), e.width / 2 + params.edgeMargin, { edgeIds: [e.id] } as Partial<PassabilityRoute>);
  }

  // ── turn: every incoming → outgoing pair at a junction (degree ≥ 3), no U-turns ──
  for (const node of [...incident.keys()].sort()) {
    const list = incident.get(node)!;
    if (degree(node) < 3) continue; // dead ends have no turn; degree 2 is a continuation of one road
    for (const a of list) for (const b of list) {
      if (a.edge.id === b.edge.id && a.atStart === b.atStart) continue; // same end = U-turn
      // Legs follow the whole roads through degree-2 continuations, so a short first segment is not a short leg.
      const inPts = legPoints(a, node, incident, true);
      const outPts = legPoints(b, node, incident, false);
      const id = `turn:${node}:${a.edge.id}:${a.atStart ? "rev" : "fwd"}>${b.edge.id}:${b.atStart ? "fwd" : "rev"}`;
      const Li = lengthsOf(inPts), Lo = lengthsOf(outPts);
      const inLen = Li[Li.length - 1], outLen = Lo[Lo.length - 1];
      const back = Math.min(params.turnReach, inLen * 0.45), ahead = Math.min(params.turnReach, outLen * 0.45);
      if (back < params.minTurnLeg || ahead < params.minTurnLeg) { exclude(id, "turn", `turn-leg-too-short:${Math.min(back, ahead).toFixed(2)}`); continue; }
      const path = fillet([...slice(inPts, inLen - back, inLen), ...slice(outPts, 0, ahead).slice(1)], params.filletRadius, params.filletStep);
      route(id, "turn", path, Math.max(a.edge.width, b.edge.width) / 2 + params.turnMargin);
    }
  }

  // ── structure-transition: each landing, onto and off the structure ──
  for (const l of [...input.landings].sort((x, y) => x.structureId < y.structureId ? -1 : x.structureId > y.structureId ? 1 : x.end < y.end ? -1 : 1)) {
    const base = `structure:${l.structureId}:${l.end}`;
    // Legal envelope: the wider of the deck's seam and the approach road (region boundaries still bound the deck).
    const approachWidth = l.structureId.startsWith("bridge:") ? Math.max(0, ...[...(incident.get((() => { const b = edges.find((e) => e.id === l.structureId.slice(7)); return b ? (l.end === "from" ? b.from : b.to) : ""; })()) ?? [])].filter((x) => x.edge.id !== l.structureId.slice(7)).map((x) => x.edge.width)) : 0;
    const half = Math.max(Math.hypot(l.seam.b.x - l.seam.a.x, l.seam.b.z - l.seam.a.z) / 2, approachWidth / 2) + params.structureMargin;
    // 桥面一侧沿结构中线走：曾一律沿落地出向直退 deckReach。高架首段只有 1.9–2.4 长、紧接约 65° 的转弯
    // （1000/7、1000/65537 的 expressway:0 from 端），直退 12 早已离开桥面，onto 出门 / off 起步都是 no-surface。
    const deckSide = deckApproach(l, input.structurePaths?.[l.structureId], params.deckReach)
      ?? [{ x: l.x, z: l.z }, { x: l.x - l.outX * params.deckReach, z: l.z - l.outZ * params.deckReach }];
    // Ground side along the ACTUAL approach: a bridge lands on a road node, whose approach bends often — a
    // straight line along the span axis ran onto sidewalks. Expressway ramps land mid-road (straight, short).
    const approach = bridgeApproach(l, edges, incident, params.groundReach);
    const groundSide: P[] = approach ?? [{ x: l.x, z: l.z }, { x: l.x + l.outX * Math.min(params.groundReach, 6), z: l.z + l.outZ * Math.min(params.groundReach, 6) }];
    for (const dir of ["onto", "off"] as const) {
      const id = `${base}:${dir}`;
      if (l.status === "no-ground") { exclude(id, "structure-transition", "no-ground-landing"); continue; }
      const onto = fillet([...[...groundSide].reverse(), ...deckSide.slice(1)], params.filletRadius, params.filletStep);
      route(id, "structure-transition", dir === "onto" ? onto : [...onto].reverse(), half,
        dir === "onto" ? { startLayer: "ground", exitLayer: l.layerId } : { startLayer: l.layerId, exitLayer: "ground" });
    }
  }

  // Whole elevated spans need their own bidirectional runs; landing probes alone
  // cannot certify the unvisited middle of a long expressway or ramp.
  for (const [structureId, raw] of Object.entries(input.structurePaths ?? {}).sort(([a],[b])=>a<b?-1:a>b?1:0)) {
    const from=input.landings.find((l)=>l.structureId===structureId&&l.end==="from");
    const to=input.landings.find((l)=>l.structureId===structureId&&l.end==="to");
    const points=dedupe(raw); const length=points.length>1?lengthsOf(points).at(-1)!:0;
    for (const dir of ["fwd","rev"] as const) {
      const id=`span:${structureId}:${dir}`;
      if(!from||!to||length-2*params.edgeTrim<params.minEdgeRun){exclude(id,"directed-edge","structure-span-unplanned");continue;}
      const core=slice(points,params.edgeTrim,length-params.edgeTrim);
      const width=Math.max(Math.hypot(from.seam.a.x-from.seam.b.x,from.seam.a.z-from.seam.b.z),
        Math.hypot(to.seam.a.x-to.seam.b.x,to.seam.a.z-to.seam.b.z))/2+params.structureMargin;
      route(id,"directed-edge",dir==="fwd"?core:[...core].reverse(),width,
        dir==="fwd"?{startLayer:from.layerId,exitLayer:to.layerId}:{startLayer:to.layerId,exitLayer:from.layerId});
    }
  }

  // ── spawn-access: each audit spawn → the farthest node reachable over the edge graph ──
  const spawns = input.spawns ?? defaultSpawns(edges);
  for (const sp of [...spawns].sort((a, b) => a.id < b.id ? -1 : 1)) {
    const id = `spawn:${sp.id}`;
    const e = edges.find((x) => x.id === sp.edgeId);
    if (!e) { exclude(id, "spawn-access", "spawn-edge-missing"); continue; }
    const full = spawnRoute(edges, e, sp);
    const total = full ? lengthsOf(full).at(-1)! : 0;
    // The exit gate needs the whole body across it: stop short of the target node (a dead end has no road past it).
    if (!full || total - params.edgeTrim < params.minEdgeRun) { exclude(id, "spawn-access", "no-reachable-target"); continue; }
    route(id, "spawn-access", fillet(slice(full, 0, total - params.edgeTrim), params.filletRadius, params.filletStep), Math.max(...edges.map((x) => x.width)) / 2 + params.spawnMargin);
  }

  const kinds: AuditUnitKind[] = ["directed-edge", "turn", "structure-transition", "spawn-access", "recovery"];
  const excluded = new Set(exclusions.map((x) => x.unitId));
  const counts = Object.fromEntries(kinds.map((k) => [k, Object.freeze({ units: units.filter((u) => u.kind === k).length, excluded: units.filter((u) => u.kind === k && excluded.has(u.id)).length })])) as AuditPlan["counts"];
  const canonical = JSON.stringify(["road-audit-plan", ROAD_AUDIT_PLANNER_VERSION, input.worldRevision, params,
    units.map((u) => [u.id, u.kind]), exclusions.map((x) => [x.unitId, x.reason]),
    routes.map((r) => [r.id, r.kind, r.halfWidth, r.startLayer ?? "ground", r.exitLayer ?? "ground", r.path.map((p) => [p.x, p.z])])]);
  return Object.freeze({ worldRevision: input.worldRevision, plannerVersion: ROAD_AUDIT_PLANNER_VERSION, manifestHash: `plan-v1:fnv64:${fnv64(canonical)}`,
    units: Object.freeze(units), exclusions: Object.freeze(exclusions), routes: Object.freeze(routes), counts: Object.freeze(counts) });
}

/** Deck-side polyline of a landing: from the landing point `reach` along the structure centreline into the
 * structure; null when no centreline is given or its matching end is not at the landing. */
function deckApproach(l: StructureLanding, path: readonly P[] | undefined, reach: number): P[] | null {
  if (!path || path.length < 2) return null;
  const pts = l.end === "from" ? [...path] : [...path].reverse();
  if (Math.hypot(pts[0].x - l.x, pts[0].z - l.z) > 0.5) return null;
  const L = lengthsOf(pts);
  if (L.at(-1)! < 1e-6) return null;
  return [{ x: l.x, z: l.z }, ...slice(pts, 0, Math.min(reach, L.at(-1)! * 0.8)).slice(1)];
}
/** Ground-side polyline of a bridge landing, starting at the landing node and running `reach` along the
 * incident road most aligned with the span (through degree-2 continuations); null when the structure is not
 * a road-edge bridge (expressway ramps) or no approach exists. */
function bridgeApproach(l: StructureLanding, edges: readonly PlannerEdge[], incident: Incident, reach: number): P[] | null {
  // 匝道落在路中间的节点上（骨架在出口处切分宿主路）：同样沿实际的地面路走，而不是沿匝道方向直出。
  // 0/42 的高架 0 to 端以约 61° 斜接宿主干道，直出 6 就上了路缘（structure:expressway:0:to:off pilot-failed）。
  const bridge = l.structureId.startsWith("bridge:") ? edges.find((e) => e.id === l.structureId.slice("bridge:".length)) : undefined;
  if (l.structureId.startsWith("bridge:") && !bridge) return null;
  const node = bridge ? (l.end === "from" ? bridge.from : bridge.to) : `${l.x}:${l.z}`;
  if (!bridge && !incident.has(node)) return midEdgeApproach(l, edges, reach);
  let best: { edge: PlannerEdge; atStart: boolean } | null = null; let bestDot = -Infinity;
  for (const x of incident.get(node) ?? []) {
    if (bridge && x.edge.id === bridge.id) continue;
    const pts = x.atStart ? x.edge.points : [...x.edge.points].reverse();
    const d = { x: pts[1].x - pts[0].x, z: pts[1].z - pts[0].z }; const len = Math.hypot(d.x, d.z) || 1;
    const dot = (d.x * l.outX + d.z * l.outZ) / len;
    if (dot > bestDot || (dot === bestDot && best && x.edge.id < best.edge.id)) { bestDot = dot; best = x; }
  }
  if (!best) return null;
  const leg = legPoints(best, node, incident, false);
  const L = lengthsOf(leg);
  return slice(leg, 0, Math.min(reach, L.at(-1)! * 0.8));
}
/** 立交匝道落在宿主路中段（宿主路未在出口处切分，1000/7 的菱形立交）：沿宿主路走向与匝道出向更一致的那一侧。
 * 直出 6 会横穿 8 宽的宿主路上路缘（structure:ramp:0:to:onto start:no-surface）。 */
function midEdgeApproach(l: StructureLanding, edges: readonly PlannerEdge[], reach: number): P[] | null {
  let best: { pts: P[]; dot: number; id: string } | null = null;
  for (const e of edges) {
    if (e.bridge || (e.structure && e.structure !== "ground-road")) continue;
    for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1], b = e.points[i]; const dx = b.x - a.x, dz = b.z - a.z; const len2 = dx * dx + dz * dz;
      if (len2 < 1e-12) continue;
      const t = Math.max(0, Math.min(1, ((l.x - a.x) * dx + (l.z - a.z) * dz) / len2));
      const q = { x: a.x + dx * t, z: a.z + dz * t };
      if (Math.hypot(l.x - q.x, l.z - q.z) > e.width / 2) continue;
      const len = Math.sqrt(len2);
      for (const sign of [1, -1]) {
        const dot = sign * (dx * l.outX + dz * l.outZ) / len;
        if (best && (dot < best.dot || (dot === best.dot && e.id >= best.id))) continue;
        const pts = sign > 0 ? [q, ...e.points.slice(i)] : [q, ...e.points.slice(0, i).reverse()];
        best = { pts, dot, id: e.id };
      }
    }
  }
  if (!best) return null;
  const L = lengthsOf(best.pts);
  if (L.at(-1)! < 1e-6) return null;
  return [{ x: l.x, z: l.z }, ...slice(best.pts, 0, Math.min(reach, L.at(-1)! * 0.8)).slice(1)];
}
type Incident = Map<string, { edge: PlannerEdge; atStart: boolean }[]>;
type Chain = { id: string; edgeIds: string[]; points: P[]; width: number; loop: boolean };
/** Maximal chains of edges through degree-2 nodes. Stable: each chain starts at its smallest-id end edge. */
function roadChains(edges: readonly PlannerEdge[], incident: Incident): Chain[] {
  const used = new Set<string>(); const chains: Chain[] = [];
  const deg = (n: string) => incident.get(n)?.length ?? 0;
  const oriented = (e: PlannerEdge, fromNode: string) => (e.from === fromNode ? [...e.points] : [...e.points].reverse());
  const walk = (first: PlannerEdge, startNode: string) => {
    const ids: string[] = []; const pts: P[] = []; let width = Infinity; let e = first; let node = startNode;
    for (;;) {
      used.add(e.id); ids.push(e.id); width = Math.min(width, e.width);
      const seg = oriented(e, node); pts.push(...(pts.length ? seg.slice(1) : seg));
      node = e.from === node ? e.to : e.from;
      if (deg(node) !== 2 || node === startNode) break;
      const next = incident.get(node)!.find((x) => x.edge.id !== e.id)?.edge;
      if (!next || used.has(next.id)) break;
      e = next;
    }
    return { ids, pts, width, end: node };
  };
  // Chains start at a junction or dead end (degree ≠ 2); what remains are closed loops of degree-2 nodes.
  for (const e of edges) for (const node of [e.from, e.to]) {
    if (used.has(e.id) || deg(node) === 2) continue;
    const w = walk(e, node);
    chains.push({ id: [...w.ids].sort()[0], edgeIds: w.ids, points: dedupe(w.pts), width: w.width, loop: false });
  }
  for (const e of edges) if (!used.has(e.id)) {
    const w = walk(e, e.from);
    chains.push({ id: [...w.ids].sort()[0], edgeIds: w.ids, points: dedupe(w.pts), width: w.width, loop: w.end === e.from });
  }
  return chains.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
/** Up to `reach` along the road continuing from `node` away from `edge` (one degree-2 step at a time),
 * starting AT the node. */
function context(incident: Incident, node: string, edge: PlannerEdge, reach: number): P[] {
  const next = incident.get(node)!.find((x) => x.edge.id !== edge.id);
  if (!next) return [];
  const leg = legPoints(next, node, incident, false);
  return slice(leg, 0, Math.min(reach, lengthsOf(leg).at(-1)!));
}
/** A turn leg along the whole road through degree-2 continuations; incoming ends at `node`, outgoing starts there. */
function legPoints(first: { edge: PlannerEdge; atStart: boolean }, node: string, incident: Incident, incoming: boolean): P[] {
  const pts: P[] = []; let e = first.edge; let at = node; const seen = new Set<string>();
  for (let guard = 0; guard < 64; guard++) {
    seen.add(e.id);
    const seg = e.from === at ? [...e.points] : [...e.points].reverse();
    pts.push(...(pts.length ? seg.slice(1) : seg));
    at = e.from === at ? e.to : e.from;
    if ((incident.get(at)?.length ?? 0) !== 2 || lengthsOf(pts).at(-1)! >= 30) break;
    const next = incident.get(at)!.find((x) => x.edge.id !== e.id)?.edge;
    if (!next || seen.has(next.id)) break;
    e = next;
  }
  return incoming ? dedupe(pts).reverse() : dedupe(pts);
}

/** One deterministic audit start per connected component: the midpoint of its longest edge. */
function defaultSpawns(edges: readonly PlannerEdge[]): AuditSpawn[] {
  const parent = new Map<string, string>();
  const find = (a: string): string => { while (parent.get(a) !== a) a = parent.get(a)!; return a; };
  for (const e of edges) for (const n of [e.from, e.to]) if (!parent.has(n)) parent.set(n, n);
  for (const e of edges) { const a = find(e.from), b = find(e.to); if (a !== b) parent.set(a < b ? b : a, a < b ? a : b); }
  const best = new Map<string, { e: PlannerEdge; len: number }>();
  for (const e of edges) {
    const len = lengthsOf(e.points).at(-1)!; const root = find(e.from); const cur = best.get(root);
    if (!cur || len > cur.len || (len === cur.len && e.id < cur.e.id)) best.set(root, { e, len });
  }
  return [...best.values()].sort((a, b) => a.e.id < b.e.id ? -1 : 1).map(({ e, len }) => {
    const p = pointAt(e.points, lengthsOf(e.points), len / 2);
    return Object.freeze({ id: `audit:${e.id}`, edgeId: e.id, x: p.x, z: p.z });
  });
}
/** Spawn → farthest node by graph distance (Dijkstra over edge lengths, stable ties), as one polyline. */
function spawnRoute(edges: readonly PlannerEdge[], start: PlannerEdge, sp: AuditSpawn): P[] | null {
  const L = lengthsOf(start.points); const total = L.at(-1)!;
  // Arc position of the spawn on its edge (closest vertex-segment projection).
  let best = Infinity, s0 = total / 2;
  for (let i = 1; i < start.points.length; i++) {
    const a = start.points[i - 1], b = start.points[i]; const dx = b.x - a.x, dz = b.z - a.z, ll = dx * dx + dz * dz;
    const u = ll ? Math.max(0, Math.min(1, ((sp.x - a.x) * dx + (sp.z - a.z) * dz) / ll)) : 0;
    const d = Math.hypot(sp.x - a.x - dx * u, sp.z - a.z - dz * u); if (d < best) { best = d; s0 = L[i - 1] + Math.sqrt(ll) * u; }
  }
  const adj = new Map<string, { edge: PlannerEdge; to: string; len: number }[]>();
  for (const e of edges) { const len = lengthsOf(e.points).at(-1)!; for (const [a, b] of [[e.from, e.to], [e.to, e.from]]) { let l = adj.get(a); if (!l) adj.set(a, l = []); l.push({ edge: e, to: b, len }); } }
  const dist = new Map<string, number>(); const prev = new Map<string, { node: string; edge: PlannerEdge } | null>();
  dist.set(start.to, total - s0); prev.set(start.to, null); dist.set(start.from, s0); prev.set(start.from, null);
  const done = new Set<string>();
  for (;;) {
    let u: string | null = null;
    for (const [n, d] of dist) if (!done.has(n) && (u === null || d < dist.get(u)! || (d === dist.get(u)! && n < u))) u = n;
    if (u === null) break; done.add(u);
    for (const { edge, to, len } of adj.get(u) ?? []) {
      if (edge.id === start.id) continue;
      const nd = dist.get(u)! + len;
      if (nd < (dist.get(to) ?? Infinity) - 1e-9) { dist.set(to, nd); prev.set(to, { node: u, edge }); }
    }
  }
  let target: string | null = null;
  for (const [n, d] of dist) if (target === null || d > dist.get(target)! || (d === dist.get(target)! && n < target)) target = n;
  if (target === null) return null;
  // Rebuild: spawn → (start edge part) → first node → … → target.
  const chain: { from: string; edge: PlannerEdge }[] = [];
  let n: string = target; while (prev.get(n)) { const p = prev.get(n)!; chain.unshift({ from: p.node, edge: p.edge }); n = p.node; }
  const first = n; // start.from or start.to
  const head = first === start.to ? slice(start.points, s0, total) : [...slice(start.points, 0, s0)].reverse();
  const path: P[] = [...head];
  for (const { from, edge } of chain) { const pts = edge.from === from ? [...edge.points] : [...edge.points].reverse(); path.push(...pts.slice(1)); }
  return dedupe(path);
}

// ── Execution: every planned case through B's audit, then the release policy on the frozen manifest ──
export type UnitStatus = "passed" | "blocked" | "inconclusive" | "excluded" | "closed";
export type AuditPlanReport = Readonly<{
  worldRevision: string; manifestHash: string;
  results: readonly PassabilityResult[];
  release: AuditReleaseDecision;
  /** Spec §11.7: "verified X/Y directions, A/B turns, C/D structure links" plus the full denominator. */
  coverage: Readonly<Record<AuditUnitKind, Readonly<{ candidates: number; excluded: number; passed: number; blocked: number; inconclusive: number; closed: number }>>>;
  summary: string;
}>;
/** The case the release policy matches results against: the same id, units, gate, budget and corridor
 * auditRoute builds; the start is the planned pose (a recovered start is a different case, by design). */
function plannedCase(world: PassabilityWorld, r: PlannedRoute): RoadAuditCase {
  const p0 = r.path[0], p1 = r.path[1], pn = r.path[r.path.length - 1], pm = r.path[r.path.length - 2];
  const start = world.regions.classify(p0.x, p0.z, r.startLayer ?? "ground");
  const exit = world.regions.classify(pn.x, pn.z, r.exitLayer ?? "ground");
  const surface = start.status === "drivable" ? start.regionId : "unresolved";
  const ex = pn.x - pm.x, ez = pn.z - pm.z, el = Math.hypot(ex, ez) || 1;
  let length = 0; for (let i = 1; i < r.path.length; i++) length += Math.hypot(r.path[i].x - r.path[i - 1].x, r.path[i].z - r.path[i - 1].z);
  const cruise = r.cruiseSpeed ?? 7;
  return { id: r.id, units: [...r.units], start: { ...initialDrivingState(p0.x, p0.z, Math.atan2(p1.z - p0.z, p1.x - p0.x), surface), y: start.status === "drivable" ? start.y : 0 },
    gates: [{ id: `${r.id}:exit`, x: pn.x, y: exit.status === "drivable" ? exit.y : 0, z: pn.z, forwardX: ex / el, forwardZ: ez / el,
      halfWidth: r.halfWidth + Math.hypot(DRIVING_FOOTPRINT.halfLength, DRIVING_FOOTPRINT.halfWidth), heightTolerance: 0.5, surfaceIds: [surface] }],
    corridor: { surfaceSequence: [surface], portalSequence: [], waypoints: r.path.map((p) => ({ x: p.x, z: p.z })) },
    policy: { cruiseSpeed: cruise, maxReverseSpeed: 0 }, maxTicks: Math.ceil(((length + 10) / cruise) * 60 * 2 + 600), maxNoProgressTicks: 240 };
}

/** Canonical full manifest for publication; final-boundary replay may evaluate a
 * working copy with closed units omitted from its mandatory cases, but callers
 * publish the original denominator and the boundary proof accounts for closures. */
export function auditManifestForPlan(world: PassabilityWorld, plan: AuditPlan, key: AuditKey): AuditManifest {
  if (plan.worldRevision !== world.worldRevision || key.baseSnapshotHash !== world.worldRevision || key.manifestHash !== plan.manifestHash ||
    key.plannerVersion !== plan.plannerVersion) throw new Error("plan-key-mismatch");
  return Object.freeze({ key, units: plan.units, exclusions: plan.exclusions,
    cases: Object.freeze(plan.routes.map((route) => Object.freeze(plannedCase(world, route)))) });
}

export function executeAuditPlan(world: PassabilityWorld, plan: AuditPlan, keyFor: (worldRevision: string, manifestHash: string) => AuditKey,
  options: PassabilityOptions & Readonly<{ onResult?: (r: PassabilityResult, index: number, total: number) => void; shouldStop?: () => boolean;
    /** A final boundary producer may mark mandatory units sealed by its verified contour.
     * These remain in the manifest denominator; their cases are omitted from route replay. */
    closedUnitIds?: readonly string[];
    /** Run only these cases (diagnostics/sampling); the frozen manifest keeps every case, unrun ones stay pending. */
    only?: (route: PlannedRoute) => boolean }> = {}): AuditPlanReport {
  if (plan.worldRevision !== world.worldRevision) throw new Error("plan-world-mismatch");
  const key = keyFor(world.worldRevision, plan.manifestHash);
  if (key.manifestHash !== plan.manifestHash || key.baseSnapshotHash !== world.worldRevision || key.plannerVersion !== plan.plannerVersion) throw new Error("plan-key-mismatch");
  // The default controller is D's RoutePilot; its version must be the key's (a different pilot is a different key).
  if (!options.pilot && key.controllerVersion !== ROUTE_PILOT_CONTROLLER_VERSION) throw new Error("plan-key-controller-mismatch");
  const pilot = options.pilot ?? routePilotFactory();
  const closed = new Set(options.closedUnitIds ?? []);
  const originallyExcluded = new Set(plan.exclusions.map((item) => item.unitId));
  if ([...closed].some((id) => !plan.units.some((unit) => unit.id === id) || originallyExcluded.has(id))) throw new Error("invalid-closed-boundary-unit");
  const results: PassabilityResult[] = [];
  for (let i = 0; i < plan.routes.length; i++) {
    if (options.shouldStop?.()) {try{options.evidence?.invalidate();}catch{/* diagnostics only */}break;}
    if (plan.routes[i].units.some((unitId) => closed.has(unitId)) || (options.only && !options.only(plan.routes[i]))) continue;
    const r = auditRoute(world, key, plan.routes[i], { ...options, pilot }); results.push(r); options.onResult?.(r, i, plan.routes.length);
  }
  const manifest: AuditManifest = { key, units: plan.units,
    exclusions: Object.freeze([...plan.exclusions, ...[...closed].sort().map((unitId) => ({ unitId, reason: `closed-by-final-boundary:${key.releaseBoundaryHash ?? "unbound"}` }))]),
    cases: plan.routes.filter((route) => !route.units.some((unitId) => closed.has(unitId))).map((r) => plannedCase(world, r)) };
  if(!world.isCurrent())try{options.evidence?.invalidate();}catch{/* diagnostics only */}
  const evaluated = evaluateAuditRelease(manifest, results.flatMap((r) => r.evidence), results.flatMap((r) => r.run ? [r.run] : []));
  const release: AuditReleaseDecision = closed.size ? Object.freeze({ ...evaluated,
    candidateCount: plan.units.length,
    mandatoryCount: plan.units.length - plan.exclusions.length,
    closedCount: closed.size,
    units: Object.freeze(evaluated.units.map((unit) => closed.has(unit.unitId)
      ? Object.freeze({ ...unit, status: "closed" as const, reason: "sealed-by-final-boundary" }) : unit)),
  }) : evaluated;
  const byUnit = new Map<string, UnitStatus>();
  for (const x of plan.exclusions) byUnit.set(x.unitId, "excluded");
  for (const unitId of closed) byUnit.set(unitId, "closed");
  for (const r of results) { const route = plan.routes.find((x) => x.id === r.routeId); for (const u of route?.units ?? []) byUnit.set(u, r.verdict); }
  const kinds: AuditUnitKind[] = ["directed-edge", "turn", "structure-transition", "spawn-access", "recovery"];
  const coverage = Object.fromEntries(kinds.map((k) => {
    const us = plan.units.filter((u) => u.kind === k); const st = us.map((u) => byUnit.get(u.id) ?? "inconclusive");
    return [k, Object.freeze({ candidates: us.length, excluded: st.filter((s) => s === "excluded").length, passed: st.filter((s) => s === "passed").length,
      blocked: st.filter((s) => s === "blocked").length, inconclusive: st.filter((s) => s === "inconclusive").length, closed: st.filter((s) => s === "closed").length })];
  })) as AuditPlanReport["coverage"];
  const c = coverage; const mand = (k: AuditUnitKind) => c[k].candidates - c[k].excluded;
  const summary = `已验 ${c["directed-edge"].passed}/${mand("directed-edge")} 个方向、${c.turn.passed}/${mand("turn")} 个转向、${c["structure-transition"].passed}/${mand("structure-transition")} 个结构连接、` +
    `${c["spawn-access"].passed}/${mand("spawn-access")} 个出生可达；候选 ${plan.units.length}，排除 ${plan.exclusions.length}，` +
    `挡住 ${kinds.reduce((n, k) => n + c[k].blocked, 0)}，边界封闭 ${kinds.reduce((n, k) => n + c[k].closed, 0)}，未确认 ${kinds.reduce((n, k) => n + c[k].inconclusive, 0)}`;
  return Object.freeze({ worldRevision: world.worldRevision, manifestHash: plan.manifestHash, results: Object.freeze(results), release, coverage: Object.freeze(coverage), summary });
}
