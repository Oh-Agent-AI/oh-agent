/**
 * 坏桥头的一键修复方案（修复升级 P1-D，docs/CITY_REPAIR_UPGRADE_PLAN.md）：体检里列出的斜接/过陡桥头，
 * 给玩家一个**可预览**的补丁候选——擦整座桥 + 擦旧桥头留下的岸边残路 + 按画路工具的同一套校验在附近找一笔合法直桥。
 *
 * 纯函数，只产出候选，不写补丁：玩家看过预览、点「采用」，会话才把这些操作作为一步写进补丁（一步撤销）。
 * 不做「一键修全城」：每条方案都要玩家看过再收，补丁仍是玩家的修改记录。
 *
 * 搜索与 scripts/verify-plan-repair-bridgehead.mjs 验收的是同一个函数：沿原桥轴平移（±32）/旋转（±0.25 rad）/
 * 加长（两岸各自伸 14–100 上岸，两岸分开找、按总伸出量从短到长配对），起止点取探针附近 12 内最近的地面路上的点
 * （或被擦掉的断头支路的尽头），取第一笔 validateRoadAdd 全过、且真的过河的。
 * 7/2 实测：悬索桥擦掉后找到一座 78 的直桥，驾驶内核双向开过。
 */
import type { CityModel } from "../cityModel";
import type { CityLayout, Vec2 } from "./cityLayout";
import { applyPlanPatch, appendRoadOp, bridgeChain, type PlanPatchV1, type RoadOp } from "./planPatch";
import { snapPoint, validateEdgeDrop, validateRoadAdd } from "./planRoadRules";

export type BridgeFixProposal = {
  deckId: string;
  /** 将被擦掉的路段 id（整座桥的桥面 + 岸边残路），按写进补丁的顺序。 */
  erase: string[];
  erasePolylines: Vec2[][];
  draw: { from: Vec2; to: Vec2; width: number; bridgeLength: number };
  /** 画桥校验的提示（推平/安置/自动路口…），原样给面板。 */
  warnings: string[];
  /** 写进补丁的操作（drop… + add），会话照此追加。 */
  ops: RoadOp[];
};
/** 失败：`codes` 是结构化拒因（missing-bridge = 擦桥的阻断码；no-redraw = 搜索里最常见的拒因码，按次数排序，最多 3 个），
 *  面板据此出文案（controller.ts::bridgeFixRefusalText）；`detail` 只是给脚本/日志看的诊断串，不进面板——
 *  它曾被原样拼进面板消息，英文界面露出「附近找不到一笔合法的直桥（no-road-on-bank×91）」。 */
export type BridgeFixResult = { ok: true; proposal: BridgeFixProposal } | { ok: false; reason: "missing-bridge" | "no-redraw"; codes: string[]; detail: string };

const OFFSETS = [0, 4, -4, 8, -8, 12, -12, 16, -16, 24, -24, 32, -32];
const REACHES = [14, 18, 24, 30, 40, 50, 65, 80, 100];
const SKEWS = [0, 0.08, -0.08, 0.16, -0.16, 0.25, -0.25];
const ROAD_SNAP = 12;
const STUB_MAX = 20;
/** 引道再长就是路网的一部分（海滨实测有 108、145 长的引道），擦了会把路网剪断——不擦。 */
const APPROACH_MAX = 60;

function nearestRoadPoint(layout: CityLayout, p: Vec2): Vec2 | null {
  let best: Vec2 | null = null; let bestD = ROAD_SNAP;
  for (const edge of layout.roadEdges) {
    if (edge.bridge || edge.structure === "deck") continue;
    for (let i = 1; i < edge.points.length; i += 1) {
      const a = edge.points[i - 1], b = edge.points[i]; const dx = b.x - a.x, dz = b.z - a.z; const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)); const q = { x: a.x + dx * t, z: a.z + dz * t };
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < bestD) { bestD = d; best = { x: Math.round(q.x * 100) / 100, z: Math.round(q.z * 100) / 100 }; }
    }
  }
  return best;
}

/**
 * `generated` 是未打补丁的生成布局，`patch` 是玩家当前的补丁，`current` 是两者套出的生效布局（玩家眼前的城市）。
 * 方案的操作追加在 `patch` 之后，套在 `generated` 上即是采用后的城市——与会话提交走同一条路。
 */
