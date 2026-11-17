#!/usr/bin/env node
// 产物构建（E5，spec §8.4 路径 2 / §11）：把嵌入式语义闸入口打成 IIFE 交给宿主的
// QuickJS（rquickjs）eval。校验逻辑单源不变——bundle 的输入就是 Studio webview 运行的
// 同一批 TS 模块（embeddedGate → sdkValidation / cityWorldOperations → @agent-vitals/
// city-sdk），没有任何源码复制或打包期改写（W1 spike 的 `\-` 补丁已随 city-sdk 上游
// 修复而移除，见 spike §2 的预告）。
//
// 产物契约（写进 bundle.lock.json，Rust 侧守卫测试钉住）：
//   - bundle 字节 sha256（改任何输入都必须重跑本脚本并重新提交 lockfile）；
//   - gate 版本 / SDK 版本 / 入口源文件摘要；
//   - 引擎标识（rquickjs / Bellard QuickJS）。
//
// 用法：
//   node apps/desktop/src-tauri/embedded_city_sdk/build.mjs            # 重新生成并写盘
//   node apps/desktop/src-tauri/embedded_city_sdk/build.mjs --check    # CI 锁步：与磁盘逐字节比较
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const ENTRY = resolve(REPO_ROOT, "apps/creator-studio/ui/src/embeddedGate.ts");
const OUT = resolve(HERE, "city-sdk-gate.iife.js");
const LOCK = resolve(HERE, "bundle.lock.json");
const SDK_PACKAGE = resolve(REPO_ROOT, "packages/agent-vitals-city-sdk/package.json");

// esbuild 从 city-sdk 的 node_modules 解析（桌面工程自身没有 node_modules；
// 版本与 city-sdk 构建链一致，避免第二份构建器版本）。
const require = createRequire(resolve(REPO_ROOT, "packages/agent-vitals-city-sdk/package.json"));
const esbuild = require("esbuild");
const check = process.argv.includes("--check");

const sha256Hex = bytes => createHash("sha256").update(bytes).digest("hex");

const result = await esbuild.build({
  entryPoints: [ENTRY],
  bundle: true,
  format: "iife",
  platform: "neutral",
  target: "es2022",
  minify: false,
  legalComments: "none",
  outfile: OUT,
  write: !check,
  logLevel: "warning",
});

if (result.warnings.length > 0) {
  console.error("esbuild reported warnings; refusing to refresh the lockfile so drift stays visible.");
  process.exit(1);
}

const bundle = check ? result.outputFiles[0].text : readFileSync(OUT, "utf8");
for (const banned of ["require(", "process.", "Buffer", "__dirname"]) {
  if (bundle.includes(banned)) {
    console.error(`bundle carries Node-only marker "${banned}"; platform=neutral purity is broken.`);
    process.exit(1);
  }
}
if (!bundle.includes("citySdkGate")) {
  console.error("bundle does not register the citySdkGate global.");
  process.exit(1);
}

const entrySources = {
  "embeddedGate.ts": sha256Hex(readFileSync(ENTRY)),
  "sdkValidation.ts": sha256Hex(readFileSync(resolve(REPO_ROOT, "apps/creator-studio/ui/src/sdkValidation.ts"))),
  "cityWorldOperations.ts": sha256Hex(readFileSync(resolve(REPO_ROOT, "apps/creator-studio/ui/src/cityWorldOperations.ts"))),
};
const sdk = JSON.parse(readFileSync(SDK_PACKAGE, "utf8"));
const lock = {
  schemaVersion: 1,
  bundle: "city-sdk-gate.iife.js",
  bundleSha256: sha256Hex(bundle),
  bundleBytes: Buffer.byteLength(bundle, "utf8"),
  gateVersion: 1,
  sdkPackage: sdk.name,
  sdkVersion: sdk.version,
  engine: "rquickjs (Bellard QuickJS, embedded in agent-vitals-menubar)",
  entrySources,
  regenerate: "node apps/desktop/src-tauri/embedded_city_sdk/build.mjs",
};
const lockBody = `${JSON.stringify(lock, null, 2)}\n`;
if (check) {
  const currentBundle = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  const currentLock = existsSync(LOCK) ? readFileSync(LOCK, "utf8") : "";
  if (currentBundle !== bundle || currentLock !== lockBody) {
    console.error("embedded gate bundle is stale: rerun `node apps/desktop/src-tauri/embedded_city_sdk/build.mjs` and commit the bundle + lockfile.");
    process.exit(1);
  }
  console.log(`embedded gate bundle up to date (${lock.bundleBytes} B sha256:${lock.bundleSha256.slice(0, 12)}…)`);
  process.exit(0);
}
mkdirSync(HERE, { recursive: true });
writeFileSync(LOCK, lockBody);
console.log(`bundle ${lock.bundleBytes} B sha256:${lock.bundleSha256.slice(0, 12)}… → ${OUT}`);
console.log(`lockfile → ${LOCK}`);
