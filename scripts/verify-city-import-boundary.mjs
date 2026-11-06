#!/usr/bin/env node
// 城市引擎 import 边界守卫（docs/CITY_PLANNER_REFACTOR_SPEC.md §4 R2）。
// CITY_ARCHITECTURE §1 声称依赖方向由守卫钉住，但此前 scripts/ 里并没有。
// R1 拆掉 planner/* <-> cityPlan 的值环之后，若没有守卫，下一次顺手的 import 就会把环接回去，
// 而且不会有任何测试变红（类型检查与哈希基线都看不见 import 方向）。
//
// 只看「值导入」：import type / `{ type X }` 全是类型的导入 / export type 编译后不存在，不构成运行时依赖，
// 不会引发环或把 three 拖进生成器；`export … from` 是值再导出，算边。
// 用真正的 AST（@babel/parser + typescript 插件）而不是正则：多行导入、注释里的 "import"、
// 字符串里的 from 都会骗过正则，守卫误报或漏报都会让人不再信它。
//
// 用法：node scripts/verify-city-import-boundary.mjs [srcRoot]
// srcRoot 默认 apps/agent-city/ui/src；可指向历史提交解出的副本，用来证明守卫有牙齿
// （411606a1 上规则 1、2 必须失败）。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repo, "apps/agent-city/ui/package.json"));
// 注意：本仓 typescript 是 7.x（原生实现），没有 JS 版 createSourceFile；改用 @babel/parser 的 TS AST
// （vite 的 react 插件已经把它装进来了，不新增依赖）。
const { parse } = require("@babel/parser");
const srcRoot = path.resolve(process.argv[2] ?? path.join(repo, "apps/agent-city/ui/src"));
const engine = path.join(srcRoot, "engine");
if (!fs.existsSync(engine)) throw new Error(`engine/ not found under ${srcRoot}`);

// 规则 4 的白名单：编辑器（engine/plan[A-Z]*.ts 与 planRepair/）当前对 engine/planner/ 的全部值导入。
// 实测目前为空——编辑器只在注释里提到 planner/constraints.ts（planRoadRules.ts 的路口夹角下限改用渲染层的 CHANNEL_T_GAP，不再同步）。
// 这是「当前允许的表面」：要新增就必须在这里显式加一行 "导入方文件 -> planner 内目标文件" 并说明理由
// （R3 计划让 planRoadRules 导入 constraints.ts 的阈值常量，到时在此登记）。
const EDITOR_PLANNER_WHITELIST = new Set([
  // "engine/planRoadRules.ts -> engine/planner/constraints.ts",  // R3 落地后启用
]);

// 规则 3 的既有违例（棘轮）：只许减不许增；清掉某条后若不从这里删除也失败（防止白名单悄悄变成死配置）。
// 已清零：原 6 条（models/ 里四个地标 drawX、landmarkMaterials 值导入 three，registry 值导入 render/buildingCompiler）
// 随「three 依赖的造型构建代码移到 render/」一并消除——render/landmarks/{twinTowers,twistTower,villaComplex,suspensionBridge}.ts、
// render/landmarkMaterials.ts、render/landmarkBuilders.ts（LANDMARK_BUILDERS 从 models/registry.ts 迁出）。
const KNOWN_RULE3_VIOLATIONS = new Set([
]);

const rel = (f) => path.relative(srcRoot, f).split(path.sep).join("/");

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(f); }
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) files.push(f);
  }
})(srcRoot);
const fileSet = new Set(files);

const resolveRel = (from, spec) => {
  const b = path.resolve(path.dirname(from), spec);
  return [b, b + ".ts", b + ".tsx", path.join(b, "index.ts"), path.join(b, "index.tsx")].find((x) => fileSet.has(x));
};

// 返回某文件的值导入：[{ spec, target? }]，target 为解析到的仓内文件（相对导入才有）。
function valueImports(file) {
  const ast = parse(fs.readFileSync(file, "utf8"), { sourceType: "module", plugins: ["typescript", "jsx"] });
  const out = [];
  for (const st of ast.program.body) {
    let spec;
    if (st.type === "ImportDeclaration") {
      if (st.importKind === "type") continue;
      // `import { type A, type B } from` 整条都是类型 -> 编译后消失；`import {} from` / 副作用导入仍是值。
      if (st.specifiers.length > 0 && st.specifiers.every((s) => s.type === "ImportSpecifier" && s.importKind === "type")) continue;
      spec = st.source.value;
    } else if (st.type === "ExportNamedDeclaration" && st.source) {
      if (st.exportKind === "type") continue;
      if (st.specifiers.length > 0 && st.specifiers.every((s) => s.exportKind === "type")) continue;
      spec = st.source.value;
    } else if (st.type === "ExportAllDeclaration") {
      if (st.exportKind === "type") continue;
      spec = st.source.value;
    } else continue;
    out.push({ spec, target: spec.startsWith(".") ? resolveRel(file, spec) : undefined });
  }
  return out;
}

