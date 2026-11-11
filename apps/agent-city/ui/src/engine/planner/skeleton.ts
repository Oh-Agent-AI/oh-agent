/**
 * 骨架阶段（CITY_PLANNER_V2_SPEC §5.1 / 步 2a 先迁核心点选择；主干/桥/环线在步 2b 迁入）。
 *
 * chooseCore 从 buildPlan 逐字迁出：25×25 网格打分（离岸 0.32R、离山脊远、靠河、种子抖动）。
 * random 为无状态键控哈希，迁移不改调用序；行为保持由基线哈希证明。
 */
import { roadWidthFor, EXPRESSWAY_DECK_WIDTH } from "../roadStandard";
import { DetMath as Math } from "../detMath";
import { fbm } from "../cityNoise";
import type { Landmark } from "../cityPlan";
import { segmentDistance } from "../roadGeometry";
import type { CityLayout, PublicSite, Vec2 } from "../cityLayout";
import { addNetworkEdge, keyOf, commitNetworkPatch, previewNetworkPatch, type Network, type NetworkPatch } from "./network";
import { chordClearsDisc, reStickClearance, walkableCorridor } from "./connect";
import type { ConnectorWorld } from "./connect";
import { groundJunctionCorridorViolation } from "./civicClearance";
import { polylineDistance } from "./footprint";
import type { Geography } from "./geography";

export type SkeletonDiagnostic = { trunk: number; phase: "ground-corridor" | "bridge-ground" | "route"; reason: string; cause: string; at?: Vec2 };

/** Screen quantized geometry before publication. Re-evaluate after retreat:
 * a declined deck must not leave its approach exemption on the retained prefix. */
export function screenTrunkRoute(world: ConnectorWorld, input: Vec2[], spans: CityLayout["bridges"], trunk: number) {
  let points = input.map(keyOf);
  const diagnostics: SkeletonDiagnostic[] = [];
  const idOf = (point: Vec2) => `${point.x}:${point.z}`;
  const isDeck = (a: Vec2, b: Vec2) => spans.some((span) => idOf(keyOf(span.from)) === idOf(a) && idOf(keyOf(span.to)) === idOf(b));
  const patchFor = (route: Vec2[]): NetworkPatch => ({ baseVersion: world.network.version ?? 0, removeEdgeIds: [], splits: [],
    addEdges: route.slice(1).map((b, i) => ({ a: route[i], b, arterial: true, primary: true, bridge: isDeck(route[i], b) })) });
  const problem = (network: Network, route: Vec2[]): { index: number; diagnostic: SkeletonDiagnostic } | null => {
    for (let k = 1; k < route.length; k += 1) {
      const a = route[k - 1], b = route[k], id = [idOf(a), idOf(b)].sort().join("/");
      const edge = network.edges.get(id);
      if (!edge || edge.width !== roadWidthFor("arterial") || edge.kind !== "arterial" || !!edge.bridge !== isDeck(a, b)) return { index: k,
        diagnostic: { trunk, phase: "route", reason: "projection-loss", cause: "geometry-or-class-mismatch" } };
      if (edge.bridge) {
        const groundAt = (nodeId: string) => [...network.edges.values()].some((road) => !road.bridge && (road.from === nodeId || road.to === nodeId)
          && road.points.slice(1).every((point, i) => !groundJunctionCorridorViolation({ ...world, network }, road.points[i], point, road.width, road)));
        if (!groundAt(edge.from) || !groundAt(edge.to)) return { index: k,
          diagnostic: { trunk, phase: "bridge-ground", reason: "no-target", cause: "missing-ground-approach" } };
      } else {
        const failure = groundJunctionCorridorViolation({ ...world, network }, a, b, edge.width, edge);
        if (failure) return { index: k, diagnostic: { trunk, phase: "ground-corridor", reason: failure.kind,
          cause: failure.cause, ...(failure.at ? { at: failure.at } : {}) } };
      }
    }
    return null;
  };
  while (points.length >= 3) {
    const patch = patchFor(points), preview = previewNetworkPatch(world.network, patch);
    if (!preview.ok) {
      diagnostics.push({ trunk, phase: "route", reason: preview.reason, cause: preview.detail ?? "patch-preview-failed" });
      points = []; break;
    }
    const failed = problem(preview.network, points);
    if (!failed) {
      const accepted = spans.filter((span) => points.slice(1).some((b, i) => idOf(points[i]) === idOf(keyOf(span.from)) && idOf(b) === idOf(keyOf(span.to))));
      return { points, bridges: accepted, diagnostics, patch, validate: (draft: Network) => problem(draft, points)?.diagnostic.cause ?? null };
    }
    diagnostics.push(failed.diagnostic);
    points = points.slice(0, failed.index);
  }
  diagnostics.push({ trunk, phase: "route", reason: "no-target", cause: "no-valid-trunk-prefix" });
  return { points: [] as Vec2[], bridges: [] as CityLayout["bridges"], diagnostics, patch: null, validate: (_draft: Network): string | null => "no-valid-trunk-prefix" };
}

