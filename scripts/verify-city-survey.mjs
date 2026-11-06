#!/usr/bin/env node
// 样本外规划普查守卫（CITY_ARCHITECTURE 约束框架；CITY_PLANNER_V2_SPEC 步 3 扩到四档）：
// 30 个固定岛是回归样本，真实用户的种子千差万别——在与回归样本错开的种子上测全部约束，
// 断言每条约束的「违例岛数」不超过该档上限；同时输出各档平均分（scorePlan 只作规划器对比，不作验收）。
// 上限：tier1 沿用 150 种子折算；tier 3/5/10 = 2026-10-08 实测 + 余量。
// looseInlandRoadEnds 2026-10-08：断头豁免改语义判定后平岛盲区首次可见（检测口径 t1 45/t3 26/t5 18/t10 7）；
// 修复策略同步语义化后实测 t1 29/t3 8/t5 8/t10 2；批次 3-2 repairs.ts 两处 height 门亦切语义后 t1 15/t3 5/t5 6/t10 2；
// 批次 4-3（孤立分量 tolerance 不校验直连删除、失败进诊断）后实测 t1 17/t3 4/t5 5/t10 2（t1 +2：被水/地形
// 围死的分量不再被非法直连掩盖，其断头如实计数；t3/t5 反降——见提交说明）。上限=实测值。
// 失败时先跑 `node scripts/city-kit/survey.mjs 150 1`（或对应档位）
// 看是哪类约束、典型种子，再决定修规划还是（有理由时）调上限。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