const graph = new Map(files.map((f) => [f, valueImports(f)]));
const failures = [];
const fail = (rule, msg) => failures.push(`规则 ${rule}: ${msg}`);

const inDir = (f, dir) => rel(f).startsWith(dir);
const isEngine = (f) => inDir(f, "engine/");
const isRenderOrSystems = (f) => inDir(f, "engine/render/") || inDir(f, "engine/systems/");

// 规则 1：engine/ 去掉 render/ systems/ 后无值层面环（Tarjan 强连通分量，大小 >1 或自环）。
{
  const nodes = files.filter((f) => isEngine(f) && !isRenderOrSystems(f));
  const set = new Set(nodes);
  const adj = new Map(nodes.map((f) => [f, new Set(graph.get(f).map((i) => i.target).filter((t) => t && set.has(t)))]));
  let idx = 0;
  const stack = [], on = new Set(), ix = new Map(), low = new Map(), cycles = [];
  const visit = (v) => {
    ix.set(v, idx); low.set(v, idx); idx++; stack.push(v); on.add(v);
    for (const w of adj.get(v)) {
      if (!ix.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), ix.get(w)));
    }
    if (low.get(v) === ix.get(v)) {
      const comp = []; let w;
      do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1 || adj.get(v).has(v)) cycles.push(comp);
    }
  };
  for (const f of nodes) if (!ix.has(f)) visit(f);
  for (const c of cycles) fail(1, `值层面循环（${c.length} 个模块）: ${c.map(rel).sort().join(", ")}`);
}

// 规则 2：planner/* 不得值导入 cityPlan.ts / cityLayout.ts（依赖方向只能是 cityPlan -> planner）。
const forbiddenUp = new Set(["engine/cityPlan.ts", "engine/cityLayout.ts"]);
for (const f of files.filter((f) => inDir(f, "engine/planner/")))
  for (const i of graph.get(f)) if (i.target && forbiddenUp.has(rel(i.target)))
    fail(2, `${rel(f)} 值导入 ${rel(i.target)}`);

// 规则 3：L1–L3（planner/、cityLayout、cityPlan、models/）不得值导入 three、render/、systems/。
const lowLayer = (f) => inDir(f, "engine/planner/") || inDir(f, "engine/models/") || ["engine/cityLayout.ts", "engine/cityPlan.ts"].includes(rel(f));
const seen3 = new Set();
const rule3 = (msg) => {
  if (KNOWN_RULE3_VIOLATIONS.has(msg)) seen3.add(msg);
  else fail(3, msg);
};
for (const f of files.filter(lowLayer))
  for (const i of graph.get(f)) {
    if (i.spec === "three" || i.spec.startsWith("three/")) rule3(`${rel(f)} 值导入 ${i.spec}`);
    else if (i.target && isRenderOrSystems(i.target)) rule3(`${rel(f)} 值导入 ${rel(i.target)}`);
  }
// 只在检查完整源码树时才做「陈旧条目」检查（指向历史副本时 models/ 可能不同）。
for (const k of KNOWN_RULE3_VIOLATIONS) if (!seen3.has(k) && !process.argv[2]) fail(3, `已清掉的既有违例仍留在 KNOWN_RULE3_VIOLATIONS: ${k}`);

// 规则 4：编辑器对 planner/ 的值导入只能走白名单。
// 编辑器 = engine/plan[A-Z]*.ts（注意 planner/ 目录本身不算，它以小写 n 开头）与 planRepair/（engine/ 下或 src 顶层）。
const isEditor = (f) => /^engine\/plan[A-Z][^/]*\.tsx?$/.test(rel(f)) || /^(engine\/)?planRepair\//.test(rel(f));
for (const f of files.filter(isEditor))
  for (const i of graph.get(f)) if (i.target && inDir(i.target, "engine/planner/")) {
    const key = `${rel(f)} -> ${rel(i.target)}`;
    if (!EDITOR_PLANNER_WHITELIST.has(key)) fail(4, `${key} 不在白名单内`);
  }

if (failures.length) {
  console.error(failures.join("\n"));
  console.error(`City import boundary: FAILED (${failures.length} violation(s)).`);
  process.exit(1);
}
console.log(`City import boundary: passed (${files.length} modules; no value cycles, planner never imports cityPlan/cityLayout, L1-L3 free of three/render/systems except ${seen3.size} known models/ entries, editor->planner whitelist = ${EDITOR_PLANNER_WHITELIST.size}).`);
