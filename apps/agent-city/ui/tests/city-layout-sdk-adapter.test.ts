import test from "node:test";
import assert from "node:assert/strict";
import { listAnchors } from "@agent-vitals/city-sdk";
import { createCityLayoutSdkView, createCreatorLayoutSnapshot, createSdkViewForCityLayout, selectCheckpointRaceCourse } from "../src/engine/sdk/cityLayoutAdapter.ts";
import { layoutCityForWorld } from "../src/engine/cityLayout.ts";
import { applyCitySkinToWorldProfile, ARID_DUNES_CITY_WORLD_V1, BUILTIN_CITY_SKINS_V1, MIAMI_CITY_WORLD_V1 } from "../src/engine/cityWorldProfile.ts";

const view = () => createCityLayoutSdkView({
  layoutId: "fixture-city-v1", worldRevision: "world-rev-1",
  roadNodes: [{ id: "n1", x: 0, z: 0 }, { id: "n2", x: 10, z: 0 }, { id: "n3", x: 20, z: 0 }, { id: "unused", x: 50, z: 50 }],
  roadEdges: [
    { id: "e1", from: "n1", to: "n2", width: 8, kind: "local", points: [{ x: 0, z: 0 }, { x: 10, z: 0 }] },
    { id: "e2", from: "n2", to: "n3", width: 8, kind: "arterial", bridge: true, points: [{ x: 10, z: 0 }, { x: 20, z: 0 }] },
    { id: "e3", from: "n2", to: "n3", width: 8, kind: "arterial", structure: "deck", points: [{ x: 10, z: 0 }, { x: 20, z: 0 }] },
  ],
});

test("projects connected ground road anchors with stable IDs and meter coordinates", () => {
  const adapted = view();
  assert.equal(adapted.layout.coordinateSystem, "city-local-m-v1");
  assert.equal(adapted.worldRevision, "world-rev-1");
  assert.deepEqual(adapted.layout.anchors.map(anchor => anchor.id), ["road-spawn:n1", "road-spawn:n2", "road-checkpoint:e1"]);
  assert.deepEqual(adapted.layout.links?.map(link => [link.fromAnchorId, link.toAnchorId, link.capabilities]), [
    ["road-spawn:n1", "road-checkpoint:e1", ["drive"]], ["road-checkpoint:e1", "road-spawn:n2", ["drive"]],
  ]);
  assert.equal(listAnchors(adapted.layout, { kind: "spawn", requires: ["drive"] }).length, 2);
  const checkpoint = adapted.layout.anchors.find(anchor => anchor.kind === "zone");
  assert.ok(checkpoint);
  assert.deepEqual(adapted.geometry.get(checkpoint.geometryRef)?.positionMeters, { x: 10, y: 0, z: 0 });
  assert.equal(adapted.geometry.get(checkpoint.geometryRef)?.activationRadiusMeters, 8.8);
});

test("exports a bounded creator layout snapshot without serializing trusted geometry", () => {
  const adapted = view();
  const snapshot = createCreatorLayoutSnapshot(adapted);
  assert.equal(snapshot.layout.id, adapted.layout.id);
  assert.equal(snapshot.worldRevision, adapted.worldRevision);
  assert.deepEqual(snapshot.layout.anchors.map(anchor => anchor.id), ["road-spawn:n1", "road-spawn:n2", "road-checkpoint:e1"]);
  assert.equal(snapshot.layout.links?.length, 2);
  assert.equal(Object.hasOwn(snapshot, "geometry"), false);
  assert.throws(() => createCreatorLayoutSnapshot(adapted, 1), /city-sdk-creator-anchor-budget-invalid/);
});

