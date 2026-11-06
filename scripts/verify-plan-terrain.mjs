#!/usr/bin/env node
// 玩家土方（docs/CITY_REPAIR_TERRAIN_GRADING_SPEC.md，T0 数据层）：
//   (a) applyTerrainOps 纯函数——§4.3 每条硬约束（不改水陆、|Δh| ≤ 3、山体不动、过渡带连续）、顺序叠加、空操作返回原对象；
//   (b) 补丁——没有平整的补丁指纹与引入土方前逐字相同、存档读回宽容、坏操作进失效清单且不改地形、剪枝；
//   (c) 真实城市——平整后地形是唯一真源：城区地形、会话楼落地、范围内的背景楼/花园等落地高度跟着变，范围外逐字不动；
//       与改路叠加时最终地形 = 重新平整 ⊕ 玩家土方；跨档重定位按半径比缩放；驾驶面照常编译。
// 只读合成城市，不读用户日志。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

globalThis.window ??= globalThis;
const kit = await loadCity({
  "engine/cityLayout.ts": ["layoutCity"],
  "cityModel.ts": ["buildCityModel"],
  "engine/planPatch.ts": ["applyPlanPatch", "emptyPlanPatch", "appendTerrainOp", "appendRoadOp", "coercePlanPatch", "hashPlanPatch", "pruneStalePatch", "planPatchEmpty"],
  "engine/planRemap.ts": ["remapPlanPatch"],
  "engine/surface/terrainOps.ts": ["applyTerrainOps", "terrainOpProblem", "terrainBeneathOps", "TERRAIN_OP_LIMITS"],
  "engine/surface/roadLandingGrading.ts": ["regradeRoadLandings"],
  "engine/surface/compileSurface.ts": ["compileCitySurface"],
  "engine/surface/SurfaceIndex.ts": ["buildSurfaceIndex"],
  "engine/surface/surfaceRegions.ts": ["buildSurfaceRegions"],
});
const L = kit.TERRAIN_OP_LIMITS;

// ── (a) 纯函数：合成地形——x < 0 是海（-2），0..200 是缓坡陆地（高 = x/50），200..260 爬上山（到 14）──
const field = (x) => (x < 0 ? -2 : x < 200 ? Math.max(0.01, x / 50) : Math.min(14, 4 + (x - 200) / 6));
const base = { height: (x) => field(x), slope: () => 0.02, buildable: (x) => x >= 0, coastRadius: () => 500, center: { x: 0, z: 0 }, radius: 500, hasRiver: false };
const pad = (x, z, height, radius = 10, falloff = 8) => ({ t: "pad", at: { x, z }, radius, falloff, height });
const ramp = (fx, fh, tx, th, width = 8, falloff = 6) => ({ t: "ramp", from: { x: fx, z: 0, h: fh }, to: { x: tx, z: 0, h: th }, width, falloff });

