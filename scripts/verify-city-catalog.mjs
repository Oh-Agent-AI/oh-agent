#!/usr/bin/env node
// 建筑模型总登记表守卫（apps/agent-city/ui/src/cityCatalog.ts）：City 的每类建模建筑集中登记在一张表里，
// 「建筑说明」面板与「查看实时模型」都以它为准。这里钉住三件事，防止表、缩略图、取景点三者脱节：
// 每条 id 唯一、缩略图文件存在（且登记在 LICENSES.md）、CityEngine.catalogTarget 有同名分支。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(repo, "apps/agent-city/ui/src");
const catalog = fs.readFileSync(path.join(src, "cityCatalog.ts"), "utf8");
const engine = fs.readFileSync(path.join(src, "engine/CityEngine.ts"), "utf8");
const licenses = fs.readFileSync(path.join(src, "assets/LICENSES.md"), "utf8");

const imports = new Map([...catalog.matchAll(/import (\w+) from "\.\/assets\/(catalog\/[\w-]+\.jpg)";/g)].map((m) => [m[1], m[2]]));
const entries = [...catalog.matchAll(/\{ id: "([\w-]+)", group: "[^"]+", image: (\w+),/g)].map((m) => ({ id: m[1], image: m[2] }));
assert(entries.length >= 20, `catalog has only ${entries.length} entries`);
assert.equal(new Set(entries.map((e) => e.id)).size, entries.length, "catalog ids must be unique");
const branch = (id) => new RegExp(`(^|[\\s{,])(${id}|"${id}"):\\s*\\(\\)\\s*=>`, "m").test(engine);
for (const { id, image } of entries) {
  const file = imports.get(image);
  assert(file, `${id}: image ${image} is not imported from assets/catalog`);
  assert(fs.existsSync(path.join(src, "assets", file)), `${id}: ${file} missing`);
  assert(licenses.includes(`\`${file}\``), `${id}: ${file} not listed in LICENSES.md`);
  assert(branch(id), `${id}: CityEngine.catalogTarget has no branch for this id`);
}
console.log(`City catalog: ${entries.length} building models registered, each with a thumbnail and a live-view target, passed.`);
