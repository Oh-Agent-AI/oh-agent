import { atLeast } from "../roadStandard";
// 规划约束的共享度量（CITY_ARCHITECTURE §2「约束即守卫」，迁移步 5 前半）。
//
// 原先这些几何度量内联在 scripts/verify-city-context.mjs 与 verify-city-planning.mjs 里，只有 CI 能「事后」看到
// 违规。现在抽成一个纯模块（无 three、无 fs）：输入 createCityPlan 的返回值，输出每条约束的违规清单。
//
// 将来 planner/solve.ts 这样消费 CONSTRAINTS（本任务不实现 solve）：
//   generate → measure → repair → re-measure
//   1. generate：照现有规划流水线出一份 plan 草案；
//   2. measure：对 CONSTRAINTS 逐条 `c.measure(plan)`，违规带 site/at，solve 据此定位要修的对象；
//   3. repair：按约束 id 选修复策略（换位、改道、删支路），只动违规对象；
//   4. re-measure：重新度量直到全部为空或达迭代上限，剩余违规如实上报（不静默吞）。
// 守卫（scripts/verify-city-*.mjs）调用同一组 measure，所以「规划器认为合格」与「CI 认为合格」不会再分叉。
//
// 边界：这里只放「单个违规的几何定义」（如中心到路 < 0.7 半径算穿路）；
// 「允许多少条」的容忍计数是策略，留在守卫里。逻辑逐字取自两个守卫，勿在此改语义。
import type { createCityPlan } from "../cityPlan";
import type { Vec2 } from "../cityLayout";
import { declaredGroundRoadClear } from "./modelEnvelope";
import { bridgeheadStubEnds, bridgeLandingNodes, isPlannedRoadEnd, isOwnedIslandGate } from "./endpoints";
import { WATER_LEVEL, wetCount, polylineDistance, polylineClosest, closestPolylineSegment } from "./footprint";
import { pointInPolygon, siteFootprint, siteFootprintSeparation, siteRoadClear, worldFootprintSamples } from "../planFootprint";
import { componentOf, primaryComponentId } from "./intent";
import { planarAccessAtYaw, resolvePlanarAccess } from "../models/siteAccess";
import { specByKind } from "./sitespec";
import { groundJunctionFindings } from "./report";
import { crowdedPolylinePair } from "./relations";

export type CityPlan = ReturnType<typeof createCityPlan>;
export type Violation = { constraint: string; site?: string; at?: { x: number; z: number }; detail: string; identity?: string };
export type Constraint = { id: string; description: string; measure: (plan: CityPlan) => Violation[] };

type Pt = { x: number; z: number };
// 规划产物的用地/路段形状很宽（各 kind 字段不同），度量只读几何字段。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Site = any;

const seg = (p: Pt, a: Pt, b: Pt) => { const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1; const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)); return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t); };
const SHORE = new Set(["harbor", "lighthouse", "sail-opera", "ferris-wheel", "villa-complex"]);

/** 带半径的用地：公共用地 + 地标（与守卫原先的 sites 同口径）。 */
export const planSites = (plan: CityPlan): Site[] => [...plan.publicSites, ...plan.landmarks].filter((s: Site) => s.radius);
const nonBridge = (plan: CityPlan): Site[] => plan.roadEdges.filter((e: Site) => !e.bridge);
/** 用地中心到最近非桥路段的距离。 */
const nearRoad = (plan: CityPlan, s: Site) => polylineDistance(nonBridge(plan).map((e: Site) => e.points), s);
const v = (constraint: string, s: Site, detail: string): Violation => ({ constraint, site: s.kind, at: { x: s.x, z: s.z }, detail });