assert.equal(kit.applyTerrainOps(base, []), base, "no ops: the same terrain object (terrain mesh / grade caches key on it)");
assert.equal(kit.applyTerrainOps(base, [pad(100, 0, 2, 999)]), base, "only invalid ops: the same object — a bad op never changes terrain");
{
  const t = kit.applyTerrainOps(base, [pad(100, 0, 3.5)]);
  assert.equal(kit.terrainBeneathOps(t), base, "the layer beneath is remembered");
  assert.equal(kit.applyTerrainOps(base, [pad(100, 0, 3.5)]), t, "same ops on the same base: cached, same object");
  assert.ok(Math.abs(t.height(100, 0) - 3.5) < 1e-9 && Math.abs(t.height(100, 9) - 3.5) < 1e-9, "inside the pad radius the ground is at the target");
  assert.equal(t.height(100, 19), field(100), "beyond radius + falloff the ground is untouched");
  const mid = t.height(100, 14);
  assert.ok(mid > field(100) && mid < 3.5, `the falloff blends between ground and target: ${mid}`);
}
{
  const t = kit.applyTerrainOps(base, [pad(100, 0, 20)]);
  assert.ok(Math.abs(t.height(100, 0) - (field(100) + L.maxDelta)) < 1e-9, "|Δh| is clamped to maxDelta");
  const dug = kit.applyTerrainOps(base, [pad(5, 0, -10, 10, 8)]);
  for (let x = 0.1; x < 25; x += 0.37) assert.ok(dug.height(x, 0) > 0, `digging never turns land into water (x=${x.toFixed(2)}: ${dug.height(x, 0)})`);
  for (let x = -20; x < 0; x += 0.5) assert.equal(dug.height(x, 0), field(x), "water points are returned untouched");
  const shore = kit.applyTerrainOps(base, [pad(4, 0, 3, 10, 8)]);
  for (let x = -10; x < 0; x += 0.5) assert.equal(shore.height(x, 0), -2, "raising next to the sea does not reclaim it");
  assert.ok(shore.height(0.001, 0) < 0.05, "at the waterline the change fades to nothing (no cliff on the shore)");
}
{
  const t = kit.applyTerrainOps(base, [pad(240, 0, 6, 30, 8)]);
  for (const x of [250, 255, 265]) assert.equal(t.height(x, 0), field(x), `ground above the mountain line is never cut (x=${x})`);
  assert.ok(t.height(205, 0) !== field(205), "the foot of the hill (below the fade) is graded");
}
{
  const t = kit.applyTerrainOps(base, [ramp(40, 1, 120, 2.5)]);
  for (const x of [40, 60, 80, 100, 120]) assert.ok(Math.abs(t.height(x, 0) - (1 + (x - 40) / 80 * 1.5)) < 1e-9, `the ramp core is a straight grade (x=${x})`);
  assert.equal(kit.terrainOpProblem(ramp(40, 0, 60, 6)), "terrain-ramp-too-steep", "a ramp steeper than 0.25 is refused");
  assert.equal(kit.terrainOpProblem(ramp(40, 1, 42, 1)), "terrain-ramp-too-short");
  assert.equal(kit.terrainOpProblem(ramp(0, 1, 200, 1)), "terrain-too-large");
  assert.equal(kit.terrainOpProblem(pad(0, 0, 1, 41)), "terrain-too-large");
  assert.equal(kit.terrainOpProblem(pad(0, 0, 1, 10, 2)), "terrain-too-large", "falloff below the minimum would leave a step");
  assert.equal(kit.terrainOpProblem(pad(0, 0, Number.NaN)), "terrain-invalid");
  assert.equal(kit.terrainOpProblem(pad(0, 0, 1)), null);
}
{
  const t = kit.applyTerrainOps(base, [pad(100, 0, 3), pad(108, 0, 1, 6, 6)]);
  assert.ok(Math.abs(t.height(108, 0) - 1) < 1e-9, "ops stack in order: the later pad wins in its core");
  assert.ok(Math.abs(t.height(92, 0) - 3) < 1e-9, "…and the earlier pad still holds outside it");
  // 过渡带连续：0.1 步长内的最大跳变有界（smoothstep 最大斜率 1.5·Δ/falloff ≤ 1.5·3/4）。
  let worst = 0;
  for (let x = 60; x < 140; x += 0.1) worst = Math.max(worst, Math.abs(t.height(x + 0.1, 3) - t.height(x, 3)));
  assert.ok(worst < 0.15, `no step in the graded ground (worst 0.1-step jump ${worst.toFixed(3)})`);
}

// ── (b) 补丁 ──
const SEED = 7, TIER = 2;
const GENERATED_AT = Date.UTC(2026, 9, 7, 12, 0, 0);
let r = 12345; const rnd = () => { r = (r * 1103515245 + 12345) & 0x7fffffff; return r / 0x7fffffff; };
const rows = Array.from({ length: TIER * 400 - 20 }, (_, i) => {
  const total = Math.round(2000 + rnd() ** 3 * 4_000_000); const start = GENERATED_AT - Math.round(rnd() * 28 * 86_400_000);
  return { session_ref: `session:${i}`, harness: ["codex", "claude-code", "dsh"][i % 3], first_event_at: new Date(start).toISOString(),
    last_event_at: new Date(start + Math.round(rnd() * 3_600_000)).toISOString(), event_count: 10, model_ids: ["claude-sonnet-5"],
    tokens: { uncached_input_tokens: Math.round(total * 0.2), cache_read_tokens: Math.round(total * 0.5), cache_write_tokens: Math.round(total * 0.1), output_tokens: Math.round(total * 0.2), total },
    peak_tokens: Math.round(total * 0.3), cost_minor: { amount_minor: Math.round(total / 1000), currency: "USD", basis: "api_equivalent" },
    cost_status: { state: "estimated", reason: "", has_unresolved: false } };
});
const model = kit.buildCityModel({ rows, findings: [], windowStartMs: GENERATED_AT - 30 * 86_400_000, windowEndMs: GENERATED_AT, windowLabel: "30d", totalSessions: rows.length, truncated: false, generatedAt: GENERATED_AT });
const city = kit.layoutCity(model, null, SEED, null);
const empty = kit.emptyPlanPatch(city.seed, city.scaleTier);

