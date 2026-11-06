#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ui = path.join(repo, "apps/desktop/ui-dev");
const { build } = createRequire(path.join(ui, "package.json"))("esbuild");
const out = await build({
  entryPoints: [path.join(repo, "apps/agent-city/ui/src/data/provider.ts")], bundle: true, write: false,
  format: "cjs", platform: "node", logLevel: "silent",
});
const mod = { exports: {} };
const stored = new Map([["city.seed", "1234"]]);
const windowStub = {
  parent: null,
  __AV_PLUGIN_INSTANCE__: undefined,
  localStorage: {
    getItem(key) { return stored.has(key) ? stored.get(key) : null; },
    setItem(key, value) { stored.set(key, String(value)); },
  },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  setTimeout, clearTimeout, setInterval, clearInterval,
};
windowStub.parent = windowStub;
const locationStub = { href: "http://localhost/", search: "" };
vm.runInNewContext(out.outputFiles[0].text, {
  module: mod, exports: mod.exports, process, console, window: windowStub, localStorage: windowStub.localStorage,
  location: locationStub, URL, URLSearchParams, setTimeout, clearTimeout,
});
const { tauriCityDataProvider } = mod.exports;
for (const windowDays of [7, 30, 90, 366]) {
  const projection = await tauriCityDataProvider.getProjection({ windowDays });
  assert.equal(projection.protocol, "city:v2");
  assert(Array.isArray(projection.harnesses));
  assert.equal(projection.window.days, windowDays);
  assert.equal(projection.status, "ready");
  assert(projection.sessions.every((session) => {
    // City may show the scrubbed, bounded session title and its provenance as the
    // building label. Paths and raw prompts stay outside this projection.
    const titleIsSafe = typeof session.title !== "string" ||
      (Array.from(session.title).length <= 256 &&
        (session.title_source == null || ["codex_thread_name", "claude_ai_title", "dsh_workspace_title"].includes(session.title_source)));
    return !("path" in session) && !("prompt" in session) && titleIsSafe;
  }));
  assert(projection.findings.every((finding) => ["critical", "warning", "info"].includes(finding.severity)));
  assert.equal(projection.coverage.total, projection.sessions.length);
}

// The standalone demo owns a deterministic city seed and must not read or
// overwrite a user's persistent seed, including when the demo is manually reseeded.
const seedOut = await build({
  entryPoints: [path.join(repo, "apps/agent-city/ui/src/data/seed.ts")], bundle: true, write: false,
  format: "cjs", platform: "node", logLevel: "silent",
});
const seedMod = { exports: {} };
locationStub.search = "?demo=1";
vm.runInNewContext(seedOut.outputFiles[0].text, {
  module: seedMod, exports: seedMod.exports, process, console, window: windowStub, localStorage: windowStub.localStorage,
  location: locationStub, URL, URLSearchParams, setTimeout, clearTimeout,
});
const { citySeed, DEMO_CITY_SEED, isStandaloneDemo } = seedMod.exports;
assert.equal(isStandaloneDemo(), true);
assert.equal(await citySeed("read"), DEMO_CITY_SEED);
assert.equal(DEMO_CITY_SEED, 74031);
assert.equal(await citySeed("write", 42), 42, "manual demo seed is accepted for this instance");
assert.equal(await citySeed("read"), DEMO_CITY_SEED, "demo reload returns to its deterministic default");
assert.equal(stored.get("city.seed"), "1234", "demo must not touch normal persisted city seed");
locationStub.search = "";
assert.equal(await citySeed("read"), 1234, "normal standalone still reads persisted seed");

locationStub.search = "?demo=1";
const demo366 = await tauriCityDataProvider.getProjection({ windowDays: 366 });
assert.equal(demo366.sessions.length, 280, "default demo window contains all 280 generated sessions");
const demo366Again = await tauriCityDataProvider.getProjection({ windowDays: 366 });
assert.deepEqual(JSON.parse(JSON.stringify(demo366Again.sessions)), JSON.parse(JSON.stringify(demo366.sessions)),
  "demo session projection is deterministic across reloads");
const demo30 = await tauriCityDataProvider.getProjection({ windowDays: 30 });
assert.ok(demo30.sessions.length < 280, "a shorter explicit window filters demo sessions");
locationStub.search = "";
windowStub.__AV_PLUGIN_INSTANCE__ = "plugin-city-test";
windowStub.__TAURI__ = { core: { async invoke(command, { request }) {
  assert.equal(command, "plugin_request");
  return { version: 1, requestId: request.requestId, ok: false, result: null,
    error: { code: "provider_unavailable", retryable: true } };
} } };
await assert.rejects(tauriCityDataProvider.getProjection({ windowDays: 30 }), /provider_unavailable/,
  "Embedded failures must not silently return synthetic sessions");
