#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { signatureContract, matchingDeveloperIdSignatures } from "./macos-signature-contract.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const defaultApp = path.join(repo, "apps/desktop/src-tauri/target/release/bundle/macos/Oh Agent.app");
const args = process.argv.slice(2);
const requireDeveloperId = args.includes("--require-developer-id");
const requiredArchitecture = args.find((arg) => arg.startsWith("--require-architecture="))
  ?.slice("--require-architecture=".length);
const app = path.resolve(args.find((arg) => !arg.startsWith("--")) || defaultApp);

function fail(message) { console.error(`FAIL ${message}`); process.exitCode = 1; }
function ok(message) { console.log(`ok   ${message}`); }

if (!existsSync(app)) {
  fail(`app bundle not found: ${app}`);
  process.exit(1);
}

// 品牌改名（docs/OH_AGENT_BRAND_RENAME_PLAN.md）：显示名与 bundle identifier 以 tauri.conf.json 为准；
// 桌面可执行文件与内置 CLI 的内部文件名不随品牌改名。
const tauriConfig = JSON.parse(readFileSync(path.join(repo, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
const plist = path.join(app, "Contents/Info.plist");
function plistValue(key) {
  try { return execFileSync("plutil", ["-extract", key, "raw", "-o", "-", plist], { encoding: "utf8" }).trim(); }
  catch (error) { fail(`cannot read ${key} from ${plist}: ${(error.stderr || error.message).trim()}`); return null; }
}
for (const [key, expected] of [["CFBundleName", tauriConfig.productName], ["CFBundleIdentifier", tauriConfig.identifier]]) {
  const value = plistValue(key);
  if (value === null) continue;
  if (value === expected) ok(`${key}: ${value}`);
  else fail(`${key} is ${value}, expected ${expected} (apps/desktop/src-tauri/tauri.conf.json)`);
}

const executable = path.join(app, "Contents/MacOS/agent-vitals-menubar");
const cli = path.join(app, "Contents/Resources/bin/agent-vitals");
const authoritySource = path.join(repo, "crates/agent-vitals-data/src/authority.rs");
for (const [label, file] of [["app executable", executable], ["bundled CLI", cli]]) {
  if (existsSync(file)) ok(`${label}: ${path.relative(repo, file)}`);
  else fail(`${label} missing: ${file}`);
}

if (existsSync(cli)) {
  try {
    const version = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim();
    if (version) ok(`bundled CLI responds: ${version}`);
    else fail("bundled CLI returned an empty version");
  } catch (error) {
    fail(`bundled CLI --version failed: ${error.message}`);
  }
}

if (existsSync(cli) && existsSync(authoritySource)) {
  try {
    const source = readFileSync(authoritySource, "utf8");
    const expected = source.match(/pub const SCHEMA_VERSION: i64 = (\d+);/)?.[1];
    if (!expected) throw new Error("could not read SCHEMA_VERSION from authority source");
    const info = JSON.parse(execFileSync(cli, ["--build-info"], { encoding: "utf8" }));
    if (String(info.authority_schema) === expected) {
      ok(`bundled CLI authority schema: v${expected}`);
    } else {
      fail(`bundled CLI authority schema v${info.authority_schema ?? "unknown"} does not match source v${expected}`);
    }
  } catch (error) {
    fail(`bundled CLI build contract failed: ${error.message}`);
  }
}

function architecture(file) {
  try {
    return execFileSync("file", [file], { encoding: "utf8" }).trim();
  } catch (error) {
    fail(`cannot inspect architecture for ${file}: ${error.message}`);
    return "";
  }
}

const architectures = [];
for (const [label, file] of [["app executable", executable], ["bundled CLI", cli]]) {
  if (!existsSync(file)) continue;
  const description = architecture(file);
  const match = description.match(/\b(arm64|x86_64|universal)\b/g);
  if (match?.length) {
    const unique = [...new Set(match)].join(",");
    architectures.push(unique);
    ok(`${label} architecture: ${unique}`);
  } else {
    fail(`${label} architecture is not a recognized macOS Mach-O binary: ${description}`);
  }
  if (requiredArchitecture && !description.includes(requiredArchitecture)) {
    fail(`${label} architecture does not include required ${requiredArchitecture}: ${description}`);
  }
}
if (requiredArchitecture && architectures.length === 0) {
  fail(`required architecture ${requiredArchitecture} could not be verified`);
}

const signatures = [];
for (const [label, file] of [["app", app], ["bundled CLI", cli]]) {
  const result = spawnSync("codesign", ["-dvvv", file], { encoding: "utf8" });
  const signature = signatureContract(`${result.stdout || ""}${result.stderr || ""}`);
  signatures.push(signature);
  if (result.status === 0 && signature.developerId) ok(`${label}: Developer ID + hardened runtime (team ${signature.team})`);
  else if (requireDeveloperId) fail(`${label}: Developer ID Application signature with hardened runtime required`);
  else console.warn(`WARN ${label} is not Developer ID signed with hardened runtime (diagnostic-only mode)`);
  if (requireDeveloperId) {
    try {
      execFileSync("codesign", ["--verify", "--strict", ...(label === "app" ? ["--deep"] : []), file], { encoding: "utf8" });
      ok(`${label}: codesign strict verification passed`);
    } catch (error) {
      fail(`${label}: codesign strict verification failed: ${(error.stderr || error.message).trim()}`);
    }
  }
}
if (requireDeveloperId && !matchingDeveloperIdSignatures(signatures[0], signatures[1])) {
  fail("app and bundled CLI must have matching Developer ID teams and hardened runtime");
}

if (process.exitCode) process.exit(process.exitCode);
