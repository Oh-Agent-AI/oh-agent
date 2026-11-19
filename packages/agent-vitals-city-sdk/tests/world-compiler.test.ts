import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CityWorldCompileError, compileWorld, compileWorldResult, createSeededRandomV1,
  createStableIdV1, stableIdV1,
} from "../src/authoring";
import { canonicalDigest, sha256Text } from "../src/digest";
import { canonicalJson } from "../src/package";
import { computeCityWorldDigests, validateCityWorldSnapshot, validateWorldPlan } from "../src/sharedValidate";
import {
  compileWorldFixtureV1, createWorldCompilerFixtureV1, reverseWorldPlanCollections,
  verifyWorldCompilerDeterminism,
} from "../src/testing";
import { segmentCrossesWorldVolume, segmentPassesRingGate, sweepSegmentThroughVolumes } from "../src/worldVolumes";
import type { CityWorldSnapshotV4, WorldPlanV1 } from "../src/contracts";

const mutable = <T>(value: T): T => structuredClone(value);
const firstCode = (result: { ok: boolean; diagnostics: readonly { code: string }[] }): string | undefined => result.ok ? undefined : result.diagnostics[0]?.code;

test("stable IDs use semantic keys rather than array positions or random identity", () => {
  assert.equal(stableIdV1("object", "Harbor Master"), "object:harbor-master");
  assert.equal(createStableIdV1("anchor", "Entry/North"), "anchor:entry-north");
  assert.equal(stableIdV1("object", "Café"), "object:cafe");
  assert.equal(stableIdV1("object", "a".repeat(300)), stableIdV1("object", "a".repeat(300)));
  assert.ok(stableIdV1("object", "a".repeat(300)).length <= 128);
  assert.throws(() => stableIdV1("Object", "harbor"), /namespace/);
  assert.throws(() => stableIdV1("object", "---"), /identity/);
});

