#!/usr/bin/env node
// 规划修复 M2：道路编辑规则守卫（docs/CITY_PLAN_MANUAL_REPAIR_SPEC.md §7.3 / §13.3）。
//   (a) 删路段（放权后 §15）：只有桥面锁定；擦主干道/滨海路/孤立楼/断网只提示（warnings），不再拒绝；
//       环路里删一条合法，只给 creates-dead-end 警告；缺失 id → missing-edge；
//   (b) 拖路口：锁定 / 未变 / 撞车 / 边过短 / 入水 / 穿楼 / 锐角各一例，合法拖动通过；
//   (c) 「只拦新引入」：生成器遗留的压路、近水路段不拦无关编辑；
//   (d) 点击拾取：6 以内取路口，其次取路面带内最近路段，锁定标记透出，空地返回 null；
//   (e) 与补丁层闭环：通过校验的编辑（拖/删/画）套用后无 stale，日志引用当前 id；
//   (g) 画路：吸附（路口 > 路段中间 > 自由点）、各条硬规则（太短/孤立/入水/穿楼/交叉/锐角/锁定/重复）、
//       新断头只警告、橡皮擦拾取；
//   (f) 真实城市：全部路段/路口逐个校验——确定性、锁定边全部被拒、有相当比例合法、单次校验耗时有界。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

