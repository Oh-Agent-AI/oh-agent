#!/usr/bin/env node
// 3fc7e243 的正式 Linux/Windows 包和 Mecha 构建在身份检查通过之后失败：
// Vite 从 packages/city-game-sdk/src/host/snapshotWorld.ts 解析不到
// @oh-agent/city-sdk。Node 只沿该文件的祖先目录找包，不会走进
// apps/agent-city/ui/node_modules。同一 SHA 的本地 deb 能生成，是因为打包
// 脚本在 tauri build 之前额外执行了 `npm ci --prefix packages/city-game-sdk`。
// City 快速守卫则在 esbuild 从 creator-studio 源文件解析同一包时失败，
// 而且已提交的 gate bundle 与三份入口源的 sha256 不一致。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(repo, relative), "utf8");
const sha256 = (relative) => createHash("sha256").update(readFileSync(path.join(repo, relative))).digest("hex");

const prepare = read("scripts/prepare-desktop-bundle.mjs");
const sdkBuild = prepare.indexOf('runNpm(["run", "build"]');
const gameSdk = prepare.indexOf('path.join(repo, "packages/city-game-sdk")');
const plugins = prepare.indexOf("buildOfficialPlugins(");
assert.ok(sdkBuild > 0 && gameSdk > sdkBuild && plugins > gameSdk, "city-game-sdk npm ci must follow the city-sdk build and precede official plugin builds");

const gameLock = JSON.parse(read("packages/city-game-sdk/package-lock.json"));
assert.equal(gameLock.packages["node_modules/@oh-agent/city-sdk"].link, true, "city-game-sdk installs city-sdk as a symlink, so dist must exist before consumers resolve it");

// 桌面发布契约 job 不做 npm ci。348c2917 的 run 44663023207 在 11 秒内
// 失败，是因为这里要求 node_modules 已经存在；同一 job 里原有的发布契约
// 脚本当时已经全部通过。安装是否落地由带 npm ci 的 job 验证，这里只钉源码契约。
const snapshotWorld = read("packages/city-game-sdk/src/host/snapshotWorld.ts");
assert.match(snapshotWorld, /from "@oh-agent\/city-sdk\/contracts"/);
assert.match(snapshotWorld, /from "@oh-agent\/city-sdk"/);
const linkedPackage = path.join(repo, "packages/city-game-sdk/node_modules/@oh-agent/city-sdk/package.json");
if (existsSync(linkedPackage)) {
  assert.equal(path.relative(repo, linkedPackage), path.join("packages/city-game-sdk/node_modules/@oh-agent/city-sdk/package.json"));
  assert.match(read("packages/city-game-sdk/node_modules/@oh-agent/city-sdk/dist/types/contracts.d.ts"), /interface WorldQueryV1/);
}

const workflow = read(".github/workflows/verify.yml");
function jobBody(name) {
  const marker = `name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, `missing job ${name}`);
  const rest = workflow.slice(start + marker.length);
  const next = rest.search(/\n {2}[A-Za-z0-9_]+:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}
const differential = jobBody("双实现差分");
assert.match(differential, /npm ci --prefix packages\/city-game-sdk/);
assert.match(differential, /npm run build --prefix packages\/agent-vitals-city-sdk/);
const cityGuards = jobBody("City 快速守卫");
assert.match(cityGuards, /working-directory: apps\/creator-studio\/ui\n\s+run: npm ci/);
const gameInstall = cityGuards.indexOf("working-directory: packages/city-game-sdk");
const fastSuite = cityGuards.indexOf("verify-city-suite.mjs fast");
assert.ok(gameInstall >= 0 && fastSuite > gameInstall, "City fast typecheck imports city-game-sdk and needs its city-sdk link installed first");
const gameSdkJob = jobBody("City game SDK");
assert.match(gameSdkJob, /working-directory: packages\/agent-vitals-city-sdk[\s\S]*npm run build/);
const mecha = jobBody("Mecha 战棋守卫");
assert.match(mecha, /working-directory: packages\/city-game-sdk\n\s+run: npm ci/);

const lock = JSON.parse(read("apps/desktop/src-tauri/embedded_city_sdk/bundle.lock.json"));
for (const [name, digest] of Object.entries(lock.entrySources)) {
  assert.equal(sha256(`apps/creator-studio/ui/src/${name}`), digest, `${name} drifted from the committed gate lock`);
}
assert.equal(sha256("apps/desktop/src-tauri/embedded_city_sdk/city-sdk-gate.iife.js"), lock.bundleSha256);

console.log("City SDK link prep: package install order, workflow jobs, and gate lock match the sources");
