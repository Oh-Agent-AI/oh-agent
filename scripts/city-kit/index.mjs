// City 守卫公共加载器（CITY_ARCHITECTURE §6 / 迁移步 1「测试提速」）。
//
// 旧做法：每个守卫用 esbuild 打包后放进 vm.runInNewContext 执行，并各自重新生成同一批岛。
// 实测 vm 沙箱里的规划比原生慢约 8 倍（tier 10 单岛原生 1.5 s、vm 内 12 s），完整 verify:city 要 25–30 分钟。
// 新做法：打包一次写成 ESM 临时文件、原生 import；规划结果按 (seed, tier, profile) 在进程内缓存，
// 同一进程里跑只读守卫时共享（scripts/verify-city-suite.mjs）。
//
// 只读约定：缓存返回同一对象，守卫不得修改它；plan 含函数，不能直接 structuredClone。
// 需要修改的测试独立生成或用显式数据副本；确定性与跨引擎检查不经过此缓存。
// 跨引擎守卫（V8 vs JavaScriptCore）仍走自己的 vm/jsc 路径，不用本加载器。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const citySrc = path.join(repo, "apps/agent-city/ui/src");
const { buildSync } = createRequire(path.join(repo, "apps/desktop/ui-dev/package.json"))("esbuild");

const loaded = new Map();
const provenance = new WeakMap();
const stats = { loads: 0, loadHits: 0, planHits: 0, planGenerations: 0, generationMs: 0, slowest: [] };
export const kitStats = () => ({ ...stats, slowest: [...stats.slowest], cachedPlans: plans.size, rssBytes: process.memoryUsage().rss });

// Content, not commit/branch identity: uncommitted source changes also invalidate.
// Include all City sources conservatively, plus loader and dependency locks.
function sourceFingerprint() {
  const hash = crypto.createHash("sha256");
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(ts|tsx|js|json)$/.test(entry.name)) hash.update(path.relative(repo, file)).update(fs.readFileSync(file));
    }
  };
  visit(citySrc);
  for (const relative of ["scripts/city-kit/index.mjs", "apps/agent-city/ui/package-lock.json", "apps/desktop/ui-dev/package-lock.json"]) {
    const file = path.join(repo, relative);
    if (fs.existsSync(file)) hash.update(relative).update(fs.readFileSync(file));
  }
  return hash.update(process.version).update(process.platform).update(process.arch).digest("hex");
}

/** 按 { 导出名: 相对 src 的模块路径 } 打包并原生加载；同一组导出只打包一次。 */
export async function loadCity(exportsByModule) {
  const lines = Object.entries(exportsByModule)
    // "pkg:three" = 包名，其余是相对 src 的模块路径。
    .map(([module, names]) => `export ${names.length === 1 && names[0].startsWith("* as ") ? names[0] : `{ ${names.join(", ")} }`} from ${JSON.stringify(module.startsWith("pkg:") ? module.slice(4) : path.join(citySrc, module))};`)
    .join("\n");
  const fingerprint = sourceFingerprint();
  const key = crypto.createHash("sha256").update(lines).update(fingerprint).digest("hex");
  if (loaded.has(key)) { stats.loadHits++; return loaded.get(key); }
  const out = buildSync({ stdin: { contents: lines, resolveDir: citySrc }, bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" });
  const dir = path.join(os.tmpdir(), "agent-city-kit");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${key}-${process.pid}.mjs`);
  fs.writeFileSync(file, out.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  for (const [name, value] of Object.entries(mod)) {
    const owner = Object.entries(exportsByModule).find(([, names]) => names.includes(name))?.[0];
    if (typeof value === "function" && owner) provenance.set(value, fingerprint + ":" + owner + ":" + name);
  }
  stats.loads++;
  loaded.set(key, mod);
  return mod;
}

const plans = new Map();
const planDigest = (plan) => crypto.createHash("sha256").update(JSON.stringify(plan, (_k, v) =>
  v instanceof Map ? { map: [...v] } : v instanceof Set ? { set: [...v] } : v)).digest("hex");
export const snapshotCachedPlans = () => new Map([...plans].map(([key, plan]) => [key, { plan, digest: planDigest(plan) }]));
export function assertCachedPlansUnchanged(snapshot) {
  // Keep references even if a stage evicts a plan from the bounded cache.
  for (const { plan, digest } of snapshot.values())
    if (planDigest(plan) !== digest) throw new Error("Read-only City guard mutated a shared cached plan");
}
const factoryIds = new WeakMap();
let nextFactoryId = 1;
function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  throw new Error("City plan cache accepts only finite JSON configuration values");
}
/** createCityPlan 的进程内缓存（只读结果）。内容相同的配置及不同导出包共享同版工厂的结果。
 *  测「同输入两次生成必须相等」这类确定性断言的守卫要直接调用原函数，不能走缓存。 */
export function cachedPlan(createCityPlan, seed, tier, config, opts = {}) {
  if (!factoryIds.has(createCityPlan)) factoryIds.set(createCityPlan, nextFactoryId++);
  const factory = provenance.get(createCityPlan) ?? "custom:" + factoryIds.get(createCityPlan);
  const key = canonical([factory, seed, tier, config ?? null, opts]);
  if (process.env.CITY_KIT_NO_CACHE !== "1" && plans.has(key)) {
    const plan = plans.get(key);
    plans.delete(key); plans.set(key, plan); // bounded LRU
    stats.planHits++;
    return plan;
  }
  const began = performance.now();
  const plan = createCityPlan(seed, tier, config, opts); // failed calls never cached
  const elapsed = performance.now() - began;
  stats.planGenerations++; stats.generationMs += elapsed;
  stats.slowest.push({ seed, tier, durationMs: Math.round(elapsed), radiusAttempts: plan.radiusAttempts ?? null });
  stats.slowest.sort((a, b) => b.durationMs - a.durationMs); stats.slowest.length = Math.min(10, stats.slowest.length);
  if (process.env.CITY_KIT_NO_CACHE !== "1") {
    plans.set(key, plan);
    while (plans.size > 64) plans.delete(plans.keys().next().value);
  }
  return plan;
}
