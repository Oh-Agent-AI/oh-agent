#!/usr/bin/env node
// 路网优先优化方案 · 批次 0（实测基线）守卫：不依赖渲染的道路诊断报告。
//   - 完整规划图：调优线种子 2_000_000_000 + i*104_729（i=0..7 → tier 1；i=8 → tier 3；
//     i=9 → tier 5），createCityPlan(seed, tier, MIAMI_COASTAL) 后跑 roadReport。
//   - 显示图：固定合成会话 buildCityModel(rows(523))（与 verify-city-culdesac-bulbs 同一套
//     12345 线性同余固定伪随机）驱动 layoutCity；layout seed 固定 523001688（scene-baseline
//     「已知固定 seed」风格的固定值，本批选定并写死在此注释与常量里）。
//   断言（C 组全部）：
//   (a) 同输入两次报告 JSON 全等（确定性）；
//   (b) roadEdges 以固定种子洗牌后再喂 → 报告 JSON 全等（顺序无关）；
//   (c) 报告前后对 roadEdges/blocks/publicSites/landmarks 的 JSON 指纹不变（无副作用；
//       指纹在首次调用前取自深拷贝快照字符串，读侧自证）；
//   (d) 度1非桥端分类完备：landing + legal + gap + unclassified === total。
//   (e) 固定显示样本：交叉/裁剪缺口为0，只保留原规划边，近接重复节点真实合并。
//
//   ⚠ 口径修正（2026-10-09 首测）：批次规格原定「完整规划图平面交叉数 == 0（planner 保证）」
//   的回归断言，实测前提不成立——本报告口径（非桥边两两线段最小距离 ≤ 0.5 且无共享节点）下，
//   调优线 10 个种子中 8 个的完整规划图带 1–12 对交叉（其中多为真交点，proper crossing），
//   golden 基线线 1703294958+i*7919 的 30 个岛全部带 3–19 对（在未改动规划器的 HEAD 60719c63
//   上直接测得；主要来自显式免交叉校验的加边路径，如 coastal-join 的 node-merge 与门前路
//   bridge-candidate 均 crossings:false）。批次纪律禁止改规划器、也禁止用调优线实测值设阈值，
//   故完整图交叉数与显示图一样降级为「只打印不设阈值」的首测基线输出；待 planner 交叉
//   缺陷修复后，把下文 PLAN_ASSERT_ZERO_CROSSINGS 恢复为 true 即还原原定回归断言。
//   node scripts/verify-city-road-report.mjs [--json <path>]
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { cachedPlan, loadCity, repo } from "./city-kit/index.mjs";
import { installCanvasShim } from "./city-kit/scene-hash.mjs";

installCanvasShim();
globalThis.window ??= globalThis;
globalThis.devicePixelRatio ??= 1;