export const siteInWater: Constraint = {
  id: "siteInWater", description: "占地圈 16 点地形高于水面（岸边类允许 ≤4 点；港口与岛上地标 shore 豁免）",
  measure(plan) {
    const out: Violation[] = [];
    const geo = { height: plan.terrain.height, inRiver: () => false };
    for (const s of planSites(plan)) {
      const declaration = specByKind(s.kind);
      const footprint = declaration?.placement === "inland-frontage" ? siteFootprint(s.kind, s.id ?? `reservation:${s.kind}`, s.radius) : null;
      // Match generator admission for exact inland footprints. The nominal radius is
      // only a reservation proxy there; testing its empty corners can reject a dry
      // station/stadium that was admitted against its declared renderer geometry.
      const samples = footprint?.exact ? worldFootprintSamples(footprint, s, s.yaw, 4) : null;
      const wet = samples
        ? samples.length === 0 ? 1 : samples.filter(point => plan.terrain.height(point.x, point.z) < WATER_LEVEL).length
        : wetCount(geo, s, s.radius); // legacy/shore proxy: height only; river is measured separately
      if (s.kind !== "harbor" && !s.shore && wet > (SHORE.has(s.kind) ? 4 : 0)) out.push(v("siteInWater", s, `${s.kind} wet=${wet}`));
    }
    return out;
  },
};

export const siteWithoutDoorRoad: Constraint = {
  id: "siteWithoutDoorRoad", description: "门前有路：最近路段（含桥）离占地边缘 ≤ 20",
  measure(plan) {
    const out: Violation[] = [];
    for (const s of planSites(plan)) {
      if (s.access) {
        const comp = componentOf(plan); const primary = primaryComponentId(plan, comp);
        if (s.x !== s.access.ownerX || s.z !== s.access.ownerZ || s.yaw !== s.access.ownerYaw || !primary || comp.get(s.access.nodeId) !== primary) out.push(v("siteWithoutDoorRoad", s, "declared plot entrance detached or moved"));
        continue;
      }
      const near = nearRoad(plan, s);
      const nearAny = Math.min(near, polylineDistance(plan.roadEdges.filter((e: Site) => e.bridge).map((e: Site) => e.points), s)); // 门口直接起桥（岸边地标隔河）也是门前有路
      if (nearAny > s.radius + 20) out.push(v("siteWithoutDoorRoad", s, `${s.kind} gap=${Math.round(nearAny - s.radius)}`));
    }
    for (const obligation of plan.siteObligations ?? []) if (!planSites(plan).some((s) => s.id === obligation.ownerId)) out.push({ constraint: "siteWithoutDoorRoad", site: obligation.ownerId, detail: obligation.reason ?? "required site unplaced" });
    return out;
  },
};

export const roadThroughSite: Constraint = {
  id: "roadThroughSite", description: "已声明完整XY实体避全路幅+3；未知模型保留中心距≥0.7半径（市政/门式豁免）",
  measure(plan) {
    const out: Violation[] = [];
    for (const s of planSites(plan)) {
      if (s.kind === "arch" || s.kind === "civic") continue;
      const near = nearRoad(plan, s);
      const declared = declaredGroundRoadClear(s, plan.roadEdges.filter(road => !road.bridge));
      if (declared === false || (declared === undefined && near < s.radius * 0.7)) out.push(v("roadThroughSite", s,
        declared === false ? "declared complete XY corridor conflict" : `${s.kind} d=${Math.round(near)}`));
    }
    return out;
  },
};

export const sitesOverlap: Constraint = {
  id: "sitesOverlap", description: "用地实体投影不重叠；未声明模型及海上岛保留名义圆",
  measure(plan) {
    const out: Violation[] = [];
    const sites = planSites(plan).sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1
      : (a.id ?? "") < (b.id ?? "") ? -1 : (a.id ?? "") > (b.id ?? "") ? 1 : 0);
    for (let i = 0; i < sites.length; i += 1) for (let j = i + 1; j < sites.length; j += 1) {
      const s = sites[i], o = sites[j];
      if (siteFootprintSeparation(s, o) < 0) out.push({ ...v("sitesOverlap", s, `${s.kind} x ${o.kind}`),
        identity: [s.id ?? `${s.kind}:${s.x}:${s.z}`, o.id ?? `${o.kind}:${o.x}:${o.z}`].sort().join("/") });
    }
    return out;
  },
};

