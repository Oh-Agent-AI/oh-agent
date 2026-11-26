import test from "node:test";
import assert from "node:assert/strict";
import { createCityLayoutWorldSourceV1 } from "../src/game/codeGameHost/cityWorldSource.ts";
import type { CityLayoutSnapshotV3 } from "../../../../packages/agent-vitals-city-sdk/src/types.ts";

/**
 * The layout snapshot is the only trusted topology a published code game has:
 * no rendered road splines, no terrain, no City engine. These tests pin the
 * projection rules — v3 required, routes follow walk-capable links, terrain is
 * injected (never fabricated), and object queries are bounded.
 */

const snapshot: CityLayoutSnapshotV3 = {
  schemaVersion: 3,
  cityId: "city-a",
  cityRevision: 4,
  worldRevision: "world-4",
  seed: 99,
  layout: {
    schemaVersion: 1,
    id: "layout-a",
    coordinateSystem: "city-local-m-v1",
    anchors: [
      { id: "spawn", kind: "spawn", capabilities: ["walk"], geometryRef: "g-spawn" },
      { id: "mid", kind: "route", capabilities: ["walk"], geometryRef: "g-mid" },
      { id: "end", kind: "object", capabilities: ["walk"], geometryRef: "g-end" },
      { id: "car", kind: "object", capabilities: ["drive"], geometryRef: "g-car" },
    ],
    links: [
      { id: "l1", fromAnchorId: "spawn", toAnchorId: "mid", capabilities: ["walk"] },
      { id: "l2", fromAnchorId: "mid", toAnchorId: "end", capabilities: ["walk"] },
      { id: "l3", fromAnchorId: "spawn", toAnchorId: "car", capabilities: ["drive"] },
    ],
  },
  geometry: [
    { geometryRef: "g-spawn", positionMeters: { x: 0, y: 0, z: 0 } },
    { geometryRef: "g-mid", positionMeters: { x: 10, y: 0, z: 0 } },
    { geometryRef: "g-end", positionMeters: { x: 20, y: 0, z: 4 } },
    { geometryRef: "g-car", positionMeters: { x: 100, y: 0, z: 100 } },
  ],
};

test("the snapshot projects city identity, anchors and a walk route", () => {
  const world = createCityLayoutWorldSourceV1({ snapshot });
  assert.deepEqual(world.city(), {
    cityId: "city-a",
    seed: 99,
    worldRevision: "world-4",
    layoutId: "layout-a",
  });
  assert.equal(world.listAnchors().length, 4);
  const routes = world.listRoutes();
  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.id, "route-spawn");
  assert.deepEqual(routes[0]?.points, [
    [0, 0, 0],
    [10, 0, 0],
    [20, 0, 4],
  ]);
  assert.equal(world.getRoute("route-spawn")?.points.length, 3);
  assert.equal(world.getRoute("route-missing"), null);
});

test("drive capability follows drive links instead of walk links", () => {
  const world = createCityLayoutWorldSourceV1({ snapshot, capability: "drive" });
  const routes = world.listRoutes();
  assert.equal(routes.length, 1);
  assert.deepEqual(routes[0]?.points, [
    [0, 0, 0],
    [100, 0, 100],
  ]);
});

test("terrain is injected, never assumed to be flat", () => {
  const withoutTerrain = createCityLayoutWorldSourceV1({ snapshot });
  assert.equal(withoutTerrain.sampleTerrain(0, 0), null);

  const withTerrain = createCityLayoutWorldSourceV1({
    snapshot,
    terrain: (x, z) => ({ height: x + z, normal: [0, 1, 0], walkable: true }),
  });
  assert.deepEqual(withTerrain.sampleTerrain(2, 3), { height: 5, normal: [0, 1, 0], walkable: true });
});

test("object queries return point bounds for object and zone anchors only", () => {
  const world = createCityLayoutWorldSourceV1({ snapshot });
  const hit = world.queryObjects({ min: [-1, -1, -1], max: [25, 5, 5] });
  assert.deepEqual(hit.map((item) => item.id), ["end"]);
  assert.deepEqual(hit[0]?.bounds, { min: [20, 0, 4], max: [20, 0, 4] });
  assert.deepEqual(world.queryObjects({ min: [50, 0, 50], max: [60, 1, 60] }), []);
});

test("a v2 snapshot is rejected because it has no anchor geometry", () => {
  const v2 = {
    schemaVersion: 2,
    cityId: "city-a",
    cityRevision: 4,
    worldRevision: "world-4",
    seed: 99,
    layout: snapshot.layout,
  } as unknown as CityLayoutSnapshotV3;
  assert.throws(() => createCityLayoutWorldSourceV1({ snapshot: v2 }), /v3/);
});
