#!/usr/bin/env node
// Build a feature-gated fixture-only host and launch through its .app bundle.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "darwin", "The native isolation probe requires macOS");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauri = path.join(repo, "apps/desktop/src-tauri");
const bundle = path.join(tauri, "target/release/bundle/macos/Oh Agent Isolation Probe.app");
const artifactDir = await mkdtemp(path.join(os.tmpdir(), "agent-vitals-plugin-probe-"));
const reportPath = path.join(artifactDir, "native-isolation.json");
if (!process.argv.includes("--skip-build")) {
  execFileSync("cargo", ["tauri", "build", "--features", "plugin-isolation-probe", "--config", "tauri.isolation-probe.conf.json", "--bundles", "app"], {
    cwd: tauri, env: { ...process.env, AGENT_VITALS_PLUGIN_ISOLATION_PROBE: "1" }, stdio: "inherit",
  });
}
assert.ok(existsSync(bundle), "Build the probe bundle before --skip-build");
execFileSync("open", ["-n", bundle, "--args", "--plugin-isolation-probe", reportPath]);
console.log(`Probe started. Local report: ${reportPath}`);
const deadline = Date.now() + 100_000;
while (!existsSync(reportPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
assert.ok(existsSync(reportPath), `Native probe did not produce a report within 100 seconds: ${artifactDir}`);
// Existence can race the native writer; retry only incomplete JSON, with a bound.
let report;
for (let attempt = 0; attempt < 20; attempt++) {
  try { report = JSON.parse(await readFile(reportPath, "utf8")); break; }
  catch (error) {
    if (!(error instanceof SyntaxError) || attempt === 19) throw error;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Use local source maps to turn only known bundle coordinates into source locations.
const require = createRequire(path.join(repo, "apps/agent-city/ui/package.json"));
const { TraceMap, originalPositionFor } = require("@jridgewell/trace-mapping");
for (const event of report.events) {
  for (const frame of event.frames) {
    const mapPath = path.join(repo, "apps/agent-city/ui/dist/assets", `${frame.asset}.map`);
    if (!existsSync(mapPath)) continue;
    const original = originalPositionFor(new TraceMap(JSON.parse(await readFile(mapPath, "utf8"))), { line: frame.line, column: Math.max(0, frame.column - 1) });
    if (original.source && !original.source.startsWith("/") && !original.source.includes("://")) {
      frame.original = { source: original.source, line: original.line, column: original.column };
    }
  }
}
await writeFile(reportPath, JSON.stringify(report, null, 2));
if (report.status === "passed") {
  for (const code of ["runtime_error", "unhandled_rejection"]) {
    assert.ok(report.events.some((event) => event.code === code && event.frames.some((frame) => frame.original?.source.endsWith("src/debug/isolationFaults.ts"))), `${code}: missing original source location`);
  }
  for (const code of ["unresponsive_detected", "host_navigation_alive", "renderer_terminated", "instance_disposed", "restart_succeeded", "formal_instance_suspended", "formal_instance_reused", "formal_disposed"]) {
    assert.ok(report.events.some((event) => event.code === code), `${code}: missing lifecycle evidence`);
  }
}
console.log(JSON.stringify({ status: report.status, code: report.code, checks: report.checks, report: reportPath }, null, 2));
if (report.status !== "passed") process.exitCode = 1;
