import test from "node:test";
import assert from "node:assert/strict";
import { parsePendingCreatorPlaytest } from "../src/game/activity/creatorPlaytestPending.ts";

const city = { schemaVersion: 1, cityId: "city-desert", revision: 0, name: "沙海之门", seed: 42,
  profile: { schemaVersion: 1, id: "egypt-desert", version: 1, biome: "arid",
    geography: { generator: "arid-dunes-v1", parameters: { dunes: { duneScale: 190, duneAmplitude: 11, orientationDeg: 18 } } }, visuals: { themeId: "desert" } } };
const layout = { schemaVersion: 2, cityId: "city-desert", cityRevision: 0, worldRevision: "city-road-v2:42:abc", seed: 42,
  layout: { schemaVersion: 1, id: "city-layout-v1:42:100:abc", coordinateSystem: "city-local-m-v1",
    anchors: [{ id: "start", kind: "spawn", capabilities: ["drive"], geometryRef: "g:start" },
      { id: "cp-1", kind: "zone", capabilities: ["drive"], geometryRef: "g:1" },
      { id: "cp-2", kind: "zone", capabilities: ["drive"], geometryRef: "g:2" }] } };
const pending = { pending: true, runId: "playtest-1", releaseId: "release-1", projectId: "project-1", revision: 3,
  worldRevision: layout.worldRevision, city, layout };

test("accepts a pending city-scoped playtest only when city, layout and world revision agree", () => {
  const parsed = parsePendingCreatorPlaytest(pending);
  assert.equal(parsed.pending, true);
  if (parsed.pending) assert.equal(parsed.city.cityId, "city-desert");
  assert.throws(() => parsePendingCreatorPlaytest({ ...pending, worldRevision: "city-road-v2:other" }), /creator_playtest/);
  assert.throws(() => parsePendingCreatorPlaytest({ ...pending, layout: { ...layout, cityId: "city-miami" } }), /creator_playtest_pending_invalid/);
  assert.throws(() => parsePendingCreatorPlaytest({ ...pending, layout: { ...layout, seed: 43 } }), /creator_playtest/);
});

test("passes through the no-pending case and rejects malformed descriptors", () => {
  assert.deepEqual(parsePendingCreatorPlaytest({ pending: false }), { pending: false });
  assert.throws(() => parsePendingCreatorPlaytest(null), /creator_playtest/);
  assert.throws(() => parsePendingCreatorPlaytest({ pending: true }), /(city_instance_invalid_shape|creator_playtest)/);
});