export const parcelInsideSite: Constraint = {
  id: "parcelInsideSite", description: "没有地块中心落在用地半径内",
  measure(plan) {
    const out: Violation[] = [];
    for (const s of planSites(plan)) for (const b of plan.blocks) for (const p of b.parcels) if (Math.hypot(p.x - s.x, p.z - s.z) < s.radius) { out.push(v("parcelInsideSite", s, `${s.kind} parcel ${p.id}`)); break; }
    return out;
  },
};

export const stationStadiumSetback: Constraint = {
  id: "stationStadiumSetback", description: "车站/体育场正面贴路：中心到路 ≤ 1.3 半径",
  measure(plan) {
    const out: Violation[] = [];
    for (const s of planSites(plan)) {
      const near = nearRoad(plan, s);
      if (specByKind(s.kind)?.planarAccess && near > s.radius * 1.3 && near <= s.radius + 90) out.push(v("stationStadiumSetback", s, `${s.kind} d=${Math.round(near)} r=${s.radius}`));
    }
    return out;
  },
};

export const stationDoorFacesRoad: Constraint = {
  id: "stationDoorFacesRoad", description: "车站模型局部 -z 正门对准已声明入口节点，夹角 < 45°",
  measure(plan) {
    const out: Violation[] = [];
    const roads = nonBridge(plan);
    for (const s of planSites(plan)) {
      const declaration = specByKind(s.kind)?.planarAccess;
      if (!declaration && s.access?.capability === "shore-plot-boundary") {
        const plot = specByKind(s.kind)?.plotBoundaryAccess;
        const gate = plan.roadNodes.find((node) => node.id === s.access!.nodeId);
        if (!plot || plot.schemaVersion !== 1 || plot.type !== "shore-plot-proxy" || !gate
          || Math.abs(Math.hypot(gate.x - s.x, gate.z - s.z) - s.radius - plot.gateOffset) > 0.02
          || s.access.entranceId !== "shore-plot-boundary" || s.access.entranceEvidence !== "plot-proxy"
          || s.access.doorX !== undefined || s.access.doorZ !== undefined || s.shore) {
          out.push(v("stationDoorFacesRoad", s, "invalid shore plot-boundary proxy (not a model door)"));
        }
        continue;
      }
      // An explicit offshore contract is validated by bridge/shore obligations,
      // not by a ground entrance normal. A tag alone cannot exempt a land owner.
      if (!declaration && s.shore && s.access?.capability === "island-causeway") continue;
      if (!declaration && !s.access) continue;
      const resolved = resolvePlanarAccess(declaration, s.radius);
      if (!resolved.ok || !Number.isFinite(s.yaw)) { out.push(v("stationDoorFacesRoad", s, "unsupported or invalid planar entrance declaration/pose")); continue; }
      const pose = planarAccessAtYaw(resolved.access, s, s.yaw);
      if (s.access) {
        const gate = plan.roadNodes.find((n) => n.id === s.access.nodeId);
        const expectedDoor = pose.door;
        const doorMatches = expectedDoor ? Number.isFinite(s.access.doorX) && Number.isFinite(s.access.doorZ)
          && Math.hypot(s.access.doorX! - expectedDoor.x, s.access.doorZ! - expectedDoor.z) <= 0.01
          && s.access.entranceEvidence === "model-position" : s.access.entranceEvidence === "plot-proxy" && s.access.doorX === undefined && s.access.doorZ === undefined;
        const origin = expectedDoor ?? s;
        const dx = gate ? gate.x - origin.x : 0;
        const dz = gate ? gate.z - origin.z : 0;
        const length = Math.hypot(dx, dz);
        const cosine = gate && length > 0 ? (pose.outward.x * dx + pose.outward.z * dz) / length : -1;
        if (!gate || !doorMatches || s.access.entranceId !== resolved.access.entranceId || cosine < Math.cos((45 * Math.PI) / 180)) out.push(v("stationDoorFacesRoad", s, "declared entrance position/evidence does not align with the plot gate"));
        continue;
      }
      const near = nearRoad(plan, s);
      if (near <= s.radius + 90) {
        const best = polylineClosest(roads.map((e: Site) => e.points), s);
        const bq = best as unknown as { d: number; q: Pt };
        const cos = (pose.outward.x * (bq.q.x - s.x) + pose.outward.z * (bq.q.z - s.z)) / (bq.d || 1);
        if (cos < Math.cos((45 * Math.PI) / 180)) out.push(v("stationDoorFacesRoad", s, `${s.kind} door faces away from the road (cos ${cos.toFixed(2)})`));
      }
    }
    return out;
  },
};

