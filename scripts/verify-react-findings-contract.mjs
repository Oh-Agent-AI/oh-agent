#!/usr/bin/env node
// Findings bridge contract test.  The renderer must reject malformed or
// unbounded safe-DTO responses before they reach the evidence UI.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ui = path.join(repo, "apps/desktop/ui-dev");
const uiRequire = createRequire(path.join(ui, "package.json"));
const { buildSync } = uiRequire("esbuild");

function loadMock() {
  const sandbox = { console: { error() {}, warn() {}, log() {} }, Intl, Date, Math, Promise, setTimeout, clearTimeout, window: {} };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(ui, "public/tauri-mock.js"), "utf8"), sandbox, { filename: "tauri-mock.js" });
  return sandbox.window.__TAURI__.core.invoke;
}

function loadBridge(invoke) {
  const built = buildSync({ entryPoints: [path.join(ui, "react/src/lib/tauri.ts")], bundle: true, format: "cjs", platform: "node", target: "node20", write: false, logLevel: "silent" });
  const sandbox = { module: { exports: {} }, exports: {}, require: uiRequire, console: { error() {}, warn() {}, log() {} }, Intl, Date, Math, Promise, setTimeout, clearTimeout, window: { __TAURI__: { core: { invoke } } } };
  vm.createContext(sandbox);
  vm.runInContext(built.outputFiles[0].text, sandbox, { filename: "tauri-bridge.bundle.cjs" });
  return { bridge: sandbox.module.exports, window: sandbox.window };
}

function loadFindingsContract() {
  const built = buildSync({ entryPoints: [path.join(ui, "react/src/features/findings/contract.ts")], bundle: true, format: "cjs", platform: "node", target: "node20", write: false, logLevel: "silent" });
  const sandbox = { module: { exports: {} }, exports: {}, console: { error() {}, warn() {}, log() {} }, Set, Map };
  vm.createContext(sandbox);
  vm.runInContext(built.outputFiles[0].text, sandbox, { filename: "findings-contract.bundle.cjs" });
  return sandbox.module.exports;
}

const invoke = loadMock();
const { bridge, window } = loadBridge(invoke);
const { mergeFindingsPage } = loadFindingsContract();
const findingsSource = readFileSync(path.join(ui, "react/src/features/findings/FindingsPage.tsx"), "utf8");
const appSource = readFileSync(path.join(ui, "react/src/app/App.tsx"), "utf8");
const settingsSource = readFileSync(path.join(ui, "react/src/features/settings/SettingsPage.tsx"), "utf8");
assert.match(findingsSource, /group\.manual_follow_up\s*&&\s*!group\.read_only/);
assert.doesNotMatch(findingsSource, /TODO_RULES|TODO_SOURCE_KINDS|PRICE_COVERAGE|ROUTE_UNCONFIRMED/);
assert.match(findingsSource, /onNavigateToAction\(group\.action_kind\)/);
assert.match(appSource, /actionKind === "billing"[\s\S]*settings-billing/);
assert.match(appSource, /actionKind === "budget"[\s\S]*settings-budget/);
assert.match(appSource, /actionKind === "source"[\s\S]*settings-sources/);
assert.match(settingsSource, /getElementById\(focusSection\)/);
const valid = await bridge.readFindings();
assert.equal(valid.issues.length, 2);
assert.equal(valid.issues[0].sample_evidence[0].destination_class, "object_storage");
assert.equal(valid.issues[0].sample_evidence[0].reference, "fnv1a64:2222222222222222");

const secondPage = structuredClone(valid);
secondPage.totals = { ...valid.totals, issues: 999, critical: 99 };
secondPage.rules = [{ ...valid.rules[0], hits: 20 }, { rule: "SV700", severity: "info", category: "behavior", hits: 1, sessions: 1 }];
secondPage.issues = [{ ...valid.issues[0] }, { ...valid.issues[1], group_id: "fnv1a64:4444444444444444", rule: "SV700" }, { ...valid.issues[1], group_id: "fnv1a64:4444444444444444", rule: "SV700" }];
secondPage.next_cursor = "100";
const merged = mergeFindingsPage(valid, secondPage);
assert.equal(merged.totals.issues, valid.totals.issues, "authority totals remain stable across pages");
assert.equal(merged.issues.length, 3, "duplicate group is not rendered twice");
assert.equal(merged.issues.filter((item) => item.group_id === "fnv1a64:4444444444444444").length, 1, "same-page duplicate group is not rendered twice");
assert.equal(merged.rules.length, 3, "rules are unioned across pages");
assert.equal(merged.rules.find((item) => item.rule === valid.rules[0].rule)?.hits, 20, "latest rule row wins");
assert.equal(merged.next_cursor, "100");

let capturedCursor = "unset";
window.__TAURI__.core.invoke = async (command, args) => {
  capturedCursor = command === "findings_groups_safe" ? args?.cursor : capturedCursor;
  return invoke(command, args);
};
await bridge.readFindings("2");
assert.equal(capturedCursor, "2");
await assert.rejects(() => bridge.readFindings("cursor-2"), /分页游标不安全/);
await assert.rejects(() => bridge.readFindings("x".repeat(257)), /分页游标不安全/);
window.__TAURI__.core.invoke = invoke;

const original = invoke;
const override = async (command, args, mutate) => {
  const value = await original(command, args);
  return command === "findings_groups_safe" ? mutate(structuredClone(value)) : value;
};
const withOverride = (mutate) => { window.__TAURI__.core.invoke = (command, args) => override(command, args, mutate); };
const restore = () => { window.__TAURI__.core.invoke = original; };

withOverride((value) => { value.refreshed = "yes"; return value; });
await assert.rejects(() => bridge.readFindings(), /refreshed/);
restore();

withOverride((value) => { value.rules = Array.from({ length: 129 }, () => value.rules[0]); return value; });
await assert.rejects(() => bridge.readFindings(), /数量超限/);
restore();

withOverride((value) => { value.issues = Array.from({ length: 101 }, () => value.issues[0]); return value; });
await assert.rejects(() => bridge.readFindings(), /数量超限/);
restore();

withOverride((value) => { value.issues[0].sample_evidence[0].available = "true"; return value; });
await assert.rejects(() => bridge.readFindings(), /状态不安全/);
restore();

withOverride((value) => { value.issues[0].sample_evidence[0].observed_first_at_ms = value.issues[0].last_seen_at_ms + 1; return value; });
await assert.rejects(() => bridge.readFindings(), /时间范围不安全/);
restore();

console.log("React Findings contract: OK (safe DTO, bounded collections, malformed rejection, action-kind navigation)");
