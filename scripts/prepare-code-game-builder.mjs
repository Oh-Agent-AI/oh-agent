import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const target = path.join(repo, "apps/desktop/src-tauri/code-game");
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.join(target, "bin"), { recursive: true });
const nodeName = process.platform === "win32" ? "node.exe" : "node";
fs.copyFileSync(process.execPath, path.join(target, "bin", nodeName));
// PR12 统一创作模板目录：打包携带所有注册的 Code Game 模板（模板 allow list 的
// 数据源是生成索引 assets/creator/code-templates-index.json；索引缺失时回退
// games/hello-city，保持本脚本在极端场景下仍可独立运行）。
let codeTemplateEntries = ["games/hello-city"];
try {
  const index = JSON.parse(fs.readFileSync(path.join(repo, "assets/creator/code-templates-index.json"), "utf8"));
  const entries = index.templates.map(template => template.source?.entry).filter(Boolean);
  if (entries.length > 0) codeTemplateEntries = entries;
} catch { /* 生成器尚未运行：回退 hello-city。 */ }
for (const directory of ["packages/city-game-sdk", "packages/agent-vitals-city-sdk", ...codeTemplateEntries, "scripts/mecha-ts-register.mjs", "scripts/mecha-ts-hook.mjs"]) {
  const source = path.join(repo, directory);
  const destination = path.join(target, directory);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, dereference: true });
}
const linkedCitySdk = path.join(target, "packages/city-game-sdk/node_modules/@oh-agent/city-sdk");
fs.rmSync(linkedCitySdk, { recursive: true, force: true });
fs.cpSync(path.join(repo, "packages/agent-vitals-city-sdk"), linkedCitySdk, { recursive: true, dereference: true });

console.log(`Code Game builder ready: ${target}`);
