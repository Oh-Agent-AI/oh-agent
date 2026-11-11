#!/usr/bin/env node
// City i18n 目录守卫（CITY_DATA_LEGIBILITY_SPEC F7）：插件 UI 以中文原文为键查英文目录（i18n.tsx english），
// 中文措辞一改，英文就静默丢失——没有编译期或运行期报错（实测：F5 改了导出说明，英文立刻失配）。
// 本守卫：抽出 .tsx 里所有含中文的字符串字面量与 JSX 文本，逐条确认目录里有英文（或命中 cityText 的模式规则）。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(repo, "apps/agent-city/ui/src");
const require = createRequire(path.join(repo, "apps/agent-city/ui/package.json"));
const { parse } = require("@babel/parser");
const i18n = fs.readFileSync(path.join(src, "i18n.tsx"), "utf8");
const catalogBody = i18n.slice(i18n.indexOf("const english"), i18n.indexOf("};", i18n.indexOf("const english")));
const keys = new Set([...catalogBody.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map((m) => JSON.parse(`"${m[1]}"`)));
// JSXText is normalized by React, while catalog keys may intentionally retain
// edge spaces for string composition (for example "Building · ").
const normalizedKeys = new Set([...keys].map((key) => key.trim()));
// 游戏模式有自己的文案目录（game/gameCopy.ts，zh 为键 → en）：与主目录同等对待。
const gameCopy = fs.readFileSync(path.join(src, "game/gameCopy.ts"), "utf8");
const gameBody = gameCopy.slice(gameCopy.indexOf("const ENGLISH"), gameCopy.indexOf("};", gameCopy.indexOf("const ENGLISH")));
for (const m of gameBody.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)) {
  const key = JSON.parse(`"${m[1]}"`); keys.add(key); normalizedKeys.add(key.trim());
}
// cityText 里的模式规则（数字前缀/后缀类）：命中这些模式的字面量片段视为已覆盖。
const patterns = [/^ 天$/, /^取消导出 · $/, /^ 个会话，一座城市$/, /^ 个会话$/, /^ 个城区 · 已载入的 token · 非费用账单$/, /^本机真实数据/];
const cjk = /[㐀-鿿]/;
const cityTextBody = i18n.slice(i18n.indexOf("export function cityText"), i18n.indexOf("export function cityView"));
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function hasInlineEnglish(source, value) {
  const literal = escapeRegExp(JSON.stringify(value));
  const english = `(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`;
  return new RegExp(`(?:\\ben\\b|(?:locale|language)\\s*===\\s*["']en["'])\\s*\\?\\s*${english}\\s*:\\s*${literal}`).test(source)
    || new RegExp(`\\b(?:text|label|t)\\s*\\(\\s*${literal}\\s*,\\s*${english}`).test(source)
    || new RegExp(`\\[\\s*${literal}\\s*,\\s*${english}\\s*\\]`).test(source)
    || new RegExp(`\\ben\\s*\\?\\s*\\{[^}]*\\}\\s*:\\s*\\{[^}]*${literal}[^}]*\\}`, "s").test(source);
}
const children = (node) => Object.values(node).flatMap((value) => Array.isArray(value)
  ? value.filter((entry) => entry && typeof entry.type === "string")
  : value && typeof value.type === "string" ? [value] : []);
const propName = (prop) => prop?.type === "ObjectProperty"
  ? prop.key.type === "Identifier" ? prop.key.name : String(prop.key.value) : null;
const hasEnglishLeaf = (node) => node?.type === "StringLiteral" ? !cjk.test(node.value)
  : Boolean(node && children(node).some(hasEnglishLeaf));