export const archStraddlesRoad: Constraint = {
  id: "archStraddlesRoad", description: "凯旋门骑路：主干道（宽 ≥ 12）从中心 3 内穿过，开口轴与路向夹角 ≤ 15°",
  measure(plan) {
    const out: Violation[] = [];
    const roads = nonBridge(plan);
    for (const s of planSites(plan)) {
      if (s.kind !== "arch") continue;
      const host = roads.filter((e: Site) => atLeast(e, "arterial")).map((e: Site) => closestPolylineSegment(e.points, s)).find((near) => near && near.d < 3);
      if (!host) out.push(v("archStraddlesRoad", s, `${s.kind} not on a road`));
      else {
        const dir = Math.atan2(host.b.x - host.a.x, host.b.z - host.a.z);
        let d = Math.abs(dir - s.yaw) % Math.PI; d = Math.min(d, Math.PI - d);
        if (d > (15 * Math.PI) / 180) out.push(v("archStraddlesRoad", s, `${s.kind} opening off road by ${Math.round((d * 180) / Math.PI)}deg`));
        else if (roads.some((road: Site) => road.points.slice(1).some((point: Vec2, i: number) =>
          !siteRoadClear(s, road.points[i], point, road.width))))
          out.push(v("archStraddlesRoad", s, "declared passage or pier clearance failed"));
      }
    }
    return out;
  },
};

export const civicPlazaCentred: Constraint = {
  id: "civicPlazaCentred", description: "市政广场与核心点（环岛圆心）重合，偏差 ≤ 4",
  measure(plan) {
    const civic = plan.publicSites.find((s: Site) => s.kind === "civic");
    if (!civic) return [];
    const off = Math.hypot(civic.x - plan.core.x, civic.z - plan.core.z);
    return off > 4 ? [v("civicPlazaCentred", civic, `civic plaza off the roundabout centre by ${Math.round(off)}`)] : [];
  },
};

export const suspensionBridgeClearOfHighways: Constraint = {
  id: "suspensionBridgeClearOfHighways", description: "悬索桥（门式塔高 34）桥身整段离环线高架 ≥ 35",
  measure(plan) {
    const bridge = plan.landmarks.find((l: Site) => l.kind === "suspension-bridge") as Site;
    if (!bridge) return [];
    let min = Infinity;
    for (const run of plan.highways ?? []) for (let k = 1; k < run.length; k += 1) for (let u = 0; u <= 10; u += 1) {
      const p = { x: bridge.x + (bridge.to.x - bridge.x) * (u / 10), z: bridge.z + (bridge.to.z - bridge.z) * (u / 10) };
      min = Math.min(min, seg(p, run[k - 1], run[k]));
    }
    return min < 35 ? [v("suspensionBridgeClearOfHighways", bridge, `expressway runs through the suspension bridge (clearance ${min.toFixed(1)})`)] : [];
  },
};

