#!/usr/bin/env node
// City i18n 目录守卫（CITY_DATA_LEGIBILITY_SPEC F7）：插件 UI 以中文原文为键查英文目录（i18n.tsx english），
// 中文措辞一改，英文就静默丢失——没有编译期或运行期报错（实测：F5 改了导出说明，英文立刻失配）。
// 本守卫：抽出 .tsx 里所有含中文的字符串字面量与 JSX 文本，逐条确认目录里有英文（或命中 cityText 的模式规则）。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(repo, "apps/agent-city/ui/src");
const i18n = fs.readFileSync(path.join(src, "i18n.tsx"), "utf8");
const catalogBody = i18n.slice(i18n.indexOf("const english"), i18n.indexOf("};", i18n.indexOf("const english")));
const keys = new Set([...catalogBody.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map((m) => JSON.parse(`"${m[1]}"`)));
// 游戏模式有自己的文案目录（game/gameCopy.ts，zh 为键 → en）：与主目录同等对待。
const gameCopy = fs.readFileSync(path.join(src, "game/gameCopy.ts"), "utf8");
const gameBody = gameCopy.slice(gameCopy.indexOf("const ENGLISH"), gameCopy.indexOf("};", gameCopy.indexOf("const ENGLISH")));
for (const m of gameBody.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)) keys.add(JSON.parse(`"${m[1]}"`));
// cityText 里的模式规则（数字前缀/后缀类）：命中这些模式的字面量片段视为已覆盖。
const patterns = [/^ 天$/, /^取消导出 · $/, /^ 个会话，一座城市$/, /^ 个会话$/, /^ 个城区 · 已载入的 token · 非费用账单$/, /^本机真实数据/];
const cjk = /[㐀-鿿]/;
const cityTextBody = i18n.slice(i18n.indexOf("export function cityText"), i18n.indexOf("export function cityView"));
// engine/cityDecor.ts 是非会话建筑说明面板的文案源（cityView 渲染时查表）：曾不在扫描范围内，文案改了两轮目录都没跟上。
const files = [...fs.readdirSync(src).filter((f) => f.endsWith(".tsx") && f !== "i18n.tsx"), "engine/cityDecor.ts", "cityCatalog.ts",
  ...fs.readdirSync(path.join(src, "game")).filter((f) => f.endsWith(".tsx")).map((f) => `game/${f}`)];
const missing = [];
for (const file of files) {
  const text = fs.readFileSync(path.join(src, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"); // 去注释
  const found = new Set();
  for (const m of text.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) if (cjk.test(m[1])) found.add(m[1]);
  for (const m of text.matchAll(/>([^<>{}\n]*[㐀-鿿][^<>{}\n]*)</g)) found.add(m[1].trim());
  for (const s of found) {
    if (keys.has(s) || patterns.some((p) => p.test(s))) continue;
    // cityText 函数体里 .replace() 链逐段翻译的片段（「本机真实数据 · 窗口内会话 …」）也算已覆盖。
    if (cityTextBody.includes(`"${s}"`)) continue;
    // 就地按语言二选一（pluginLocale() === "en" ? "…" : "中文"）的字面量自带英文，不走目录。
    if (text.includes(`: "${s}"`) && /=== "en" \? "[^"]*" : "/.test(text.slice(Math.max(0, text.indexOf(`: "${s}"`) - 200), text.indexOf(`: "${s}"`) + 3))) continue;
    missing.push(`${file}: ${s}`);
  }
}
assert.equal(missing.length, 0, `Chinese UI strings without an English catalog entry:\n  ${missing.join("\n  ")}`);
console.log(`City i18n catalog: ${keys.size} entries; every Chinese UI string in ${files.length} files has English.`);