{
  const withRoad = kit.appendRoadOp(empty, { t: "drop", edge: city.roadEdges[0].id }, 1);
  assert.equal(kit.hashPlanPatch({ ...withRoad, terrainOps: [] }), kit.hashPlanPatch(withRoad), "an empty terrainOps does not change the fingerprint (old saves keep their hash)");
  assert.notEqual(kit.hashPlanPatch(kit.appendTerrainOp(withRoad, pad(0, 0, 1), 1)), kit.hashPlanPatch(withRoad), "a terrain op changes the fingerprint (activityKey → terrain mesh redraw)");
  assert.equal(kit.planPatchEmpty(kit.appendTerrainOp(empty, pad(0, 0, 1), 1)), false, "a patch with only terrain ops is not empty");
  const saved = JSON.parse(JSON.stringify({ ...empty, terrainOps: [pad(1, 2, 3), ramp(0, 1, 40, 2), { t: "pad", at: { x: 1 } }, { t: "dig" }, null] }));
  assert.deepEqual(kit.coercePlanPatch(saved).terrainOps, [pad(1, 2, 3), ramp(0, 1, 40, 2)], "coerce keeps well-formed terrain ops and drops malformed ones");
  assert.equal(kit.coercePlanPatch(JSON.parse(JSON.stringify(empty))).terrainOps, undefined, "old saves without terrainOps read back without the key");
}

// 真实城市里取一块会话楼所在的平地做平台中心。
const slots = city.districts.flatMap((district) => [...district.slots.entries()].map(([id, slot]) => ({ district, id, slot })));
const site = slots.find(({ slot }) => { const h = city.terrain.height(slot.x, slot.z); return h > 0.5 && h < 8; });
assert.ok(site, "the synthetic city has a session building on dry, low ground");
const center = { x: Math.round(site.slot.x * 100) / 100, z: Math.round(site.slot.z * 100) / 100 };
const h0 = city.terrain.height(center.x, center.z);
const raise = pad(center.x, center.z, Math.round((h0 + 1.5) * 100) / 100, 14, 10);
// 另外在一座花园、一棵公园树、一个城区地标所在的低地各放一个平台（这座合成城市没有背景楼；背景楼与 massing 走同一条重取路径）：「范围内的跟着新地面」必须真的有对象可测。
const lowGround = (p) => { const h = city.terrain.height(p.x, p.z); return h > 0.5 && h < 8; };
const extra = ["gardens", "parkTrees", "districtLandmarks"].map((key) => {
  const item = (city[key] ?? []).find((candidate) => lowGround(candidate) && Math.hypot(candidate.x - center.x, candidate.z - center.z) > 60);
  assert.ok(item, `${key}: the synthetic city has one on low ground`);
  const at = { x: Math.round(item.x * 100) / 100, z: Math.round(item.z * 100) / 100 };
  return { key, op: pad(at.x, at.z, Math.round((city.terrain.height(at.x, at.z) + 1) * 100) / 100, 8, 6) };
});
const pads = [raise, ...extra.map((e) => e.op)];