const TIERS = [
  { tier: 1, seeds: 60 },
  { tier: 3, seeds: 30 },
  { tier: 5, seeds: 20 },
  { tier: 10, seeds: 10 },
];
// 0 = 当前实测为 0 的约束必须保持为 0；非 0 的是已知残留。tier>1 的表覆盖 tier1 表（未列键沿用）。
// disconnectedComponents / bridgeheadContinuity（批次 5-3 新增，诊断口径，阈值=实测值）：
// 批次 4-3c 加了跨河档（bridge-candidate ≤84 连续水段）与帆形歌剧院岸点选址避让后实测
// t1 2 / t3 1 / t5 1 / t10 0 岛（前值 19/10/3/3——多数孤立分量隔河而居，跨河桥是设计 §4.2
// 的正解）；悬空桥头 t1 8 / t3 5 / t5 4 / t10 1（桥建成后接续地面路被后续阶段删除——批次前不可见）。
// acuteJunctions（city-roundabout 批次，2026-10-08）：resolveAcuteJunctions 对三岔锐汇先试
// mini-roundabout 建环、删枝退居最后手段后，四档实测不变（t1 5 / t3 1 / t5 4 / t10 3 岛，
// 15 处违例逐个核对均为环契约外的形态：多岔 4/5 路 ×8、桥腿 ×3、近共线 0.68°/2.77° 对 ×2、腿过短 ×1、
// 预留地压环带 ×1）——不放松硬约束换数字，阈值维持；收益是形态层（建环保边替代删枝，
// 见 docs/CITY_PLANNER_V2_FINDINGS §5）。
// 桥头落地环批（E 轨 2026-10-08，planner/landing.ts：失配 >25°/缺失/可删风险 → 半径 10–14 落地环）
// 实测 t1 8→4 / t3 5→5 / t5 4→1 / t10 1→1；残留全部是安全检查如实 declined（water-span 无干环位 /
// no-ground-reach 环缘外 ≤26 无路 / edge-inside / acute）。副作用：disconnectedComponents t1 2→0。
const CEILING = {
  unjoinedGroundJunctions: 0,
  siteInWater: 2, siteWithoutDoorRoad: 0, roadThroughSite: 0, sitesOverlap: 1, parcelInsideSite: 0,
  stationStadiumSetback: 0, stationDoorFacesRoad: 0, archStraddlesRoad: 0, civicPlazaCentred: 0,
  suspensionBridgeClearOfHighways: 0, looseInlandRoadEnds: 17, acuteJunctions: 5, crowdedArterials: 4,
  disconnectedComponents: 2, bridgeheadContinuity: 4,
};
const TIER_CEILING = {
  3: { siteInWater: 4, looseInlandRoadEnds: 4, acuteJunctions: 1, crowdedArterials: 0, disconnectedComponents: 1, bridgeheadContinuity: 5 },
  5: { siteInWater: 2, looseInlandRoadEnds: 5, acuteJunctions: 4, crowdedArterials: 3, disconnectedComponents: 1, bridgeheadContinuity: 1 },
  10: { siteInWater: 1, looseInlandRoadEnds: 2, acuteJunctions: 4, crowdedArterials: 3, disconnectedComponents: 0, bridgeheadContinuity: 1 },
};
// 可按档位/样本集分片并行跑；默认仍执行全部 240 座，不改种子、数量或验收上限。
let sampleSet = "all", selectedTier = null;
for (let i = 2; i < process.argv.length; i += 1) {
  const flag = process.argv[i], value = process.argv[++i];
  if (flag === "--set" && ["all", "acceptance", "tuning"].includes(value)) sampleSet = value;
  else if (flag === "--tier" && TIERS.some(({ tier }) => String(tier) === value)) selectedTier = Number(value);
  else throw new Error("Usage: verify-city-survey.mjs [--set all|acceptance|tuning] [--tier 1|3|5|10]");
}
const selectedTiers = TIERS.filter(({ tier }) => selectedTier === null || tier === selectedTier);
const { createCityPlan, MIAMI_COASTAL, CONSTRAINTS, scorePlan } = await loadCity({
  "engine/cityPlan.ts": ["createCityPlan"], "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "engine/planner/constraints.ts": ["CONSTRAINTS"], "engine/planner/score.ts": ["scorePlan"],
});
const summaries = [];
// 独立验收集（评审 2026-10-09：seed 只进测试、不决定规则；调参集 2_000_000_000 系与验收集分离）。
// 旧3B线曾参与候选参数试验，已失去独立验收资格；4B线仅供冻结源码后的验收，不用于调参。
const ACCEPT_BASE = 4_000_000_000;
const acceptance = [];
const ACCEPT_CEILING = { siteWithoutDoorRoad: 1, looseInlandRoadEnds: 16, acuteJunctions: 4, crowdedArterials: 2, bridgeheadContinuity: 5 };
// Long default surveys report seed progress; callers may explicitly silence it.
const progress = process.env.CITY_VERIFY_PROGRESS !== "0";
// 2026-10-09 独立验收集（3_000_000_000 系）首测基线=实测值（棘轮起点，只降不升）：t1 门路 1（seed 3005341179
// villa-complex 门链全败）、t1 断头 16、t3 断头 7/锐角 4、扎堆 t1 2/t3 1、桥头 t1 5/t10 3——调参集（2_000_000_000 系）上限不泛化的直接证据；逐项修复后归零回落。
if (sampleSet !== "tuning") for (const { tier, seeds } of selectedTiers) {
  const ceiling = { ...CEILING, ...(TIER_CEILING[tier] ?? {}) };
  const islands = new Map(CONSTRAINTS.map((c) => [c.id, []]));
  for (let i = 0; i < seeds; i += 1) {
    const seed = ACCEPT_BASE + i * 104_729;
    const began = Date.now();
    if (progress) console.error(`City acceptance: start ${seed}/t${tier} (${i + 1}/${seeds})`);
    const plan = createCityPlan(seed, tier, MIAMI_COASTAL);
    for (const c of CONSTRAINTS) if (c.measure(plan).length) islands.get(c.id).push(seed);
    if (progress) console.error(`City acceptance: done ${seed}/t${tier} ${Date.now() - began}ms`);
  }
  const problems = [];
  for (const c of CONSTRAINTS) {
    const n = islands.get(c.id).length;
    const accCeil = c.id in ACCEPT_CEILING ? ACCEPT_CEILING[c.id] : (ceiling[c.id] ?? 0);
    if (n > accCeil) problems.push(`tier ${tier} ${c.id}: ${n}/${seeds} (acceptance ceiling ${accCeil}) e.g. ${islands.get(c.id).slice(0, 2).join(", ")}`);
  }
  assert.equal(problems.length, 0, `INDEPENDENT ACCEPTANCE SET regressed (overfitting signal):\n  ${problems.join("\n  ")}`);
  const residual = [...islands].map(([id, l]) => `${id} ${l.length}`).filter((x) => !x.endsWith(" 0")).join(", ");
  acceptance.push(`t${tier}: ${residual || "clean"}`);
  if (progress) console.error(`City acceptance: passed ${acceptance.at(-1)}`);
}
if (sampleSet !== "tuning") console.log(`City acceptance (independent seeds, never used for tuning): ${acceptance.join(" | ")}.`);
if (sampleSet !== "acceptance") for (const { tier, seeds } of selectedTiers) {
  const ceiling = { ...CEILING, ...(TIER_CEILING[tier] ?? {}) };
  const islands = new Map(CONSTRAINTS.map((c) => [c.id, []]));
  let scoreSum = 0;
  for (let i = 0; i < seeds; i += 1) {
    const seed = 2_000_000_000 + i * 104_729; // 与回归样本（1703294958 + i*7919）错开
    const began = Date.now();
    if (progress) console.error(`City survey: start ${seed}/t${tier} (${i + 1}/${seeds})`);
    const plan = createCityPlan(seed, tier, MIAMI_COASTAL);
    scoreSum += scorePlan(plan);
    for (const c of CONSTRAINTS) if (c.measure(plan).length) islands.get(c.id).push(seed);
    if (progress) console.error(`City survey: done ${seed}/t${tier} ${Date.now() - began}ms`);
  }
  const problems = [];
  for (const c of CONSTRAINTS) {
    assert(c.id in CEILING, `survey ceiling missing for constraint ${c.id}`);
    const n = islands.get(c.id).length;
    if (n > ceiling[c.id]) problems.push(`tier ${tier} ${c.id}: ${n}/${seeds} islands (ceiling ${ceiling[c.id]}) e.g. seeds ${islands.get(c.id).slice(0, 3).join(", ")}`);
  }
  assert.equal(problems.length, 0, `out-of-sample planning quality regressed:\n  ${problems.join("\n  ")}`);
  const residual = [...islands].map(([id, l]) => `${id} ${l.length}`).filter((x) => !x.endsWith(" 0")).join(", ");
  summaries.push(`t${tier}(${seeds}): ${residual || "clean"}; score ${(scoreSum / seeds).toFixed(3)}`);
}
if (sampleSet !== "acceptance") console.log(`City survey: ${selectedTiers.length} tiers — ${summaries.join(" | ")} (all within ceilings).`);
