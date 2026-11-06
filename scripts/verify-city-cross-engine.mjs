#!/usr/bin/env node
// 跨 JS 引擎确定性守卫（docs/CITY_ROAD_SIMULATION_ANALYSIS.md §2）：同一份 createCityPlan 在 V8（本守卫进程）
// 与 JavaScriptCore（App 的 WKWebView 引擎，macOS 自带 jsc）里必须产出逐字节相同的布局摘要。
// 修复前 30/30 不同——其余 City 守卫验证的是 V8 的城市，不是用户看到的城市。无 jsc 的平台（Linux CI）报告跳过。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ui = path.join(repo, "apps/desktop/ui-dev");
const engine = path.join(repo, "apps/agent-city/ui/src/engine");
const jsc = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc";
const { buildSync } = createRequire(path.join(ui, "package.json"))("esbuild");
// Focused regression does not replace the default thirty-layout gate.
const cases = process.env.CITY_CROSS_ENGINE_PASSAGE === "1" ? [{ tier: 3, i: 0, seed: 4000104729 }]
  : [1, 2, 5].flatMap(tier => Array.from({ length: 10 }, (_, i) => ({ tier, i, seed: 1703294958 + i * 7919 })));
const entry = `
import { createCityPlan } from ${JSON.stringify(path.join(engine, "cityPlan.ts"))};
import { MIAMI_COASTAL } from ${JSON.stringify(path.join(engine, "citySeaside.ts"))};
import { CONSTRAINTS } from ${JSON.stringify(path.join(engine, "planner/constraints.ts"))};
import { diagnoseNetwork } from ${JSON.stringify(path.join(engine, "planner/intent.ts"))};
const fnv = (t) => { let h = 0x811c9dc5; for (let i = 0; i < t.length; i += 1) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); };
const out = [];
for (const { tier, i, seed } of ${JSON.stringify(cases)}) {
  const trace = typeof process !== "undefined" && process.env.CITY_VERIFY_PROGRESS === "1";
  if (trace) console.error("City cross-engine V8: start " + tier + "/" + i);
  const plan = createCityPlan(seed, tier, MIAMI_COASTAL);
  const constraintCounts = Object.fromEntries(CONSTRAINTS.map(c => [c.id, c.measure(plan).length]));
  const unmet = diagnoseNetwork(plan)?.unmet ?? null;
  if (trace) console.error("City cross-engine V8: done " + tier + "/" + i + " R=" + plan.islandRadius + " attempts=" + plan.radiusAttempts + " edges=" + plan.roadEdges.length
    + " capacity=" + plan.capacity.available + "/" + plan.capacity.required + " nonzero=" + JSON.stringify(Object.fromEntries(Object.entries(constraintCounts).filter(([_, count]) => count)))
    + " unmet=" + JSON.stringify(unmet));
  const shape = JSON.stringify({
    roads: plan.roadEdges.map((e) => [e.id, e.width, e.kind, !!e.bridge, e.structure ?? null, e.purpose ?? null, e.points.map((p) => [p.x, p.z])]),
    blocks: plan.blocks.map((b) => [b.id, b.parcels.map((p) => [p.id, p.x, p.z, p.yaw])]),
    sites: [...plan.publicSites, ...plan.landmarks].map((s) => [s.kind, s.x, s.z, s.yaw, s.radius, s.access ?? null]),
    primaryAnchorNodeId: plan.primaryAnchorNodeId,
    siteObligations: plan.siteObligations,
    demandCatalogue: plan.demandCatalogue,
    solveReport: plan.solveReport,
    skeletonDiagnostics: plan.skeletonDiagnostics,
    skeletonReservationIds: plan.skeletonReservationIds,
    radiusHistory: plan.radiusHistory,
    capacity: plan.capacity,
    parcelGeneration: plan.parcelGeneration,
    constraintCounts,
    unmet,
  });
  out.push(tier + "/" + i + ":" + fnv(shape));
}
const line = out.join(" ");
if (typeof print === "function") print(line); else console.log(line);
`;
const bundle = buildSync({ stdin: { contents: entry, resolveDir: engine, loader: "ts" }, bundle: true, write: false, format: "iife", platform: "neutral", logLevel: "silent" }).outputFiles[0].text;
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "city-xengine-")), "plan.js");
fs.writeFileSync(file, bundle);
const v8 = execFileSync(process.execPath, [file], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
if (!fs.existsSync(jsc)) {
  console.log("City cross-engine: skipped (no JavaScriptCore shell on this platform).");
} else {
  const core = execFileSync(jsc, [file], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
  const a = v8.split(" "); const b = core.split(" ");
  const differing = a.filter((digest, i) => digest !== b[i]);
  assert.equal(differing.length, 0, `V8 and JavaScriptCore produced different layouts for ${differing.length}/${a.length} seeds: ${differing.slice(0, 5).join(" ")}`);
  console.log(`City cross-engine: ${a.length} layouts identical in V8 and JavaScriptCore passed.`);
}