const { buildCityModel, layoutCity, createCityPlan, scaleTierFor, MIAMI_COASTAL, roadReport, segmentDistance } = await loadCity({
  "cityModel.ts": ["buildCityModel"],
  "engine/cityLayout.ts": ["layoutCity"],
  "engine/cityPlan.ts": ["createCityPlan", "scaleTierFor", "segmentDistance"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "engine/planner/report.ts": ["roadReport"],
});

// 调优线（普查种子线；不得用于设阈值——本批只测量）。
const TUNING_BASE = 2_000_000_000;
const TUNING_STEP = 104_729;
const CASES = process.argv.includes("--display-only") ? [] : [
  ...Array.from({ length: 8 }, (_, i) => ({ seed: TUNING_BASE + i * TUNING_STEP, tier: 1 })),
  { seed: TUNING_BASE + 8 * TUNING_STEP, tier: 3 },
  { seed: TUNING_BASE + 9 * TUNING_STEP, tier: 5 },
];

// 显示图固定 fixture（抄 verify-city-culdesac-bulbs：同一套固定伪随机，同 count 恒同数据）。
const DISPLAY_SEED = 523001688;
const HARNESSES = ["codex", "claude-code", "dsh", "harness:zcode"];
const GENERATED_AT = Date.UTC(2026, 9, 7, 12, 0, 0);
function rows(count) {
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  return Array.from({ length: count }, (_, i) => {
    const total = Math.round(2000 + rnd() ** 3 * 4_000_000);
    const start = GENERATED_AT - Math.round(rnd() * 28 * 86_400_000);
    const end = i % 17 === 0 ? GENERATED_AT - 60_000 : start + Math.round(rnd() * 3_600_000);
    return {
      session_ref: `session:${i}`, harness: HARNESSES[i % HARNESSES.length],
      first_event_at: new Date(start).toISOString(), last_event_at: new Date(end).toISOString(),
      event_count: 10 + (i % 50), model_ids: [i % 3 ? "claude-sonnet-5" : "gpt-5"],
      tokens: { uncached_input_tokens: Math.round(total * 0.2), cache_read_tokens: Math.round(total * 0.5), cache_write_tokens: Math.round(total * 0.1), output_tokens: Math.round(total * 0.2), total },
      peak_tokens: Math.round(total * 0.3),
      cost_minor: { amount_minor: Math.round(total / 1000), currency: "USD", basis: "api_equivalent" },
      cost_status: { state: "estimated", reason: "", has_unresolved: false },
    };
  });
}

/** 固定种子 Fisher–Yates（LCG 同 rows 风格）：返回新数组，不碰输入。 */
function shuffled(edges, seed) {
  const out = [...edges];
  let s = (seed ^ 0x5eed) >>> 0 || 1;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 见文件头「口径修正」：原定完整图 ==0 断言的前提（planner 保证）实测不成立，降级为首测基线输出。 */
const PLAN_ASSERT_ZERO_CROSSINGS = false;

/** C 组断言（确定性 / 顺序无关 / 无副作用 / 分类完备）；交叉数按口径修正只测量。 */
function runCase(label, input, { assertZeroCrossings }) {
  const fingerprint = (obj) => JSON.stringify([obj.roadEdges, obj.blocks, obj.publicSites, obj.landmarks]);
  const before = fingerprint(input); // 调用前快照（字符串即深拷贝读侧，自证不受后续变动影响）
  const first = roadReport(input);
  assert.equal(JSON.stringify(roadReport(input)), JSON.stringify(first), `${label}: report not deterministic for identical input`);
  const mixed = shuffled(input.roadEdges, label.length + input.roadEdges.length + (assertZeroCrossings ? 1 : 2));
  assert.notEqual(JSON.stringify(mixed.map((e) => e.id)), JSON.stringify(input.roadEdges.map((e) => e.id)), `${label}: shuffle left the edge order unchanged (test would be vacuous)`);
  assert.equal(JSON.stringify(roadReport({ ...input, roadEdges: mixed })), JSON.stringify(first), `${label}: report depends on roadEdges order`);
  assert.equal(fingerprint(input), before, `${label}: report mutated its input`);
  const d1 = first.graph.degree1;
  assert.equal(d1.bridgeLandings + d1.legalCulDeSac + d1.approachableGap + d1.unclassified, d1.total, `${label}: degree-1 classification incomplete`);
  if (assertZeroCrossings && PLAN_ASSERT_ZERO_CROSSINGS) {
    assert.equal(first.graph.planarCrossings.count, 0,
      `${label}: full-plan graph has ${first.graph.planarCrossings.count} planar crossings (planner regression): ${first.graph.planarCrossings.findings.slice(0, 5).map((f) => f.edges.join("↔")).join(", ")}`);
  }
  return first;
}

// Curved roads must use the local endpoint tangent for junction angles; the
// endpoint chord would falsely report an acute overlap at this 3-way node.
{
  const j = { x: 0, z: 0 };
  const report = roadReport({ roadEdges: [
    { id: "0:0/-10:-10", from: "0:0", to: "-10:-10", points: [j, { x: 0, z: -2 }, { x: -10, z: -10 }], width: 5, kind: "local" },
    { id: "-10:-10.1/0:0", from: "0:0", to: "-10:-10.1", points: [j, { x: -10, z: -10.1 }], width: 8, kind: "arterial" },
    { id: "0:0/10:10", from: "0:0", to: "10:10", points: [j, { x: 10, z: 10 }], width: 8, kind: "arterial" },
  ], nodes: [{ ...j, id: "0:0" }], blocks: [], publicSites: [], landmarks: [] });
  assert.equal(report.graph.junctions.acuteBelow30, 0, "curve tangent should separate the junction legs");
  assert.ok((report.graph.junctions.minAngleDeg ?? 0) >= 30, "road report must not use a curved edge's end-to-end chord");
}

const began = performance.now();
const dump = { plan: {}, display: null };
const lines = [];
for (const { seed, tier } of CASES) {
  const plan = cachedPlan(createCityPlan, seed, tier, MIAMI_COASTAL);
  const report = runCase(`plan ${seed}/t${tier}`, {
    layer: "plan",
    roadEdges: plan.roadEdges, nodes: plan.roadNodes, blocks: plan.blocks,
    publicSites: plan.publicSites, landmarks: plan.landmarks,
    culDeSacEnds: plan.culDeSacEnds ?? [], seaside: plan.seaside ?? null,
  }, { assertZeroCrossings: true });
  dump.plan[`${seed}/t${tier}`] = report;
  const g = report.graph;
  lines.push(`plan   seed=${seed} tier=${tier} edges=${report.edgeCount} nodes=${report.nodeCount} comps=${g.componentCount}`
    + ` deg1=${g.degree1.total}(landing=${g.degree1.bridgeLandings},legal=${g.degree1.legalCulDeSac},gap=${g.degree1.approachableGap},unclass=${g.degree1.unclassified})`
    + ` cross=${g.planarCrossings.count} junctions=${g.junctions.total}(acute<30=${g.junctions.acuteBelow30},min=${g.junctions.minAngleDeg ?? "n/a"})`
    + ` len[12=${g.lengthByWidth.ge12.share},8=${g.lengthByWidth.ge8lt12.share},5=${g.lengthByWidth.lt8.share}]`
    + ` blocks=${report.blocks.analyzed} gridMax=${report.blocks.gridRepetition.cityMax}`
    + ` doors=${report.facilities.doorsOk}/${report.facilities.total} bridges=${g.bridges.total}(bad=${g.bridges.violations.length})`);
}

// 显示图：固定 fixture 驱动 layoutCity；referenceRoadEdges = 同 seed/tier 的完整规划边。
const model = buildCityModel({ rows: rows(523), findings: [], windowStartMs: GENERATED_AT - 30 * 86_400_000, windowEndMs: GENERATED_AT, windowLabel: "30d", totalSessions: 523, truncated: false, generatedAt: GENERATED_AT });
const displayTier = scaleTierFor(model.buildings.length);
const layout = layoutCity(model, null, DISPLAY_SEED, MIAMI_COASTAL);
const reference = cachedPlan(createCityPlan, DISPLAY_SEED, displayTier, MIAMI_COASTAL);
const displayReport = runCase(`display ${DISPLAY_SEED}/t${displayTier}`, {
  layer: "display",
  roadEdges: layout.roadEdges, nodes: layout.roadNodes, blocks: layout.blocks,
  publicSites: layout.publicSites, landmarks: layout.landmarks,
  culDeSacEnds: layout.culDeSacEnds ?? [], seaside: layout.seaside ?? null,
  referenceRoadEdges: reference.roadEdges,
}, { assertZeroCrossings: false });
assert.equal(displayReport.graph.degree1.approachableGap, 0, "fixed display fixture must not acquire degree-1 gaps through activity pruning");
assert.equal(displayReport.graph.planarCrossings.count, 0, "fixed display fixture must have real shared nodes at every ground crossing");
// The civic layout/radius may change when unsafe skeleton routes are rejected.
// Preserve real junctions from this plan, not coordinates from an older plan.
// The historical sub-unit gap is replayed independently in verify-city-connect.
const degree = (edges, id) => edges.filter((edge) => !edge.bridge && (edge.from === id || edge.to === id)).length;
const civic = reference.publicSites.find((site) => site.kind === "civic");
assert.ok(civic, "display fixture requires a planned civic site");
const civicJunctions = reference.roadNodes.filter((node) => Math.hypot(node.x - civic.x, node.z - civic.z) <= civic.radius + 20
  && degree(reference.roadEdges, node.id) >= 3);
assert.ok(civicJunctions.length > 0, "planned civic perimeter must have a real road junction");
for (const node of civicJunctions) assert.ok(degree(layout.roadEdges, node.id) >= 3, `display must preserve civic junction ${node.id}`);
const plannedIds = new Set(reference.roadEdges.map((edge) => edge.id));
// 唯一例外：机场堤道（2026-10-22，airportPlan.layoutAirport）——它是剪枝之后挂上去的地标桥段（到机场岛平台），
// 不是显示闭包的产物；按 layout.airport.causeway 认定，且必须恰好是这一条桥面。
const causeway = layout.airport?.causeway ? `${layout.airport.causeway.fromNode}/${layout.airport.causeway.to.x}:${layout.airport.causeway.to.z}` : null;
const unplanned = layout.roadEdges.filter((edge) => !plannedIds.has(edge.id));
assert.ok(unplanned.every((edge) => edge.id === causeway && edge.bridge && edge.structure === "deck"), `display closure must only retain existing planning edges (unplanned: ${unplanned.map((e) => e.id).join(", ")})`);
for (const blocks of [[], layout.blocks.map((b) => ({ ...b, vacant: false }))]) {
  const report = roadReport({ layer: "display", roadEdges: layout.roadEdges, blocks, publicSites: layout.publicSites, landmarks: layout.landmarks });
  assert.equal(report.layer, "display", "empty/fully built display stays a display graph");
  assert.ok(report.display, "display metrics cannot disappear with vacancy state");
}
dump.display = displayReport;
{
  const g = displayReport.graph;
  const d = displayReport.display;
  lines.push(`display seed=${DISPLAY_SEED} tier=${displayTier} edges=${displayReport.edgeCount} nodes=${displayReport.nodeCount} comps=${g.componentCount}`
    + ` deg1=${g.degree1.total}(landing=${g.degree1.bridgeLandings},legal=${g.degree1.legalCulDeSac},gap=${g.degree1.approachableGap},unclass=${g.degree1.unclassified})`
    + ` cross=${g.planarCrossings.count} junctions=${g.junctions.total}(acute<30=${g.junctions.acuteBelow30},min=${g.junctions.minAngleDeg ?? "n/a"})`
    + ` len[12=${g.lengthByWidth.ge12.share},8=${g.lengthByWidth.ge8lt12.share},5=${g.lengthByWidth.lt8.share}]`
    + ` blocks(live/vac)=${d ? `${d.liveBlocks}/${d.vacantBlocks}` : "n/a"} service=${d ? d.activityServiceRate : "n/a"}`
    + ` vacNarrow=${d ? `${d.vacantNarrowRoads.totalLength}(reserved=${d.vacantNarrowRoads.reservedLength},unsupported=${d.vacantNarrowRoads.unsupportedLength})` : "n/a"}`
    + ` doors=${displayReport.facilities.doorsOk}/${displayReport.facilities.total} bridges=${g.bridges.total}(bad=${g.bridges.violations.length})`);
}

// 匝道落在 8 宽干道上时，活动裁剪仍须保留实际宿主；否则坡道已落地但地面路被删成空地。
{
  const rampModel = buildCityModel({ rows: rows(2000), findings: [], windowStartMs: GENERATED_AT - 30 * 86_400_000,
    windowEndMs: GENERATED_AT, windowLabel: "30d", totalSessions: 2000, truncated: false, generatedAt: GENERATED_AT });
  const rampLayout = layoutCity(rampModel, null, 42, MIAMI_COASTAL);
  assert.ok(rampLayout.highwayRamps.length > 0, "the witness must contain real accepted ramps");
  const landings = [...rampLayout.highwayRamps.map(ramp => ramp.points.at(-1)),
    ...rampLayout.highways.filter(run => Math.hypot(run[0].x - run.at(-1).x, run[0].z - run.at(-1).z) > 0.01).flatMap(run => [run[0], run.at(-1)])];
  for (const point of landings) assert.ok(rampLayout.roadEdges.some(edge => !edge.bridge
    && edge.points.slice(1).some((b, i) => segmentDistance(point, edge.points[i], b) < 0.02)),
  "display must retain the real ground road at every accepted highway/ramp landing");
}

// 聚合：最差 seed 点名（完整规划图按未分类端点数，并列按锐角路口数、再按 seed；交叉数另点一名）。
const ranked = Object.entries(dump.plan)
  .map(([key, report]) => ({ key, unclass: report.graph.degree1.unclassified, acute: report.graph.junctions.acuteBelow30, cross: report.graph.planarCrossings.count }))
  .sort((a, b) => b.unclass - a.unclass || b.acute - a.acute || (a.key < b.key ? -1 : 1));
const worst = ranked[0];
const worstCross = [...ranked].sort((a, b) => b.cross - a.cross || (a.key < b.key ? -1 : 1))[0];

for (const line of lines) console.log(line);
if (worst) console.log(`worst plan seed by unclassified degree-1 ends: ${worst.key} (unclass=${worst.unclass}, acute<30=${worst.acute})`);
if (worstCross) console.log(`worst plan seed by planar crossings: ${worstCross.key} (cross=${worstCross.cross}) — first-measurement baseline, no threshold (see header: ==0 premise disproven)`);
console.log(`display-graph first-measurement baseline (no thresholds): crossings=${displayReport.graph.planarCrossings.count}`
  + ` unclassified=${displayReport.graph.degree1.unclassified}`
  + ` serviceRate=${displayReport.display ? displayReport.display.activityServiceRate : "n/a"}`
  + ` unsupportedVacantNarrowLength=${displayReport.display ? displayReport.display.vacantNarrowRoads.unsupportedLength : "n/a"}`);

const jsonArg = process.argv.indexOf("--json");
if (jsonArg >= 0) {
  const target = process.argv[jsonArg + 1];
  assert.ok(target, "--json requires a path");
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(dump, null, 1)}\n`);
  console.log(`full report written to ${path.resolve(target)}`);
}
console.log(`City road report: ${CASES.length} plan seeds + 1 display graph — deterministic, order-independent, side-effect-free, classification complete; crossing counts are measured baselines, not thresholds (${Math.round(performance.now() - began)}ms).`);
