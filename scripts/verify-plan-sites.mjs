#!/usr/bin/env node
// 规划修复：设施（非会话建筑）编辑规则守卫（docs/CITY_PLAN_MANUAL_REPAIR_SPEC.md §14）。
//   (a) 拆除：公共设施/花园/城区地标/背景楼各一例；占用随之释放（空出的街区/地块可被后续操作使用）；
//   (b) 移动：街区级（公共设施/花园）要整块空街区，地块级（城区地标/背景楼）要空地块；
//       被占 / 不存在 / 不可建 / 压路 / 高架净空各拒一例；背景楼搬家后 id 跟着地块变；
//   (b2) 与生成器同一个落位谓词：不规则街区装不下（D2）、城区地标裙房越出小街区（D1）、搬家保持自身尺寸；
//   (c) 位置校验：`at` 对不上 → site-changed（公共设施 id 按序号编，数据增长后序号会变，不能落到另一座上）；未知 id → unknown-site；
//   (d) 顺序语义：设施操作先于会话楼移动套用——设施让出的地块，同一份补丁里的会话楼可以搬进去；
//   (e) 实例级拾取：射线对占地盒求交取最近；打空 → null；
//   (f) 候选：按距离从近到远、只含合法目标；
//   (g) 存档宽容读取：siteOps 坏条目逐条丢弃；旧 suppressedContext 仍然生效；
//   (h) 真实城市：每座设施俯视射线能拾取到自己；拆除/搬到首个候选套用后无 stale 且占用一致；跨档整份失效。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