{
  const out = kit.applyPlanPatch(city, pads.reduce((next, op) => kit.appendTerrainOp(next, op, 1), empty));
  assert.deepEqual(out.stale, [], "valid pads replay cleanly");
  const t = out.layout.terrain;
  assert.ok(Math.abs(t.height(center.x, center.z) - raise.height) < 1e-6, "the effective terrain carries the pad");
  assert.ok(out.layout.districts.every((d) => d.terrain === t), "every district reads the same effective terrain");
  const ground = out.layout.districts.find((d) => d.id === site.district.id).grounds.get(site.id);
  assert.ok(Math.abs(ground - t.height(site.slot.x, site.slot.z)) < 1e-9, "the session building on the pad stands on the new ground");
  // 范围外的背景楼/花园/树逐字不动；范围内的跟着新地面。
  const near = (p) => pads.some((op) => { const R = op.radius + op.falloff; return Math.abs(p.x - op.at.x) <= R && Math.abs(p.z - op.at.z) <= R; });
  for (const [key, floor] of [["contextBuildings", 0.3], ["gardens", -Infinity], ["parkTrees", -Infinity], ["districtLandmarks", -Infinity], ["massing", 0.3]]) {
    const before = city[key] ?? [], after = out.layout[key] ?? [];
    assert.equal(after.length, before.length, `${key}: nothing added or removed`);
    if (extra.some((e) => e.key === key)) assert.ok(after.some(near), `${key}: at least one item sits on a pad (the regrounding check is not vacuous)`);
    after.forEach((item, i) => {
      if (near(item)) assert.ok(Math.abs(item.y - Math.max(floor, t.height(item.x, item.z))) < 1e-9, `${key}: an item on the pad is regrounded`);
      else assert.equal(item.y, before[i].y, `${key}: an item away from the pad keeps its height`);
    });
  }
  const unrelated = slots.find(({ slot }) => !near(slot));
  assert.equal(out.layout.districts.find((d) => d.id === unrelated.district.id).grounds.get(unrelated.id),
    city.districts.find((d) => d.id === unrelated.district.id).grounds.get(unrelated.id), "a building far from the pad keeps its exact ground");

  // 驾驶面在平整后的城市上照常编译。
  const c = kit.compileCitySurface(out.layout); const surface = { ...c.surface, revision: "terrain" };
  const index = kit.buildSurfaceIndex(surface); assert.equal(index.status, "ready", "the driving surface compiles on graded ground");
  assert.equal(kit.buildSurfaceRegions(surface, index).status, "ready");
}
{
  // 与改路叠加：最终地形 = 重新平整（仍在的生成器桥）⊕ 玩家土方。
  const deck = city.roadEdges.find((e) => e.bridge);
  const both = kit.appendTerrainOp(kit.appendRoadOp(empty, { t: "drop", edge: deck.id }, 1), raise, 1);
  const out = kit.applyPlanPatch(city, both);
  const expected = kit.regradeRoadLandings(city.terrain, out.layout.roadEdges.filter((e) => !e.bridge || city.roadEdges.some((g) => g.bridge && g.id === e.id)));
  assert.ok(Math.abs(out.layout.terrain.height(center.x, center.z) - raise.height) < 1e-6, "the pad survives a road edit");
  for (const p of [deck.points[0], deck.points[deck.points.length - 1]]) {
    assert.equal(out.layout.terrain.height(p.x, p.z), expected.height(p.x, p.z), "away from the pad, the final terrain is the regraded one");
  }
}
{
  // 坏操作：进失效清单、不改地形；剪枝把它们去掉。
  const sea = (() => { for (let a = 0; a < 360; a += 5) { const x = Math.cos(a * Math.PI / 180) * city.islandRadius * 1.6, z = Math.sin(a * Math.PI / 180) * city.islandRadius * 1.6; if (city.terrain.height(x, z) <= 0) return { x: Math.round(x), z: Math.round(z) }; } return null; })();
  assert.ok(sea, "found open water around the island");
  let bad = kit.appendTerrainOp(empty, pad(sea.x, sea.z, 2), 1);
  bad = kit.appendTerrainOp(bad, pad(center.x, center.z, 2, 80), 1);
  const out = kit.applyPlanPatch(city, bad);
  assert.deepEqual(out.stale.map((e) => `${e.kind}:${e.id}:${e.reason}`), ["terrain-op:1:pad:terrain-on-water", "terrain-op:2:pad:terrain-too-large"], "bad terrain ops are reported, not guessed at");
  assert.equal(out.layout.terrain, city.terrain, "…and change nothing");
  assert.equal(kit.pruneStalePatch(bad, out.stale, 1), null, "pruning drops them (an all-stale patch becomes no patch)");
  let many = empty;
  for (let i = 0; i <= L.maxOps; i += 1) many = kit.appendTerrainOp(many, pad(center.x, center.z, raise.height), 1);
  assert.deepEqual(kit.applyPlanPatch(city, many).stale.map((e) => `${e.id}:${e.reason}`), [`${L.maxOps + 1}:pad:terrain-too-many`], "ops beyond the cap are reported");
  const other = kit.applyPlanPatch(city, { ...bad, scaleTier: city.scaleTier + 1 });
  assert.ok(other.stale.filter((e) => e.kind === "terrain-op").every((e) => e.reason === "tier-changed") && other.stale.some((e) => e.kind === "terrain-op"), "a patch from another tier reports its terrain ops as tier-changed");
}
{
  // 跨档重定位：坐标与尺寸按半径比缩放，高度不缩放。
  const old = { ...kit.appendTerrainOp(empty, pad(center.x / 2, center.z / 2, raise.height, 7, 5), 1), scaleTier: city.scaleTier - 1, islandRadius: city.islandRadius / 2 };
  const { patch, report } = kit.remapPlanPatch(city, model, old);
  assert.equal(report.ratio, 2);
  assert.deepEqual(report.failed, [], `the pad remaps cleanly: ${JSON.stringify(report.failed)}`);
  const op = patch.terrainOps[0];
  assert.ok(Math.abs(op.at.x - center.x) < 0.02 && Math.abs(op.at.z - center.z) < 0.02 && op.radius === 14 && op.falloff === 10 && op.height === raise.height, `scaled position and size, same height: ${JSON.stringify(op)}`);
}

console.log("City plan terrain (T0): pads/ramps hit their targets, never turn land into water or touch the sea, clamp |Δh| ≤ 3, leave the mountains, blend without steps and stack in order; patches keep their old fingerprint without terrain ops, read back tolerantly, report and prune bad ops; on a real city the pad is the one terrain every district, building and in-range object stands on (out-of-range objects untouched), survives road edits on top of the regraded landings, remaps across tiers and compiles a driving surface.");
