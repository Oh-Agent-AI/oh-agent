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

// Embedded reads use the generic typed-data boundary. Dataset pagination and
// revision pinning are exercised by typed-city-session-adapter tests (also run
// by the dedicated Node 22 CI job); this provider guard checks that the obsolete
// app-specific protocol is gone.
assert.equal(mod.exports.cityDataProtocol(), "typed");
console.log("City data provider: generic typed-data transport fails closed; typed projection is the only embedded protocol.");