export const looseInlandRoadEnds: Constraint = {
  id: "looseInlandRoadEnds", description: "内陆断头：度为 1 且不属于计划内终点（滨海大道端/门前终点/沿河海路 run 端/近水终止）的路端；地形高度不参与判定",
  measure(plan) {
    const out: Violation[] = [];
    const deg = new Map<string, number>(); for (const e of plan.roadEdges) if (!e.bridge) for (const id of [e.from, e.to]) deg.set(id, (deg.get(id) || 0) + 1);
    const nodes = new Map<string, Site>(plan.roadNodes.map((n: Site) => [n.id, n]));
    // 豁免改用语义判定（planner/endpoints.ts，网络优先设计批次 1）：旧 height ≥ 2.5 是「靠水断头=合法」的
    // 地形代理，把平岛的内陆断头全部藏进盲区（四档 75–90% 的岛至少 1 个，2026-10-08 实测）。
    const world = {
      bridgeLandings: bridgeLandingNodes(plan.roadEdges), bridgeheadStubs: bridgeheadStubEnds(plan.roadEdges),
      sites: planSites(plan),
      boulevardEnds: (plan.seaside?.samples ?? []).filter((s: Site) => s.valid && s.boulevard).map((s: Site) => s.boulevard),
      // 海段 + 河岸段（批次 3-2 清偿切片分歧：曾只看海段，宽河 run 端 >40 时修复豁免、检测计违例）
      coastRoadRunEnds: [...(plan.coastRoads ?? []), ...(plan.riverRoadRuns ?? [])].flatMap((r: Site[]) => [r[0], r[r.length - 1]]),
      coast: plan.coast ?? [], river: plan.river ?? null, waterEdges: plan.waterEdges ?? [],
    };
    for (const [id, d] of deg) { if (d !== 1) continue; const q = nodes.get(id); if (!q || isPlannedRoadEnd(q, world)) continue; out.push({ constraint: "looseInlandRoadEnds", at: { x: q.x, z: q.z }, detail: `node ${id}` }); }
    return out;
  },
};

/** 锐角路口阈值（相邻两条路夹角下限）。生成器的口径；编辑器（planRoadRules.ts::SHARP_LIMIT）自 2026-10-21 起改用更严的
 *  50°（渲染层渠化阈值 CHANNEL_T_GAP，玩家造出的锐角口车拐不过来），不再与这里同步。表达式保持 `(30 * Math.PI) / 180` 原样，浮点结果逐位不变。
 *  改值是产品决策（会改变所有种子布局，见 CITY_PLANNER_REFACTOR_SPEC R3/R6），不在此随手改。 */
export const ACUTE_JUNCTION_RAD = (30 * Math.PI) / 180;

export const acuteJunctions: Constraint = {
  id: "acuteJunctions", description: "三路及以上的路口，相邻两条路夹角 ≥ 30°",
  measure(plan) {
    const out: Violation[] = [];
    const incident = new Map<string, Site[]>();
    for (const edge of plan.roadEdges) for (const id of [edge.from, edge.to]) (incident.get(id) ?? incident.set(id, []).get(id)!).push(edge);
    const nodes = new Map<string, Site>(plan.roadNodes.map((node: Site) => [node.id, node]));
    for (const [id, list] of incident) {
      if (list.length < 3) continue;
      const node = nodes.get(id) as Site;
      const angles = list.map((edge: Site) => { const pts = edge.from === id ? edge.points : [...edge.points].reverse(); return Math.atan2(pts[1].z - node.z, pts[1].x - node.x); }).sort((a: number, b: number) => a - b);
      for (let k = 0; k < angles.length; k += 1) {
        const gap = (k + 1 < angles.length ? angles[k + 1] : angles[0] + Math.PI * 2) - angles[k];
        if (gap < ACUTE_JUNCTION_RAD) { out.push({ constraint: "acuteJunctions", at: { x: node.x, z: node.z }, detail: `node ${id}` }); break; }
      }
    }
    return out;
  },
};

export const crowdedArterials: Constraint = {
  id: "crowdedArterials", description: "主干道不扎堆：不共享节点、彼此 < 25、夹角 < 15° 且侧向重叠的段对",
  measure(plan) {
    const out: Violation[] = [];
    const arterials: Site[] = plan.roadEdges.filter((edge: Site) => edge.kind === "arterial" && !edge.bridge).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (let a = 0; a < arterials.length; a += 1) for (let b = a + 1; b < arterials.length; b += 1) {
      const A = arterials[a]; const B = arterials[b];
      if ([A.from, A.to].some((id: string) => id === B.from || id === B.to)) continue;
      const conflict = crowdedPolylinePair(A.points, B.points);
      if (conflict) out.push({ constraint: "crowdedArterials", at: conflict.at, detail: `${A.from}-${A.to} ~ ${B.from}-${B.to}`,
        identity: JSON.stringify([[A.id, A.points], [B.id, B.points]]) });
    }
    return out;
  },
};

