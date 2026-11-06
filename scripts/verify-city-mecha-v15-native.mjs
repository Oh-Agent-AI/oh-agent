#!/usr/bin/env node
// Open the isolated, feature-gated macOS .app; never launch its bare binary.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
assert.equal(process.platform, "darwin");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(repo, "apps/desktop/src-tauri/target/release/bundle/macos/Oh Agent Isolation Probe.app");
const dir = await mkdtemp(path.join(os.tmpdir(), "mecha-v15-native-"));
const data = path.join(dir, "isolated-data"); await mkdir(data);
const formal = process.argv.includes("--formal");
const status = process.argv.includes("--status");
assert.ok(!status || formal, "status probe is available with --formal");
async function run(flag, name, required) {
  const report = path.join(dir, `${name}.json`);
  execFileSync("open", ["-n", "--env", `AGENT_VITALS_HOME=${data}`, "--env", `AGENT_VITALS_ISOLATION_REPORT=${report}`, bundle, "--args", flag, report]);
  console.log(`Native ${name} started; report: ${report}`);
  const deadline = Date.now() + 240_000;
  let result;
  while (Date.now() < deadline) {
    try { result = JSON.parse(await readFile(report, "utf8")); break; }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!result) {
    try { execFileSync("pkill", ["-f", `${bundle}/Contents/MacOS/agent-vitals-menubar ${flag} ${report}`]); } catch {}
  }
  assert.ok(result, `Native probe did not finish: ${report}`);
  console.log(JSON.stringify({ status: result.status, code: result.code, checks: result.checks, report }, null, 2));
  assert.equal(result.status, "passed", `Native probe failed: ${result.code}`);
  for (const code of required) assert.ok(result.events.some(event => event.code === code), `Missing ${code}`);
  assert.ok(!result.events.some(event => event.code === "runtime_error" || event.code === "unhandled_rejection"), "Native WebView reported a JavaScript error");
  return result;
}
const first = await run(status ? "--plugin-formal-v15-status-probe" : formal ? "--plugin-formal-v15-probe" : "--plugin-v15-probe", "initial", ["v15_board_ready", "v15_deployed", ...(status ? ["formal_disposed"] : ["v15_moved", "v15_undo", ...(formal ? ["formal_disposed"] : ["v15_recovered"])])]);
if (formal) {
  assert.equal(first.checks?.checkpoint_backend, "host_sqlite");
  const { DatabaseSync } = await import("node:sqlite");
  const read = () => {
    const db = new DatabaseSync(path.join(data, "state/plugins/city-assets/mecha-sequential-checkpoint.sqlite"), { readOnly: true });
    try { return db.prepare("SELECT revision, record FROM checkpoint WHERE id = 1").get(); } finally { db.close(); }
  };
  const before = read(); assert.ok(before && typeof before.record === "string");
  const archive = JSON.parse(JSON.parse(before.record).archive);
  if (status) {
    assert.equal(archive.schema, "mecha-sequential-bundle:v2");
    assert.equal(archive.opening.encounter.speciesId, "prism_warden");
    assert.equal(archive.opening.encounter.statusRules, "mecha-status-encounter:v1");
    assert.deepEqual(archive.replay.entries, []);
  } else assert.deepEqual(archive.replay.entries.map(entry => entry.command.id), ["c0", "c1"], "native checkpoint preserves durable command IDs");
  const resumed = await run(status ? "--plugin-formal-v15-status-resume" : "--plugin-formal-v15-resume", "restart", ["v15_board_ready", "v15_recovered", "formal_disposed"]);
  assert.equal(resumed.checks?.checkpoint_backend, "host_sqlite");
  assert.equal(resumed.checks?.restart_recovery, true);
  assert.deepEqual(read(), before, "recovery must not re-execute or rewrite the checkpoint");
}