test("SHA-256 and canonical digest match fixed vectors", () => {
  assert.equal(sha256Text("abc"), "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(canonicalDigest({ b: 2, a: 1 }), canonicalDigest({ a: 1, b: 2 }));
});

test("seeded randomness is repeatable and bounded", () => {
  const first = createSeededRandomV1(42), second = createSeededRandomV1(42);
  const values = Array.from({ length: 16 }, () => first());
  assert.deepEqual(values, Array.from({ length: 16 }, () => second()));
  assert.ok(values.every(value => value >= 0 && value < 1));
});

test("WorldPlan routes compile to canonical roads with exact endpoint mapping", () => {
  const snapshot = compileWorldFixtureV1();
  assert.equal(snapshot.schemaVersion, 4);
  assert.equal(snapshot.roads.length, 1);
  assert.deepEqual(snapshot.roads[0], {
    id: "road:harbor-entry", kind: "road", fromAnchorId: "anchor:entry", toAnchorId: "anchor:harbor",
    directed: false, travelModes: ["walk"], centerline: [[0, 0, 0], [10, 0, 0]],
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.roads[0]?.centerline[0]), true);
  assert.equal(validateCityWorldSnapshot(snapshot).ok, true);
});

test("compiler is deterministic across collection order and separate Node processes", () => {
  const fixture = createWorldCompilerFixtureV1();
  const evidence = verifyWorldCompilerDeterminism(fixture.plan, fixture.context, 4);
  const direct = compileWorld(fixture.plan, fixture.context);
  const reversed = compileWorld(reverseWorldPlanCollections(fixture.plan), fixture.context);
  assert.equal(direct.header.snapshotDigest, reversed.header.snapshotDigest);
  assert.equal(direct.header.topologyDigest, reversed.header.topologyDigest);
  assert.equal(evidence.snapshotDigest, direct.header.snapshotDigest);

  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const script = `import { compileWorldFixtureV1 } from ${JSON.stringify(new URL("../dist/testing.js", import.meta.url).href)}; process.stdout.write(JSON.stringify(compileWorldFixtureV1()));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: packageRoot, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(canonicalJson(JSON.parse(child.stdout)), canonicalJson(direct));
});

test("cityRevision is a CAS identity and does not alter content digests", () => {
  const snapshot = compileWorldFixtureV1();
  const changed = mutable(snapshot);
  changed.header.cityRevision += 100;
  const checked = validateCityWorldSnapshot(changed);
  assert.equal(checked.ok, true);
  if (checked.ok) {
    assert.equal(checked.value.header.snapshotDigest, snapshot.header.snapshotDigest);
    assert.equal(checked.value.header.revisions.worldRevision, snapshot.header.revisions.worldRevision);
  }
});

test("Place and semantic environment changes use independent revision domains", () => {
  const snapshot = compileWorldFixtureV1();
  const placeChanged = mutable(snapshot);
  placeChanged.places[0]!.displayName = "New Harbor";
  const placeDigests = computeCityWorldDigests(placeChanged);
  assert.notEqual(placeDigests.revisions.placeRevision, snapshot.header.revisions.placeRevision);
  assert.notEqual(placeDigests.snapshotDigest, snapshot.header.snapshotDigest);
  assert.equal(placeDigests.revisions.worldRevision, snapshot.header.revisions.worldRevision);
  assert.equal(placeDigests.revisions.residentRevision, snapshot.header.revisions.residentRevision);

  const environmentChanged = mutable(snapshot);
  environmentChanged.environment.medium = "water";
  const environmentDigests = computeCityWorldDigests(environmentChanged);
  assert.notEqual(environmentDigests.revisions.environmentRevision, snapshot.header.revisions.environmentRevision);
  assert.notEqual(environmentDigests.revisions.worldRevision, snapshot.header.revisions.worldRevision);
  assert.equal(environmentDigests.topologyDigest, snapshot.header.topologyDigest);
  assert.equal(environmentDigests.revisions.weatherRevision, snapshot.header.revisions.weatherRevision);
  assert.equal(environmentDigests.revisions.clockRevision, snapshot.header.revisions.clockRevision);
});

test("runtime-owned dynamic revisions can advance without changing spatial digests", () => {
  const snapshot = mutable(compileWorldFixtureV1());
  snapshot.header.revisions.weatherRevision = "weather-runtime-9";
  snapshot.header.revisions.clockRevision = "clock-runtime-4";
  snapshot.header.revisions.appearanceRevision = "appearance-runtime-2";
  snapshot.header.revisions.renderRevision = "render-runtime-3";
  snapshot.header.revisions.interactionRevision = "interaction-runtime-8";
  const checked = validateCityWorldSnapshot(snapshot);
  assert.equal(checked.ok, true);
  if (checked.ok) {
    assert.equal(checked.value.header.revisions.worldRevision, snapshot.header.revisions.worldRevision);
    assert.equal(checked.value.header.snapshotDigest, snapshot.header.snapshotDigest);
  }
});

test("snapshot tampering fails closed against topology, revision, and snapshot digests", () => {
  const snapshot = mutable(compileWorldFixtureV1());
  snapshot.roads[0]!.kind = "tunnel";
  assert.equal(firstCode(validateCityWorldSnapshot(snapshot)), "city_topology_digest_mismatch");
  snapshot.header.topologyDigest = computeCityWorldDigests(snapshot).topologyDigest;
  assert.equal(firstCode(validateCityWorldSnapshot(snapshot)), "city_snapshot_digest_mismatch");
});

test("all world references are validated across sites, objects, anchors, volumes, places, and residents", () => {
  const cases: Array<[string, (plan: WorldPlanV1) => void]> = [
    ["city_reference_missing", plan => { plan.sites[0]!.objectIds = ["object:missing"]; }],
    ["city_reference_missing", plan => { plan.objects[0]!.siteId = "site:missing"; }],
    ["city_reference_missing", plan => { plan.anchors[0]!.objectId = "object:missing"; }],
    ["city_reference_missing", plan => { plan.volumes[0]!.objectId = "object:missing"; }],
    ["city_reference_missing", plan => { plan.places[0]!.objectRef = "anchor:missing"; }],
    ["city_reference_missing", plan => { plan.residents[0]!.homePlaceId = "place:missing"; }],
    ["city_reference_missing", plan => { plan.residents[0]!.schedule![0]!.placeId = "place:missing"; }],
    ["city_reference_missing", plan => { plan.routes[0]!.toAnchorId = "anchor:missing"; }],
  ];
  for (const [code, mutate] of cases) {
    const fixture = createWorldCompilerFixtureV1();
    const plan = mutable(fixture.plan);
    mutate(plan);
    assert.equal(firstCode(compileWorldResult(plan, fixture.context)), code);
  }
});

test("duplicate IDs fail across the shared City namespace", () => {
  const fixture = createWorldCompilerFixtureV1();
  const plan = mutable(fixture.plan);
  plan.volumes[0]!.id = "object:harbor-master";
  assert.equal(firstCode(validateWorldPlan(plan)), "city_duplicate_stable_id");
});

test("road endpoints, travel modes, and self-intersections are rejected", () => {
  const disconnected = createWorldCompilerFixtureV1();
  const disconnectedPlan = mutable(disconnected.plan);
  disconnectedPlan.routes[0]!.centerline = [[0, 0, 0], [9, 0, 0]];
  assert.equal(firstCode(validateWorldPlan(disconnectedPlan)), "city_road_centerline_disconnected");

  const unsupported = createWorldCompilerFixtureV1();
  const unsupportedPlan = mutable(unsupported.plan);
  unsupportedPlan.routes[0]!.travelModes = ["drive"];
  assert.equal(firstCode(validateWorldPlan(unsupportedPlan)), "city_road_travel_mode_unsupported");

  const crossing = createWorldCompilerFixtureV1();
  const crossingPlan = mutable(crossing.plan);
  crossingPlan.anchors[1]!.position = [10, 0, 0];
  crossingPlan.routes[0]!.centerline = [[0, 0, 0], [10, 0, 10], [0, 0, 10], [10, 0, 0]];
  assert.equal(firstCode(validateWorldPlan(crossingPlan)), "city_road_centerline_self_intersects");
});

test("malformed numbers, transforms, bounds, and volumes fail closed", () => {
  const mutations: Array<[string, (plan: WorldPlanV1) => void]> = [
    ["city_number_invalid", plan => { plan.anchors[0]!.position = [Number.NaN, 0, 0]; }],
    ["city_number_invalid", plan => { plan.anchors[0]!.position = [-0, 0, 0]; }],
    ["city_quaternion_invalid", plan => { plan.objects[0]!.transform.rotation = [0, 0, 0, 0]; }],
    ["city_scale_invalid", plan => { plan.objects[0]!.transform.scale = [0, 1, 1]; }],
    ["city_bounds_invalid", plan => { plan.objects[0]!.bounds = { min: [2, 0, 0], max: [1, 1, 1] }; }],
    ["city_volume_geometry_invalid", plan => {
      plan.volumes[1]!.geometry = { kind: "ring", center: [0, 0, 0], normal: [0, 0, 0], innerRadiusMeters: 2, outerRadiusMeters: 1, thicknessMeters: 1 };
    }],
  ];
  for (const [code, mutate] of mutations) {
    const fixture = createWorldCompilerFixtureV1();
    const plan = mutable(fixture.plan);
    mutate(plan);
    assert.equal(firstCode(validateWorldPlan(plan)), code);
  }
});

test("compileWorld throws typed diagnostics while compileWorldResult preserves Result style", () => {
  const fixture = createWorldCompilerFixtureV1();
  const plan = mutable(fixture.plan);
  plan.routes[0]!.fromAnchorId = "anchor:missing";
  assert.throws(() => compileWorld(plan, fixture.context), error => {
    assert.ok(error instanceof CityWorldCompileError);
    assert.equal(error.diagnostics[0]?.code, "city_reference_missing");
    return true;
  });
  assert.equal(compileWorldResult(plan, fixture.context).ok, false);
});

test("static volume crossings support water, convex prisms, and rings without claiming pathfinding", () => {
  const snapshot: CityWorldSnapshotV4 = compileWorldFixtureV1();
  const water = snapshot.volumes.find(volume => volume.id === "volume:harbor-water")!;
  const ring = snapshot.volumes.find(volume => volume.id === "volume:harbor-ring")!;
  assert.equal(segmentCrossesWorldVolume([0, -2, 0], [0, 1, 0], water), true);
  assert.equal(segmentCrossesWorldVolume([0, 1, 0], [0, 2, 0], water), false);
  assert.equal(segmentCrossesWorldVolume([0, 2, 0], [10, 2, 0], ring), true);
  assert.equal(segmentCrossesWorldVolume([0, 5, 0], [10, 5, 0], ring), false);
  assert.equal(segmentPassesRingGate([0, 1, 0], [10, 1, 0], ring), true);
  assert.equal(segmentPassesRingGate([0, 2.5, 0], [10, 2.5, 0], ring), false);
  assert.equal(segmentPassesRingGate([0, 5, 0], [10, 5, 0], ring), false);
  assert.equal(segmentPassesRingGate([0, 1, 0], [0, 1, 10], ring), false);
  assert.deepEqual(sweepSegmentThroughVolumes([0, -1, 0], [10, -1, 0], snapshot.volumes), ["volume:harbor-ring", "volume:harbor-water"]);

  const prism = mutable(water);
  prism.geometry = { kind: "convex-prism", polygonXZ: [[0, 0], [2, 0], [2, 2], [0, 2]], minY: 0, maxY: 2 };
  assert.equal(segmentCrossesWorldVolume([-1, 1, 1], [3, 1, 1], prism), true);
  assert.equal(segmentCrossesWorldVolume([-1, 3, 1], [3, 3, 1], prism), false);
});

test("WorldPlan preserves an explicitly declared semantic environment", () => {
  const fixture = createWorldCompilerFixtureV1();
  const plan = { ...fixture.plan, environment: { medium: "water" as const, biome: "underwater" } };
  const snapshot = compileWorld(plan, fixture.context);
  assert.deepEqual(snapshot.environment, { medium: "water", biome: "underwater" });
  assert.notEqual(snapshot.header.revisions.environmentRevision, compileWorldFixtureV1().header.revisions.environmentRevision);
});