export function proposeBridgeFix(generated: CityLayout, current: CityLayout, model: CityModel, patch: PlanPatchV1, deckId: string): BridgeFixResult {
  const deck = current.roadEdges.find((edge) => edge.id === deckId);
  if (!deck || !(deck.bridge || deck.structure === "deck")) return { ok: false, reason: "missing-bridge", codes: [], detail: `${deckId} 不是当前城市里的桥面` };
  const chain = bridgeChain(current.roadEdges, deck);
  const drop = validateEdgeDrop(current, model, deck.id);
  if (drop.blockers.length) return { ok: false, reason: "missing-bridge", codes: drop.blockers, detail: drop.blockers.join(",") };
  // 擦桥，再擦旧桥头留下的岸边残路：连着旧桥端点、且短（≤ 20，伸到水边的残桩会横穿新桥面）或本就是这座桥的引道
  // （生成器标 ground-approach：陡桥头的坡就在引道上——1703294958/2 的引道坡比 1.13，不擦它在原址画不出合格的桥）。
  // 长的过路不擦：它是路网的一部分，新桥接到它上面。
  const approachIds = new Set(current.roadEdges.filter((edge) => edge.structure === "ground-approach").map((edge) => edge.id));
  const erasedOnly = applyPlanPatch(generated, appendRoadOp(patch, { t: "drop", edge: deck.id })).layout;
  const landings = new Set(chain.flatMap((piece) => [piece.from, piece.to]));
  const lengthOf = (points: readonly Vec2[]) => points.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x - points[i].x, q.z - points[i].z), 0);
  const stubs = erasedOnly.roadEdges.filter((edge) => !edge.bridge && (landings.has(edge.from) || landings.has(edge.to))
    && (lengthOf(edge.points) <= STUB_MAX || (approachIds.has(edge.id) && lengthOf(edge.points) <= APPROACH_MAX)) && !validateEdgeDrop(erasedOnly, model, edge.id).blockers.length);
  const ops: RoadOp[] = [{ t: "drop", edge: deck.id }, ...stubs.map((stub) => ({ t: "drop" as const, edge: stub.id }))];
  const cleared = applyPlanPatch(generated, ops.reduce((next, op) => appendRoadOp(next, op), patch)).layout;
  // 断头支路的尽头：擦掉的残路若是一条通到尽头的支路（溪桥常见——支路通往一处设施），它的尽头也是合法落笔点，
  // 新的一笔「路 → 桥 → 尽头」原样重建这条断头支路（1703294958/2、1703358310/5 的陡溪桥对岸只有这样一条支路）。
  const alive = new Set(cleared.roadEdges.flatMap((edge) => [edge.from, edge.to]));
  const terminals = stubs.flatMap((stub) => [stub.from, stub.to].filter((id) => !landings.has(id) && !alive.has(id))
    .map((id) => (stub.from === id ? stub.points[0] : stub.points[stub.points.length - 1])));
  const endpoint = (probe: Vec2): Vec2 | null => {
    const road = nearestRoadPoint(cleared, probe);
    if (road && snapPoint(cleared, road.x, road.z).kind !== "free") return road;
    return terminals.find((t) => Math.hypot(t.x - probe.x, t.z - probe.z) <= ROAD_SNAP) ?? null;
  };

  // 原桥轴：整座桥最远的两个端点。
  const ends = chain.flatMap((piece) => [piece.points[0], piece.points[piece.points.length - 1]]);
  let [a, b] = [ends[0], ends[1]];
  for (const p of ends) for (const q of ends) if (Math.hypot(p.x - q.x, p.z - q.z) > Math.hypot(a.x - b.x, a.z - b.z)) [a, b] = [p, q];
  const len = Math.hypot(b.x - a.x, b.z - a.z); const ux = (b.x - a.x) / len, uz = (b.z - a.z) / len;
  const refused: Record<string, number> = {};
  const note = (code: string) => { refused[code] = (refused[code] ?? 0) + 1; };
  // 两岸分开找落笔点：两岸离路网的距离常常不一样（溪桥一侧是 44 外的支路尽头、另一侧是 88 外的路口），同一个伸出量两头都对不上。
  // 每个（平移, 旋转）先各自收集去重的落笔点，再按两侧伸出量之和从短到长配对——先试最短的一笔。
  const tried = new Set<string>();
  for (const offset of OFFSETS) for (const skew of SKEWS) {
    const vx = ux * Math.cos(skew) - uz * Math.sin(skew), vz = ux * Math.sin(skew) + uz * Math.cos(skew);
    const mid = { x: (a.x + b.x) / 2 - uz * offset, z: (a.z + b.z) / 2 + ux * offset };
    const side = (sign: number) => {
      const out: Array<{ p: Vec2; rank: number }> = []; const seen = new Set<string>();
      REACHES.forEach((reach, rank) => {
        const half = len / 2 + reach; const p = endpoint({ x: mid.x + sign * vx * half, z: mid.z + sign * vz * half });
        if (p && !seen.has(`${p.x}:${p.z}`)) { seen.add(`${p.x}:${p.z}`); out.push({ p, rank }); }
      });
      return out;
    };
    const fromSide = side(-1), toSide = side(1);
    if (!fromSide.length || !toSide.length) { note("no-road-on-bank"); continue; }
    const pairs = fromSide.flatMap((f) => toSide.map((t) => ({ from: f.p, to: t.p, rank: f.rank + t.rank }))).sort((x, y) => x.rank - y.rank);
    for (const { from, to } of pairs) {
      const key = `${from.x}:${from.z}>${to.x}:${to.z}`;
      if (tried.has(key)) continue;
      tried.add(key);
      if (terminals.includes(from) && terminals.includes(to)) { note("no-road-on-bank"); continue; } // 两端都是尽头：新桥接不上路网
      const verdict = validateRoadAdd(cleared, model, from, to, deck.width);
      const bridge = verdict.warnings.find((code) => code.startsWith("bridge:"));
      if (verdict.blockers.length || !bridge) { for (const code of verdict.blockers.length ? verdict.blockers : ["no-water"]) note(code); continue; }
      return { ok: true, proposal: { deckId, erase: ops.map((op) => (op as { edge: string }).edge), erasePolylines: [...chain, ...stubs].map((edge) => edge.points),
        draw: { from, to, width: deck.width, bridgeLength: Number(bridge.split(":")[1]) }, warnings: verdict.warnings.filter((code) => !code.startsWith("bridge:")),
        ops: [...ops, { t: "add", from, to, width: deck.width }] } };
    }
  }
  const top = Object.entries(refused).sort((x, y) => y[1] - x[1]).slice(0, 3);
  return { ok: false, reason: "no-redraw", codes: top.map(([code]) => code), detail: `附近找不到一笔合法的直桥（${top.map(([code, n]) => `${code}×${n}`).join(" ")}）` };
}
