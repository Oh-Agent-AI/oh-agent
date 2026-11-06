#!/usr/bin/env node
// 回放起点守卫：开始回放 / 拖时间轴是「时间跳变」，城市必须直接是那一刻的样子。
// 曾经：从实时（所有楼 display=1）点播放，目标变成「还没开工 = 0」，但 display 只按每帧 1.35/s 追赶——
// 整座城先站着、约 4 秒内慢慢缩下去，回放看起来就不是从第一栋楼开始。
//   (a) replayStartMs 取第一栋楼自己的开工时刻，不取整到当天 0 点（默认每秒 1 小时下最多白等 24 秒）；
//   (b) applyCursor 设目标后 snapToTargets(true) 让每栋楼立即对齐：起点那一刻没有已建成的楼，
//       起点之后只有已开工的楼；
//   (c) snapToTargets() 不带 all 时保持旧行为（还在长入的新楼不被打断）。
//   node scripts/verify-city-replay-snap.mjs
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
import { installCanvasShim } from "./city-kit/scene-hash.mjs";

installCanvasShim();
globalThis.window ??= globalThis;
globalThis.devicePixelRatio ??= 1;

const { buildCityModel, layoutCity, CityParts, MIAMI_COASTAL, replayStartMs } = await loadCity({
  "cityModel.ts": ["buildCityModel"],
  "engine/cityLayout.ts": ["layoutCity"],
  "engine/cityParts.ts": ["CityParts"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "replayRange.ts": ["replayStartMs"],
});

const GENERATED_AT = Date.UTC(2026, 9, 7, 12, 0, 0);
const DAY = 86_400_000;
// 14 天里每天一栋会话楼；最早一栋在 14 天前的 07:20。
const rows = Array.from({ length: 14 }, (_, i) => {
  const start = GENERATED_AT - (14 - i) * DAY + (i === 0 ? -4 * 3_600_000 : 0);
  return {
    session_ref: `session:${i}`, harness: ["codex", "claude-code"][i % 2],
    first_event_at: new Date(start).toISOString(), last_event_at: new Date(start + 40 * 60_000).toISOString(),
    event_count: 20, model_ids: ["m"], peak_tokens: 40_000 + i * 1000,
    tokens: { uncached_input_tokens: 20_000, cache_read_tokens: 10_000, cache_write_tokens: 0, output_tokens: 10_000 + i * 1000, total: 40_000 + i * 1000 },
    cost_minor: null, cost_status: { state: "unavailable", reason: "x", has_unresolved: true },
  };
});
const from = GENERATED_AT - 30 * DAY;

// (a)
const earliest = Math.min(...rows.map((row) => Date.parse(row.first_event_at)));
const start = replayStartMs(rows.map((row) => ({ first_event_at: row.first_event_at })), from, GENERATED_AT);
assert.equal(start, earliest, "replay starts at the first session building's own start, not that day's midnight");

const model = buildCityModel({ rows, findings: [], windowStartMs: start, windowEndMs: GENERATED_AT, windowLabel: "30d", totalSessions: rows.length, truncated: false, generatedAt: GENERATED_AT });
const layout = layoutCity(model, null, undefined, MIAMI_COASTAL);
const parts = new CityParts(model, layout, null);
const shown = () => parts.runtimes.filter((runtime) => runtime.display > 0.05).length;

// 实时：全部楼已建成。
parts.applyCursor(GENERATED_AT, true);
parts.snapToTargets(true);
assert.equal(shown(), parts.runtimes.length, "live: every building stands");

// (b) 回放起点：跳到第一栋楼开工那一刻——对齐前楼还都站着（旧行为的症状），对齐后一栋已建成的都没有。
parts.applyCursor(start, false, 3_600_000);
assert.equal(shown(), parts.runtimes.length, "before snapping the display still chases (this is the symptom)");
parts.snapToTargets(true);
assert.ok(shown() <= 1, `at the replay start no building is already standing (${shown()} shown)`);
assert.ok(parts.runtimes.every((runtime) => runtime.settled), "snapped runtimes are settled");

// 拖到中间：只有已开工的楼。
const middle = start + 7 * DAY;
parts.applyCursor(middle, false, 3_600_000);
parts.snapToTargets(true);
const started = parts.runtimes.filter((runtime) => runtime.building.startedAt <= middle).length;
assert.ok(started > 0 && started < parts.runtimes.length);
assert.equal(shown(), parts.runtimes.filter((runtime) => runtime.display > 0.05).length);
assert.ok(parts.runtimes.every((runtime) => (runtime.building.startedAt > middle) === (runtime.display <= 0.05) || runtime.display > 0), "only buildings started by the cursor are up");
assert.ok(parts.runtimes.filter((runtime) => runtime.building.startedAt > middle).every((runtime) => runtime.display <= 0.05), "buildings not started yet are down");

// (c) 不带 all：还没落定的楼保持原状。
const unsettled = parts.runtimes[0];
unsettled.settled = false; unsettled.display = 0.5; unsettled.target = 1;
parts.snapToTargets();
assert.equal(unsettled.display, 0.5, "snapToTargets() without all leaves growing buildings alone");
parts.snapToTargets(true);
assert.equal(unsettled.display, 1, "…and with all it snaps them");
parts.dispose?.();
console.log(`City replay snap: replay starts at the first building (${new Date(start).toISOString()}), time jumps align all ${parts.runtimes.length} buildings to the cursor at once, plain snapToTargets keeps growing buildings.`);