/** 环线高架在方位角 t 处的采样点（唯一公式，chooseCore 的成活率估计与 buildSkeleton 共用）。 */
function ringPointAt(core: Vec2, R: number, seed: number, t: number): Vec2 {
  const r = 0.55 * R * (1 + 0.08 * fbm(Math.cos(t) * 1.7, Math.sin(t) * 1.7, seed + 91, 2));
  return { x: core.x + Math.cos(t) * r, z: core.z + Math.sin(t) * r };
}

export function chooseCore(geo: Geography, seed: number, random: (key: string) => number): Vec2 {
  const { R, bbox, buildable, coastDistance, riverX, riverWidth, hasRiver, hillProj, hillLine, riverShift } = geo;
  // ── 城市核心点：可建地上评分最高处——离岸约 0.32R、离山脊远、靠河（有河时）。
  // V2 步 4（§5.4，按普查实证收敛）：核心与广场的联合决定由两半构造——
  // ① 出口接驳弦净空（buildSkeleton）：环线高架不再从广场上空切过，re-stick 不再推走广场；
  // ② 广场落位后核心跟随（cityPlan）：snap 即使推开广场，环岛/放射主干仍围着广场画。
  // 曾试「候选核心硬门（landClearance ≥ 58 + isDry 52）」：civicPlazaCentred 同样归零，但核心被
  // 推离地理最优，四档普查平均分下降（t1 −0.019），不采用——约束已由 ①② 构造成立，见步 4 提交。
  // 环线高架绕核心画：成活判据与生成端同口径（0..96 顺序、不跨首尾合并、run 需连续 ≥6 点）——
  // 统计最长连续成活段，< 6 的核心降分：散点再多也拼不出一段合法高架（§5.4；评审 P2）。
  const ringSurvival = (c: Vec2): number => {
    let longest = 0; let run = 0;
    for (let i = 0; i <= 96; i += 1) {
      const q = ringPointAt(c, R, seed, (i / 96) * Math.PI * 2);
      if (coastDistance(q.x, q.z) > 0 && hillProj(q.x, q.z) < hillLine - 12) { run += 1; if (run > longest) longest = run; }
      else run = 0;
    }
    return longest;
  };
  let core: Vec2 = { x: riverShift, z: 0 };
  let best = -Infinity;
  for (let gx = 0; gx <= 24; gx += 1) for (let gz = 0; gz <= 24; gz += 1) {
    const x = bbox.minX + ((bbox.maxX - bbox.minX) * gx) / 24;
    const z = bbox.minZ + ((bbox.maxZ - bbox.minZ) * gz) / 24;
    if (!buildable(x, z)) continue;
    // 开湾：核心（Downtown）只落在西岛大陆，并离湾岸 0.12R——曾按窄河的「离岸 70」贴在湾边，
    // 朝湾的主干道一出广场就进水，本岸没有引道，跨湾桥全被拒（seed 807065449/5 档实测）。
    const bayMode = geo.maxWaterSpan > 140;
    if (bayMode && x > riverX(z)) continue;
    const shore = coastDistance(x, z);
    const riverGap = hasRiver ? Math.abs(Math.abs(x - riverX(z)) - riverWidth(z) - (bayMode ? 0.12 * R : 70)) : 0;
    const score = -Math.abs(shore - 0.32 * R) - riverGap * 0.6 - Math.max(0, hillProj(x, z) - hillLine * 0.4) * 0.8 + random(`core${gx}:${gz}`) * 8;
    const total = score - (ringSurvival({ x, z }) < 6 ? 40 : 0);
    if (total > best) { best = total; core = { x, z }; }
  }
  return core;
}

/**
 * 骨架生成（CITY_PLANNER_V2_SPEC §5.1 / 步 2b-full）：主干放射（含最窄处过河）、环线高架（含修剪与出口接入）。
 * 从 buildPlan 逐字迁出；random 为无状态键控哈希、迁移不改调用序，行为保持由基线哈希证明。
 * 输入全是数据（geography/core/sites/network），输出 { trunks, bridges, ringRuns }—— highwayRuns 即 ringRuns 的别名（原样保留在 buildPlan）。
 */

export type TrunkRun = { angle: number; points: Vec2[] };

