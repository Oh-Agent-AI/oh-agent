#!/usr/bin/env node
// 修复工具能不能修坏桥头（2026-10-21，用户：「不追求完美，因为我们还有 city repair——玩家能不能用这个工具修复问题是关键」）。
// 真实城市 7/2（生成器斜接桥头的样本）：找出车沿桥轴开不过去的桥 → 用修复补丁整座擦掉 → 按画路工具同一套校验
// （validateRoadAdd：桥长、桥上无路口、两端直引道 ≥6、岸坡不陡）在附近找一笔能画的直桥 → 套补丁、重编驾驶面，
// 同一驾驶内核沿新桥开一遍。断言：每座坏桥都能擦；擦掉后桥与桁架登记一起消失；至少一座坏桥能被重画成车开得过去的桥。
// 只读合成城市，不读用户日志。用法：node scripts/verify-plan-repair-bridgehead.mjs [seed tier]
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
import { makeRoutePilot } from "./city-kit/route-pilot.mjs";

globalThis.window ??= globalThis;
const kit = await loadCity({
  "engine/cityLayout.ts": ["layoutCity"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "cityModel.ts": ["buildCityModel"],
  "engine/planPatch.ts": ["applyPlanPatch", "emptyPlanPatch", "bridgeChain"],
  "engine/planBridgeFix.ts": ["proposeBridgeFix"],
  "engine/planRoadRules.ts": ["validateRoadAdd", "validateEdgeDrop", "snapPoint"],
  "engine/planAudit.ts": ["auditLayout"],
  "planRepair/testDrive.ts": ["testDrive"],
  "engine/surface/roadLandingGrading.ts": ["regradeRoadLandings"],
  "engine/surface/compileSurface.ts": ["compileCitySurface", "landingConnectivity"],
  "engine/surface/SurfaceIndex.ts": ["buildSurfaceIndex"],
  "engine/surface/surfaceRegions.ts": ["buildSurfaceRegions"],
  "game/driving/surfaceFootprint.ts": ["footprintSupport"],
  "game/driving/SurfaceDrivingWorld.ts": ["SurfaceDrivingEnvironment", "SurfaceWorldValidator", "polylineProgress"],
  "game/driving/DrivingKernel.ts": ["DrivingKernel"],
  "game/DrivingSimulation.ts": ["initialDrivingState"],
});

// 用法：[seed tier [miami]]——miami = 海滨配置（MIAMI_COASTAL，陡桥头所在的 30 个岛形规划）。
const [seed, tier] = process.argv.length >= 4 ? [Number(process.argv[2]), Number(process.argv[3])] : [7, 2];
const coastal = process.argv[4] === "miami" ? kit.MIAMI_COASTAL : null;
const GENERATED_AT = Date.UTC(2026, 9, 7, 12, 0, 0);
let r = 12345; const rnd = () => { r = (r * 1103515245 + 12345) & 0x7fffffff; return r / 0x7fffffff; };
const rows = Array.from({ length: tier * 400 - 20 }, (_, i) => {
  const total = Math.round(2000 + rnd() ** 3 * 4_000_000); const start = GENERATED_AT - Math.round(rnd() * 28 * 86_400_000);
  return { session_ref: `session:${i}`, harness: ["codex", "claude-code", "dsh"][i % 3], first_event_at: new Date(start).toISOString(),
    last_event_at: new Date(start + Math.round(rnd() * 3_600_000)).toISOString(), event_count: 10, model_ids: ["claude-sonnet-5"],
    tokens: { uncached_input_tokens: Math.round(total * 0.2), cache_read_tokens: Math.round(total * 0.5), cache_write_tokens: Math.round(total * 0.1), output_tokens: Math.round(total * 0.2), total },
    peak_tokens: Math.round(total * 0.3), cost_minor: { amount_minor: Math.round(total / 1000), currency: "USD", basis: "api_equivalent" },
    cost_status: { state: "estimated", reason: "", has_unresolved: false } };
});
const model = kit.buildCityModel({ rows, findings: [], windowStartMs: GENERATED_AT - 30 * 86_400_000, windowEndMs: GENERATED_AT, windowLabel: "30d", totalSessions: rows.length, truncated: false, generatedAt: GENERATED_AT });
const base = kit.layoutCity(model, null, seed, coastal);
assert.equal(base.scaleTier, tier, `the synthetic model lands on tier ${tier}`);

const key = { baseSnapshotHash: "repair-bridgehead-v1", vehicleConfigHash: "car-v1", kernelBuildId: "fixture-build-v1",
  surfaceVersion: 2, queryVersion: 2, snapshotCompilerVersion: 1, physicsVersion: 1, collisionVersion: 1, controllerVersion: 1, plannerVersion: 1, observerVersion: 1, manifestHash: "x", releasePolicyVersion: 1, releaseBoundaryHash: null };
const drivePath = makeRoutePilot(kit, key);
const compile = (layout) => {
  const c = kit.compileCitySurface(layout); const surface = { ...c.surface, revision: "repair" };
  const index = kit.buildSurfaceIndex(surface); assert.equal(index.status, "ready");
  const regions = kit.buildSurfaceRegions(surface, index); assert.equal(regions.status, "ready");
  return { c, regions };
};
const leg = (layout, end, other) => {
  const id = `${end.x}:${end.z}`; const ox = end.x - other.x, oz = end.z - other.z, ol = Math.hypot(ox, oz);
  let best = null, bestDot = -Infinity;
  for (const e of layout.roadEdges) {
    if (e.bridge || (e.from !== id && e.to !== id)) continue;
    const pts = e.from === id ? e.points : [...e.points].reverse(); const d = Math.hypot(pts[1].x - pts[0].x, pts[1].z - pts[0].z) || 1;
    const dot = ((pts[1].x - pts[0].x) * ox + (pts[1].z - pts[0].z) * oz) / (d * ol);
    if (dot > bestDot) { bestDot = dot; best = { pts, d }; }
  }
  if (!best) return null;
  const t = Math.min(6, best.d * 0.8) / best.d;
  return { x: best.pts[0].x + (best.pts[1].x - best.pts[0].x) * t, z: best.pts[0].z + (best.pts[1].z - best.pts[0].z) * t };
};
const along = (a, b, s) => { const d = Math.hypot(b.x - a.x, b.z - a.z); return { x: a.x + (b.x - a.x) * s / d, z: a.z + (b.z - a.z) * s / d }; };

// ── 1. 坏桥：车沿桥轴（桥前 6 → 桥后 6）开不过去 ──
const before = compile(base);
const decks = base.roadEdges.filter((e) => e.bridge);
const bad = [];
const seen = new Set();
for (const deck of decks) {
  if (seen.has(deck.id)) continue;
  const chain = kit.bridgeChain(base.roadEdges, deck); for (const e of chain) seen.add(e.id);
  const ends = chain.flatMap((e) => [e.points[0], e.points[e.points.length - 1]]);
  let [a, b] = [ends[0], ends[1]]; for (const p of ends) for (const q of ends) if (Math.hypot(p.x - q.x, p.z - q.z) > Math.hypot(a.x - b.x, a.z - b.z)) [a, b] = [p, q];
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  // 沿真实引道开（与 verify-city-structure-surface --cities 的 routed 同口径）：两端各取与离桥方向最一致的地面边，走 6。
  const path = [leg(base, a, b) ?? along(a, b, -6), a, b, leg(base, b, a) ?? along(a, b, len + 6)];
  const pathLen = path.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x - path[i].x, q.z - path[i].z), 0);
  const forward = drivePath(before.regions, path, { until: pathLen - 0.5 }).result, back = drivePath(before.regions, [...path].reverse(), { until: pathLen - 0.5 }).result;
  if (forward !== "ok" || back !== "ok") bad.push({ deck, chain, a, b, len, forward, back });
}
console.log(`${seed}/${tier}: ${decks.length} deck edges, ${seen.size ? new Set([...seen]).size : 0} in chains; ${bad.length} bridge(s) not drivable straight along the axis`);
for (const x of bad) console.log(`  ${x.deck.id.slice(0, 32)} w${x.deck.width} len ${x.len.toFixed(1)} forward ${x.forward} back ${x.back}`);