console.log("City data provider: versioned windows, standalone fixtures, redacted DTO and no embedded fixture fallback passed.");

// v3: a changed snapshot discards the entire staged city; pages never rebuild the scene independently.
locationStub.search = "?cityData=v3";
let overviewReads = 0;
let forcedRevision = false;
const stages = [];
const fromMs = Date.parse("2026-09-01T00:00:00Z"), toMs = fromMs + 30*86400000;
function responseV3(epoch, offset, count) {
  return { protocol: "city:v3", source: "local", generated_at: new Date(toMs).toISOString(), data_revision: epoch,
    query_semantics: "city-window-v3.1", snapshot: `sr_${String(epoch).repeat(32)}`, context: `sr_${"c".repeat(32)}`,
    window: { days:30,from_ms:fromMs,to_ms:toMs,from:new Date(fromMs).toISOString(),to:new Date(toMs).toISOString(),timezone:"UTC",calendar_mode:"rolling",boundary:"half_open" },
    harnesses:[{id:"codex",display_name:"Codex",capabilities:{session_statistics:{available:true},findings:{available:true,reason:null}}}],
    modules:{overview:{state:"ready",supported:true,data:{session_count:501,usage_event_count:501,tokens:{input:30060,output:20040,total:50100},
        models:{model_ids:["example"],unknown_model_usage_events:3,legacy_usage_events:1},
        time_classification:{scope:"all_non_deleted_sessions",unknown_time_only:2,mixed_time:1,excluded_no_usage:0}}},
      activity:{state:"empty",supported:true,data:{days:[],busiest_day:null}},
      findings:{state:"ready",supported:true,data:{current_backlog:[{harness:"codex",severity:"warning",count:2}],window_new:[]}}},
    page:{sessions:Array.from({length:count},(_,i)=>{const index=offset+i; return {
      id:`sr_${index.toString(16).padStart(32,"0")}`,asset_ref:`ca_${index.toString(16).padStart(32,"0")}`,layout_order:501-index,
      harness:"codex",title:epoch===1?"stale":"current",first_event_at:new Date(fromMs).toISOString(),last_event_at:new Date(toMs-1).toISOString(),
      tokens:{input:60,output:40,total:100},
      cost_status:{state:"unavailable",reason:"load_on_demand",has_unresolved:false}};}),next_cursor:offset===0?"cursor-next":null,
      coverage:{matched:501,returned:count,offset,has_more:offset===0}} };
}
windowStub.__TAURI__.core.invoke = async (command,{request}) => {
  let result;
  if (request.payload.operation === "overview") { overviewReads++; result=responseV3(overviewReads,0,500); }
  else if (!forcedRevision) { forcedRevision=true; return {version:1,requestId:request.requestId,ok:false,error:{code:"revision_changed"}}; }
  else result=responseV3(overviewReads,500,1);
  return {version:1,requestId:request.requestId,ok:true,result};
};
const paged=await tauriCityDataProvider.getProjection({windowDays:30,onStage:(stage)=>stages.push(stage)});
assert.equal(overviewReads,2);
assert.equal(paged.sessions.length,501);
assert(paged.sessions.every((s)=>s.title==="current"));
assert.equal(paged.sessions[0].id,`sr_${(500).toString(16).padStart(32,"0")}`);
assert.equal(paged.summary.tokens.total,50100);
assert.equal(paged.findings[0].count,2);
assert.equal(paged.coverage.findings_state,"partial");
assert.equal(paged.coverage.time_classification.unknown_time_only,2);
assert.equal(paged.model_coverage.unknown_model_usage_events,3);
assert.equal(paged.sessions[0].cost_status.reason,"load_on_demand");
assert.deepEqual(stages,["reading_summary","reading_sessions","reading_summary","reading_sessions","ready"]);
console.log("City v3: staged pages, deterministic layout order, whole-window totals and revision restart passed.");

// Lazy detail must retain reference provenance through the host -> UI adapter.
const referencePrices=[{pricing_version:"local-reference",captured_at_ms:toMs}];
windowStub.__TAURI__.core.invoke = async (_command,{request}) => {
  const result=responseV3(overviewReads,0,1);
  const row=result.page.sessions[0]; delete result.page;
  result.detail={...row,cost:{cost_minor:{amount_minor:20,currency:"USD",basis:"metered_estimate"},status:"estimated",
    reason:"current-card-reference-estimate",has_unresolved:true,complete:true,reference_prices:referencePrices,
    breakdown:[{amount_minor:20,currency:"USD",basis:"metered_estimate"}]}};
  return {version:1,requestId:request.requestId,ok:true,result};
};
const detailed=await mod.exports.readCitySessionDetail(paged,`sr_${"0".repeat(32)}`);
assert.deepEqual(detailed.cost_reference_prices,referencePrices);
assert.equal(detailed.cost_status.has_unresolved,true);
assert.equal(detailed.cost_minor.amount_minor,20);
console.log("City reference estimate: host provenance survives lazy detail mapping.");

