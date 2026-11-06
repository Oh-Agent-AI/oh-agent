#!/usr/bin/env node
// planner/constraints.ts 自检（CITY_ARCHITECTURE §2）：每条约束返回数组、id 唯一、
// 且覆盖 verify-city-context / verify-city-planning 用到的全部约束 id。
import assert from "node:assert/strict";
import fs from "node:fs";
import { cachedPlan, loadCity, repo } from "./city-kit/index.mjs";

const { createCityPlan: rawPlan, MIAMI_COASTAL, CONSTRAINTS } = await loadCity({
  "engine/cityPlan.ts": ["createCityPlan"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "engine/planner/constraints.ts": ["CONSTRAINTS"],
});
const ids = CONSTRAINTS.map((c) => c.id);
assert.equal(new Set(ids).size, ids.length, "constraint ids must be unique");
for (const c of CONSTRAINTS) assert(c.description && typeof c.measure === "function", `${c.id} needs description + measure`);

// 守卫里引用的约束 id（字符串字面量或 byId.X）必须都在 CONSTRAINTS 里；凡出现在守卫源码里的已知 id 计为「被使用」。
const used = new Set();
const referenced = new Set();
for (const f of ["verify-city-context.mjs", "verify-city-planning.mjs"]) {
  const src = fs.readFileSync(`${repo}/scripts/${f}`, "utf8");
  for (const m of src.matchAll(/byId\.(\w+)/g)) referenced.add(m[1]);
  for (const m of src.matchAll(/(?:push|byId\[)\([^")]*"(\w+)"/g)) referenced.add(m[1]);
  for (const id of ids) if (src.includes(`"${id}"`) || src.includes(`byId.${id}`)) used.add(id);
}
for (const id of referenced) assert(ids.includes(id), `guard uses unknown constraint ${id}`);
assert(used.size >= 10, `expected guards to use most constraints, found ${used.size}`);

let violations = 0;
for (const [tier, i] of [[1, 0], [2, 3], [5, 7]]) {
  const plan = cachedPlan(rawPlan, 1703294958 + i * 7919, tier, MIAMI_COASTAL);
  for (const c of CONSTRAINTS) {
    const out = c.measure(plan);
    assert(Array.isArray(out), `${c.id} must return an array`);
    for (const x of out) { assert.equal(x.constraint, c.id, `${c.id} violation carries its id`); assert.equal(typeof x.detail, "string"); }
    violations += out.length;
  }
}
console.log(`City constraints: ${CONSTRAINTS.length} constraints, ids unique, ${used.size} used by guards, 3 islands measured (${violations} violations observed).`);