// 体检列得出坏桥头：7/2 悬索桥斜接（它是玩家要修的那座）。
const audited = kit.auditLayout(base, model).filter((i) => i.rule.startsWith("bridgehead"));
console.log(`audit: ${audited.map((i) => `${i.rule} @${i.id.split(":").slice(1).join(":")}`).join(", ") || "none"}`);
if (seed === 7 && tier === 2) assert.ok(audited.some((i) => i.rule === "bridgeheadOblique" && i.entities.includes("-16.57:295.97/58.1:308.1")), "the audit lists the 7/2 suspension bridge as an oblique bridgehead");

// ── 2. 擦掉每座坏桥：校验放行、补丁干净、桥面与登记一起消失 ──
let fixed = 0; const report = [];
for (const x of bad) {
  const verdict = kit.validateEdgeDrop(base, model, x.deck.id);
  assert.deepEqual(verdict.blockers, [], `${x.deck.id}: a whole bridge can be erased`);
  const drop = { ...kit.emptyPlanPatch(base.seed, base.scaleTier), roadOps: [{ t: "drop", edge: x.deck.id }] };
  const erased = kit.applyPlanPatch(base, drop);
  assert.deepEqual(erased.stale, [], `${x.deck.id}: the erase replays cleanly`);
  // 桥头土方跟着路走（planPatch：补丁改路就从原始地形重新平整）：擦掉的桥，土台一起撤。
  // 回归（ceaa2cce 之后）：补丁不重算，旧土台留在原地，重画的桥两头 height-conflict，一键修复一座也修不好。
  const raw = kit.regradeRoadLandings(base.terrain, []);
  for (const p of x.chain.flatMap((c) => [c.points[0], c.points[c.points.length - 1]])) {
    assert.equal(erased.layout.terrain.height(p.x, p.z), raw.height(p.x, p.z), `${x.deck.id}: the erased bridge's landing pad is gone at ${p.x}:${p.z}`);
  }
  assert.equal(kit.applyPlanPatch(base, kit.emptyPlanPatch(base.seed, base.scaleTier)).layout.terrain, base.terrain, "a patch with no road edits keeps the generated earthworks as they are");
  assert.ok(!erased.layout.roadEdges.some((e) => x.chain.some((c) => c.id === e.id)), "every deck piece of the bridge is gone");
  assert.equal(erased.layout.bridges.length, base.bridges.length - base.bridges.filter((g) => x.chain.some((c) => {
    const mid = { x: (g.from.x + g.to.x) / 2, z: (g.from.z + g.to.z) / 2 };
    // 到线段（不是直线）的距离：海滨堤道是几座共线的桥，按直线算会把同一条线上的别的桥也算进来。
    return c.points.some((p, i) => { if (i === 0) return false; const a = c.points[i - 1]; const dx = p.x - a.x, dz = p.z - a.z; const t = Math.max(0, Math.min(1, ((mid.x - a.x) * dx + (mid.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
      return Math.hypot(mid.x - a.x - dx * t, mid.z - a.z - dz * t) <= c.width / 2 + 1; });
  })).length, "the truss registry drops exactly the erased bridge");

  // ── 3. 一键修复方案（P1-D，面板里「修复方案」调的同一个函数）：擦桥 + 擦岸边残路 + 按画路校验搜一笔合法直桥 ──
  const fix = kit.proposeBridgeFix(base, base, model, kit.emptyPlanPatch(base.seed, base.scaleTier), x.deck.id);
  if (!fix.ok) { report.push(`  ${x.deck.id.slice(0, 32)}: erased; no fix proposal (${fix.reason}: ${fix.detail})`); continue; }
  const drawn = { from: fix.proposal.draw.from, to: fix.proposal.draw.to, verdict: { warnings: [`bridge:${fix.proposal.draw.bridgeLength}`, ...fix.proposal.warnings] } };
  for (const id of fix.proposal.erase.slice(1)) assert.deepEqual(kit.validateEdgeDrop(kit.applyPlanPatch(base, drop).layout, model, id).blockers, [], `${id}: the leftover shore road can be erased`);
  const redraw = { ...drop, roadOps: fix.proposal.ops };
  const repaired = kit.applyPlanPatch(base, redraw);
  assert.deepEqual(repaired.stale, [], `${x.deck.id}: the redraw replays cleanly`);
  const after = compile(repaired.layout);
  // 从桥头前 4 开到桥尾后 4：考的是两个桥头本身（路口里的渠化导流岛在路中线上，沿中线开的领航员会撞岛——那是路口的事）。
  const newDeck = repaired.layout.roadEdges.find((e) => e.bridge && !base.roadEdges.some((o) => o.id === e.id));
  assert.ok(newDeck, "the redraw lays a new deck");
  // 玩家画的桥不自动垫土：画桥校验看到的地形就是车开的地形。
  for (const p of [newDeck.points[0], newDeck.points[newDeck.points.length - 1]]) {
    assert.equal(repaired.layout.terrain.height(p.x, p.z), raw.height(p.x, p.z), `the player's new bridge gets no automatic landing pad at ${p.x}:${p.z}`);
  }
  const [d0, d1] = [newDeck.points[0], newDeck.points[newDeck.points.length - 1]];
  const near = (p) => Math.hypot(p.x - drawn.from.x, p.z - drawn.from.z);
  const [deckFrom, deckTo] = near(d0) < near(d1) ? [d0, d1] : [d1, d0];
  const deckLen = Math.hypot(deckTo.x - deckFrom.x, deckTo.z - deckFrom.z);
  const tail = 4;
  const path = [along(deckFrom, deckTo, -tail), deckFrom, deckTo, along(deckFrom, deckTo, deckLen + tail)];
  // 领航员追最后一个目标点会在终点前打满方向撞路缘（与路面无关，换尾长恒在终点前 0.3 出现）：跑到终点前 0.5 即算通过。
  const until = deckLen + 2 * tail - 0.5;
  const forward = drivePath(after.regions, path, { until }).result, back = drivePath(after.regions, [...path].reverse(), { until }).result;
  assert.ok(!forward.startsWith("invalid") && !back.startsWith("invalid"), `${forward} / ${back}`);
  const ok = forward === "ok" && back === "ok";
  if (ok) fixed++;
  // 试驾（P1-E，玩家在面板里点的同一个函数）：修前这座桥不算通过，修后新桥通过。
  const t0 = performance.now(); const drivenBefore = kit.testDrive(base, x.deck.id); const t1 = performance.now();
  const drivenAfter = kit.testDrive(repaired.layout, newDeck.id); const t2 = performance.now();
  report.push(`    test drive: before ${drivenBefore.verdict} (${drivenBefore.forward.result}/${drivenBefore.back.result} ${drivenBefore.forward.reason || drivenBefore.back.reason}) ${Math.round(t1 - t0)}ms; after ${drivenAfter.verdict} (${drivenAfter.forward.reason || drivenAfter.back.reason || "ok"}) ${Math.round(t2 - t1)}ms`);
  assert.notEqual(drivenBefore.verdict, "passed", `${x.deck.id}: the test drive does not pass the defective bridge`);
  if (ok) assert.equal(drivenAfter.verdict, "passed", `${x.deck.id}: the test drive passes the repaired bridge`);
  // 体检（P0-A）：修之前列出这座桥的桥头问题，修好之后不再列。
  const flagged = (layout) => kit.auditLayout(layout, model).filter((i) => i.rule.startsWith("bridgehead") && i.entities.some((id) => x.chain.some((c) => c.id === id)));
  if (ok) assert.deepEqual(flagged(repaired.layout), [], `${x.deck.id}: the repaired bridge leaves no bridgehead issue`);
  report.push(`  ${x.deck.id.slice(0, 32)}: erased; redrawn ${drawn.verdict.warnings.find((w) => w.startsWith("bridge:"))} from ${drawn.from.x.toFixed(1)}:${drawn.from.z.toFixed(1)} → forward ${forward} back ${back}`);
}
for (const line of report) console.log(line);
// 其它规划只报告（海滨的陡桥头多是通往小岛设施的堤道跳板、或断头溪桥：对岸没有路网，自动方案如实拒绝并说明原因）。
if (bad.length && seed === 7 && tier === 2) assert.ok(fixed > 0, "at least one defective bridge can be repaired by the player (erase + redraw)");
// 7/2 的悬索桥就是那座斜接坏桥头（驾驶内核在桥头 wheel-twist / 越出桥面）：它必须能被玩家修好。
if (seed === 7 && tier === 2) assert.ok(report.some((line) => line.includes("-16.57:295.97/58.1:308.1") && line.includes("forward ok back ok")), "the 7/2 suspension bridge is repairable");
console.log(`City plan repair bridgehead: ${bad.length} defective bridge(s) on ${seed}/${tier}; every one erasable as a whole (registry follows); ${fixed}/${bad.length} redrawn with the draw tool's own rules and driven across by the same kernel.`);
