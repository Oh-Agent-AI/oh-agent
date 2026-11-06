#!/usr/bin/env node
// 构建 Agent City 插件产物并灌入落地页：
//   node tools/build-city3d.mjs
// 前提：apps/agent-city/ui 已存在（codex/app-layer-city 落地后）。
// 产物 website/landing/city3d/ 为自托管静态文件（three 已打包、同源加载、
// 无第三方请求）；缺失时落地页保留产品截图并显示明确的重试说明。
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
// Allow a clean main snapshot as source while preserving local landing edits.
const sourceArg = process.argv.find((arg) => arg.startsWith("--source-root="));
const sourceRoot = sourceArg ? resolve(sourceArg.slice("--source-root=".length)) : root;
const src = join(sourceRoot, "apps/agent-city/ui");
const dist = join(src, "dist");
const target = join(root, "website/landing/city3d");

if (!existsSync(join(src, "package.json"))) {
  console.error(`[city3d] ${src} 不存在——agent-city 插件应用尚未落地（codex/app-layer-city 合入后重跑）。`);
  process.exit(1);
}
if (!process.argv.includes("--skip-install")) {
  console.log("[city3d] installing deps (apps/agent-city/ui)…");
  execSync("npm ci --no-audit --no-fund", { cwd: src, stdio: "inherit" });
}
console.log("[city3d] building…");
execSync("npm run build", { cwd: src, stdio: "inherit" });
if (!existsSync(dist)) {
  console.error("[city3d] build 未产出 dist/；检查 vite 配置。");
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(dist, target, { recursive: true });

const sizeOf = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
  const full = join(dir, entry.name);
  return total + (entry.isDirectory() ? sizeOf(full) : statSync(full).size);
}, 0);
console.log(`[city3d] copied → website/landing/city3d (${(sizeOf(target) / 1024 / 1024).toFixed(2)} MB)`);
console.log("[city3d] done. Oh Agent 桌面首屏自动运行 mock 城市；窄屏点击进入，缺失产物时保留预览和重试说明。");