test("maps planner IDs with slashes to stable host-safe anchor and link IDs", () => {
  const adapted = createCityLayoutSdkView({ layoutId: "slash-fixture", worldRevision: "slash-world", preferredStart: { x: 0, z: 0 },
    roadNodes: [{ id: "node/1", x: 0, z: 0 }, { id: "node/2", x: 20, z: 0 }],
    roadEdges: [{ id: "node/1/node/2", from: "node/1", to: "node/2", width: 8, kind: "local", points: [{ x: 0, z: 0 }, { x: 20, z: 0 }] }] });
  const snapshot = createCreatorLayoutSnapshot(adapted);
  const ids = [...snapshot.layout.anchors.map(anchor => anchor.id), ...(snapshot.layout.links ?? []).map(link => link.id),
    ...snapshot.layout.anchors.map(anchor => anchor.geometryRef)];
  assert.ok(ids.every(id => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)));
  assert.equal(new Set(snapshot.layout.anchors.map(anchor => anchor.id)).size, snapshot.layout.anchors.length);
  assert.equal(snapshot.layout.links?.length, 2);
  assert.deepEqual(createCreatorLayoutSnapshot(adapted), snapshot);
});

test("rejects a road edge whose endpoints are absent from layout", () => {
  assert.throws(() => createCityLayoutSdkView({ layoutId: "bad", worldRevision: "r", roadNodes: [], roadEdges: [
    { id: "e", from: "missing", to: "also-missing", width: 5, kind: "local", points: [{ x: 0, z: 0 }, { x: 1, z: 0 }] },
  ] }), /city-sdk-road-node-missing/);
});

test("selects a deterministic connected three-checkpoint course", () => {
  const adapted = createCityLayoutSdkView({ layoutId: "course", worldRevision: "r", preferredStart: { x: 0, z: 0 },
    roadNodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 50, z: 0 }, { id: "c", x: 100, z: 0 }, { id: "d", x: 150, z: 0 }],
    roadEdges: [
      { id: "ab", from: "a", to: "b", width: 8, kind: "local", points: [{ x: 0, z: 0 }, { x: 50, z: 0 }] },
      { id: "bc", from: "b", to: "c", width: 8, kind: "local", points: [{ x: 50, z: 0 }, { x: 100, z: 0 }] },
      { id: "cd", from: "c", to: "d", width: 8, kind: "local", points: [{ x: 100, z: 0 }, { x: 150, z: 0 }] },
    ] });
  const first = selectCheckpointRaceCourse(adapted);
  const second = selectCheckpointRaceCourse(adapted);
  assert.deepEqual(first, second);
  assert.equal(first?.startAnchorId, "road-spawn:a");
  assert.deepEqual(first?.checkpointAnchorIds, ["road-checkpoint:ab", "road-checkpoint:bc", "road-checkpoint:cd"]);
  assert.equal(first?.totalLengthMeters, 300);
});

test("keeps SDK courses playable across geography and skin combinations", () => {
  const buildings = Array.from({ length: 8 }, (_, index) => ({
    id: `synthetic-session-${index + 1}`, districtId: "synthetic-district", archetype: "tower" as const,
    facade: index % 5, seed: (index + 1) / 9, tokensTotal: 100, height: 8, footprint: 3,
    startedAt: index + 1, endedAt: null, active: true, builtFraction: 1, busyness: 0.2, aggregated: false, extraCount: 0,
  }));
  const model = {
    districts: [{ id: "synthetic-district", label: "Synthetic", sessionCount: buildings.length, tokensTotal: 800, activeCount: 8, anomaly: null }],
    buildings, rows: new Map(buildings.map(building => [building.id, { title: building.id }])),
    generatedAt: 0, windowStartMs: 0, windowEndMs: 1, windowLabel: "fixture",
    stats: { renderedSessions: buildings.length, aggregatedSessions: 0, totalSessions: buildings.length, tokensTotal: 800, activeCount: 8, truncated: false },
  };
  for (const base of [MIAMI_CITY_WORLD_V1, ARID_DUNES_CITY_WORLD_V1]) for (const skin of BUILTIN_CITY_SKINS_V1) {
    const world = applyCitySkinToWorldProfile(base, skin);
    const layout = layoutCityForWorld(model, null, 74031, world, "off");
    const adapted = createSdkViewForCityLayout(layout);
    assert.ok(adapted.layout.anchors.length > 3, `${base.id} with ${skin.id} exposes road anchors`);
    assert.ok(selectCheckpointRaceCourse(adapted), `${base.id} with ${skin.id} exposes a connected checkpoint route`);
    assert.equal(layout.worldProfileKey?.includes(`:${world.visuals.themeId}:`), true);
  }
});
