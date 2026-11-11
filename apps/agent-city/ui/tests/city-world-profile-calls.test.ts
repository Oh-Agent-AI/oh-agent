import test from "node:test";
import assert from "node:assert/strict";
import { ARID_DUNES_CITY_WORLD_V1, MIAMI_CITY_WORLD_V1, readCityWorldProfilePreference } from "../src/engine/cityWorldProfile.ts";
import { createCityWorldProfileCallHandlers } from "../src/engine/cityWorldProfileCalls.ts";

const customDunes = { ...ARID_DUNES_CITY_WORLD_V1, id: "agent-dunes" };

function installStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  return values;
}

test("world profile MCP applies a validated profile only after explicit preview and is idempotent", async () => {
  const values = installStorage();
  let applied: unknown = null;
  let now = 100;
  let allowed = true;
  const handlers = createCityWorldProfileCallHandlers({
    instanceId: () => "city-instance-1", canApply: () => allowed,
    onApplied: profile => { applied = profile; }, now: () => now, createPreviewId: () => "cwp_preview0001",
  });
  const preview = await handlers["city.world.profile.preview"]({ profile: customDunes as unknown as Record<string, unknown> }) as Record<string, unknown>;
  assert.equal((preview.proposedWorld as Record<string, unknown>).generator, "arid-dunes-v1");
  assert.equal(readCityWorldProfilePreference().id, MIAMI_CITY_WORLD_V1.id);
  const request = { previewId: "cwp_preview0001", operationId: "op-world-1" };
  const result = await handlers["city.world.profile.apply"](request) as Record<string, unknown>;
  assert.equal(result.applied, true);
  assert.equal(readCityWorldProfilePreference().id, customDunes.id);
  assert.equal((applied as typeof customDunes).id, customDunes.id);
  assert.deepEqual(await handlers["city.world.profile.apply"](request), result);
  assert.equal(values.get("city.world-profile.v1"), JSON.stringify(customDunes));
});

test("world profile MCP refuses stale, busy, expired, and cross-instance commits", async () => {
  installStorage();
  let now = 100;
  let instanceId = "city-instance-1";
  let allowed = false;
  let sequence = 0;
  const handlers = createCityWorldProfileCallHandlers({
    instanceId: () => instanceId, canApply: () => allowed, onApplied: () => {}, now: () => now,
    createPreviewId: () => `cwp_preview${String(++sequence).padStart(4, "0")}`,
  });
  const makePreview = () => handlers["city.world.profile.preview"]({ profile: customDunes as unknown as Record<string, unknown> });
  const first = await makePreview() as { previewId: string };
  assert.throws(() => handlers["city.world.profile.apply"]({ previewId: first.previewId, operationId: "op-busy" }), /city_world_busy/);
  allowed = true;
  instanceId = "city-instance-2";
  assert.throws(() => handlers["city.world.profile.apply"]({ previewId: first.previewId, operationId: "op-instance" }), /plugin_instance_mismatch/);
  instanceId = "city-instance-1";
  const second = await makePreview() as { previewId: string };
  now += 5 * 60 * 1000;
  assert.throws(() => handlers["city.world.profile.apply"]({ previewId: second.previewId, operationId: "op-expired" }), /preview_expired/);
});

test("world profile MCP preview refuses stale base world and invalid profile data", async () => {
  const values = installStorage();
  let sequence = 0;
  const handlers = createCityWorldProfileCallHandlers({
    instanceId: () => "city-instance-1", canApply: () => true, onApplied: () => {},
    createPreviewId: () => `cwp_preview${String(++sequence).padStart(4, "0")}`,
  });
  assert.throws(() => handlers["city.world.profile.preview"]({ profile: { ...customDunes, extra: "forbidden" } }), /world_profile_invalid_shape/);
  const preview = await handlers["city.world.profile.preview"]({ profile: customDunes as unknown as Record<string, unknown> }) as { previewId: string };
  values.set("city.world-profile.v1", JSON.stringify({ ...MIAMI_CITY_WORLD_V1, id: "other-coast" }));
  assert.throws(() => handlers["city.world.profile.apply"]({ previewId: preview.previewId, operationId: "op-stale" }), /revision_conflict/);
});