globalThis.window ??= globalThis;
const {
  listSites, siteTargets, siteMoveProblem, pickSite, siteKindOf, applyPlanPatch, emptyPlanPatch, appendSiteOp, coercePlanPatch, reservedParcelIds,
  buildCityModel, layoutCity, MIAMI_COASTAL,
} = await loadCity({
  "engine/planSites.ts": ["listSites", "siteTargets", "siteMoveProblem", "pickSite", "siteKindOf"],
  "engine/planPatch.ts": ["applyPlanPatch", "emptyPlanPatch", "appendSiteOp", "coercePlanPatch", "reservedParcelIds"],
  "cityModel.ts": ["buildCityModel"],
  "engine/cityLayout.ts": ["layoutCity"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
});

// ── 合成城市 ──────────────────────────────────────────────────────────────────
const terrain = { height: () => 2, slope: (x, z) => (Math.hypot(x - 330, z - 200) < 10 ? 0.9 : 0.1), buildable: (x) => x < 400, center: { x: 0, z: 0 }, radius: 500, coastRadius: () => 500, hasRiver: false };
const parcel = (id, blockId, x, z, w = 8, d = 8) => ({ id, blockId, x, z, yaw: 0, zone: "residential", width: w, depth: d });
// 街区的真实面（生成器谓词 checkSitePlacement 在面内判设施包络——空 polygon 会被判 invalid-block-boundary）。
const rectFace = (x, z, w, d) => [{ x: x - w / 2, z: z - d / 2 }, { x: x + w / 2, z: z - d / 2 }, { x: x + w / 2, z: z + d / 2 }, { x: x - w / 2, z: z + d / 2 }];
const block = (id, x, z, w, d, parcels, polygon = rectFace(x, z, w, d)) => ({ id, districtId: "d0", x, z, width: w, depth: d, zone: "residential", parcels, polygon });
const B1 = block("B1", 100, 100, 40, 40, [parcel("p1a", "B1", 90, 90), parcel("p1b", "B1", 110, 90), parcel("p1c", "B1", 90, 110), parcel("p1d", "B1", 110, 110)]);
const B2 = block("B2", 200, 100, 40, 40, [parcel("p2a", "B2", 190, 90), parcel("p2b", "B2", 210, 90), parcel("p2c", "B2", 190, 110), parcel("p2d", "B2", 210, 110)]);
const BG = block("BG", -100, 100, 36, 36, [parcel("pg1", "BG", -100, 100)]);
const B3 = block("B3", 300, 100, 40, 40, [parcel("p3a", "B3", 300, 100)]);   // 有一个会话楼 → 不是空街区
const B4 = block("B4", 500, 100, 40, 40, [parcel("p4a", "B4", 500, 100)]);   // 不可建（x ≥ 400）
// 城区地标独占一个街区（生成器只把它放进空街区并预留整面，见注册表 SPEC D1）。
const BL = block("BL", 50, 200, 10, 10, [parcel("pL", "BL", 50, 200)]);
const BA = block("BA", 80, 225, 200, 60, [
  parcel("pC", "BA", 70, 200), parcel("pF1", "BA", 90, 200), parcel("pF2", "BA", 110, 200),
  parcel("pS", "BA", 130, 200), parcel("pRoad", "BA", 60, 250), parcel("pHwy", "BA", 160, 300), parcel("pSlope", "BA", 330, 200),
]);
const edge = (from, to, width = 5) => {
  const [fx, fz] = from.split(":").map(Number); const [tx, tz] = to.split(":").map(Number);
  return { id: [from, to].sort().join("/"), from, to, width, kind: "local", points: [{ x: fx, z: fz }, { x: tx, z: tz }], structure: "ground-road" };
};
const model = {
  windowStartMs: 0, windowEndMs: 1, windowLabel: "t", generatedAt: 1,
  districts: [{ id: "d0", label: "D0", sessionCount: 2, tokensTotal: 0, activeCount: 0, anomaly: null }],
  buildings: ["b1", "b2"].map((id) => ({ id, districtId: "d0", footprint: 5, height: 10, archetype: "block" })),
};
function makeLayout() {
  const slots = new Map([["b1", parcel("pS", "BA", 130, 200)], ["b2", parcel("p3a", "B3", 300, 100)]]);
  return {
    seed: 1, scaleTier: 1, activityKey: "k", terrain,
    blocks: [B1, B2, BG, B3, B4, BA, BL],
    roadNodes: [{ id: "0:250", x: 0, z: 250 }, { id: "300:250", x: 300, z: 250 }], roadEdges: [edge("0:250", "300:250")], culDeSacEnds: [],
    civics: [{ id: "civic:0", kind: "school", districtId: "d0", parcelId: "B1", x: 100, z: 100, y: 2, yaw: 0, width: 40, depth: 40, unlockAt: 0 }],
    gardens: [{ id: "garden:d0", districtId: "d0", blockId: "BG", x: -100, z: 100, y: 2, yaw: 0, width: 36, depth: 36, seed: 1 }],
    districtLandmarks: [{ districtId: "d0", parcelId: "pL", x: 50, z: 200, yaw: 0, y: 2 }],
    contextBuildings: [{ id: "context:pC", x: 70, z: 200, y: 2, yaw: 0, width: 8, depth: 8, height: 15, seed: 0.5, zone: "residential", appearAt: 0 }],
    highways: [[{ x: 0, z: 300 }, { x: 400, z: 300 }]],
    landmarks: [], publicSites: [],
    districts: [{ id: "d0", label: "D0", center: { x: 100, z: 100 }, radius: 300, terrain, slots, grounds: new Map([["b1", 2], ["b2", 2]]), roads: [], carPaths: [], river: null, riverHalfWidth: 0, trees: [], plaza: { x: 0, z: 0, y: 2 }, anomaly: null, sessionCount: 2 }],
  };
}
const fresh = () => emptyPlanPatch(1, 1);
const withOps = (...ops) => ops.reduce((patch, op) => appendSiteOp(patch, op, 1), fresh());
const apply = (...ops) => applyPlanPatch(makeLayout(), withOps(...ops));
const centre = (layout, id) => { const site = listSites(layout).find((s) => s.id === id); return { x: site.x, z: site.z }; };

// (a) 拆除 + 释放占用。
{
  const base = makeLayout();
  assert.deepEqual(listSites(base).map((s) => s.id).sort(), ["civic:0", "context:pC", "district-landmark:d0", "garden:d0"]);
  for (const id of ["civic:0", "garden:d0", "district-landmark:d0", "context:pC"]) {
    const { layout, stale } = apply({ t: "remove", id, at: centre(base, id) });
    assert.equal(stale.length, 0, `${id} removes cleanly`);
    assert.ok(!listSites(layout).some((s) => s.id === id), `${id} is gone`);
    assert.equal(listSites(layout).length, 3, "only that one site is removed");
  }
  const removedCivic = apply({ t: "remove", id: "civic:0", at: { x: 100, z: 100 } }).layout;
  assert.ok(!reservedParcelIds(removedCivic).has("p1a"), "removing a civic frees its whole block");
  assert.ok(reservedParcelIds(base).has("p1a"), "…while the untouched layout still reserves it");
}

// (b) 移动：街区级 / 地块级 / 各类阻止。
{
  const base = makeLayout();
  const civic = listSites(base).find((s) => s.id === "civic:0"); const garden = listSites(base).find((s) => s.id === "garden:d0");
  const lm = listSites(base).find((s) => s.id === "district-landmark:d0"); const ctx = listSites(base).find((s) => s.id === "context:pC");
  assert.equal(siteMoveProblem(base, civic, "B2"), null, "an empty block accepts a civic");
  assert.equal(siteMoveProblem(base, civic, "BG"), "target-occupied", "a block holding a garden is occupied");
  assert.equal(siteMoveProblem(base, civic, "B3"), "target-occupied", "a block with a session building is occupied");
  assert.equal(siteMoveProblem(base, civic, "B4"), "not-buildable");
  assert.equal(siteMoveProblem(base, civic, "nope"), "missing-target");
  assert.equal(siteMoveProblem(base, civic, "B1"), "unchanged");
  assert.equal(siteMoveProblem(base, garden, "B2"), null);
  // 城区地标占整面（与生成器一致，注册表 SPEC D1）：目标街区除它自己外必须全空。
  assert.equal(siteMoveProblem(base, lm, "p2a"), null, "an empty block accepts a district landmark");
  assert.equal(siteMoveProblem(base, lm, "pF1"), "target-occupied", "a parcel whose block also holds a session building and a context building is not enough for the 17 m skirt");
  assert.equal(siteMoveProblem(base, lm, "pS"), "target-occupied", "a session parcel is occupied");
  // 地块级规则（压路/高架/陡坡/不可建）用背景楼来测。
  assert.equal(siteMoveProblem(base, ctx, "pRoad"), "site-over-road");
  assert.equal(siteMoveProblem(base, ctx, "pHwy"), "highway-clearance");
  assert.equal(siteMoveProblem(base, ctx, "pSlope"), "steep-slope");
  assert.equal(siteMoveProblem(base, ctx, "p4a"), "not-buildable");
  assert.equal(siteMoveProblem(base, ctx, "pS"), "target-occupied", "a session parcel is occupied for a context building too");
  assert.equal(siteMoveProblem(base, ctx, "pF2"), null);

  const moved = apply({ t: "move", id: "civic:0", at: { x: 100, z: 100 }, to: "B2" });
  assert.equal(moved.stale.length, 0);
  const civicAfter = moved.layout.civics[0];
  assert.deepEqual([civicAfter.id, civicAfter.parcelId, civicAfter.x, civicAfter.z, civicAfter.width], ["civic:0", "B2", 200, 100, 40], "the civic takes the target block's geometry and keeps its id");
  assert.ok(reservedParcelIds(moved.layout).has("p2a") && !reservedParcelIds(moved.layout).has("p1a"), "occupancy follows the move");
  const ctxMoved = apply({ t: "move", id: "context:pC", at: { x: 70, z: 200 }, to: "pF2" });
  assert.deepEqual(ctxMoved.layout.contextBuildings.map((c) => [c.id, c.x]), [["context:pF2", 110]], "a context building's id follows its parcel");
  assert.ok(reservedParcelIds(ctxMoved.layout).has("pF2") && !reservedParcelIds(ctxMoved.layout).has("pC"), "…so occupancy is recognised at the new parcel");
  const lmMoved = apply({ t: "move", id: "district-landmark:d0", at: { x: 50, z: 200 }, to: "p2a" });
  assert.deepEqual([lmMoved.layout.districtLandmarks[0].parcelId, lmMoved.layout.districtLandmarks[0].x], ["p2a", 190]);
  assert.ok(reservedParcelIds(lmMoved.layout).has("p2d") && !reservedParcelIds(lmMoved.layout).has("pL"), "the whole new block is reserved and the old address is freed");
  // 失败的移动：进 stale，设施原地不动。
  for (const [to, reason] of [["BG", "target-occupied"], ["nope", "missing-target"], ["B4", "site-blocked"]]) {
    const failed = apply({ t: "move", id: "civic:0", at: { x: 100, z: 100 }, to });
    assert.deepEqual(failed.stale.map((s) => s.reason), [reason], `move to ${to}`);
    assert.equal(failed.layout.civics[0].parcelId, "B1", "a rejected move leaves the civic where it was");
  }
}

// (b2) 与生成器同一个落位谓词（checkSitePlacement，注册表 SPEC §5 / 路线图 P1-3）。
{
  const base = makeLayout();
  // D2：L 形街区，外接 60 × 60，但两条臂只有 12 宽——旧近似「整块空街区」放行，学校（40 × 40）会越出街区面。
  const L = [{ x: 120, z: -130 }, { x: 180, z: -130 }, { x: 180, z: -118 }, { x: 132, z: -118 }, { x: 132, z: -70 }, { x: 120, z: -70 }];
  base.blocks.push(block("BLs", 150, -100, 60, 60, [parcel("pl1", "BLs", 126, -100), parcel("pl2", "BLs", 160, -124)], L));
  // 方正的大街区：放得下，且学校保持自己的 40 × 40（不再被拉成 60 × 60 的街区外接矩形）。
  base.blocks.push(block("BW", 250, -100, 60, 60, [parcel("pw1", "BW", 240, -100), parcel("pw2", "BW", 260, -100)]));
  // D1：只有一个地址的 12 × 12 小街区——地址空着，但城区地标的 17 m 裙房装不下。
  base.blocks.push(block("BS", 330, -100, 12, 12, [parcel("ps1", "BS", 330, -100)]));
  const civic = listSites(base).find((s) => s.id === "civic:0"); const lm = listSites(base).find((s) => s.id === "district-landmark:d0");
  assert.equal(siteMoveProblem(base, civic, "BLs"), "does-not-fit", "D2: a school does not fit an L-shaped block whose bounding box is big enough");
  assert.equal(siteMoveProblem(base, civic, "BW"), null, "a square block that really holds it is accepted");
  const moved = applyPlanPatch(base, withOps({ t: "move", id: "civic:0", at: { x: 100, z: 100 }, to: "BW" }));
  assert.equal(moved.stale.length, 0);
  const school = moved.layout.civics.find((c) => c.id === "civic:0");
  assert.deepEqual([school.width, school.depth, school.parcelId], [40, 40, "BW"], "the school keeps its own size — not stretched to the block's bounding box");
  assert.ok(Math.hypot(school.x - 250, school.z + 100) < 1e-6, "…placed where the generator predicate accepted it (the block centre)");
  assert.equal(siteMoveProblem(base, lm, "ps1"), "does-not-fit", "D1: an empty address is not enough when the 17 m skirt overflows its block");
  assert.ok(!siteTargets(base, civic, [], 40, 400).some((t) => t.id === "BLs"), "…and the candidate list agrees with the predicate");
  const target = siteTargets(base, civic, [], 40, 400).find((t) => t.id === "BW");
  assert.ok(target && target.width === 40 && target.depth === 40, "the green candidate box is the school where it would land, not the whole block");
}

// (c) 位置校验 / 未知 id。
{
  const guard = apply({ t: "remove", id: "civic:0", at: { x: 500, z: 500 } });
  assert.deepEqual(guard.stale.map((s) => s.reason), ["site-changed"], "a civic that is no longer where the edit saw it must not be touched");
  assert.equal(guard.layout.civics.length, 1);
  assert.deepEqual(apply({ t: "remove", id: "civic:9" }).stale.map((s) => s.reason), ["unknown-site"]);
  assert.equal(apply({ t: "remove", id: "civic:0" }).stale.length, 0, "`at` is optional (legacy/console edits)");
  // 换了位置的「civic:0」（数据增长后序号重排）：同 id、不同位置 → 作废而不是误删。
  const renumbered = makeLayout(); renumbered.civics[0] = { ...renumbered.civics[0], parcelId: "B2", x: 200, z: 100 };
  const result = applyPlanPatch(renumbered, withOps({ t: "remove", id: "civic:0", at: { x: 100, z: 100 } }));
  assert.deepEqual(result.stale.map((s) => s.reason), ["site-changed"]); assert.equal(result.layout.civics.length, 1);
}

// (d) 顺序语义：设施先于会话楼移动。
{
  const patch = withOps({ t: "move", id: "context:pC", at: { x: 70, z: 200 }, to: "pF2" });
  patch.buildingMoves = { b1: "pC" };
  const { layout, stale } = applyPlanPatch(makeLayout(), patch);
  assert.equal(stale.length, 0, "the parcel the context building vacated is available to the session building in the same patch");
  assert.equal(layout.districts[0].slots.get("b1").id, "pC");
  const without = fresh(); without.buildingMoves = { b1: "pC" };
  assert.deepEqual(applyPlanPatch(makeLayout(), without).stale.map((s) => s.reason), ["parcel-occupied"], "…and without the site edit it is occupied");
  // 同理：拆掉公共设施后，整块街区的地块可供会话楼搬入。
  const razed = withOps({ t: "remove", id: "civic:0", at: { x: 100, z: 100 } }); razed.buildingMoves = { b1: "p1a" };
  assert.equal(applyPlanPatch(makeLayout(), razed).stale.length, 0);
}

// (e) 拾取。
{
  const base = makeLayout();
  const down = (x, z) => ({ origin: { x, y: 300, z }, direction: { x: 0, y: -1, z: 0 } });
  assert.equal(pickSite(base, down(100, 100)).id, "civic:0");
  assert.equal(pickSite(base, down(-100, 100)).id, "garden:d0");
  assert.equal(pickSite(base, down(70, 200)).id, "context:pC");
  assert.equal(pickSite(base, down(0, 500)), null, "a ray into empty ground picks nothing");
  // 斜射线：从东南上空斜着看公共设施（占地盒有高度，打得到）。
  const oblique = { origin: { x: 160, y: 40, z: 160 }, direction: (() => { const v = { x: -60, y: -30, z: -60 }; const l = Math.hypot(v.x, v.y, v.z); return { x: v.x / l, y: v.y / l, z: v.z / l }; })() };
  assert.equal(pickSite(base, oblique).id, "civic:0", "an oblique ray hits the civic's volume, not just its footprint");
  // 最近优先：背景楼前面有公共设施时取近的。
  const overlap = makeLayout(); overlap.contextBuildings = [{ ...overlap.contextBuildings[0], x: 100, z: 100, height: 60 }];
  const high = { origin: { x: 100, y: 300, z: 100 }, direction: { x: 0, y: -1, z: 0 } };
  assert.equal(pickSite(overlap, high).id, "context:pC", "the nearest volume along the ray wins");
}

// (f) 候选。
{
  const base = makeLayout();
  const civic = listSites(base).find((s) => s.id === "civic:0");
  assert.deepEqual(siteTargets(base, civic).map((t) => t.id), ["B2"], "only the one empty buildable block is a legal civic target");
  const ctx = listSites(base).find((s) => s.id === "context:pC");
  const targets = siteTargets(base, ctx, [], 10);
  assert.ok(targets.length > 0 && targets.every((t) => siteMoveProblem(base, ctx, t.id) === null), "every candidate is legal");
  assert.deepEqual(targets.map((t) => t.distance), [...targets.map((t) => t.distance)].sort((a, b) => a - b), "nearest first");
  assert.ok(!targets.some((t) => ["pRoad", "pHwy", "pSlope", "pS", "pL"].includes(t.id)), "illegal parcels never appear");
  assert.equal(siteTargets(base, ctx, [], 2).length, 2, "the limit is honoured");
}

// (g) 存档与旧字段。
{
  const messy = coercePlanPatch({ version: 1, seed: 1, scaleTier: 1, siteOps: [
    { t: "remove", id: "civic:0", at: { x: 1, z: 2 } }, { t: "move", id: "garden:d0", to: "B2" }, { t: "move", id: "x" }, { t: "zap", id: "y" }, null, { t: "remove" },
  ] });
  assert.deepEqual(messy.siteOps, [{ t: "remove", id: "civic:0", at: { x: 1, z: 2 } }, { t: "move", id: "garden:d0", to: "B2" }], "malformed site ops are dropped one by one");
  assert.deepEqual(coercePlanPatch({ version: 1, seed: 1, scaleTier: 1 }).siteOps, [], "old patches without siteOps load");
  const legacy = fresh(); legacy.suppressedContext = ["context:pC"];
  assert.equal(applyPlanPatch(makeLayout(), legacy).layout.contextBuildings.length, 0, "the legacy suppressedContext list still works");
  const cross = emptyPlanPatch(1, 2); cross.siteOps = [{ t: "remove", id: "civic:0" }];
  const base = makeLayout();
  const crossed = applyPlanPatch(base, cross);
  assert.equal(crossed.layout, base); assert.deepEqual(crossed.stale.map((s) => `${s.kind}:${s.reason}`), ["site-remove:tier-changed"]);
  assert.equal(siteKindOf("civic:3"), "civic"); assert.equal(siteKindOf("decor:civic"), null);
}

// (h) 真实城市。
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
  const layout = layoutCity(real, null, undefined, MIAMI_COASTAL, "full"); // full：背景楼全开，覆盖四类
  const sites = listSites(layout);
  const byKind = Object.fromEntries(["civic", "garden", "district-landmark", "context"].map((k) => [k, sites.filter((x) => x.kind === k).length]));
  assert.ok(byKind.civic > 0 && byKind.garden > 0 && byKind["district-landmark"] > 0, `a generated city has every non-context kind — ${JSON.stringify(byKind)}`);
  let picked = 0; let moved = 0; let removed = 0; let noTarget = 0;
  const seen = new Set(sites.map((x) => x.id)); assert.equal(seen.size, sites.length, "site ids are unique");
  for (const site of sites.slice(0, 400)) {
    const hit = pickSite(layout, { origin: { x: site.x, y: site.y + 400, z: site.z }, direction: { x: 0, y: -1, z: 0 } });
    if (hit?.id === site.id) picked += 1;
    const op = { t: "remove", id: site.id, at: { x: site.x, z: site.z } };
    const r = applyPlanPatch(layout, appendSiteOp(emptyPlanPatch(layout.seed, layout.scaleTier), op, 1));
    assert.equal(r.stale.length, 0, `removing ${site.id} applies cleanly`);
    assert.equal(listSites(r.layout).length, sites.length - 1);
    removed += 1;
    const target = siteTargets(layout, site, [], 1)[0];
    if (!target) { noTarget += 1; continue; }
    const m = applyPlanPatch(layout, appendSiteOp(emptyPlanPatch(layout.seed, layout.scaleTier), { t: "move", id: site.id, at: { x: site.x, z: site.z }, to: target.id }, 1));
    assert.equal(m.stale.length, 0, `moving ${site.id} to its first candidate applies cleanly — ${JSON.stringify(m.stale)}`);
    const after = listSites(m.layout).find((x) => x.slotId === target.id);
    assert.ok(after && Math.hypot(after.x - target.x, after.z - target.z) < 0.01, `${site.id} lands on ${target.id}`);
    moved += 1;
  }
  // 俯视射线：同一点上若叠着别的设施（花园旁的地标/背景楼），最近者胜——允许少量被遮，但绝大多数能拾到自己。
  assert.ok(picked >= Math.floor(Math.min(sites.length, 400) * 0.9), `top-down rays must pick the site under them — ${picked}/${Math.min(sites.length, 400)}`);
  console.log(`  真实城市 380 楼：设施 ${JSON.stringify(byKind)}；俯视拾取 ${picked}/${Math.min(sites.length, 400)}；拆除 ${removed} 次全部干净；搬到首个候选 ${moved} 次干净、${noTarget} 座无合法候选`);
}

console.log("City plan sites: removals and moves for civics/gardens/district landmarks/context buildings replay in log order with position guards, block-level vs parcel-level targets, occupancy follows edits (and session moves see the post-edit occupancy), picking is instance-level by ray volume, candidates are legal and nearest-first, storage coercion is tolerant, real-city edits apply cleanly.");
