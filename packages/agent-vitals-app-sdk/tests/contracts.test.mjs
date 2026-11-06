import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { assertCityResponseInvariants, assertCompatible, createValidators, repo, requireSdk, schemas, sdk } from "../../../scripts/app-contract-support.mjs";
import { renderArtifacts, verifyArtifact } from "../../../scripts/generate-app-contracts.mjs";

const validators = createValidators();
const requestSchema = "city-v1-app-local-request.json";
const responseSchema = "city-v1-app-local-response.json";
const errorSchema = "app-projection-error-v1.json";
const fixture = JSON.parse(fs.readFileSync(path.join(repo, "fixtures/app-contracts/city-v1-response.json"), "utf8"));

test("open/next/recent requests are separate, scoped and bounded", () => {
  const common = { projection: "city", version: 1, face: "app-local" };
  const open = { ...common, operation: "open", window_kind: "30d", page_size: 500 };
  assert(validators[requestSchema](open));
  assert(validators[requestSchema]({ ...common, operation: "next", snapshot_id: fixture.snapshot.id, cursor: "csc1_" + "B".repeat(43) }));
  assert(validators[requestSchema]({ ...common, operation: "recent", snapshot_id: fixture.snapshot.id }));
  for (const bad of [{ ...open, sql: "select *" }, { ...open, page_size: 501 }, { ...open, face: "app-internal" },
    { ...open, version: 2 }, { ...open, session_ref: "raw" }, { ...common, operation: "next", cursor: "cursor" },
    { ...common, operation: "recent", snapshot_id: fixture.snapshot.id, window_kind: "7d" }]) assert(!validators[requestSchema](bad));
});

test("DTO fixture, unknown time and honest missing cost are serializable", () => {
  assert(validators[responseSchema](fixture), JSON.stringify(validators[responseSchema].errors));
  assertCityResponseInvariants(fixture);
  const unknown = structuredClone(fixture);
  unknown.sessions[0].first_event_ms = null;
  unknown.sessions[0].last_event_ms = null;
  unknown.sessions[0].reliability.time = "unknown";
  unknown.sessions[0].cost_minor = null;
  unknown.sessions[0].cost_status.state = "unpriced";
  unknown.sessions[0].cost_status.reason_code = "missing_price";
  assert(validators[responseSchema](unknown));
  assertCityResponseInvariants(unknown);
});

test("empty, multi-harness and continuation DTOs remain explicit", () => {
  const empty = structuredClone(fixture);
  empty.sessions = [];
  empty.harness_summaries = [];
  empty.coverage.returned_count = 0;
  empty.coverage.window_session_count = 0;
  empty.coverage.window_tokens_total = 0;
  assert(validators[responseSchema](empty));
  assertCityResponseInvariants(empty);
  const multi = structuredClone(fixture);
  const second = structuredClone(multi.sessions[0]);
  second.opaque_id = "csh1_" + "B".repeat(43);
  second.harness = "claude-code";
  multi.sessions.push(second);
  multi.coverage.returned_count = 2;
  multi.coverage.window_session_count = 3;
  multi.coverage.window_tokens_total = 375;
  multi.harness_summaries.push({ ...multi.harness_summaries[0], harness: "claude-code" });
  multi.harness_summaries[0].session_count = 2;
  multi.harness_summaries[0].tokens_total = 250;
  multi.pagination = { has_more: true, next_cursor: "csc1_" + "B".repeat(43) };
  assert(validators[responseSchema](multi));
  assertCityResponseInvariants(multi);
  // Current-page counts deliberately differ from full-window totals.
  assert.equal(multi.coverage.returned_count, 2);
  assert.equal(multi.coverage.window_session_count, 3);
});

test("raw fields and arbitrary error details fail schema validation", () => {
  for (const field of ["session_ref", "source_path", "title", "working_directory", "raw_error", "arguments", "credential", "canary"]) {
    const bad = structuredClone(fixture);
    bad.sessions[0][field] = "redacted-test-value";
    assert(!validators[responseSchema](bad), field);
  }
  const badModel = structuredClone(fixture);
  badModel.sessions[0].model_ids = ["/private/log-path"];
  assert(!validators[responseSchema](badModel));
  const error = { protocol_version: 1, request_id: "apr1_" + "A".repeat(16), code: "data_unavailable", retryable: true, retry_after_ms: null };
  assert(validators[errorSchema](error));
  assert(!validators[errorSchema]({ ...error, message: "raw internal error" }));
});

