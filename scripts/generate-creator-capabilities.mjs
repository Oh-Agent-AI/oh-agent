#!/usr/bin/env node
// Creator 能力描述符/模板生成器（设计文档 AGENT_CREATOR_RUST_BOUNDARY_OPTIMIZATION §5.1.2）。
// 从 city-sdk 的唯一来源常量导出 canonical JSON 到 assets/creator/*；
// Rust include_str! 与 MCP 消费生成产物，改内容只改 SDK 常量 + 重新生成。
// --check：重新生成并与磁盘字节比较，不一致退出码 1（CI 锁步门禁）。
// 运行：node --experimental-transform-types scripts/generate-creator-capabilities.mjs [--check]
// SDK 源码内部使用无扩展名相对导入（tsc moduleResolution=Bundler），这里注册与
// mecha-ts-register 相同的解析钩子后动态加载，保持 SDK 常量仍是唯一组合来源。
import { register } from "node:module";
register("./mecha-ts-hook.mjs", import.meta.url);
const { CREATOR_CAPABILITIES_V1, CREATOR_WORLDS_V1 } = await import("../packages/agent-vitals-city-sdk/src/creatorCapabilities.ts");
const { CREATOR_TEMPLATES_V1 } = await import("../packages/agent-vitals-city-sdk/src/creatorTemplates.ts");
const { CREATOR_VEHICLE_CATALOG_V1 } = await import("../packages/agent-vitals-city-sdk/src/vehicleProfile.ts");
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "assets", "creator");
// canonical JSON：键排序（嵌套递归）、2 空格缩进、末尾换行——与 generate-app-contracts 同规。
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};
const render = (value) => JSON.stringify(canonical(value), null, 2) + "\n";

const capabilities = render(CREATOR_CAPABILITIES_V1);
// 世界参数目录（世界多样化规格 §2.1/§5.1）：同一生成链单独成文件，Rust 在
// creator.city.edit.preview 的 world.set 结构校验里 include_str! 消费；
// 生成物只读，语义校验仍以 city-sdk 的 validateWorldParametersV1 为准。
const files = new Map([["capabilities.json", capabilities], ["worlds.json", render(CREATOR_WORLDS_V1)],
  // 车辆目录（2026-11-15 泛化切片）：preset/物理边界/相机默认公式的单一来源，
  // MCP creator_vehicle_list、宿主结构上限与相机派生都消费这一份生成产物。
  ["vehicles.json", render(CREATOR_VEHICLE_CATALOG_V1)]]);
for (const template of CREATOR_TEMPLATES_V1) {
  files.set(path.join("templates", `${template.id}.json`), render({ schemaVersion: 1, templateId: template.id, label: template.label, gameType: template.gameType, pack: template.pack }));
}
// 模板索引：Rust/MCP 只 include_str! 这一个文件；新增模板 = SDK 常量 + 重新生成，
// 不再需要手工在 Rust 注册表里加一行（设计 §1.3 / DoD）。gameType 随模板冻结，
// 发布用它决定 release 的 gameType / runtime 契约（creator_projects.rs 消费）。
files.set("templates-index.json", render({ schemaVersion: 1, templates: CREATOR_TEMPLATES_V1.map(({ id, label, gameType, pack }) => ({ id, label, gameType, pack })) }));

const check = process.argv.includes("--check");
let drift = false;
for (const [relative, content] of files) {
  const target = path.join(outDir, relative);
  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  if (check) {
    if (existing !== content) {
      console.error(`creator capabilities drift: ${relative}`);
      drift = true;
    }
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    console.log(`wrote ${path.relative(root, target)} (${content.length} chars)`);
  }
}
if (drift) {
  console.error("Run `node --experimental-transform-types scripts/generate-creator-capabilities.mjs` to regenerate.");
  process.exit(1);
}
console.log(`creator capabilities ${check ? "check passed" : "generated"} (${files.size} files)`);
