import test from "node:test";
import assert from "node:assert/strict";
import { compileWorldFixtureV1 } from "@oh-agent/city-sdk/testing";
import { sha256Bytes } from "@oh-agent/city-sdk";
import { createSnapshotWorldAPIV2 } from "../src/host/snapshotWorld";

const digest = (bytes: Uint8Array) => `sha256:${Array.from(sha256Bytes(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

test("Snapshot WorldAPI exposes headers and bounded stable pages without a full-snapshot getter", () => {
  const api = createSnapshotWorldAPIV2(compileWorldFixtureV1());
  assert.equal(api.header().cityId, "city-fixture");
  assert.equal("city" in api, false);
  assert.equal(api.supports("volumes.indexed"), true);

  const first = api.volumes({ limit: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const second = api.volumes({ limit: 1, cursor: first.nextCursor });
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0]!.id, second.items[0]!.id);
  assert.equal(second.nextCursor, undefined);
  assert.throws(() => api.volumes({ limit: 1, cursor: "v1:sha256:bad:0" }), /stale or malformed/);
  assert.throws(() => api.volumes({ limit: 0 }), /positive integer/);
});

test("Snapshot queries filter by kind and bounds and preserve resident/place identity", () => {
  const api = createSnapshotWorldAPIV2(compileWorldFixtureV1());
  assert.equal(api.objects({ bounds: { min: [0, 0, 0], max: [20, 10, 20] }, limit: 10 }).items.length, 1);
  assert.equal(api.objects({ bounds: { min: [100, 100, 100], max: [101, 101, 101] }, limit: 10 }).items.length, 0);
  assert.equal(api.volumes({ kinds: ["checkpoint"], limit: 10 }).items.length, 1);
  assert.equal(api.listSites({ kind: "harbor" }).items.length, 1);
  assert.equal(api.getResident("resident:keeper").displayName, "Keeper");
  assert.equal(api.listPlaces({ kind: "harbor" }).items.length, 1);
  assert.throws(() => api.getRoute("road:missing"), /not present/);
});

test("digest-addressed assets verify bytes at open and every subsequent read", async () => {
  const tileBytes = new TextEncoder().encode("tile-v1");
  const tileDigest = digest(tileBytes);
  const snapshot = structuredClone(compileWorldFixtureV1()) as any;
  snapshot.terrain.tiles = [{
    id: "tile:harbor",
    assetDigest: tileDigest,
    bounds: { min: [0, 0, 0], max: [10, 10, 10] },
  }];
  let current = tileBytes;
  const api = createSnapshotWorldAPIV2(snapshot, {
    terrainTiles: { "tile:harbor": () => current },
    models: { [tileDigest]: () => current },
  });
  const reader = await api.openTerrainTile("tile:harbor", tileDigest);
  assert.equal(reader.byteLength, tileBytes.byteLength);
  assert.deepEqual(await reader.read(), tileBytes);
  assert.deepEqual(await (await api.openModel(tileDigest)).read(), tileBytes);
  assert.throws(() => api.openTerrainTile("tile:harbor", `sha256:${"0".repeat(64)}`), /identity or digest/);
  current = new TextEncoder().encode("tampered");
  await assert.rejects(() => reader.read(), /bytes changed/);
});

test("live environment and appearance are explicit optional providers", () => {
  const snapshot = compileWorldFixtureV1();
  assert.throws(() => createSnapshotWorldAPIV2(snapshot).environment(), /no live environment/);
  const environment = createSnapshotWorldAPIV2(snapshot, {
    environment: () => ({
      schemaVersion: 1,
      medium: "water",
      biome: "underwater",
      simulationUtcMs: 0,
      timeZoneId: "Asia/Shanghai",
      localHour: 8,
      environmentRevision: snapshot.header.revisions.environmentRevision,
      weatherRevision: snapshot.header.revisions.weatherRevision,
      clockRevision: snapshot.header.revisions.clockRevision,
      weather: { kind: "clear", intensity: 0 },
    }),
  }).environment();
  assert.equal(environment.medium, "water");
  assert.equal(environment.biome, "underwater");
});