export function buildSkeleton(opts: {
  geo: Geography; seed: number; core: Vec2;
  publicSites: PublicSite[]; landmarks: Landmark[];
  shoreSiteKinds: Set<string>;
  random: (key: string) => number;
  network: Network;
  /** buildPlan 的河道闭包（含 coastDistance>0 短路）——geography 阶段尚未收编，先作参数。 */
  inRiver: (x: number, z: number) => boolean;
}): { trunks: TrunkRun[]; bridges: CityLayout["bridges"]; ringRuns: Vec2[][]; primaryAnchorNodeId: string | null; primaryAnchorNodeIds: string[]; diagnostics: SkeletonDiagnostic[] } {
  const { geo, seed, core, publicSites, landmarks, random, network } = opts;
  const SHORE_SITE_KINDS = opts.shoreSiteKinds;
  const { R, hasRiver, coastDistance, hillDir, hillProj, hillLine, buildable } = geo;
  const { inRiver } = opts;
  const { edges } = network;
  const key = keyOf;
  const addEdge = (a: Vec2, b: Vec2, arterial: boolean, bridge = false, primary = false) => addNetworkEdge(network, a, b, arterial, bridge, primary);
  // 市政广场（核心处，半径 44）外环路半径：主干道都接在这一圈上，广场四周是路、中间不走车。
  const PLAZA_RING = 52;
  // 主干道：5–6 条，均分方位 + 抖动；指向山脊的方向（与山脊方位夹角 < 40°）不修路。
  const trunkCount = 5 + Math.floor(random("trunks") * 2);
  const trunkBase = random("trunkBase") * Math.PI * 2;
  const trunks: Array<{ angle: number; points: Vec2[] }> = [];
  const bridges: CityLayout["bridges"] = [];
  const diagnostics: SkeletonDiagnostic[] = [];
  for (let i = 0; i < trunkCount; i += 1) {
    const nominal = trunkBase + (i / trunkCount) * Math.PI * 2 + (random(`trunkJ${i}`) - 0.5) * 0.35;
    // 桥址取最窄处（规划旧债 D-桥址，CITY_ROAD_SIMULATION_PROPOSAL §1）：主干道是从核心出发的射线，过河位置
    // 曾由抖动角度偶然决定。在 ±0.14 弧度内选过河跨距最短的角度；跨距相同取偏移最小者，尽量不动原规划。
    const waterSpan = (a: number) => {
      const d = { x: Math.cos(a), z: Math.sin(a) };
      let span = 0; let entered = false;
      for (let step = Math.ceil(PLAZA_RING / 12) + 1; step < 400; step += 1) {
        const q = { x: core.x + d.x * step * 12, z: core.z + d.z * step * 12 };
        if (inRiver(q.x, q.z)) { span += 12; entered = true; continue; }
        if (entered || coastDistance(q.x, q.z) <= 0) break;
      }
      return span;
    };
    let angle = nominal;
    if (hasRiver) {
      let best = { offset: 0, span: waterSpan(nominal) };
      if (best.span > 0) for (let k = -7; k <= 7; k += 1) {
        const offset = k * 0.02; const span = waterSpan(nominal + offset);
        if (span > 0 && (span < best.span || (span === best.span && Math.abs(offset) < Math.abs(best.offset)))) best = { offset, span };
      }
      angle = nominal + best.offset;
    }
    const dir = { x: Math.cos(angle), z: Math.sin(angle) };
    if (dir.x * hillDir.x + dir.z * hillDir.z > Math.cos((40 * Math.PI) / 180)) continue;
    // 主干道从市政广场外环出发（环形广场 = 环岛），不再穿过广场中心。
    const start = { x: core.x + dir.x * PLAZA_RING, z: core.z + dir.z * PLAZA_RING };
    const points: Vec2[] = [start];
    const rayBridges: CityLayout["bridges"] = [];
    let water = 0;
    let lastLand: Vec2 = start;
    let farBank = 0;
    for (let step = Math.ceil(PLAZA_RING / 12) + 1; step < 400; step += 1) {
      const q = { x: core.x + dir.x * step * 12, z: core.z + dir.z * step * 12 };
      if (inRiver(q.x, q.z)) {
        // 开湾：方向偏离东西向超过 30° 的主干道停在本岸，过湾交给等距的平行堤道（buildCauseways）。
        // 斜射线过湾的桥长 500–700，两条还会在湾上交叉成 X（seed 807065449/5 档截图）。
        if (water === 0 && geo.maxWaterSpan > 140 && Math.abs(dir.z) > 0.5) {
          if (points[points.length - 1] !== lastLand) points.push(lastLand);
          break;
        }
        // 入水前的最后一个陆地点作为桥头（曾用「每 3 步才记一次」的上一个路点，桥头最多退回岸上 36）。
        if (water === 0 && points[points.length - 1] !== lastLand) points.push(lastLand);
        water += 12; if (water > geo.maxWaterSpan) break; continue; // 河最多跨 140；开湾时按湾宽放开（堤道）
      }
      // Riverbank setbacks are not obstacles to a road crossing the river.
      if (coastDistance(q.x, q.z) <= 0 || hillProj(q.x, q.z) >= hillLine - 12) {
        // 开湾：东岛窄，主干道刚上岸几步就碰到外侧海岸。桥落点后面没有地面段，桥头就没有引道
        // （screenTrunkRoute 以 missing-ground-approach 拒掉整条，seed 807065449/5 档实测）。
        // 上岸后走过的最后一个陆地点补进路线当引道；一个都没走到，就退掉这座桥，主干道停在本岸桥头。
        const landing = rayBridges[rayBridges.length - 1];
        if (geo.maxWaterSpan > 140 && water === 0 && landing && points[points.length - 1] === landing.to) {
          const beyond = (lastLand.x - landing.to.x) * dir.x + (lastLand.z - landing.to.z) * dir.z > 0;
          if (beyond) points.push(lastLand);
          else { points.pop(); rayBridges.pop(); }
        } else if (geo.maxWaterSpan > 140 && points[points.length - 1] !== lastLand) {
          // 路点每 3 步（36）才记一次：停在海岸时最后一个路点可能离 lastLand 还差 36，加上离岸 13 的门槛，
          // 端头离水最远 ~49，过了近水终止带（40）成了断头（seed 1703294958/2 档实测）。把 lastLand 补进路线。
          points.push(lastLand);
        }
        break;
      }
      // 岸边用地（港口/灯塔/歌剧院/摩天轮）：主干道到它门口为止，这一段就是它的入口路。
      // 曾一路穿过去直到海边（港口中心离主干道 1 单位）。
      // 开湾时只为位置固定的港口停：可挪动的岸边地标（庄园/歌剧院/灯塔…）随后会被贴岸遍挪走，主干道端头留在原地成了
      // 离新位置 30+ 的断头（seed 1703294958/2 档实测：庄园挪到 67 外）。它们贴岸时本来就避让主干道。
      if (water === 0 && [...publicSites, ...landmarks].some((site) => SHORE_SITE_KINDS.has(site.kind)
        && (geo.maxWaterSpan <= 140 || site.kind === "harbor") && Math.hypot(q.x - site.x, q.z - site.z) < site.radius + 4)) {
        if (points[points.length - 1] !== lastLand) points.push(lastLand);
        break;
      }
      if (water > 0) {
        // 对岸退界最多再铺 3 步（36）桥面就落地：曾一直延伸到「可建设」地块为止——对岸是一长条不可建的
        // 低地/海岸带时，「桥」在干地上又铺了两百多单位（扩到 1 档 2000 栋的大岛后 seed 2175747322 实测）。
        if (!buildable(q.x, q.z) && farBank < 3) { farBank += 1; continue; }
        farBank = 0;
        // 刚过完河：把对岸点接上，这一段是桥。
        const from = points[points.length - 1];
        rayBridges.push({ from, to: q, angle: Math.atan2(q.z - from.z, q.x - from.x), length: Math.hypot(q.x - from.x, q.z - from.z) });
        points.push(q);
        water = 0;
        continue;
      }
      // 开湾时桥头只记在离岸 ≥10 的陆地上：湾岸是长缓坡，离水 <3 的点高度已 ≤0.5，桥头落在那里时
      // 引道两侧的横向采样会掉进水里，整条跨湾主干道被走廊检查以 water-span 拒掉（seed 807065449/5 档实测）。
      // 岸边带内的点也不进路线：否则路线先走到岸边、再折回桥头，引道是一段回头路。
      // 门槛 13（> buildable 的 12）：离岸 10–12 的路点过不了地面路走廊的可建设检查，整段被退回到更早的点，
      // 端头停在离水 ~50 的内陆成了断头（seed 1703294958/2 档实测 trunk 3 building-setback）。
      if (geo.maxWaterSpan > 140 && geo.landClearance(q.x, q.z) < 13) continue;
      lastLand = q;
      if (step % 3 === 0) points.push(q);
    }
    if (points.length < 3) continue;
    const world = { network, geo, inRiver, reservations: () => [...publicSites, ...landmarks] };
    const screened = screenTrunkRoute(world, points, rayBridges, i);
    diagnostics.push(...screened.diagnostics);
    if (!screened.patch) continue;
    const result = commitNetworkPatch(network, screened.patch, screened.validate);
    if (!result.ok) { diagnostics.push({ trunk: i, phase: "route", reason: result.reason, cause: result.detail ?? "commit-rejected" }); continue; }
    bridges.push(...screened.bridges);
    trunks.push({ angle, points: screened.points });
  }
  trunks.sort((p, q) => p.angle - q.angle);
  if (geo.maxWaterSpan > 140) buildCauseways(geo, network, inRiver, publicSites, landmarks, bridges, diagnostics);
  let primaryAnchorNodeId: string | null = null;
  let primaryAnchorDistance = Infinity;
  const civicNodes = new Map<string, Vec2>();
  // 广场环路：经过每条主干道的起点，其余按 24 等分补点；跨河/不可建的弧段不修。
  {
    const angles = [...trunks.map((t) => ((t.angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)),
      ...Array.from({ length: 24 }, (_, i) => (i / 24) * Math.PI * 2)].sort((a, b) => a - b)
      .filter((a, i, all) => i === 0 || a - all[i - 1] > 0.08);
    const ringPoint = (a: number) => {
      const trunk = trunks.find((t) => Math.abs((((t.angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - a) < 1e-9);
      return trunk ? trunk.points[0] : { x: core.x + Math.cos(a) * PLAZA_RING, z: core.z + Math.sin(a) * PLAZA_RING };
    };
    for (let i = 0; i < angles.length; i += 1) {
      const a = ringPoint(angles[i]); const b = ringPoint(angles[(i + 1) % angles.length]);
      const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      if (inRiver(mid.x, mid.z) || inRiver(a.x, a.z) || inRiver(b.x, b.z) || coastDistance(mid.x, mid.z) <= 0) continue;
      addEdge(a, b, true);
      for (const p of [a, b]) {
        const id = `${keyOf(p).x}:${keyOf(p).z}`;
        civicNodes.set(id, keyOf(p));
        const q = keyOf(p); const distance = Math.hypot(q.x - core.x, q.z - core.z);
        if (distance < primaryAnchorDistance || (distance === primaryAnchorDistance && (primaryAnchorNodeId === null || id < primaryAnchorNodeId))) {
          primaryAnchorNodeId = id; primaryAnchorDistance = distance;
        }
      }
    }
  }
  // 环线高架：半径 0.55R ± fbm，河流/河岸连续跨越，仅出海或进山时断开。
  const ringRuns: Vec2[][] = [];
  let run: Vec2[] = [];
  for (let i = 0; i <= 96; i += 1) {
    const t = (i / 96) * Math.PI * 2;
    const q = ringPointAt(core, R, seed, t);
    // 开湾时环线也在海湾处断开：环半径 0.55R 必然斜穿海湾，高架斜跨 300+ 的湾面，和平行堤道
    // 交叉成一片乱线（seed 807065449/5 档截图）。两岸各留一段弧，端头由下面的修剪 + 出口接入收尾。
    if (coastDistance(q.x, q.z) > 0 && hillProj(q.x, q.z) < hillLine - 12 && !(geo.maxWaterSpan > 140 && inRiver(q.x, q.z))) run.push(q);
    else { if (run.length >= 6) ringRuns.push(run); run = []; }
  }
  if (run.length >= 6) ringRuns.push(run);
  // Highway fragments stop at the coast today, where the deck still hangs above
  // the ground. Trim each end to buildable land, then connect it to a nearby arterial.
  // 批次 5-2：出口接驳弦的净空/可走校验改走连接器共享的 corridor validator（connect.ts），
  // 不再当 69 特例——公式同源（re-stick 净空 EXPRESSWAY_DECK_WIDTH / 2 + hypot(88,88)/2 + 1，向上取整 = 69）。
  // 落点以NetworkPatch拓扑细分，继承宿主等级/宽度/结构而不按默认arterial重建。
  const EXIT_CONE = (60 * Math.PI) / 180; // 出口接驳弦与环线切线的最大夹角
  const EXIT_STEP = 8;                    // 接驳曲线采样间距（世界单位）
  const chordClearance = reStickClearance(88, 88); // 88 = 高架双车道幅面（clearsHighways 同尺寸）
  for (let r = ringRuns.length - 1; r >= 0; r -= 1) {
    const points = ringRuns[r];
    if (Math.hypot(points[0].x - points[points.length - 1].x, points[0].z - points[points.length - 1].z) < 0.01) continue;
    const safe = (p: Vec2) => buildable(p.x, p.z);
    while (points.length > 6 && !safe(points[0])) points.shift();
    while (points.length > 6 && !safe(points[points.length - 1])) points.pop();
    if (points.length <= 6) { ringRuns.splice(r, 1); continue; }
    // 出口接驳弦（闸道）：高架在这里落地并入干道，是「高架 ↔ 普通道路」的过渡段，必须顺着环线走、顺着干道并入。
    // 曾取「离端点最近的干道点」：弦的方向与环线切线没有任何约束，端点落在出口之前时环线要「走过头再折回」，
    // 成了一根 150°–180° 的尖刺（基线 11 条高架里 10 条有；开湾后环线断成更多段，更显眼），或一条斜插的长弦。
    // 现在：① 只接受朝前的出口（弦与环线切线夹角 ≤ EXIT_CONE）；前方没有就把环线末端往回缩一个点再找（最多 8 个）；
    // ② 弦做成三次曲线——起点切线 = 环线切线，终点切线 = 干道方向（与行进同向），按 EXIT_STEP 采样，
    // 每段都要过「可走」与「不切近广场」校验，不过则退回直线弦（仍满足朝前）。
    const exits: Vec2[] = [];
    const exitCurves: Vec2[][] = [[], []];
    const unit = (v: Vec2): Vec2 => { const l = Math.hypot(v.x, v.z) || 1; return { x: v.x / l, z: v.z / l }; };
    // 接驳弦/曲线不得压公共用地与地标（与 verify-react-city-geography 同口径：桥面半宽 EXPRESSWAY_DECK_WIDTH / 2 + 半径 + 1）：
    // 曲线比直弦外拱，曾把高架送到港口上（seed 3576928465 间距 29.5）。
    const sitesClear = (a: Vec2, b: Vec2) => [...publicSites, ...landmarks].every((site) => !site.radius || chordClearsDisc(a, b, site, EXPRESSWAY_DECK_WIDTH / 2 + site.radius + 1));
    const pickExit = (fromStart: boolean): { p: Vec2; curve: Vec2[] } | null => {
      for (let trim = 0; trim <= 8 && points.length > 6; trim += 1) {
        const i = fromStart ? 0 : points.length - 1; const j = fromStart ? 1 : points.length - 2;
        const end = points[i];
        const tangent = unit({ x: end.x - points[j].x, z: end.z - points[j].z });
        const candidates: Array<{ p: Vec2; distance: number; host: Vec2; score: number }> = [];
        for (const edge of edges.values()) {
          if (edge.bridge) continue;
          const [a, b] = edge.points;
          const dx = b.x - a.x; const dz = b.z - a.z;
          const t = Math.max(0, Math.min(1, ((end.x - a.x) * dx + (end.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
          const p = key({ x: a.x + t * dx, z: a.z + t * dz });
          if (Math.hypot(p.x - core.x, p.z - core.z) < 110) continue; // 出口不能落在环岛附近：高架贴到市政广场（半径 44 + 避让 ≈ 69）会把广场推离核心点
          if (!chordClearsDisc(end, p, core, chordClearance) || !sitesClear(end, p)) continue; // 出口接驳弦本身也不得切近广场：端点 ≥110 不够，弦可从核心旁切过（seed 2002199309 实测弦离核心 56.7，把广场推走 72）；69 = re-stick 净空刚过线
          const distance = Math.hypot(p.x - end.x, p.z - end.z);
          // 朝前：弦与环线切线的夹角不超过 EXIT_CONE（距离 < 1 的出口就在端点上，不受限）。
          const cosine = distance > 1 ? (tangent.x * (p.x - end.x) + tangent.z * (p.z - end.z)) / distance : 1;
          if (cosine < Math.cos(EXIT_CONE)) continue;
          // 偏好更直的出口：距离 × (1 + 3·(1 − cos 偏角))；贴着锥边的近出口会让接驳处出现明显折角。
          if (walkableCorridor(geo, end, p)) candidates.push({ p, distance, host: unit({ x: dx, z: dz }), score: distance * (1 + 3 * (1 - cosine)) });
        }
        candidates.sort((a, b) => a.score - b.score);
        const best = candidates[0];
        if (best) {
          // 三次曲线：起点切线 = 环线切线，终点切线 = 干道方向（取与行进同向的一侧）。
          const chord = { x: best.p.x - end.x, z: best.p.z - end.z };
          const arrive = best.host.x * chord.x + best.host.z * chord.z >= 0 ? best.host : { x: -best.host.x, z: -best.host.z };
          const steps = Math.max(3, Math.ceil(best.distance / EXIT_STEP));
          // 控制柄由长到短依次试：外拱的曲线擦到水边/山坡（采样点不可建）时，换更贴近弦的曲线，最后才退回直线。
          let curve: Vec2[] = [];
          if (best.distance > 6) for (const handle of [0.45, 0.3, 0.18]) {
            const h = best.distance * handle;
            const c1 = { x: end.x + tangent.x * h, z: end.z + tangent.z * h }, c2 = { x: best.p.x - arrive.x * h, z: best.p.z - arrive.z * h };
            const samples: Vec2[] = [];
            for (let k = 1; k < steps; k += 1) {
              const q = k / steps, o = 1 - q;
              samples.push(key({ x: o * o * o * end.x + 3 * o * o * q * c1.x + 3 * o * q * q * c2.x + q * q * q * best.p.x, z: o * o * o * end.z + 3 * o * o * q * c1.z + 3 * o * q * q * c2.z + q * q * q * best.p.z }));
            }
            const path = [end, ...samples, best.p];
            if (path.every((q, k) => k === 0 || (chordClearsDisc(path[k - 1], q, core, chordClearance) && sitesClear(path[k - 1], q) && walkableCorridor(geo, path[k - 1], q)))) { curve = samples; break; }
          }
          return { p: best.p, curve };
        }
        if (fromStart) points.shift(); else points.pop();
      }
      return null;
    };
    for (const [slot, fromStart] of ([[0, true], [1, false]] as const)) {
      const picked = pickExit(fromStart);
      if (!picked) break;
      exits.push(picked.p);
      exitCurves[slot] = fromStart ? [...picked.curve].reverse() : picked.curve;
    }
    if (exits.length !== 2) { ringRuns.splice(r, 1); continue; }
    ringRuns[r] = [exits[0], ...exitCurves[0], ...points, ...exitCurves[1], exits[1]].filter((p, i, all) => i === 0 || Math.hypot(p.x - all[i - 1].x, p.z - all[i - 1].z) > 0.01);
    for (const endpoint of exits) {
      const at = keyOf(endpoint), nodeId = `${at.x}:${at.z}`;
      const hosts = [...edges.values()].filter((edge) => !edge.bridge && edge.from !== nodeId && edge.to !== nodeId
        && polylineDistance([edge.points], at) <= 0.02);
      if (hosts.length) {
        // One atomic topological refinement preserves arbitrary host widths,
        // structure, curve and ordered lineage. Never delete then recreate as8.
        const split = commitNetworkPatch(network, { baseVersion: network.version,
          removeEdgeIds: [], addEdges: [], splits: hosts.map((edge) => ({ edgeId: edge.id, at })) });
        if (!split.ok) {
          diagnostics.push({ trunk: -1, phase: "route", reason: split.reason, cause: `ring-exit-split:${split.detail ?? split.reason}` });
          ringRuns.splice(r, 1); break;
        }
      }
    }
  }
  const primaryAnchorNodeIds = [...civicNodes.keys()].sort((a, b) => {
    const p = civicNodes.get(a)!; const q = civicNodes.get(b)!;
    return Math.hypot(p.x - core.x, p.z - core.z) - Math.hypot(q.x - core.x, q.z - core.z) || (a < b ? -1 : a > b ? 1 : 0);
  });
  return { trunks, bridges, ringRuns, primaryAnchorNodeId, primaryAnchorNodeIds, diagnostics };
}

/**
 * 跨湾堤道（Vice City 式）：开湾时沿海湾等距架 3 条东西向堤道。
 * 只靠放射主干道「顺路过湾」时，核心常在岛的一端，射线斜着过湾，跨湾通道只有 1–2 条且位置随缘
 * （6 种子 × 3 档实测）。堤道沿等 z 线直跨：西岸引道 → 桥 → 东岸引道，两端各留一段地面路当桥头引道，
 * 和街网的连接交给后面的连通阶段（connectGeneratedComponents）。已有跨湾桥附近的那一条不再重复架。
 */
function buildCauseways(geo: Geography, network: Network, inRiver: (x: number, z: number) => boolean,
  publicSites: PublicSite[], landmarks: Landmark[], bridges: CityLayout["bridges"], diagnostics: SkeletonDiagnostic[]): void {
  const { coast, riverX, riverWidth, landClearance, coastDistance } = geo;
  const eastShore = coast.filter((p) => p.x > riverX(p.z) + riverWidth(p.z));
  if (eastShore.length < 3) return;
  const minZ = Math.min(...eastShore.map((p) => p.z)); const maxZ = Math.max(...eastShore.map((p) => p.z));
  const spacing = (maxZ - minZ) / 4;
  const crossesBay = (b: CityLayout["bridges"][number]) => (b.from.x - riverX(b.from.z)) * (b.to.x - riverX(b.to.z)) < 0;
  const world = { network, geo, inRiver, reservations: () => [...publicSites, ...landmarks] };
  const clearOfSites = (p: Vec2) => [...publicSites, ...landmarks].every((site) => Math.hypot(p.x - site.x, p.z - site.z) > site.radius + 16);
  for (let k = 1; k <= 3; k += 1) {
    const z = minZ + spacing * k;
    // 已有跨湾桥附近不重复架——除非这条线上有湾内岛：岛只能靠这条堤道上岸（seed 1703342472 实测 Leaf Links 成孤岛）。
    const onIslet = geo.islets.some((i) => Math.abs(z - i.z) < i.radius * 0.6);
    if (!onIslet && bridges.some((b) => crossesBay(b) && Math.abs((b.from.z + b.to.z) / 2 - z) < spacing * 0.5)) continue;
    // 两岸桥头：从湾岸各向外走，直到离岸 ≥10（与主干道桥头同一口径）。
    const walk = (side: -1 | 1): Vec2 | null => {
      for (let d = 0; d < 240; d += 4) { // 步长 4：桥头离岸 10–14（步长 12 时 10–22）
        const p = { x: riverX(z) + side * (riverWidth(z) + d), z };
        if (coastDistance(p.x, p.z) <= 0) return null;
        if (landClearance(p.x, p.z) >= 10 && !inRiver(p.x, p.z)) return p;
      }
      return null;
    };
    const west = walk(-1); const east = walk(1);
    if (!west || !east) { diagnostics.push({ trunk: 100 + k, phase: "route", reason: "no-target", cause: "causeway-no-landing" }); continue; }
    // 引道：桥头外再走 20（走不满退到 16）。端头离湾岸 ≤ 34，落在近水终止带（WATER_STOP_MARGIN 40）内：
    // 引道靠后面的连通阶段接进街网，没被接满时剩下的尾段是合法的近水尽端。曾走 48，端头离岸 58–70，
    // 被街在中途 T 接后剩下的 5 长尾巴成了违规断头（seed 1703310796/1–2 档实测）。
    const approach = (from: Vec2, side: -1 | 1): Vec2 | null => {
      for (const d of [20, 16]) {
        const p = { x: from.x + side * d, z };
        if (coastDistance(p.x, p.z) > 20 && landClearance(p.x, p.z) >= 10) return p;
      }
      return null;
    };
    const westIn = approach(west, -1); const eastIn = approach(east, 1);
    if (!westIn || !eastIn || ![westIn, west, east, eastIn].every(clearOfSites)) {
      diagnostics.push({ trunk: 100 + k, phase: "route", reason: "no-target", cause: "causeway-no-approach" }); continue;
    }
    // 穿过湾心小岛时拆成两座桥：桥 → 岛上一段地面路 → 桥。一整座桥面横压在岛上会和地形穿模（用户截图）。
    // 岛上两个桥头取离岛岸 ≥10 的最外侧点（与两岸桥头同一口径）。
    const islet = geo.islets.find((i) => Math.abs(z - i.z) < i.radius * 0.6);
    let route = [westIn, west, east, eastIn];
    let spans = [{ from: west, to: east, angle: 0, length: east.x - west.x }];
    if (islet) {
      const edge = (side: -1 | 1): Vec2 | null => {
        let last: Vec2 | null = null;
        for (let d = 0; d < islet.radius * 1.3; d += 6) {
          const p = { x: islet.x + side * d, z };
          if (geo.isletClearance(p.x, p.z) < 10) break;
          last = p;
        }
        return last;
      };
      const isletWest = edge(-1); const isletEast = edge(1);
      if (isletWest && isletEast && isletEast.x - isletWest.x >= 24 && isletWest.x > west.x + 24 && isletEast.x < east.x - 24) {
        route = [westIn, west, isletWest, isletEast, east, eastIn];
        spans = [{ from: west, to: isletWest, angle: 0, length: isletWest.x - west.x },
          { from: isletEast, to: east, angle: 0, length: east.x - isletEast.x }];
      }
    }
    const screened = screenTrunkRoute(world, route, spans, 100 + k);
    diagnostics.push(...screened.diagnostics);
    if (!screened.patch || screened.points.length < route.length) continue;
    const result = commitNetworkPatch(network, screened.patch, screened.validate);
    if (!result.ok) { diagnostics.push({ trunk: 100 + k, phase: "route", reason: result.reason, cause: result.detail ?? "commit-rejected" }); continue; }
    bridges.push(...screened.bridges);
  }
  // Prawn Island（不在任何堤道线上）：岛中心 → 岛岸桥头 → 短桥 → 它贴的那一岸（side：1 东岛 / -1 大陆）。岛上那段是桥头引道。
  for (const islet of geo.islets.filter((i) => i.kind === "prawn")) {
    const z = islet.z; const s = islet.side ?? 1;
    let edge: Vec2 | null = null;
    for (let d = 0; d < islet.radius * 1.3; d += 6) {
      const p = { x: islet.x + s * d, z };
      if (geo.isletClearance(p.x, p.z) < 10) break;
      edge = p;
    }
    let east: Vec2 | null = null;
    for (let d = 0; d < 240 && edge; d += 4) {
      const p = { x: edge.x + s * (12 + d), z };
      if (coastDistance(p.x, p.z) <= 0) break;
      if (landClearance(p.x, p.z) >= 10 && !inRiver(p.x, p.z)) { east = p; break; }
    }
    const eastIn = east && [20, 16].map((d) => ({ x: east!.x + s * d, z })).find((p) => coastDistance(p.x, p.z) > 20 && landClearance(p.x, p.z) >= 10);
    // 岛上的路从岛的另一侧岸边（离岸 12）起，而不是岛心：岛心那一端离任何水都 > 40，会被判成违规断头
    // （seed 2005864824/1 档实测「required road endpoint has no accepted continuation」）；岸边起点算近水终止。
    let start: Vec2 = { x: islet.x, z };
    for (let d = 0; d < islet.radius * 1.3; d += 3) {
      const p = { x: islet.x - s * d, z };
      if (geo.isletClearance(p.x, p.z) < 12) break;
      start = p;
    }
    if (!edge || !east || !eastIn || Math.abs(edge.x - start.x) < 18 || ![start, edge, east, eastIn].every(clearOfSites)) {
      diagnostics.push({ trunk: 200, phase: "route", reason: "no-target", cause: "prawn-bridge-no-landing" }); continue;
    }
    const screened = screenTrunkRoute(world, [start, edge, east, eastIn], [{ from: edge, to: east, angle: s > 0 ? 0 : Math.PI, length: Math.abs(east.x - edge.x) }], 200);
    diagnostics.push(...screened.diagnostics);
    if (!screened.patch || screened.points.length < 4) continue;
    const result = commitNetworkPatch(network, screened.patch, screened.validate);
    if (!result.ok) { diagnostics.push({ trunk: 200, phase: "route", reason: result.reason, cause: result.detail ?? "commit-rejected" }); continue; }
    bridges.push(...screened.bridges);
  }
}
