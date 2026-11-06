#!/usr/bin/env node
// 整座城场景图基线（CITY_ARCHITECTURE 迁移步 2/3）：用固定的合成数据 → layoutCity → new CityParts → 取整棵场景图的哈希，
// 与 golden/city-scene-baseline.json 比较。拆分 cityParts（CITY_ENGINE_SPLIT_SPEC）是「纯搬迁」，每一步前后哈希必须相等——
// 这是比「截图逐像素等价」更强、且不需要 GPU 的验收。输出里按顶层 group/mesh 名分区哈希，能指出是哪一块变了。
//   node scripts/verify-city-scene-baseline.mjs [--diff|--update]
// 范围：日夜两态（setNightGlow 0 / 1）× 两个岛档（380 与 1600 会话）。贴图内容不进哈希（Node 里画布是空替身）。
// 时间相关量固定：生成时间 generatedAt 与回放游标写死，不读墙钟。
// 时区钉死：天气与天光按本机时区算当地时刻（engine/environment/WeatherState.ts 默认取 getTimezoneOffset），
// 屋顶/竖井/实例网格的哈希随之变。基线是在 +0800 机器上冻结的，UTC 的 CI/云端容器上同一份代码恒失配
// （2026-10-19 实测：连冻结它的 929921c3 自身都过不了）。Node 运行时改 TZ 即生效；须在建场景之前设置。
process.env.TZ = "Asia/Shanghai";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadCity, repo } from "./city-kit/index.mjs";
import { installCanvasShim, sceneDescriptor } from "./city-kit/scene-hash.mjs";

installCanvasShim();
// CityParts 的构造器会读 document/window 的少量全局：给最小替身。
globalThis.window ??= globalThis;
globalThis.devicePixelRatio ??= 1;

const { THREE, buildCityModel, layoutCity, CityParts, MIAMI_COASTAL } = await loadCity({
  "pkg:three": ["* as THREE"],
  "cityModel.ts": ["buildCityModel"],
  "engine/cityLayout.ts": ["layoutCity"],
  "engine/cityParts.ts": ["CityParts"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
});
const goldenPath = path.join(repo, "golden/city-scene-baseline.json");

const HARNESSES = ["codex", "claude-code", "dsh", "harness:zcode"];
const GENERATED_AT = Date.UTC(2026, 9, 7, 12, 0, 0);
function rows(count) {
  // 线性同余的固定伪随机：同一 count 恒同数据。
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

function buildScene(count, night) {
  const model = buildCityModel({ rows: rows(count), findings: [], windowStartMs: GENERATED_AT - 30 * 86_400_000, windowEndMs: GENERATED_AT, windowLabel: "30d", totalSessions: count, truncated: false, generatedAt: GENERATED_AT });
  const layout = layoutCity(model, null, undefined, MIAMI_COASTAL);
  const parts = new CityParts(model, layout, null);
  parts.setNightGlow(night);
  parts.applySelfLit(0.24);
  return parts;
}

/** 按「最近的有名字的祖先」分区；无名字的节点向下找到有名字的后代，再不行才记成 <类型>@<序号>。
 *  同名多个合并后排序，使分区哈希不依赖子节点顺序。 */
function sectionHashes(parts) {
  const sections = new Map();
  const add = (key, node) => sections.set(key, [...(sections.get(key) ?? []), ...sceneDescriptor(THREE, node)]);
  const visit = (node, inherited, path) => {
    const name = node.name || inherited;
    if (node.isMesh || node.isSprite || node.isInstancedMesh) { add(name || `unnamed:${node.type}`, node); return; }
    node.children.forEach((child, i) => visit(child, name, `${path}/${i}`));
  };
  // 注意：sceneDescriptor 对单个 Mesh 取世界矩阵——先整体更新一次世界矩阵。
  parts.group.updateMatrixWorld(true);
  parts.group.children.forEach((child, i) => visit(child, "", `${i}`));
  const out = {};
  for (const [key, list] of [...sections].sort(([a], [b]) => (a < b ? -1 : 1))) {
    list.sort();
    out[key] = `${list.length}:${crypto.createHash("sha1").update(list.join("\n")).digest("hex").slice(0, 12)}`;
  }
  return out;
}

const current = {};
for (const count of [380, 1600]) {
  for (const [label, night] of [["day", 0.05], ["night", 1]]) {
    const parts = buildScene(count, night);
    const sec = sectionHashes(parts);
    current[`${count}/${label}`] = { all: crypto.createHash("sha1").update(JSON.stringify(sec)).digest("hex").slice(0, 16), sections: sec };
    parts.dispose?.();
  }
}

if (process.argv.includes("--update")) {
  fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
  fs.writeFileSync(goldenPath, `${JSON.stringify(current, null, 1)}\n`);
  console.log(`City scene baseline: rewrote ${Object.keys(current).length} scene hashes (${Object.values(current).reduce((n, v) => n + Object.keys(v.sections).length, 0)} sections).`);
  process.exit(0);
}
assert(fs.existsSync(goldenPath), "golden/city-scene-baseline.json missing — run with --update once and review");
const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
const problems = [];
for (const key of Object.keys(current)) {
  if (golden[key]?.all === current[key].all) continue;
  const g = golden[key]?.sections ?? {}; const c = current[key].sections;
  const diff = [...new Set([...Object.keys(g), ...Object.keys(c)])].filter((s) => g[s] !== c[s]).map((s) => `${s} (${g[s] ?? "—"} → ${c[s] ?? "—"})`);
  problems.push(`${key}: ${diff.join("; ")}`);
}
if (problems.length) assert.fail(`scene graph changed:\n  ${problems.join("\n  ")}`);
console.log(`City scene baseline: ${Object.keys(current).length} whole-city scene graphs (380/1600 sessions × day/night) match golden/city-scene-baseline.json.`);