function leaves(node, path = "", out = new Map()) {
  if (node?.type === "StringLiteral") out.set(path, node);
  else if (node?.type === "ObjectExpression") for (const prop of node.properties) {
    const key = propName(prop); if (key !== null) leaves(prop.value, `${path}.${key}`, out);
  }
  else if (node?.type === "ArrayExpression") node.elements.forEach((item, i) => leaves(item, `${path}.${i}`, out));
  return out;
}
function localizedOffsets(ast) {
  const offsets = new Set();
  const visit = (node, ancestors = []) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "ObjectExpression") {
      const props = new Map(node.properties.map((prop) => [propName(prop), prop.value]));
      const zh = props.get("zh-Hans") ?? props.get("zh"), en = props.get("en");
      if (zh && en) {
        const english = leaves(en);
        for (const [key, value] of leaves(zh)) if (english.has(key) && !cjk.test(english.get(key).value)) offsets.add(value.start);
      }
    }
    if (node.type === "ArrayExpression" && node.elements[0]?.type === "StringLiteral"
        && cjk.test(node.elements[0].value) && node.elements[1]?.type === "StringLiteral"
        && !cjk.test(node.elements[1].value)) offsets.add(node.elements[0].start);
    if (node.type === "CallExpression" && node.arguments[0]?.type === "StringLiteral"
        && cjk.test(node.arguments[0].value) && hasEnglishLeaf(node.arguments[1])) offsets.add(node.arguments[0].start);
    if (node.type === "StringLiteral" && cjk.test(node.value)) for (const parent of ancestors) {
      if (parent.type !== "ConditionalExpression") continue;
      const test = parent.test;
      const languageTest = test.type === "Identifier" && ["en", "isEnglish"].includes(test.name)
        || test.type === "BinaryExpression" && ["===", "=="].includes(test.operator)
          && [test.left, test.right].some((part) => part.type === "StringLiteral" && ["en", "zh", "zh-Hans"].includes(part.value));
      const inConsequent = parent.consequent === node || ancestors.includes(parent.consequent);
      const inAlternate = parent.alternate === node || ancestors.includes(parent.alternate);
      if (languageTest && ((inConsequent && hasEnglishLeaf(parent.alternate)) || (inAlternate && hasEnglishLeaf(parent.consequent)))) offsets.add(node.start);
    }
    const next = [...ancestors, node];
    for (const child of children(node)) visit(child, next);
  };
  visit(ast);
  return offsets;
}
// engine/cityDecor.ts 是非会话建筑说明面板的文案源（cityView 渲染时查表）：曾不在扫描范围内，文案改了两轮目录都没跟上。
const files = [...fs.readdirSync(src).filter((f) => f.endsWith(".tsx") && f !== "i18n.tsx"), "engine/cityDecor.ts", "cityCatalog.ts",
  ...fs.readdirSync(path.join(src, "game")).filter((f) => f.endsWith(".tsx")).map((f) => `game/${f}`)];
const missing = [];
for (const file of files) {
  const text = fs.readFileSync(path.join(src, file), "utf8");
  const ast = parse(text, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const localized = localizedOffsets(ast);
  const found = new Map();
  const collect = (node) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "StringLiteral" && cjk.test(node.value)) found.set(node.start, node.value);
    if (node.type === "JSXText" && cjk.test(node.value.trim())) found.set(node.start, node.value.trim());
    for (const child of children(node)) collect(child);
  };
  collect(ast);
  for (const [offset, s] of found) {
    if (keys.has(s) || normalizedKeys.has(s.trim()) || patterns.some((p) => p.test(s))) continue;
    if (localized.has(offset)) continue;
    // cityText 函数体里 .replace() 链逐段翻译的片段（「本机真实数据 · 窗口内会话 …」）也算已覆盖。
    if (cityTextBody.includes(`"${s}"`)) continue;
    // 就地按语言二选一（pluginLocale() === "en" ? "…" : "中文"）的字面量自带英文，不走目录。
    if (hasInlineEnglish(text, s)) continue;
    missing.push(`${file}: ${s}`);
  }
}
assert.equal(missing.length, 0, `Chinese UI strings without an English catalog entry:\n  ${missing.join("\n  ")}`);
console.log(`City i18n catalog: ${keys.size} entries; every Chinese UI string in ${files.length} files has English.`);
