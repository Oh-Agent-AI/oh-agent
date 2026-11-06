#!/usr/bin/env node
// 玩家修的路车开不开得过去（2026-10-21，用户：「现在玩家手动 repair 的道路都可以满足开车？」）。
// 在真实城市上随机做画路工具接受的编辑（直线、弧线、拖路口；过河的一笔自动架桥），逐条套补丁、用试驾（planRepair/testDrive.ts，
// 驾驶模式同一内核）双向开每段新路。会话的驾驶面安全网（surface-unresolved）会拦的编辑单独计数，不算玩家画得出的路。
// 失败的再用审计的几何截面（corridorCutEvidence）分类：clear = 路面处处有车宽的空当，问题在拐弯/接缝而非太窄。
// 历史：锐角接路（< 50°）只有约四成通过 → 拦下（junction-too-sharp）；试驾的窄路改走中线、导流岛从空侧绕、局部窗口带全路口；
// 380 / 1600 楼 69% / 52% → 99% / 100%。用法：node scripts/verify-plan-repair-drivability.mjs [楼数 种子 [miami]]
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
globalThis.window ??= globalThis;
const kit = await loadCity({ "engine/cityLayout.ts": ["layoutCity"], "cityModel.ts": ["buildCityModel"], "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "engine/planPatch.ts": ["applyPlanPatch", "emptyPlanPatch"], "engine/planRoadRules.ts": ["validateRoadAdd", "validateNodeMove", "snapPoint"], "planRepair/testDrive.ts": ["testDrive", "drivingRegions", "surfaceHoles"], "game/driving/audit/RoadPassabilityAudit.ts": ["corridorCutEvidence"], "game/driving/CollisionIndex.ts": ["buildCollisionIndex"] });
const EMPTY = kit.buildCollisionIndex([]);
const N = Number(process.argv[2] ?? 380), SEED = Number(process.argv[3] ?? 1927), coastal = process.argv[4] === "miami" ? kit.MIAMI_COASTAL : null;
const GENERATED_AT = Date.UTC(2026, 9, 7, 12);
let r = 12345; const rnd = () => { r = (r * 1103515245 + 12345) & 0x7fffffff; return r / 0x7fffffff; };
const rows = Array.from({ length: N }, (_, i) => { const total = Math.round(2000 + rnd() ** 3 * 4e6); const start = GENERATED_AT - Math.round(rnd() * 28 * 864e5);
  return { session_ref: `s:${i}`, harness: "codex", first_event_at: new Date(start).toISOString(), last_event_at: new Date(start + 1e6).toISOString(), event_count: 10, model_ids: ["m"],
    tokens: { uncached_input_tokens: total * 0.2 | 0, cache_read_tokens: total * 0.5 | 0, cache_write_tokens: total * 0.1 | 0, output_tokens: total * 0.2 | 0, total }, peak_tokens: total * 0.3 | 0,
    cost_minor: { amount_minor: total / 1000 | 0, currency: "USD", basis: "api_equivalent" }, cost_status: { state: "estimated", reason: "", has_unresolved: false } }; });
const model = kit.buildCityModel({ rows, findings: [], windowStartMs: GENERATED_AT - 30 * 864e5, windowEndMs: GENERATED_AT, windowLabel: "30d", totalSessions: N, truncated: false, generatedAt: GENERATED_AT });
const base = kit.layoutCity(model, null, SEED, coastal);
const ground = base.roadEdges.filter((e) => !e.bridge && e.structure !== "deck");
const q = (p) => ({ x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100 });
const onEdge = (e, t) => { const a = e.points[0], b = e.points[e.points.length - 1]; return q({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }); };
const nearestRoad = (layout, p, max = 10) => { let best = null, bd = max; for (const e of layout.roadEdges) { if (e.bridge) continue; for (let i = 1; i < e.points.length; i++) { const a = e.points[i - 1], b = e.points[i]; const dx = b.x - a.x, dz = b.z - a.z; const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1))); const c = { x: a.x + dx * t, z: a.z + dz * t }; const d = Math.hypot(c.x - p.x, c.z - p.z); if (d < bd) { bd = d; best = q(c); } } } return best; };
const tally = {}; const fails = []; let edits = 0, drives = 0;
const bump = (k) => (tally[k] = (tally[k] ?? 0) + 1);
const tryEdit = (kind, op, warnings) => {
  const patch = { ...kit.emptyPlanPatch(base.seed, base.scaleTier), roadOps: [op] };
  const { layout, stale } = kit.applyPlanPatch(base, patch);
  if (stale.length) { bump(`${kind}:stale`); return; }
  const baseIds = new Set(base.roadEdges.map((e) => e.id));
  const fresh = layout.roadEdges.filter((e) => !baseIds.has(e.id));
  const decks = fresh.filter((e) => e.bridge); const groundNew = fresh.filter((e) => !e.bridge);
  // 会话的驾驶面安全网（surface-unresolved）：新出现解不出的路面片 → 这一笔在面板里会被拦，不算玩家画得出的路。
  const lines = fresh.map((e) => e.points);
  if (lines.length && kit.surfaceHoles(layout, lines) > kit.surfaceHoles(base, lines)) { bump(`${kind}:refused-surface`); return; }
  edits++;
  // 一笔路的结论：整座新桥 + 每段新地面路（自动路口把一笔拆成几段，各段分别开）
  const targets = decks.length ? [decks[0]] : groundNew;
  let worst = "passed"; const notes = [];
  for (const e of targets) {
    const res = kit.testDrive(layout, e.id); if (!res) continue; drives++;
    if (res.verdict !== "passed") {
      const leg = res.forward.result !== "ok" ? res.forward : res.back;
      // 几何证明：沿这条路的走廊（路宽一半 + 2.5，含喇叭口）每条横截线上，最宽的连续可行驶区间是否都短于车宽——是才算真的过不去。
      const regions = kit.drivingRegions(layout, res.target.path);
      const start = regions.classify(res.target.path[0].x, res.target.path[0].z, "ground");
      const cut = start.status === "drivable" ? kit.corridorCutEvidence({ regions, exact: EMPTY }, { id: "x", units: [], path: res.target.path, halfWidth: res.target.width / 2 + 2.5 }, start.regionId) : { status: "unresolved", reason: "start" };
      notes.push(`${res.verdict}:${leg.reason}[cut:${cut.status}]`); bump(`cut:${res.verdict}:${cut.status}`);
      if (worst === "passed" || res.verdict === "blocked") worst = res.verdict;
    }
  }
  const flags = [warnings.some((w) => w === "acute-junction") ? "acute" : "", warnings.some((w) => w.startsWith("auto-junction")) ? "x" : "", decks.length ? "bridge" : ""].filter(Boolean).join("+") || "plain";
  bump(`${kind}:${worst}`); bump(`flag:${flags}:${worst}`);
  if (worst !== "passed") fails.push(`${kind} ${flags} ${notes.join(" ")} ${JSON.stringify(op).slice(0, 120)}`);
};
// 直线路：从一条路上的点出发，随机方向 20–120，终点吸附到附近的路（没有就落空地）
for (let i = 0, accepted = 0; i < 400 && accepted < 60; i++) {
  const e = ground[Math.floor(rnd() * ground.length)]; const from = onEdge(e, 0.2 + rnd() * 0.6);
  const ang = rnd() * Math.PI * 2, len = 20 + rnd() * 100; const probe = { x: from.x + Math.cos(ang) * len, z: from.z + Math.sin(ang) * len };
  const to = nearestRoad(base, probe) ?? q(probe);
  const v = kit.validateRoadAdd(base, model, from, to, [5, 5, 8, 12][Math.floor(rnd() * 4)]);
  if (v.blockers.length) continue; accepted++;
  tryEdit(v.warnings.some((w) => w.startsWith("bridge:")) ? "bridge" : "straight", { t: "add", from, to, width: 5 }, v.warnings);
}
// 弧线
for (let i = 0, accepted = 0; i < 300 && accepted < 20; i++) {
  const e = ground[Math.floor(rnd() * ground.length)]; const from = onEdge(e, 0.3 + rnd() * 0.4);
  const ang = rnd() * Math.PI * 2, len = 40 + rnd() * 60; const to = nearestRoad(base, { x: from.x + Math.cos(ang) * len, z: from.z + Math.sin(ang) * len }) ?? q({ x: from.x + Math.cos(ang) * len, z: from.z + Math.sin(ang) * len });
  const via = q({ x: (from.x + to.x) / 2 - Math.sin(ang) * len * 0.15, z: (from.z + to.z) / 2 + Math.cos(ang) * len * 0.15 });
  const v = kit.validateRoadAdd(base, model, from, to, 5, undefined, [], via); if (v.blockers.length) continue; accepted++;
  tryEdit("arc", { t: "add", from, to, width: 5, via }, v.warnings);
}
// 拖路口
for (let i = 0, accepted = 0; i < 300 && accepted < 20; i++) {
  const n = base.roadNodes[Math.floor(rnd() * base.roadNodes.length)]; const to = q({ x: n.x + (rnd() - 0.5) * 24, z: n.z + (rnd() - 0.5) * 24 });
  const v = kit.validateNodeMove(base, model, n.id, to); if (v.blockers.length) continue; accepted++;
  tryEdit("node", { t: "move", node: n.id, to }, v.warnings);
}
console.log(`${N} buildings seed ${SEED}${coastal ? " miami" : ""}: ${edits} accepted edits, ${drives} drives`);
console.log(JSON.stringify(Object.fromEntries(Object.entries(tally).sort())));
for (const f of fails.slice(0, 25)) console.log("  ", f);

// 守卫：默认城市（380 楼、种子 1927）上，工具接受的编辑至少 95% 试驾通过、「挡住」不超过 2 条——回退就红。
const accepted = Object.entries(tally).filter(([k]) => /^(straight|bridge|arc|node):(passed|blocked|undetermined)$/.test(k)).reduce((n, [, v]) => n + v, 0);
const passed = Object.entries(tally).filter(([k]) => /^(straight|bridge|arc|node):passed$/.test(k)).reduce((n, [, v]) => n + v, 0);
const blocked = Object.entries(tally).filter(([k]) => /^(straight|bridge|arc|node):blocked$/.test(k)).reduce((n, [, v]) => n + v, 0);
if (process.argv.length < 4) {
  assert.ok(passed / accepted >= 0.95, `tool-accepted edits must test-drive at ≥ 95%: ${passed}/${accepted}`);
  assert.ok(blocked <= 2, `at most 2 accepted edits may be blocked: ${blocked}`);
}
console.log(`City plan repair drivability: ${passed}/${accepted} tool-accepted player edits test-drive both ways (${blocked} blocked); edits the surface safety net would refuse: ${Object.entries(tally).filter(([k]) => k.endsWith(":refused-surface")).reduce((n, [, v]) => n + v, 0)}.`);
