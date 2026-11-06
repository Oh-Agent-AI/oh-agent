import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url));
const { build } = require("esbuild");
const result = await build({ entryPoints: [new URL("../packages/agent-vitals-app-sdk/src/harness-data.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "node" });
const { createHarnessDataClient } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
let revision = 1, ids = ["opaque-native", "opaque-dynamic"], changed = false;
const calls = [];
const client = createHarnessDataClient("metrics-test", async (request) => {
  calls.push(request);
  assert.equal(request.instanceId, "metrics-test");
  assert.equal(request.payload.version, 1);
  if (request.method === "harnesses.list") return { version: 1, requestId: request.requestId, ok: true,
    result: { protocol: "harnesses:v1", data_revision: revision, harnesses: ids.map((id) => ({ id, display_name: id,
      capabilities: { session_statistics: { available: true }, findings: { available: false, reason: "findings_not_supported" } } })) }, error: null };
  assert.equal(request.method, "harnesses.sessions");
  if (!changed) { changed = true; revision++; }
  if (request.payload.data_revision !== revision) return { version: 1, requestId: request.requestId, ok: false, result: null,
    error: { code: "revision_changed", retryable: true } };
  return { version: 1, requestId: request.requestId, ok: true, error: null, result: { protocol: "harness-sessions:v1",
    data_revision: revision, harness_id: request.payload.harness_id, status: "empty", sessions: [],
    window: { days: request.payload.windowDays, from_ms: 0, to_ms: 1 }, coverage: { total: 0, returned: 0, truncated: false } } };
});
let snapshot = await client.snapshot(30);
assert.equal(snapshot.list.data_revision, 2);
assert.equal(snapshot.data.length, 2);
ids.push("opaque-added"); revision++;
snapshot = await client.snapshot(7); // same running consumer refreshes on invalidation/resume
assert.equal(snapshot.data.length, 3);
assert(snapshot.data.every((d) => d.data_revision === snapshot.list.data_revision));
assert(calls.every((c) => !JSON.stringify(c).includes("city")));
const denied = createHarnessDataClient("denied", async (r) => ({ version: 1, requestId: r.requestId, ok: false, result: null,
  error: { code: "projection_denied", retryable: false } }));
await assert.rejects(denied.snapshot(30), /projection_denied/);
const mismatched = createHarnessDataClient("wrong", async () => ({ version: 1, requestId: "wrong", ok: true, result: {}, error: null }));
await assert.rejects(mismatched.list(), /plugin_response_invalid/);
console.log("Generic App Plugin harness client: passed (opaque identities, dynamic refresh, revision retry, denied access).");
