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
import crypto from "node:crypto";
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

// ── Code Game 模板目录（PR12 统一创作模板目录 §6.1）────────────────────
// games/<id>/template.json 是 Code Game 模板目录的唯一人工维护碎片（极小，只写
// 创作入口元数据）。生成器扫描碎片、与 game.manifest.json 交叉核对（displayName/
// version/世界兼容能力），渲染到两个消费面：
//   assets/creator/code-templates-index.json —— Rust include_str!（MCP 模板 allow
//     list 与 creator_template_list 的数据源）
//   packages/agent-vitals-city-sdk/src/creatorCodeTemplates.generated.ts —— TS/UI 面
// 目录条目只是创作入口元数据，不是可执行授权：真正创建仍走 creator_code_project_create，
// 由宿主校验模板 provenance/manifest 存在性与路径边界。
//
// 模板源摘要配方（source.digest，与 MCP creator_code_workspace 的 digest_workspace
// 同构）：sha256("oh-agent-code-template-v1" + Σ 按相对路径字节序排序的每个文件
// [len_be_u64(relPath) + relPath + len_be_u64(bytes) + bytes])。文件集为
// games/<id>/ 下全部普通文件（跳过 node_modules/dist/.git 目录；template.json
// 本身计入）。任何模板内容变化都会改变 digest，索引随 assets 一起提交。
const CODE_TEMPLATE_SKIPPED_DIRS = new Set(["node_modules", "dist", ".git"]);
const lengthPrefix = (length) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(length));
  return buffer;
};
function collectTemplateFiles(directory, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!CODE_TEMPLATE_SKIPPED_DIRS.has(entry.name)) {
        files.push(...collectTemplateFiles(path.join(directory, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name));
      }
    } else if (entry.isFile()) {
      files.push({ relative: prefix ? `${prefix}/${entry.name}` : entry.name, absolute: path.join(directory, entry.name) });
    }
  }
  return files;
}
function templateSourceDigest(directory) {
  const files = collectTemplateFiles(directory).sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
  const hasher = crypto.createHash("sha256");
  hasher.update("oh-agent-code-template-v1");
  for (const file of files) {
    const key = Buffer.from(file.relative, "utf8");
    const bytes = fs.readFileSync(file.absolute);
    hasher.update(lengthPrefix(key.length));
    hasher.update(key);
    hasher.update(lengthPrefix(bytes.length));
    hasher.update(bytes);
  }
  return `sha256:${hasher.digest("hex")}`;
}
function boundedText(value, field, max) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`games/*/template.json: ${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}
function codeTemplateCatalog() {
  const gamesDir = path.join(root, "games");
  const catalog = [];
  for (const entry of fs.readdirSync(gamesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(gamesDir, entry.name);
    const fragmentPath = path.join(directory, "template.json");
    if (!fs.existsSync(fragmentPath)) continue;
    const fragment = JSON.parse(fs.readFileSync(fragmentPath, "utf8"));
    if (typeof fragment !== "object" || fragment === null || Array.isArray(fragment)) {
      throw new Error(`${fragmentPath} must be a JSON object`);
    }
    const allowed = new Set(["schemaVersion", "templateId", "version", "name", "description", "runtime", "genre", "tags", "license"]);
    for (const key of Object.keys(fragment)) {
      if (!allowed.has(key)) throw new Error(`${fragmentPath}: unknown field ${key} (closed vocabulary)`);
    }
    if (fragment.schemaVersion !== 1) throw new Error(`${fragmentPath}: schemaVersion must be 1`);
    if (fragment.templateId !== entry.name) throw new Error(`${fragmentPath}: templateId must equal the directory name (${entry.name})`);
    if (fragment.runtime !== "code") throw new Error(`${fragmentPath}: runtime must be "code"`);
    const manifestPath = path.join(directory, "game.manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.kind !== "code-game") throw new Error(`${manifestPath}: kind must be code-game`);
    if (typeof manifest.gameId !== "string" || manifest.gameId.length === 0) throw new Error(`${manifestPath}: gameId must be a non-empty string`);
    // 碎片与 manifest 同源核对：目录元数据不允许和可安装模板各说各话。
    if (fragment.name !== manifest.displayName) throw new Error(`${fragmentPath}: name must equal the manifest displayName`);
    if (fragment.version !== manifest.version) throw new Error(`${fragmentPath}: version must equal the manifest version`);
    const requiredCapabilities = manifest?.world?.requiredCapabilities;
    if (!Array.isArray(requiredCapabilities) || requiredCapabilities.length === 0 || requiredCapabilities.length > 8
      || requiredCapabilities.some(capability => typeof capability !== "string" || capability.length === 0 || capability.length > 64)) {
      throw new Error(`${manifestPath}: world.requiredCapabilities must be 1..8 non-empty strings`);
    }
    const tests = collectTemplateFiles(path.join(directory, "tests")).map(file => `games/${entry.name}/tests/${path.basename(file.relative)}`)
      .filter(name => name.endsWith(".test.ts"))
      .sort();
    if (tests.length === 0) throw new Error(`${fragmentPath}: template must carry at least one tests/*.test.ts`);
    catalog.push({
      templateId: boundedText(fragment.templateId, "templateId", 64),
      version: boundedText(fragment.version, "version", 32),
      name: boundedText(fragment.name, "name", 80),
      description: boundedText(fragment.description, "description", 400),
      runtime: "code",
      genre: boundedText(fragment.genre, "genre", 32),
      tags: Array.isArray(fragment.tags) && fragment.tags.length <= 8
        ? fragment.tags.map(tag => boundedText(tag, "tags[]", 32)) : (() => { throw new Error(`${fragmentPath}: tags must be an array of at most 8 strings`); })(),
      source: { digest: templateSourceDigest(directory), entry: `games/${entry.name}` },
      compatibility: { requiredCapabilities },
      license: boundedText(fragment.license, "license", 64),
      tests,
    });
  }
  if (catalog.length === 0) throw new Error("no games/*/template.json fragments found; a Code Game template registry must not be silently empty");
  catalog.sort((a, b) => (a.templateId < b.templateId ? -1 : a.templateId > b.templateId ? 1 : 0));
  for (let index = 1; index < catalog.length; index += 1) {
    if (catalog[index].templateId === catalog[index - 1].templateId) {
      throw new Error(`duplicate code template id ${catalog[index].templateId}`);
    }
  }
  return catalog;
}
const codeTemplates = codeTemplateCatalog();
files.set("code-templates-index.json", render({ schemaVersion: 1, templates: codeTemplates }));
// TS 面：与 JSON 同一份数据，UI/TS 消费者走 SDK 的既有 import 约定（勿手改）。
files.set(path.join(root, "packages/agent-vitals-city-sdk/src/creatorCodeTemplates.generated.ts"), `// 由 scripts/generate-creator-capabilities.mjs 生成（PR12 统一创作模板目录）。
// 数据源：games/<id>/template.json（人工维护碎片）+ game.manifest.json 的 world
// 兼容性。不要手改本文件——改碎片后重新生成；Rust 消费同一份数据
// （assets/creator/code-templates-index.json，include_str!）。
export type CreatorCodeTemplateV1 = Readonly<{
  templateId: string;
  version: string;
  name: string;
  description: string;
  runtime: "code";
  genre: string;
  tags: readonly string[];
  source: Readonly<{ digest: string; entry: string }>;
  compatibility: Readonly<{ requiredCapabilities: readonly string[] }>;
  license: string;
  tests: readonly string[];
}>;

export const CREATOR_CODE_TEMPLATES_V1: readonly CreatorCodeTemplateV1[] = ${JSON.stringify(codeTemplates, null, 2)};
`);

const check = process.argv.includes("--check");
let drift = false;
for (const [relative, content] of files) {
  const target = path.isAbsolute(relative) ? relative : path.join(outDir, relative);
  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  if (check) {
    if (existing !== content) {
      console.error(`creator capabilities drift: ${path.relative(root, target)}`);
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
