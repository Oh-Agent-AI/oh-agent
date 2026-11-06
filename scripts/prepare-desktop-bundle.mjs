#!/usr/bin/env node
import { runNpm } from "./run-npm.mjs";

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
