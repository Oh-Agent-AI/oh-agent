#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ui = path.join(repo, "apps/desktop/ui-dev");
const uiRequire = createRequire(path.join(ui, "package.json"));
const { buildSync } = uiRequire("esbuild");
const source = path.join(ui, "react/src/lib/tauri.ts");
const trustPage = fs.readFileSync(path.join(ui, "react/src/features/trust/TrustPage.tsx"), "utf8");
assert.match(trustPage, /readTrustEvidence\(null, 200, cursor\)/, "Trust page must load persisted evidence through the read-only history API");
assert.match(trustPage, /tr\.controlsSummary/, "less-frequent profile controls must be disclosed behind a secondary section");
assert.match(trustPage, /tr\.noSavedEvidence/, "empty history must clearly distinguish no evidence from no risk");
assert.match(trustPage, /event\.type !== "TrustMonitorInvalidated"\) return;\s+setReport\(null\)/, "monitor invalidation must reveal refreshed persisted history instead of pinning a stale audit report");
assert.match(trustPage, /onClick=\{\(\) => requestProfileDecision\(profile, "revoke"\)\}/, "revoke must first show an in-page confirmation");
assert.match(trustPage, /role="group" aria-label=\{tx\("tr\.revokeAria", \{ name: profile\.display_name \}\)\}/, "revoke confirmation must be adjacent to its profile");
assert.match(trustPage, /profileFeedback\?\.section === "approved"/, "revoke outcome must be visible in the approved-profile section");
assert.doesNotMatch(trustPage.slice(trustPage.indexOf("const requestProfileDecision"), trustPage.indexOf("const revokeSuppression")), /window\.confirm/, "profile decisions must not rely on native confirmation dialogs");
const built = buildSync({ entryPoints: [source], bundle: true, format: "cjs", platform: "node", target: "node20", write: false, logLevel: "silent" });

const pending = {
  slug: "sample-agent", display_name: "Sample Agent", state: "pending", manifest_hash: "0123456789abcdef",
  discovery_include_count: 1, trust_roots_count: 1, artifact_terms_count: 2, extensions_count: 1,
  trust_adapter: "generic_artifact_v1", watch_priority: "normal",
  source_scope_preview: { roots_count: 1, root_classes: ["home_relative"], covers_workspace_or_project: true, may_include_git_metadata: false, covers_full_filesystem: false, may_leave_home_directory: false },
  trust_scope_preview: { roots_count: 1, root_classes: ["home_relative_app_data"], covers_workspace_or_project: false, may_include_git_metadata: false, home_relative_only: true },
  local_path: "/Users/private/should-not-enter-ui",
};
const approved = { ...pending, slug: "approved-agent", display_name: "Approved Agent", state: "approved", manifest_hash: "fedcba9876543210" };
let suppressions = [
  { suppression_id: "trust-suppression-SV709-1780000000000", issue_type: "SV709", created_at_ms: 1780000000000, revoked_at_ms: null, reason: "/Users/private/must-be-ignored" },
  { suppression_id: "trust-suppression-SV702-1780000000001", issue_type: "SV702", created_at_ms: 1780000000001, revoked_at_ms: 1780000000002 },
];
const status = { status: "ok", authority_state: "ready", data: { pending: [pending], approved: [approved], history: [{ path: "/private/history" }] } };
const calls = [];
const invoke = async (command, args = {}) => {
  calls.push({ command, args });
  if (command === "trust_profile_proposal_status") return status;
  if (command === "trust_suppression_list") return { status: "ok", suppressions };
  if (command === "trust_profile_approve") return { status: "ok", data: { status: "approved", slug: args.slug } };
  if (command === "trust_profile_reject") return { status: "ok", data: { status: "rejected", slug: args.slug } };
  if (command === "trust_profile_revoke") return { status: "ok", data: { status: "revoked", slug: args.slug } };
  if (command === "trust_suppression_revoke") {
    const row = suppressions.find((item) => item.suppression_id === args.suppressionId);
    if (row) row.revoked_at_ms = 1780000000003;
    return { status: "revoked", suppression_id: args.suppressionId };
  }
  if (command === "trust_suppression_create") return { status: "saved", suppression_id: "trust-suppression-SV709-1780000000004" };
  throw new Error(`unexpected command ${command}`);
};

const sandbox = { module: { exports: {} }, exports: {}, require: uiRequire, console: { error() {}, warn() {}, log() {} }, Intl, Date, Math, Promise, setTimeout, clearTimeout, window: { __TAURI__: { core: { invoke } } } };
vm.createContext(sandbox);
vm.runInContext(built.outputFiles[0].text, sandbox, { filename: "tauri-trust-controls.bundle.cjs" });
const bridge = sandbox.module.exports;

