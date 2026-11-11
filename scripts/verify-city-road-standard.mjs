#!/usr/bin/env node
// 道路标准表（engine/roadStandard.ts；docs/CITY_WORLD_PRECISION_AND_SIZE_STANDARD_SPEC.md §2–§4）。
// 标准 API 与源码边界；默认另跑 15 座规划城 + 3 座海滨布局 + 10 座完整布局。
// --unit 仅用于开发时快速检查 API/源码；CI 与 full suite 默认执行全部城市。
// 补丁入口/存档重放拒绝非标宽度由 verify-plan-patch.mjs 检查。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCity, cachedPlan } from "./city-kit/index.mjs";
const S = await loadCity({ "engine/roadStandard.ts": ["ROAD_CLASSES", "roadClassSpec", "roadClassOfWidth", "isStandardRoadWidth", "atLeast", "kindOfWidth", "roadWidthFor", "isStandardEdge", "EXPRESSWAY_DECK_WIDTH"] });

assert.deepEqual(S.ROAD_CLASSES.map((c) => [c.id, c.width, c.kind, c.repairType]), [["local", 5, "local", "local"], ["collector", 8, "arterial", "secondary"], ["arterial", 12, "arterial", "main"]]);
assert.ok(S.ROAD_CLASSES.every((c) => c.sidewalk === 1.8 && c.maxGrade === null && c.bridgeTransition === null && c.maxBridgeSkewDeg === null && c.label.zh && c.label.en), "phase-two fields stay null until measured");
assert.ok(Object.isFrozen(S.ROAD_CLASSES) && S.ROAD_CLASSES.every(Object.isFrozen), "the table is frozen");
assert.throws(() => { S.ROAD_CLASSES[0].width = 6; });
for (const c of S.ROAD_CLASSES) { assert.equal(S.roadClassOfWidth(c.width), c.id); assert.equal(S.roadClassOfWidth(c.width + 1e-12), c.id, "JSON round-trip noise absorbed"); assert.equal(S.roadWidthFor(c.id), c.width); }
for (const w of [0, 4.2, 6, 10, 10.5, 12.5, 24]) { assert.equal(S.roadClassOfWidth(w), null, `${w} is not a standard width`); assert.equal(S.isStandardRoadWidth(w), false); }
assert.throws(() => S.roadClassSpec("boulevard"));
// atLeast / kindOfWidth 与它们替换掉的区间判断在任何宽度上都给同一答案（迁移不改结果的前提）。
for (const w of [0, 4.2, 5, 6, 8, 10, 10.5, 12, 13, 24]) {
  assert.equal(S.atLeast({ width: w }, "collector"), w >= 8, `atLeast collector ≡ width >= 8 at ${w}`);
  assert.equal(S.atLeast({ width: w }, "arterial"), w >= 12, `atLeast arterial ≡ width >= 12 at ${w}`);
  assert.equal(S.atLeast({ width: w }, "local"), w >= 5);
  assert.equal(S.kindOfWidth(w), w >= 8 ? "arterial" : "local", `kindOfWidth ≡ width >= 8 ? arterial : local at ${w}`);
}
assert.ok(S.isStandardEdge({ width: 8, kind: "arterial" }) && S.isStandardEdge({ width: 5, kind: "local" }) && !S.isStandardEdge({ width: 8, kind: "local" }) && !S.isStandardEdge({ width: 10, kind: "arterial" }));
assert.equal(S.EXPRESSWAY_DECK_WIDTH, 10.5);
console.log("City road standard: three classes 5/8/12 with kinds, strict reverse lookup, atLeast/kindOfWidth equal to the range checks they replace, frozen table.");

// AST boundary guard: ignore comments, distinguish property names from prose, and
// catch both comparisons and new defaults/properties. Parcel/site sizes are separate.
const root = fileURLToPath(new URL("../apps/agent-city/ui/src/", import.meta.url));
const require = createRequire(new URL("../apps/agent-city/ui/package.json", import.meta.url));
const { parse } = require("@babel/parser");
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []);
const files = [...walk(path.join(root, "engine")), ...walk(path.join(root, "planRepair"))]
  .filter((f) => !f.includes(`${path.sep}models${path.sep}`) && !/[\/](roadStandard|worldScale)\.ts$/.test(f));
