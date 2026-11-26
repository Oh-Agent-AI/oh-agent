import test from "node:test";
import assert from "node:assert/strict";
import { MIAMI_ACTIVITY_CATALOG_V1, ORNITHOPTER_GAME_TYPE_V1, ORNITHOPTER_PROTOTYPE_GAME_TYPE_V1 } from "../src/index.ts";
import { CREATOR_GAME_TYPES_V1 } from "../../agent-vitals-city-sdk/src/index";
import { createMiamiLegacyRegistry, type MiamiActivityIdV1, type MiamiLegacyActivityHostV1 } from "../src/index.ts";

function host(): { host: MiamiLegacyActivityHostV1; calls: MiamiActivityIdV1[]; disposed: number } {
  const calls: MiamiActivityIdV1[] = [];
  let disposed = 0;
  return {
    calls,
    get disposed() { return disposed; },
    host: {
      enter: async (activity) => {
        calls.push(activity);
        return { ok: true, value: {
          telemetry: () => ({ status: "running", tick: 7, counters: { next: 1 }, metrics: { speed: 12 }, reason: null }),
          dispose: () => { disposed += 1; },
        } };
      },
    },
  };
}

test("registers the four Miami activities and the flight prototype as host-driven adapters", () => {
  const h = host();
  const registry = createMiamiLegacyRegistry(h.host);
  const descriptors = registry.descriptors();
  assert.deepEqual(descriptors.map(item => item.id), ["miami.flight-v1", "miami.driving-v1", "miami.mecha-v1", "miami.cinema-v1",
    "creator.flight-ornithopter-prototype-v1"]);
  for (const item of descriptors) {
    const runtime = registry.resolve(item.id, item.runtime.contractVersion);
    assert.equal(runtime.execution, "host-driven");
    assert.equal(runtime.type, item.runtime.id);
  }
});

test("prepare delegates lifecycle to the legacy host and never double-steps it", async () => {
  const h = host();
  const registry = createMiamiLegacyRegistry(h.host);
  const runtime = registry.resolve("miami.flight-v1", 1);
  const prepared = await runtime.prepare({} as never);
  assert.equal(prepared.ok, true);
  assert.deepEqual(h.calls, ["flight"]);
  if (!prepared.ok) return;
  assert.equal(prepared.value.fixedStep, undefined);
  assert.equal(prepared.value.telemetry().counters.next, 1);
  prepared.value.dispose();
  assert.equal(h.disposed, 1);
});

test("host entry failure propagates without inventing a handle", async () => {
  const registry = createMiamiLegacyRegistry({ enter: async () => ({ ok: false, failure: { code: "activity_busy", message: "busy" } }) });
  const runtime = registry.resolve("miami.mecha-v1", 1);
  const prepared = await runtime.prepare({} as never);
  assert.equal(prepared.ok, false);
  if (!prepared.ok) assert.equal(prepared.failure.code, "activity_busy");
});

test("adapter mapping is golden-locked to the existing Miami activity order", () => {
  const h = host();
  const registry = createMiamiLegacyRegistry(h.host);
  assert.deepEqual(registry.descriptors().map(item => ({
    id: item.id, runtime: item.runtime, templateCatalog: item.templateCatalog, template: item.template,
  })), [
    { id: "miami.flight-v1", runtime: { id: "miami.flight", contractVersion: 1 }, templateCatalog: "builtin", template: "miami-flight" },
    { id: "miami.driving-v1", runtime: { id: "miami.driving", contractVersion: 1 }, templateCatalog: "builtin", template: "miami-driving" },
    { id: "miami.mecha-v1", runtime: { id: "miami.mecha", contractVersion: 1 }, templateCatalog: "builtin", template: "miami-mecha" },
    { id: "miami.cinema-v1", runtime: { id: "miami.cinema", contractVersion: 1 }, templateCatalog: "builtin", template: "miami-cinema" },
    { id: "creator.flight-ornithopter-prototype-v1", runtime: { id: "miami.flight", contractVersion: 1 }, templateCatalog: "builtin", template: "miami-flight" },
  ]);
});

test("legacy descriptors stay catalog-only and are not Creator capability claims", () => {
  const h = host();
  const registry = createMiamiLegacyRegistry(h.host);
  for (const descriptor of registry.descriptors()) {
    assert.equal(descriptor.templateCatalog, "builtin");
    assert.equal(descriptor.template.startsWith("miami-"), true);
  }
  // The planned ornithopter remains unregistrable until its adapter/template lands.
  assert.equal(MIAMI_ACTIVITY_CATALOG_V1.length, 4);
});

test("Miami/ornithopter descriptors stay lockstep with the Creator capability list", () => {
  assert.deepEqual([...MIAMI_ACTIVITY_CATALOG_V1, ORNITHOPTER_PROTOTYPE_GAME_TYPE_V1, ORNITHOPTER_GAME_TYPE_V1].map(item => ({
    id: item.id, template: item.template, templateCatalog: item.templateCatalog, runtime: item.runtime,
  })), CREATOR_GAME_TYPES_V1.map(item => ({
    id: item.id, template: item.template, templateCatalog: item.templateCatalog, runtime: item.runtime,
  })));
});