assert.equal(mod.exports.cityDataProtocol(), "v3");
locationStub.search = "?cityData=v2";
assert.equal(mod.exports.cityDataProtocol(), "v2");
locationStub.search = "?presentation=landing";
assert.equal(mod.exports.cityDataProtocol(), "v2");
locationStub.search = "";
assert.equal(mod.exports.cityDataProtocol(), "v3", "packaged plugin webviews default to v3");

const v2Result = {
  protocol: "city:v2", source: "local", generated_at: new Date(toMs).toISOString(),
  harnesses: [{ id: "codex", display_name: "Codex", capabilities: { session_statistics: { available: true }, findings: { available: true, reason: null } } }],
  window: { days: 30, label: "最近 30 天", from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
  sessions: [{ id: "sr_v2", harness: "codex", first_event_at: new Date(fromMs).toISOString(), last_event_at: new Date(toMs-1).toISOString(),
    tokens: { input: 10, output: 5, total: 15 } }],
  findings: [], coverage: { total: 1, returned: 1, truncated: false, unknown_time: 0 }, status: "ready",
};

locationStub.search = "?presentation=landing";
let requested = [];
windowStub.__TAURI__.core.invoke = async (_command, { request }) => {
  requested.push(request.payload.version);
  return { version: 1, requestId: request.requestId, ok: true, result: v2Result };
};
const landing = await tauriCityDataProvider.getProjection({ windowDays: 30 });
assert.deepEqual(requested, [2]);
assert.equal(landing.sessions[0].id, "sr_v2");
console.log("City landing presentation stays on city:v2.");

locationStub.search = "";
requested = [];
windowStub.__TAURI__.core.invoke = async (_command, { request }) => {
  requested.push(request.payload.version);
  if (request.payload.version === 3) {
    return { version: 1, requestId: request.requestId, ok: false, error: { code: "revision_changed" } };
  }
  return { version: 1, requestId: request.requestId, ok: true, result: v2Result };
};
const fallback = await tauriCityDataProvider.getProjection({ windowDays: 30 });
assert(requested.includes(3) && requested.includes(2), "v3 errors fall back to v2");
assert.equal(fallback.sessions[0].id, "sr_v2");
console.log("City v3 default falls back to v2 after snapshot retries.");

locationStub.search = "";
const partials = [];
let releasePage;
const pageGate = new Promise((resolve) => { releasePage = resolve; });
windowStub.__TAURI__.core.invoke = async (_command, { request }) => {
  let result;
  if (request.payload.operation === "overview") result = responseV3(4, 0, 500);
  else { await pageGate; result = responseV3(4, 500, 1); }
  return { version: 1, requestId: request.requestId, ok: true, result };
};
const pending = tauriCityDataProvider.getProjection({ windowDays: 30, onPartial: (projection) => partials.push(projection) });
for (let i = 0; i < 20 && partials.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(partials.length, 1, "first page is published before later pages finish");
assert.equal(partials[0].sessions.length, 500);
assert.equal(partials[0].coverage.truncated, true);
assert.equal(partials[0].coverage.total, 501);
releasePage();
const progressive = await pending;
assert.equal(progressive.sessions.length, 501);
assert.equal(progressive.coverage.truncated, false);
console.log("City v3 progressive load: first page renders before the remaining pages.");

let detailAttempts = 0;
windowStub.__TAURI__.core.invoke = async (_command, { request }) => {
  if (request.payload.operation === "session.detail") {
    detailAttempts += 1;
    if (detailAttempts === 1) return { version: 1, requestId: request.requestId, ok: false, error: { code: "revision_changed" } };
  }
  const result = responseV3(4, 0, 1);
  if (request.payload.operation === "overview") return { version: 1, requestId: request.requestId, ok: true, result };
  const row = result.page.sessions[0]; delete result.page;
  result.detail = { ...row, cost: { cost_minor: { amount_minor: 20, currency: "USD", basis: "metered_estimate" }, status: "estimated",
    reason: "current-card-reference-estimate", has_unresolved: true, complete: true, reference_prices: referencePrices,
    breakdown: [{ amount_minor: 20, currency: "USD", basis: "metered_estimate" }] } };
  return { version: 1, requestId: request.requestId, ok: true, result };
};
const recovered = await mod.exports.readCitySessionDetail(progressive, `sr_${"0".repeat(32)}`);
assert.equal(detailAttempts, 2);
assert.equal(recovered.cost_minor.amount_minor, 20);
console.log("City session detail re-snapshots after a background write.");