globalThis.window ??= globalThis;
const {
  validateNodeMove, validateEdgeDrop, validateRoadAdd, snapPoint, nearestEdgeAt, nearestRoadTarget, applyPlanPatch, emptyPlanPatch, appendRoadOp,
  buildCityModel, layoutCity, MIAMI_COASTAL,
} = await loadCity({
  "engine/planRoadRules.ts": ["validateNodeMove", "validateEdgeDrop", "validateRoadAdd", "snapPoint", "nearestEdgeAt", "nearestRoadTarget"],
  "engine/planPatch.ts": ["applyPlanPatch", "emptyPlanPatch", "appendRoadOp"],
  "cityModel.ts": ["buildCityModel"],
  "engine/cityLayout.ts": ["layoutCity"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
});

// ── 合成路网 ──────────────────────────────────────────────────────────────────
//      E(0,100) ── D(100,100)
//        │            │
//      A(0,0) ──── B(100,0) ──── C(200,0) ──── F(200,60)   （C-F 是尽头支路，F 旁有一栋楼）
// 水：x > 400 不可建。
const terrain = { height: () => 2, slope: () => 0.1, buildable: (x) => x < 400, center: { x: 0, z: 0 }, radius: 500, coastRadius: () => 500, hasRiver: false };
const node = (id) => { const [x, z] = id.split(":").map(Number); return { id, x, z }; };
const edge = (from, to, width = 5, extra = {}) => {
  const a = node(from); const b = node(to);
  return { id: [from, to].sort().join("/"), from, to, width, kind: width >= 8 ? "arterial" : "local", points: [{ x: a.x, z: a.z }, { x: b.x, z: b.z }], ...extra };
};
const slot = (id, x, z, extra = {}) => ({ id, blockId: `blk:${id}`, x, z, yaw: 0, zone: "residential", width: 8, depth: 8, ...extra });
const model = {
  windowStartMs: 0, windowEndMs: 1, windowLabel: "t", generatedAt: 1,
  districts: [{ id: "d0", label: "D0", sessionCount: 4, tokensTotal: 0, activeCount: 0, anomaly: null }],
  buildings: ["bA", "bD", "bF", "bX"].map((id) => ({ id, districtId: "d0", footprint: 5, height: 10, archetype: "block" })),
};
function makeLayout(overrides = {}) {
  const edges = overrides.edges ?? [edge("0:0", "100:0"), edge("100:0", "200:0"), edge("100:0", "100:100"), edge("100:100", "0:100"), edge("0:100", "0:0"), edge("200:0", "200:60")];
  const ids = [...new Set(edges.flatMap((e) => [e.from, e.to]))];
  const slots = new Map([["bA", slot("pA", 8, 10)], ["bD", slot("pD", 92, 92)], ["bF", slot("pF", 208, 70)], ["bX", slot("pX", 50, 20)]]);
  return {
    seed: 1, scaleTier: 1, activityKey: "k", terrain,
    blocks: [], roadNodes: ids.map(node), roadEdges: edges, culDeSacEnds: [],
    civics: [], gardens: [], districtLandmarks: [], contextBuildings: overrides.context ?? [], highways: [],
    districts: [{ id: "d0", label: "D0", center: { x: 100, z: 50 }, radius: 300, terrain, slots, grounds: new Map([...slots.keys()].map((k) => [k, 2])), roads: [], carPaths: [], river: null, riverHalfWidth: 0, trees: [], plaza: { x: 0, z: 0, y: 2 }, anomaly: null, sessionCount: 4 }],
  };
}

// (a) 删路段。
{
  const layout = makeLayout();
  const spur = validateEdgeDrop(layout, model, "200:0/200:60");
  assert.deepEqual(spur.blockers, [], "dropping the only road to a building is allowed (SimCity lets you strand buildings)");
  assert.ok(spur.warnings.includes("strands-buildings"), "…and the user is told");
  // A-B 正中间有楼 bX（离路 20）：删掉后最近的路是 x=0 / x=100 的竖路，都 > 40 → 楼被孤立。规则是对的。
  assert.ok(validateEdgeDrop(layout, model, "0:0/100:0").warnings.includes("strands-buildings"), "a building mid-way along the road would be left > 40 from any road — warned, not blocked");
  const loopEdge = validateEdgeDrop(layout, model, "0:100/100:100");
  assert.deepEqual(loopEdge.blockers, [], "a loop edge whose buildings keep another road within range is legal to drop");
  assert.ok(loopEdge.warnings.includes("creates-dead-end"), "…but it leaves D with a single road");
  assert.deepEqual(validateEdgeDrop(layout, model, "nope").blockers, ["missing-edge"]);
  const wide = makeLayout({ edges: [edge("0:0", "100:0", 12), edge("100:0", "100:100"), edge("100:100", "0:100"), edge("0:100", "0:0")] });
  assert.deepEqual(validateEdgeDrop(wide, model, "0:0/100:0").blockers, [], "an arterial can be erased");
  assert.ok(validateEdgeDrop(wide, model, "0:0/100:0").warnings.includes("erases-arterial"), "…with a warning");
  const bridge = makeLayout({ edges: [edge("0:0", "100:0", 5, { bridge: true, structure: "deck" }), edge("100:0", "100:100")] });
  assert.deepEqual(validateEdgeDrop(bridge, model, "0:0/100:0").blockers, [], "a whole bridge can be erased (2026-10-21: the only way to fix a bad bridgehead)");
  assert.ok(validateEdgeDrop(bridge, model, "0:0/100:0").warnings.includes("erases-bridge"), "…with a warning");
  const waterfront = makeLayout({ edges: [edge("0:0", "100:0", 5, { purpose: "waterfront" }), edge("100:0", "100:100")] });
  assert.deepEqual(validateEdgeDrop(waterfront, model, "0:0/100:0").blockers, [], "a waterfront road can be erased");
  assert.ok(validateEdgeDrop(waterfront, model, "0:0/100:0").warnings.includes("erases-waterfront"));
  // 断网：一条桥一样的独木桥——把只有它连着的两片路网拆开，两侧都有楼。
  const chain = makeLayout({ edges: [edge("0:0", "100:0"), edge("100:0", "100:100"), edge("100:100", "0:100"), edge("200:0", "200:60"), edge("100:0", "200:0")] });
  chain.districts[0].slots.set("bF", slot("pF", 205, 5)); // F 的楼挨着 100:0-200:0
  const cut = validateEdgeDrop(chain, model, "100:0/200:0");
  assert.deepEqual(cut.blockers, [], "cutting the network is allowed");
  assert.ok(cut.warnings.includes("disconnects-buildings") || cut.warnings.includes("strands-buildings"), `…but the split is reported — got ${cut.warnings}`);
}

// (b) 拖路口。
{
  const layout = makeLayout();
  const ok = validateNodeMove(layout, model, "100:100", { x: 100, z: 130 });
  assert.deepEqual(ok.blockers, [], "an ordinary drag passes");
  assert.deepEqual(validateNodeMove(layout, model, "100:100", { x: 100, z: 100 }).blockers, ["unchanged"]);
  assert.deepEqual(validateNodeMove(layout, model, "ghost", { x: 1, z: 1 }).blockers, ["missing-node"]);
  assert.ok(validateNodeMove(layout, model, "100:100", { x: 0.4, z: 100.3 }).blockers.includes("node-collision"), "dropping onto another node collides");
  assert.ok(validateNodeMove(layout, model, "100:100", { x: 100, z: 2 }).blockers.includes("edge-too-short"), "an edge squeezed below the minimum length is rejected");
  assert.ok(validateNodeMove(layout, model, "100:100", { x: 450, z: 100 }).blockers.includes("road-in-water"), "dragging a road end into the water is rejected");
  const locked = makeLayout({ edges: [edge("0:0", "100:0", 5, { structure: "ground-approach" }), edge("100:0", "100:100")] });
  assert.deepEqual(validateNodeMove(locked, model, "100:0", { x: 100, z: 30 }).blockers, [], "a node on a bridge approach can be dragged now");
  const deck = makeLayout({ edges: [edge("0:0", "100:0", 5, { bridge: true, structure: "deck" }), edge("100:0", "100:100")] });
  assert.deepEqual(validateNodeMove(deck, model, "100:0", { x: 100, z: 30 }).blockers, ["locked-edge"], "a node on a bridge deck stays locked");
  // 穿楼：D→(100,100) 拖到 (45,18)，路段 B-D 会从 bX(50,20) 上穿过。
  const through = validateNodeMove(layout, model, "100:100", { x: 55, z: 22 });
  // 穿过 bX 的唯一方向在 B 处与 B→A 只差 22°（< 50°）：被拦的是锐角路口，不是穿楼。
  assert.deepEqual(through.blockers, ["junction-too-sharp"], "dragging a road through a session building is allowed (only the incidental 22° junction is refused)");
  assert.ok(through.warnings.includes("relocate:1"), `…the developer will re-home it — got ${through.warnings}`);
  // 锐角：B 处已有三条路（A、C、D）；把 D 拖到贴着 B→A 方向。
  assert.ok(validateNodeMove(layout, model, "100:100", { x: 40, z: 3 }).blockers.includes("junction-too-sharp"), "a new < 50° junction is refused (cars can't make the turn; 2026-10-21)");
  assert.ok(validateNodeMove(layout, model, "100:100", { x: 100, z: 300 }).warnings.includes("far-move"), "a long drag warns");
  const again = validateNodeMove(layout, model, "100:100", { x: 55, z: 22 });
  assert.deepEqual(again, validateNodeMove(layout, model, "100:100", { x: 55, z: 22 }), "deterministic");
}

// (c) 只拦新引入：生成器遗留的压路不拦无关编辑。
{
  // 背景楼压在 D-E 路上（遗留问题）。拖 D 沿原路线微动：关联的 D-E 仍压同一栋——不是新引入，放行。
  const layout = makeLayout({ context: [{ id: "context:c1", x: 50, z: 100, y: 2, yaw: 0, width: 9, depth: 9, height: 10, seed: 0.5, zone: "residential", appearAt: 0 }] });
  const nudge = validateNodeMove(layout, model, "100:100", { x: 100, z: 108 });
  assert.ok(!nudge.warnings.some((w) => w.startsWith("bulldoze:")), "a pre-existing overlap is not this edit's impact — nothing gets bulldozed");
  // 但把别的路拖进同一栋，是新引入——拦。
  const fresh = makeLayout({ context: [{ id: "context:c2", x: 100, z: 60, y: 2, yaw: 0, width: 9, depth: 9, height: 10, seed: 0.5, zone: "residential", appearAt: 0 }] });
    // 拖到 (150,80)：B→D 在 B 处与 B→C 成 58°（≥ 50°，不是锐角口），途经 (130,48) 压上背景楼 c3。
    const hit = validateNodeMove(makeLayout({ context: [{ id: "context:c3", x: 130, z: 50, y: 2, yaw: 0, width: 9, depth: 9, height: 10, seed: 0.5, zone: "residential", appearAt: 0 }] }), model, "100:100", { x: 150, z: 80 });
  assert.deepEqual(hit.blockers, []); assert.ok(hit.warnings.includes("bulldoze:1"), "a context building newly crossed by the dragged road will be bulldozed");
}

// (d) 点击拾取。
{
  const layout = makeLayout();
  assert.deepEqual(nearestRoadTarget(layout, 102, 3), { kind: "node", id: "100:0", locked: false }, "within 6 of a node picks the node");
  assert.deepEqual(nearestRoadTarget(layout, 50, 1.5), { kind: "edge", id: "0:0/100:0", locked: false }, "on the road band picks the edge");
  assert.equal(nearestRoadTarget(layout, 50, 50), null, "open ground picks nothing");
  const locked = makeLayout({ edges: [edge("0:0", "100:0", 5, { bridge: true, structure: "deck" })] });
  assert.equal(nearestRoadTarget(locked, 50, 0).locked, true, "locked edges are pickable but flagged");
  assert.equal(nearestRoadTarget(locked, 1, 1).locked, true, "…and so are their nodes");
}

// (e) 与补丁层闭环：校验用当前布局，日志引用当前 id。
{
  const layout = makeLayout();
  let patch = emptyPlanPatch(1, 1);
  assert.deepEqual(validateNodeMove(layout, model, "100:100", { x: 100, z: 130 }).blockers, []);
  patch = appendRoadOp(patch, { t: "move", node: "100:100", to: { x: 100, z: 130 } }, 1);
  let patched = applyPlanPatch(layout, patch);
  assert.equal(patched.stale.length, 0, "a validated move applies cleanly");
  // 拖过的节点再校验：用生效布局 + 当前 id；写日志也用当前 id。
  assert.deepEqual(validateNodeMove(patched.layout, model, "100:130", { x: 100, z: 140 }).blockers, [], "validation runs against the effective layout");
  patch = appendRoadOp(patch, { t: "move", node: "100:130", to: { x: 100, z: 140 } }, 2);
  patched = applyPlanPatch(layout, patch);
  assert.equal(patched.stale.length, 0);
  assert.ok(patched.layout.roadNodes.some((n) => n.id === "100:140"));
  const drop = validateEdgeDrop(patched.layout, model, "0:100/100:140");
  assert.deepEqual(drop.blockers, []);
  patch = appendRoadOp(patch, { t: "drop", edge: "0:100/100:140" }, 3);
  assert.equal(applyPlanPatch(layout, patch).stale.length, 0, "move, move, drop in sequence still apply cleanly");
}

// (g) 画路与橡皮擦。
{
  const layout = makeLayout();
  // 吸附优先级：路口 8 内 > 路段 4 内 > 自由点。
  assert.deepEqual(snapPoint(layout, 104, 4), { x: 100, z: 0, kind: "node", nodeId: "100:0", locked: false }, "near a node snaps to the node");
  const onEdge = snapPoint(layout, 50, 3);
  assert.equal(onEdge.kind, "edge"); assert.equal(onEdge.edgeId, "0:0/100:0"); assert.equal(onEdge.z, 0, "an edge snap lands exactly on the road");
  assert.equal(snapPoint(layout, 50, 40).kind, "free");
  const lockedLayout = makeLayout({ edges: [edge("0:0", "100:0", 5, { bridge: true, structure: "deck" }), edge("100:0", "100:100")] });
  assert.equal(snapPoint(lockedLayout, 50, 2).locked, true, "snapping onto a bridge is flagged locked");

  // (100,100)→(200,60)：两端夹角都 ≥ 50°（旧用例落在 (200,0)，那里与 200:0→200:60 只差 45°，现在算锐角口）。
  const ok = validateRoadAdd(layout, model, { x: 100, z: 100 }, { x: 200, z: 60 }, 5);
  assert.deepEqual(ok.blockers, [], `a clean node-to-node road passes — got ${ok.blockers}`);
  assert.deepEqual(validateRoadAdd(layout, model, { x: 100, z: 0 }, { x: 103, z: 0 }, 5).blockers, ["edge-too-short"]);
  assert.ok(validateRoadAdd(layout, model, { x: 100, z: 0 }, { x: 100, z: 900 }, 5).blockers.includes("edge-too-long"), "only very long single strokes (> 800) are rejected");
  assert.deepEqual(validateRoadAdd(layout, model, { x: 100, z: 0 }, { x: 100.4, z: 0.3 }, 5).blockers, ["edge-too-short"], "both ends on the same node is degenerate/too short");
  assert.deepEqual(validateRoadAdd(layout, model, { x: 0, z: 0 }, { x: 100, z: 0 }, 5).blockers, ["edge-exists"], "re-drawing an existing road is rejected");
  assert.ok(validateRoadAdd(layout, model, { x: 300, z: 50 }, { x: 330, z: 80 }, 5).warnings.includes("isolated-road"), "a road touching nothing is allowed but warned");
  const stub = validateRoadAdd(layout, model, { x: 200, z: 60 }, { x: 260, z: 60 }, 5);
  assert.deepEqual(stub.blockers, [], "extending from a dead end into open ground is fine");
  assert.ok(stub.warnings.includes("creates-dead-end"), "…with a dead-end warning");
  assert.ok(validateRoadAdd(layout, model, { x: 200, z: 60 }, { x: 450, z: 60 }, 5).blockers.includes("road-in-water"), "a road into the water is rejected");
  assert.ok(validateRoadAdd(layout, model, { x: 100, z: 0 }, { x: 0, z: 40 }, 5).warnings.includes("relocate:1"), "a road straight through bX (50,20) re-homes it");
  assert.ok(!validateRoadAdd(layout, model, { x: 100, z: 0 }, { x: 40, z: 40 }, 5).warnings.some((w) => w.startsWith("relocate:")), "…while one that passes ~11 away from it does not");
  // 从一边到对边斜穿（两端 68°）；角到角的对角线把 90° 角劈成两个 45°，现在算锐角口。
  assert.deepEqual(validateRoadAdd(layout, model, { x: 30, z: 0 }, { x: 70, z: 100 }, 5).blockers, [], "a diagonal across the loop is allowed — crossings become junctions, buildings get re-homed");
  assert.ok(validateRoadAdd(layout, model, { x: 0, z: 0 }, { x: 100, z: 100 }, 5).blockers.includes("junction-too-sharp"), "a corner-to-corner diagonal makes two 45° junctions — refused");
  const cross = validateRoadAdd(makeLayout({ context: [] }), { ...model, buildings: [] }, { x: 30, z: -40 }, { x: 70, z: 40 }, 5); // 穿过 A-B（z=0）中段
  assert.deepEqual(cross.blockers, []); assert.ok(cross.warnings.includes("auto-junction:1"), `crossing an existing road creates a junction — got ${cross.warnings}`);
  // 从路段中间接出（拆开宿主）合法；从锁定段/桥接出被拒。
  const tee = validateRoadAdd(layout, { ...model, buildings: [] }, { x: 50, z: 0 }, { x: 50, z: 60 }, 5);
  assert.ok(!tee.blockers.includes("locked-edge") && !tee.blockers.includes("isolated-road"), `a T-junction onto a normal road is allowed — got ${tee.blockers}`);
  const fromBridge = validateRoadAdd(lockedLayout, model, { x: 50, z: 0 }, { x: 50, z: 60 }, 5);
  assert.deepEqual(fromBridge.blockers, ["locked-edge"], "no junction may be cut into a bridge deck");
  // 锐角：B(100,0) 已有 A、C、D 三路；再接一条几乎贴着 B→C 的路。
  assert.ok(validateRoadAdd(layout, { ...model, buildings: [] }, { x: 100, z: 0 }, { x: 190, z: 8 }, 5).blockers.includes("junction-too-sharp"), "a new 5° junction is refused");
  assert.ok(validateRoadAdd(layout, { ...model, buildings: [] }, { x: 100, z: 0 }, { x: 190, z: 60 }, 5).blockers.includes("junction-too-sharp"), "…and so is a 34° one (30–50° used to pass without even a warning; the renderer channelizes it)");
  assert.ok(!validateRoadAdd(layout, { ...model, buildings: [] }, { x: 100, z: 0 }, { x: 130, z: -90 }, 5).blockers.includes("junction-too-sharp"), "a 72° junction is fine");
  // 画出来的路套用后结构一致：吸附到路段中间的端点把宿主拆成两半。
  let patch = emptyPlanPatch(1, 1);
  patch = appendRoadOp(patch, { t: "add", from: { x: 50, z: 0 }, to: { x: 50, z: 60 }, width: 5 }, 1);
  const patched = applyPlanPatch(layout, patch);
  assert.equal(patched.stale.length, 0);
  assert.ok(patched.layout.roadEdges.some((e) => e.id === "0:0/50:0") && patched.layout.roadEdges.some((e) => e.id === "50:0/50:60"), "the validated T-junction applies as a split plus a new edge");
  // 橡皮擦拾取：路面带内最近路段，空地 null。
  assert.equal(nearestEdgeAt(layout, 50, 3).id, "0:0/100:0");
  assert.equal(nearestEdgeAt(layout, 50, 40), null);
}

// (f) 真实城市。
{
  const HARNESSES = ["codex", "claude-code", "dsh", "harness:zcode"];
  const GENERATED_AT = Date.UTC(2026, 9, 7, 12, 0, 0);
  let s = 12345; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const rows = Array.from({ length: 380 }, (_, i) => {
    const total = Math.round(2000 + rnd() ** 3 * 4_000_000);
    const start = GENERATED_AT - Math.round(rnd() * 28 * 86_400_000);
    return {
      session_ref: `session:${i}`, harness: HARNESSES[i % HARNESSES.length],
      first_event_at: new Date(start).toISOString(), last_event_at: new Date(start + Math.round(rnd() * 3_600_000)).toISOString(),
      event_count: 10, model_ids: ["claude-sonnet-5"],
      tokens: { uncached_input_tokens: Math.round(total * 0.2), cache_read_tokens: Math.round(total * 0.5), cache_write_tokens: Math.round(total * 0.1), output_tokens: Math.round(total * 0.2), total },
      peak_tokens: Math.round(total * 0.3), cost_minor: { amount_minor: Math.round(total / 1000), currency: "USD", basis: "api_equivalent" },
      cost_status: { state: "estimated", reason: "", has_unresolved: false },
    };
  });
  const real = buildCityModel({ rows, findings: [], windowStartMs: GENERATED_AT - 30 * 86_400_000, windowEndMs: GENERATED_AT, windowLabel: "30d", totalSessions: rows.length, truncated: false, generatedAt: GENERATED_AT });
  const layout = layoutCity(real, null, undefined, MIAMI_COASTAL);
  const isLocked = (e) => e.bridge === true || e.structure === "deck"; // 放权后只锁桥面
  const tally = { edge: { ok: 0, blocked: 0, reasons: {} }, node: { ok: 0, blocked: 0, reasons: {} } };
  const count = (bucket, verdict) => { if (verdict.blockers.length) { bucket.blocked += 1; for (const b of verdict.blockers) bucket.reasons[b] = (bucket.reasons[b] ?? 0) + 1; } else bucket.ok += 1; };
  let slowest = 0;
  for (const e of layout.roadEdges) {
    const t0 = performance.now();
    const verdict = validateEdgeDrop(layout, real, e.id);
    slowest = Math.max(slowest, performance.now() - t0);
    // 桥面：整座擦（提示 erases-bridge；悬索桥提示 erases-suspension-bridge，塔缆一起拆）。
    if (isLocked(e)) assert.ok(verdict.blockers.length === 0 && verdict.warnings.some((w) => w === "erases-bridge" || w === "erases-suspension-bridge"), `deck ${e.id} must erase as a whole bridge: ${verdict.blockers} / ${verdict.warnings}`);
    count(tally.edge, verdict);
  }
  const tries = [{ dx: 12, dz: 0 }, { dx: 0, dz: 12 }];
  for (const n of layout.roadNodes) for (const { dx, dz } of tries) {
    const t0 = performance.now();
    const verdict = validateNodeMove(layout, real, n.id, { x: n.x + dx, z: n.z + dz });
    slowest = Math.max(slowest, performance.now() - t0);
    count(tally.node, verdict);
    assert.deepEqual(verdict, validateNodeMove(layout, real, n.id, { x: n.x + dx, z: n.z + dz }), "deterministic on a real city");
  }
  assert.ok(tally.edge.ok > 0 && tally.node.ok > 0, "a generated city must have legal edits — otherwise the rules are over-tight");
  assert.ok(slowest < 400, `a single validation must stay interactive — slowest ${slowest.toFixed(0)}ms`);
  // 合法的编辑套用后体检不新增 error。
  const firstOkEdge = layout.roadEdges.find((e) => !validateEdgeDrop(layout, real, e.id).blockers.length);
  let patch = emptyPlanPatch(layout.seed, layout.scaleTier);
  patch = appendRoadOp(patch, { t: "drop", edge: firstOkEdge.id }, 1);
  assert.equal(applyPlanPatch(layout, patch).stale.length, 0, "a validated real-city edge drop applies cleanly");
  console.log(`  真实城市 380 楼：${layout.roadEdges.length} 路段 / ${layout.roadNodes.length} 路口；删路段 合法 ${tally.edge.ok} 拒绝 ${tally.edge.blocked} ${JSON.stringify(tally.edge.reasons)}；拖路口(×2 方向) 合法 ${tally.node.ok} 拒绝 ${tally.node.blocked} ${JSON.stringify(tally.node.reasons)}；单次校验最慢 ${slowest.toFixed(0)}ms`);
}

console.log("City plan road rules (relaxed, SPEC §15): only physical impossibilities block — bridge decks, water, degenerate/too-short strokes, node collisions, locked sites; new junctions under 50° are refused (cars can't make the turn); erasing arterials/waterfront, stranding buildings and isolated roads are warned; crossings become junctions and buildings in the way are reported for bulldozing/re-homing; validated edits apply cleanly; real-city validation is deterministic and interactive.");