// ── 网络优先批次 5-3（设计 §4.2/§6）：最终连通与桥头连续 ─────────────────────────────────

/** 最终连通：除主网（intent.primaryComponentId 分量）外没有孤立路网分量。批次 4-3 删除
 *  tolerance 不校验直连后，被水/地形围死的分量如实保持隔离并在此计数（需求侧汇总见
 *  intent.ts 的 unmet district 需求；两个口径同源：都按 primary 分量判定）。 */
export const disconnectedComponents: Constraint = {
  id: "disconnectedComponents", description: "最终连通：除主网分量外没有孤立路网分量（被水/地形围死的分量如实计数，不再被非法直连掩盖）",
  measure(plan) {
    const comp = componentOf(plan);
    const primary = primaryComponentId(plan, comp);
    if (!primary) return [{ constraint: "disconnectedComponents", detail: "primary component missing (civic skeleton absent)" }];
    const seen = new Set<string>([primary]);
    const out: Violation[] = [];
    for (const n of plan.roadNodes) {
      const c = comp.get(n.id);
      if (!c || c === primary || seen.has(c)) continue;
      seen.add(c);
      out.push({ constraint: "disconnectedComponents", at: { x: n.x, z: n.z }, detail: `component ${c} not merged into the primary network` });
    }
    return out;
  },
};

/** 桥头连续：每条桥面的两端必须接着地面路（桥头悬空 = 桥接到虚无）。海上地标
 *  （shore 存在）的岛侧桥头是堤道尽端、即该地标的 site-access 入口，按端点角色豁免。 */
export const bridgeheadContinuity: Constraint = {
  id: "bridgeheadContinuity", description: "桥头连续：桥边两端各至少接一条非桥边（海上地标岛侧堤道尽端豁免）",
  measure(plan) {
    const out: Violation[] = [];
    const grounded = new Map<string, boolean>();
    for (const e of plan.roadEdges) if (!e.bridge) for (const id of [e.from, e.to]) grounded.set(id, true);
    const nodes = new Map<string, Site>(plan.roadNodes.map((n: Site) => [n.id, n]));
    const islandSites = planSites(plan).filter((s: Site) => s.shore);
    for (const e of plan.roadEdges) {
      if (!e.bridge) continue;
      for (const id of [e.from, e.to]) {
        const node = nodes.get(id);
        if (!node) { out.push({ constraint: "bridgeheadContinuity", identity: `${e.id}:${id}`, detail: `bridge ${e.id} end ${id} is missing` }); continue; }
        if (grounded.get(id)) continue;
        if (isOwnedIslandGate(id, islandSites)) continue;
        out.push({ constraint: "bridgeheadContinuity", identity: `${e.id}:${id}`, at: { x: node.x, z: node.z }, detail: `bridge ${e.id} end ${id} has no ground road` });
      }
    }
    return out;
  },
};

export const unjoinedGroundJunctions: Constraint = {
  id: "unjoinedGroundJunctions", description: "地面交叉/近接0.5范围必须共用真实节点，桥不平接",
  measure: (plan) => {
    const edges = new Map(plan.roadEdges.map((edge) => [edge.id, edge]));
    return groundJunctionFindings(plan.roadEdges).map((finding) => ({
      constraint: "unjoinedGroundJunctions", detail: finding.id,
      // Until verified lineage/remap is available, changed participant geometry
      // cannot claim to be the same pre-existing contact merely by keeping IDs.
      identity: JSON.stringify(finding.edges.map((id) => [id, edges.get(id)?.points])),
    }));
  },
};

export const CONSTRAINTS: Constraint[] = [
  unjoinedGroundJunctions,
  siteInWater, siteWithoutDoorRoad, roadThroughSite, sitesOverlap, parcelInsideSite,
  stationStadiumSetback, stationDoorFacesRoad, archStraddlesRoad, civicPlazaCentred,
  suspensionBridgeClearOfHighways, looseInlandRoadEnds, acuteJunctions, crowdedArterials,
  disconnectedComponents, bridgeheadContinuity,
];