const violations = [];
const standardNumber = (n) => n?.type === "NumericLiteral" && [5, 8, 12, 10.5].includes(n.value);
const widthName = (n) => n?.type === "Identifier" && n.name === "width"
  || n?.type === "MemberExpression" && !n.computed && n.property.name === "width";
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const source = parse(text, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const visit = (node) => {
    if (!node || typeof node.type !== "string") return;
    if ((node.type === "BinaryExpression" && ((widthName(node.left) && standardNumber(node.right)) || (standardNumber(node.left) && widthName(node.right))))
      || (node.type === "ObjectProperty" && widthName(node.key) && standardNumber(node.value))
      || (node.type === "AssignmentPattern" && widthName(node.left) && standardNumber(node.right))
      || (node.type === "VariableDeclarator" && widthName(node.id) && standardNumber(node.init))
      || (node.type === "ConditionalExpression" && standardNumber(node.consequent) && standardNumber(node.alternate))) {
      violations.push(`${path.relative(root, file)}:${node.loc.start.line}: ${text.slice(node.start, node.end)}`);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(source);
}
assert.deepEqual(violations, [], "road width constants must come from roadStandard (site/model dimensions are not road widths)");
console.log(`Road width source boundary: ${files.length} TypeScript files checked.`);

if (!process.argv.includes("--unit")) {
  globalThis.window ??= globalThis;
  const k = await loadCity({ "engine/cityPlan.ts": ["createCityPlan"], "engine/cityLayout.ts": ["layoutCity"], "cityModel.ts": ["buildCityModel"],
    "engine/citySeaside.ts": ["MIAMI_COASTAL"], "engine/surface/structureCompiler.ts": ["bridgeDeckParts"] });
  const { sceneRows, GENERATED_AT } = await import("./city-kit/scene-parts.mjs");
  let cities = 0, edges = 0, bridges = 0, matched = 0, ends = 0;
  const mismatches = [];
  const check = (tag, layout) => {
    cities++;
    console.log(`Road standard: checking ${tag} (${layout.roadEdges.length} roads).`);
    for (const edge of layout.roadEdges) {
      assert.ok(S.isStandardEdge(edge), `${tag}: non-standard road ${edge.id} width=${edge.width} kind=${edge.kind}`); edges++;
      if (!edge.bridge) continue;
      bridges++;
      const deck = k.bridgeDeckParts(edge, layout).filter((p) => p.role === "bridge-deck");
      assert.ok(deck.length > 0, `${tag}: bridge deck exists for ${edge.id}`);
      assert.ok(deck.every((p) => p.sz === S.roadWidthFor(S.roadClassOfWidth(edge.width))), `${tag}: bridge deck and road class share full width`);
      for (const node of [edge.from, edge.to]) {
        const ground = layout.roadEdges.filter((e) => !e.bridge && (e.from === node || e.to === node));
        if (!ground.length) continue; // Island platforms have no ground-road leg to compare.
        ends++;
        if (ground.every((e) => e.width === edge.width)) matched++;
        else mismatches.push({ city: tag, bridge: edge.id, node, width: edge.width, groundWidths: ground.map((e) => e.width) });
      }
    }
  };
  for (const seed of [1, 7, 42, 2026, 65537]) for (const tier of [1, 2, 3]) check(`plan:${seed}/${tier}`, cachedPlan(k.createCityPlan, seed, tier));
  const model = (count) => k.buildCityModel({ rows: sceneRows(count), findings: [], windowStartMs: GENERATED_AT - 30 * 86400000,
    windowEndMs: GENERATED_AT, windowLabel: "30d", totalSessions: count, truncated: false, generatedAt: GENERATED_AT });
  for (const [seed, tier] of [[1703294958, 2], [1703310796, 2], [1703334553, 5]]) check(`coast:${seed}/${tier}`, k.layoutCity(model(tier * 400 - 20), null, seed, k.MIAMI_COASTAL));
  for (const count of [0, 500]) for (const seed of [1, 7, 42, 2026, 65537]) check(`layout:${count}/${seed}`, k.layoutCity(model(count), null, seed, k.MIAMI_COASTAL));
  console.log(`Road standard matrix: ${cities} cities, ${edges} roads, ${bridges} bridges; equal-width bridge/ground ends ${matched}/${ends} (report only).`);
  console.log("Mixed-width bridge junctions (diagnostic, not passability rejection): " + JSON.stringify(mismatches));
}