const profiles = await bridge.readTrustProfileStatus();
assert.equal(profiles.pending.length, 1);
assert.equal(profiles.pending[0].source_scope_preview.covers_workspace_or_project, true);
assert.equal(profiles.approved[0].state, "approved");
assert.equal("local_path" in profiles.pending[0], false, "raw manifest extras must not cross the React bridge");
const readSuppressions = await bridge.readTrustSuppressions();
assert.equal(readSuppressions.length, 2);
assert.equal(readSuppressions[0].issue_type, "SV709");
assert.equal("reason" in readSuppressions[0], false, "free-form suppression reason must stay out of the UI DTO");
await bridge.approveTrustProfile(profiles.pending[0]);
await bridge.rejectTrustProfile(profiles.pending[0]);
await bridge.revokeTrustProfile(profiles.approved[0]);
assert.equal(await bridge.revokeTrustSuppression(profiles.pending.length ? "trust-suppression-SV709-1780000000000" : ""), "revoked");
assert.equal(await bridge.createTrustSuppression("SV709"), "trust-suppression-SV709-1780000000004");
assert.deepEqual(calls.filter((call) => call.command.startsWith("trust_profile_") && call.command !== "trust_profile_proposal_status").map((call) => call.args.manifestHash), [pending.manifest_hash, pending.manifest_hash, approved.manifest_hash], "every profile mutation must be pinned to the viewed manifest hash");
await assert.rejects(() => bridge.approveTrustProfile({ ...profiles.pending[0], manifest_hash: "bad" }), /reference is invalid/);
await assert.rejects(() => bridge.createTrustSuppression("SV999"), /issue type is invalid/);

const evidenceDto = {
  kind: "package", stage: "package_observed", evidence_level: "E1", evidence_origin: "local_artifact", observed_at_ms: 1780000000000,
  workspace_ref: "tr_workspace123", native_event_ref: null, scope_classes: ["git_history"], file_count: 2, byte_count: 4096,
  destination_class: "object_storage", collector_id: "generic_artifact_v1", raw_path: "/private/path/never-expose",
};
const longValidCursor = `1780000000000:${"a".repeat(32)}:${"b".repeat(256)}`;
assert.ok(longValidCursor.length > 256 && longValidCursor.length <= 320, "fixture exercises the upper cursor contract beyond generic string DTO limits");
const evidenceCalls = [];
const evidenceBridge = (() => {
  const sandbox = { module: { exports: {} }, exports: {}, require: uiRequire, console: { error() {}, warn() {}, log() {} }, Intl, Date, Math, Promise, setTimeout, clearTimeout, window: { __TAURI__: { core: { invoke: async (command, args) => {
    evidenceCalls.push({ command, args });
    return { harness: null, count: 1, next_cursor: longValidCursor, source: "authority_readonly", evidence: [evidenceDto] };
  } } } } };
  vm.createContext(sandbox);
  vm.runInContext(built.outputFiles[0].text, sandbox, { filename: "tauri-trust-history.bundle.cjs" });
  return sandbox.module.exports;
})();
const history = await evidenceBridge.readTrustEvidence(null, 200);
assert.equal(history.count, 1);
assert.equal(history.evidence[0].kind, "package");
assert.equal("raw_path" in history.evidence[0], false, "history parser must discard raw path fields");
assert.equal(evidenceCalls[0].command, "trust_evidence_read");
assert.equal(evidenceCalls[0].args.harness, null);
assert.equal(evidenceCalls[0].args.limit, 200);
assert.equal(evidenceCalls[0].args.cursor, null);
assert.equal(history.next_cursor, longValidCursor, "history parser must accept the full 320-character cursor contract");
await evidenceBridge.readTrustEvidence(null, 200, history.next_cursor);
assert.equal(evidenceCalls[1].args.cursor, history.next_cursor, "opaque history cursor must be forwarded unchanged");
await assert.rejects(() => evidenceBridge.readTrustEvidence(null, 200, "../../private"), /游标不安全/);
assert.match(trustPage, /tr\.loadOlder/);
await assert.rejects(() => evidenceBridge.readTrustEvidence("../private", 200), /执行环境标识不安全/);
await assert.rejects(() => evidenceBridge.readTrustEvidence(null, 501), /读取范围不安全/);

const malformed = async (command) => command === "trust_profile_proposal_status"
  ? { status: "ok", data: { pending: [{ ...pending, source_scope_preview: { ...pending.source_scope_preview, root_classes: ["/Users/private"] } }], approved: [] } }
  : { status: "ok", suppressions: [] };
sandbox.window.__TAURI__.core.invoke = malformed;
await assert.rejects(() => bridge.readTrustProfileStatus(), /root class 不安全/);

console.log("React Trust controls contract: OK (scope redaction, bounded DTOs, hash-pinned UI decisions)");
