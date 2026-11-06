#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const app = process.argv[2]
  || `${root}/apps/desktop/src-tauri/target/release/bundle/macos/Oh Agent.app`;
const plist = `${app}/Contents/Info.plist`;
const appBin = `${app}/Contents/MacOS/agent-vitals-menubar`;
const cliBin = `${app}/Contents/Resources/bin/agent-vitals`;

let failed = 0;
function ok(condition, message) {
  if (condition) console.log(`  ok  ${message}`);
  else {
    failed += 1;
    console.error(`FAIL  ${message}`);
  }
}

function output(program, args) {
  return execFileSync(program, args, { encoding: "utf8" }).trim();
}

console.log(`# bundle ${app}`);
ok(existsSync(plist), "Info.plist 存在");
ok(existsSync(appBin), "桌面可执行文件存在");
ok(existsSync(cliBin), "内置 CLI 存在");

if (!failed) {
  const shortVersion = output("plutil", [
    "-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist,
  ]);
  const bundleVersion = output("plutil", [
    "-extract", "CFBundleVersion", "raw", "-o", "-", plist,
  ]);
  ok(shortVersion === "0.11.0", "CFBundleShortVersionString = 0.11.0");
  ok(bundleVersion === "0.11.0", "CFBundleVersion = 0.11.0");

  const cliVersion = output(cliBin, ["--version"]).split(/\s+/).at(-1);
  ok(cliVersion === "1.3.0", "内置 CLI = 1.3.0");

  const binaryStrings = output("strings", [appBin]);
  ok(binaryStrings.includes("data_status"), "桌面二进制包含数据质量状态 IPC");
  ok(binaryStrings.includes("session_trace"), "桌面二进制包含 Trace IPC");
  ok(binaryStrings.includes("pricing_snapshots"), "桌面二进制包含价格快照状态");
}

console.log(failed ? `\n${failed} FAIL` : "\n全部通过。");
process.exit(failed ? 1 : 0);