test("cross-field counts, costs and handle uniqueness have meaningful invariants", () => {
  const badCount = structuredClone(fixture);
  badCount.coverage.returned_count = 0;
  assert.throws(() => assertCityResponseInvariants(badCount), /count mismatch/);
  const badToken = structuredClone(fixture);
  badToken.sessions[0].tokens.total += 1;
  assert.throws(() => assertCityResponseInvariants(badToken), /token total/);
  const badBilling = structuredClone(fixture);
  badBilling.sessions[0].harness = "harness:fixture";
  badBilling.sessions[0].cost_status = { state: "subscription", reason_code: "none", has_unresolved: false };
  badBilling.sessions[0].cost_minor.basis = "fixed_subscription";
  assert.throws(() => assertCityResponseInvariants(badBilling), /subscription forbidden/);
  const badCursor = structuredClone(fixture);
  badCursor.pagination.has_more = true;
  assert.throws(() => assertCityResponseInvariants(badCursor), /cursor state/);
  const mismatched = structuredClone(fixture);
  mismatched.sessions[0].cost_status = { state: "subscription", reason_code: "none", has_unresolved: false };
  assert.throws(() => assertCityResponseInvariants(mismatched), /basis\/state mismatch/);
  const actual = structuredClone(fixture);
  actual.sessions[0].cost_minor.basis = "metered_actual";
  actual.sessions[0].cost_status = { state: "actual", reason_code: "none", has_unresolved: false };
  assert(validators[responseSchema](actual));
  assertCityResponseInvariants(actual);
  const uncertain = structuredClone(fixture);
  uncertain.sessions[0].cost_status.has_unresolved = false;
  assert.throws(() => assertCityResponseInvariants(uncertain), /reason\/unresolved mismatch/);
  const badTime = structuredClone(fixture);
  badTime.sessions[0].first_event_ms = null;
  assert.throws(() => assertCityResponseInvariants(badTime), /time reliability mismatch/);
  badTime.sessions[0].reliability.time = "partial";
  assertCityResponseInvariants(badTime);
});

test("schema validation changes require compatibility review independently of codegen", () => {
  for (const mutate of [
    (s) => { s[responseSchema].required.push("new_required"); },
    (s) => { delete s[responseSchema].properties.sessions; },
    (s) => { s[responseSchema].properties.sessions.type = "string"; },
    (s) => { s[responseSchema].properties.freshness.properties.state.enum.pop(); },
    (s) => { s[requestSchema].oneOf[0].properties.page_size.maximum = 100; },
  ]) {
    const changed = structuredClone(schemas);
    mutate(changed);
    assert.throws(() => assertCompatible(schemas, changed), /compatibility review/);
  }
  const documented = structuredClone(schemas);
  documented[responseSchema].description = "documentation-only change";
  assert.doesNotThrow(() => assertCompatible(schemas, documented));
  // Property names and literal data are not schema annotations.
  assert.throws(() => assertCompatible({ sample: { properties: { description: { type: "string" } } } },
    { sample: { properties: {} } }), /compatibility review/);
  assert.throws(() => assertCompatible({ sample: { const: { description: "first" } } },
    { sample: { const: { description: "second" } } }), /compatibility review/);
});

test("generation is reproducible, drift fails and negotiation uses generated metadata", async () => {
  const first = await renderArtifacts();
  assert.deepEqual(await renderArtifacts(), first);
  verifyArtifact(first["contracts.ts"], fs.readFileSync(path.join(sdk, "src/generated/contracts.ts"), "utf8"));
  assert.throws(() => verifyArtifact(first["contracts.ts"], first["contracts.ts"] + "changed"), /drift/);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "app-contract-test-"));
  let negotiate;
  try {
    execFileSync(process.execPath, [path.join(sdk, "node_modules/typescript/bin/tsc"), "-p", path.join(sdk, "tsconfig.json"), "--noEmit", "false", "--rootDir", path.join(sdk, "src"), "--outDir", temporary], { stdio: "pipe" });
    fs.writeFileSync(path.join(temporary, "package.json"), JSON.stringify({ type: "module" }));
    const contracts = await import(pathToFileURL(path.join(temporary, "generated/contracts.js")));
    assert.deepEqual(contracts.PROJECTION_CAPABILITIES, [{ id: "city", version: 1, face: "app-local", max_page_size: 500 }]);
    negotiate = (await import(pathToFileURL(path.join(temporary, "negotiation.js")))).negotiateProjection;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  assert.equal(negotiate({ id: "city", face: "app-local", versions: [1, 2] }).version, 1);
  for (const [id, face, versions, reason] of [["unknown", "app-local", [1], "unsupported_projection"],
    ["city", "app-internal", [1], "unsupported_face"], ["city", "app-local", [2], "unsupported_version"]]) {
    assert.equal(negotiate({ id, face, versions }).reason, reason);
  }
});
