import test from "node:test";
import assert from "node:assert/strict";
import { validateCityWorldSnapshot } from "@oh-agent/city-sdk";
import { createCitySnapshotV4 } from "../src/game/codeGameHost/citySnapshot";
import { createSnapshotWorldAPIV2 } from "../../../../packages/city-game-sdk/src/host/snapshotWorld";
import type { CityLayout } from "../src/engine/cityLayout";
import { createCityLayoutSdkView, type CityLayoutSdkViewV1 } from "../src/engine/sdk/cityLayoutAdapter";

const layout = {
  seed: 123,
  derivedNetworkVersion: 7,
  terrain: {
    height: (x: number, _z: number) => x * 0.1,
    buildable: (x: number, _z: number) => x >= 0,
  },
  roadNodes: [
    { id: "n0", x: 0, z: 0 },
    { id: "n1", x: 10, z: 0 },
  ],
  roadEdges: [{
    id: "a-arterial",
    from: "n0",
    to: "n1",
    width: 14,
    kind: "arterial",
    points: [{ x: 0, z: 0 }, { x: 10, z: 0 }],
  }],
  blocks: [{ id: "block-1", x: 4, z: 2, width: 8, depth: 6 }],
} as unknown as CityLayout;
const view = {
  layout: { id: "layout-live" },
  worldRevision: "world-live-7",
} as CityLayoutSdkViewV1;

test("live City layout compiles to a validated Snapshot V4 with real generator identity", () => {
  const snapshot = createCitySnapshotV4({ cityId: "city-live", cityRevision: 9, layout, view });
  const checked = validateCityWorldSnapshot(snapshot);
  assert.equal(checked.ok, true, checked.ok ? "" : JSON.stringify(checked.diagnostics));
  assert.equal(snapshot.header.cityId, "city-live");
  assert.equal(snapshot.header.cityRevision, 9);
  assert.equal(snapshot.header.generator.version, "7");
  assert.match(snapshot.header.generator.codeDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(snapshot.roads[0]?.fromAnchorId, "anchor:n0");
  assert.equal(snapshot.roads[0]?.toAnchorId, "anchor:n1");
  assert.equal(snapshot.objects[0]?.id, "object:block-1");
  assert.equal(snapshot.header.capabilities.includes("terrain.heightfield"), false);
  assert.deepEqual(snapshot.volumes, []);
  assert.deepEqual(snapshot.places, []);
  assert.deepEqual(snapshot.residents, []);
});

test("real zone geometry becomes a capability-scoped checkpoint ring without inventing City content", () => {
  const flightView = {
    layout: {
      id: "layout-flight",
      anchors: [{ id: "flight-gate-1", kind: "zone", capabilities: ["fly"], geometryRef: "flight-gate-geometry" }],
    },
    geometry: new Map([["flight-gate-geometry", {
      positionMeters: { x: 12, y: 30, z: -8 },
      activationRadiusMeters: 6,
      facingRadians: Math.PI / 2,
    }]]),
    worldRevision: "world-flight-1",
  } as CityLayoutSdkViewV1;
  const place = { id: "place:cafe", kind: "cafe", displayName: "Cafe", objectRef: "object:block-1", activities: ["date"] } as const;
  const resident = { id: "resident:xia", displayName: "Xia", prefabRef: "resident-default", homePlaceId: place.id, interactions: ["dialogue"] } as const;
  const snapshot = createCitySnapshotV4({
    cityId: "city-flight",
    cityRevision: 1,
    layout,
    view: flightView,
    content: { places: [place], residents: [resident] },
  });
  const checked = validateCityWorldSnapshot(snapshot);
  assert.equal(checked.ok, true, checked.ok ? "" : JSON.stringify(checked.diagnostics));
  assert.equal(snapshot.volumes.length, 1);
  assert.equal(snapshot.volumes[0]?.id, "volume:flight-gate-1");
  assert.equal(snapshot.volumes[0]?.geometry.kind, "ring");
  assert.deepEqual(snapshot.volumes[0]?.travelModes, ["fly"]);
  assert.deepEqual(snapshot.anchors.find((anchor) => anchor.id === "anchor:flight-gate-1")?.travelModes, ["fly"]);
  assert.equal(snapshot.header.capabilities.includes("volumes.indexed"), true);
  assert.deepEqual(snapshot.places, [place]);
  assert.deepEqual(snapshot.residents, [resident]);
});

test("the same live Snapshot drives bounded V2 queries and real terrain sampling", () => {
  const snapshot = createCitySnapshotV4({ cityId: "city-live", cityRevision: 9, layout, view });
  const world = createSnapshotWorldAPIV2(snapshot, {
    terrain: (x, z) => ({
      height: layout.terrain.height(x, z),
      normal: [0, 1, 0],
      walkable: layout.terrain.buildable(x, z),
    }),
  });
  assert.equal(world.roads({ limit: 1 }).items.length, 1);
  assert.equal(world.terrainSample(5, 2).height, 0.5);
  assert.equal(world.objects({ limit: 1 }).items[0]?.id, "object:block-1");
});

test("road checkpoints from the real SDK adapter preserve Snapshot digests", () => {
  const roadView = createCityLayoutSdkView({
    layoutId: "layout-real-roads",
    worldRevision: "world-real-roads-1",
    roadNodes: layout.roadNodes,
    roadEdges: layout.roadEdges,
    groundHeight: (x, z) => layout.terrain.height(x, z),
    seed: layout.seed,
  });
  const snapshot = createCitySnapshotV4({ cityId: "city-real-roads", cityRevision: 1, layout, view: roadView });
  const checked = validateCityWorldSnapshot(snapshot);
  assert.equal(checked.ok, true, checked.ok ? "" : JSON.stringify(checked.diagnostics));
});
