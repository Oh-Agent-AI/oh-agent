import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repo, "apps/desktop/ui-dev/package.json"));
const React = require("react");
const { buildSync } = require("esbuild");
const source = buildSync({ entryPoints: [path.join(repo, "apps/agent-city/ui/src/i18n.tsx")],
  bundle: true, write: false, format: "cjs", external: ["react"],
  nodePaths: [path.join(repo, "apps/agent-city/ui/node_modules")] }).outputFiles[0].text;
const window = { __AV_PLUGIN_LOCALE__: "en" }; window.parent = window;
const module = { exports: {} };
vm.runInNewContext(source, { window, module, exports: module.exports, require, URL,
  location: { href: "http://localhost/" } });
const { cityText, cityView } = module.exports;
for (const [zh, en] of [["城市设置", "City settings"], ["执行环境城区", "Harness districts"],
  ["30 天", "30 days"], ["取消导出 · 25%", "Cancel export · 25%"],
  ["暂停回放", "Pause replay"], ["会话详情", "Session details"],
  ["当前环境没有可用的视频编码器（H.264 / VP9 / VP8），可使用拍照。", "No video encoder is available here (H.264 / VP9 / VP8). Photos remain available."]]) {
  assert.equal(cityText(zh, "en"), en);
  assert.equal(cityText(zh, "zh-Hans"), zh);
}
const translated = cityView(React.createElement("button", { "aria-label": "城市设置" }, "城市设置"), "en");
assert.equal(translated.props["aria-label"], "City settings");
assert.equal(translated.props.children, "City settings");
const excerpt = React.createElement("blockquote", null, "城市设置");
assert.equal(cityView(excerpt, "en"), excerpt, "user excerpts must never be translated");
assert.equal(cityText("用户原文，不应翻译", "en"), "用户原文，不应翻译");
console.log("City locale: passed (catalog, dynamic labels, accessibility, zh fallback, raw excerpt preservation).");
const copyCode = buildSync({ entryPoints: [path.join(repo, "apps/agent-city/ui/src/engine/cinematicCopy.ts")],
  bundle: true, write: false, format: "cjs" }).outputFiles[0].text;
const copyModule = { exports: {} };
vm.runInNewContext(copyCode, { module: copyModule, exports: copyModule.exports });
const model = { stats: { renderedSessions: 264, tokensTotal: 1234567 }, windowLabel: "最近 30 天", districts: [{}, {}] };
const title = { kind: "title", text: "", atSec: 0, untilSec: 2 };
assert.equal(copyModule.exports.cinematicCopy(model, title, "en").title, "264 sessions, one city");
assert.equal(copyModule.exports.cinematicCopy(model, title, "en").subtitle, "Last 30 days · 1,234,567 tokens");
assert.equal(copyModule.exports.cinematicCopy(model, title, "zh-Hans").title, "264 个会话，一座城市");
assert.equal(copyModule.exports.cinematicCopy(model, { ...title, kind: "district", text: "Codex", detail: "81" }, "en").subtitle, "81 sessions");
assert.equal(copyModule.exports.cinematicCopy(model, { ...title, kind: "finale" }, "en").subtitle, "2 districts · Loaded tokens · Not a bill");
console.log("Cinematic locale: passed (shared foreground/Worker copy, title, range, district, finale).");
