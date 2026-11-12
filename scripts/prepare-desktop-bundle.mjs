#!/usr/bin/env node
import { runNpm } from "./run-npm.mjs";

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { buildOfficialPlugins } from "./official-plugins.mjs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const authoritySource = readFileSync(path.join(repo, "crates/agent-vitals-data/src/authority.rs"), "utf8");
const expectedSchema = authoritySource.match(/pub const SCHEMA_VERSION: i64 = (\d+);/)?.[1];
if (!expectedSchema) throw new Error("Cannot read authority schema version from source");

runNpm(["--prefix", "apps/desktop/ui-dev", "run", "build:react"], {
  cwd: repo,
  stdio: "inherit",
});

// 官方插件（creator-studio）依赖 workspace 包 `@agent-vitals/city-sdk`，它的
// `main` 指向 `dist/index.js`；不先构建会得到 Vite 的 "Failed to resolve entry
// for package @agent-vitals/city-sdk"（Windows CI 实测）。这里在任何插件构建
// 之前把 SDK 装好并构建，保证本地与 CI 同一条路径。
{
  const citySdk = path.join(repo, "packages/agent-vitals-city-sdk");
  if (existsSync(path.join(citySdk, "package.json"))) {
    runNpm(["ci"], { cwd: citySdk, stdio: "inherit" });
    runNpm(["run", "build"], { cwd: citySdk, stdio: "inherit" });
  }
}

// creator-studio 直接引用 agent-city 的视口源码，Rollup 会从源文件目录
// （apps/agent-city/ui）向上解析依赖。CI 的 fresh checkout 里那里没有
// node_modules，于是 three / mp4-muxer 等逐个解析失败。先把 city 的依赖装好，
// 后续插件构建共享这棵树；buildOfficialPlugins 仍会各自 npm ci。
{
  const cityUi = path.join(repo, "apps/agent-city/ui");
  if (existsSync(path.join(cityUi, "package.json"))) {
    runNpm(["ci"], { cwd: cityUi, stdio: "inherit" });
  }
}

{
  const probe = process.env.AGENT_VITALS_PLUGIN_ISOLATION_PROBE === "1";
  buildOfficialPlugins({ install: true, probe });
}

execFileSync("cargo", ["build", "--release", "-p", "agent-vitals"], {
  cwd: repo,
  stdio: "inherit",
});

const binary = path.join(repo, "target/release", process.platform === "win32" ? "agent-vitals.exe" : "agent-vitals");
const info = JSON.parse(execFileSync(binary, ["--build-info"], { encoding: "utf8" }));
if (String(info.authority_schema) !== expectedSchema) {
  throw new Error(`Bundled CLI schema v${info.authority_schema ?? "unknown"} differs from source v${expectedSchema}`);
}
console.log(`Bundled CLI ready: authority schema v${expectedSchema}`);
