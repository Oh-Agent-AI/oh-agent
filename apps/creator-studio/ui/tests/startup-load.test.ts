import test from "node:test";
import assert from "node:assert/strict";
import { parseCityListPage, parseInstallations } from "../src/cityGameLibrary.ts";
import { loadStudioAtStartup, loadStudioValueAtStartup } from "../src/startupLoad.ts";

test("startup retries the transient instance race and eventually loads", async () => {
  let calls = 0, waits = 0;
  await loadStudioAtStartup(async () => { calls++; if (calls < 3) throw "plugin_instance_mismatch"; },
    { isCancelled: () => false, delay: async () => { waits++; } });
  assert.equal(calls, 3); assert.equal(waits, 2);
});

test("startup surfaces real failures and bounds transient retries", async () => {
  let calls = 0;
  await assert.rejects(loadStudioAtStartup(async () => { calls++; throw new Error("creator_store_unavailable"); },
    { isCancelled: () => false, delay: async () => {} }), /creator_store_unavailable/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(loadStudioAtStartup(async () => { calls++; throw new Error("plugin_instance_mismatch"); },
    { isCancelled: () => false, delay: async () => {}, attempts: 3 }), /plugin_instance_mismatch/);
  assert.equal(calls, 3);
});

test("empty catalog reads survive one instance mismatch and stay empty", async () => {
  let cityCalls = 0;
  const page = parseCityListPage(await loadStudioValueAtStartup(async () => {
    cityCalls += 1;
    if (cityCalls === 1) throw "plugin_instance_mismatch";
    return { cities: [], nextCursor: null };
  }, { isCancelled: () => false, delay: async () => {} }));
  assert.equal(cityCalls, 2);
  assert.deepEqual(page.cities, []);
  assert.equal(page.nextCursor, null);
  const installations = parseInstallations(await loadStudioValueAtStartup(async () => ({ installations: [] }),
    { isCancelled: () => false, delay: async () => {} }));
  assert.deepEqual(installations, []);
  let storageCalls = 0;
  await assert.rejects(loadStudioValueAtStartup(async () => { storageCalls += 1; throw new Error("creator_store_unavailable"); },
    { isCancelled: () => false, delay: async () => {} }), /creator_store_unavailable/);
  assert.equal(storageCalls, 1);
});

test("startup stops retrying when the Studio is unmounted", async () => {
  let cancelled = false, calls = 0;
  await loadStudioAtStartup(async () => { calls++; throw new Error("plugin_instance_mismatch"); },
    { isCancelled: () => cancelled, delay: async () => { cancelled = true; } });
  assert.equal(calls, 1);
});
