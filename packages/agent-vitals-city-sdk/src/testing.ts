import { compileWorld } from "./authoring";
import type { CityWorldSnapshotV4, CompileContextV1, WorldPlanV1 } from "./contracts";
import { canonicalJson } from "./package";

export { segmentCrossesWorldVolume, segmentIntersectsVolumeGeometry, sweepSegmentThroughVolumes } from "./worldVolumes";

export interface WorldCompilerFixtureV1 {
  readonly plan: WorldPlanV1;
  readonly context: CompileContextV1;
}

export function createWorldCompilerFixtureV1(): WorldCompilerFixtureV1 {
  return {
    plan: {
      schemaVersion: 1,
      terrain: { format: "heightfield-tiles-v1", tiles: [] },
      sites: [{ id: "site:harbor", kind: "harbor", bounds: { min: [0, 0, 0], max: [20, 10, 20] }, objectIds: ["object:harbor-master"], placeId: "place:harbor" }],
      routes: [{
        id: "road:harbor-entry", kind: "road", fromAnchorId: "anchor:entry", toAnchorId: "anchor:harbor",
        bidirectional: true, travelModes: ["walk"], centerline: [[0, 0, 0], [10, 0, 0]],
      }],
      objects: [{
        id: "object:harbor-master", kind: "building", siteId: "site:harbor",
        transform: { position: [10, 0, 5], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        bounds: { min: [8, 0, 3], max: [12, 5, 7] }, collision: { kind: "box" },
      }],
      anchors: [
        { id: "anchor:entry", kind: "spawn", position: [0, 0, 0], travelModes: ["walk"] },
        { id: "anchor:harbor", kind: "object", position: [10, 0, 0], objectId: "object:harbor-master", travelModes: ["walk"] },
      ],
      volumes: [
        { id: "volume:harbor-water", kind: "water", geometry: { kind: "box", bounds: { min: [-20, -5, -20], max: [20, -1, 20] } }, travelModes: ["swim", "submersible"] },
        { id: "volume:harbor-ring", kind: "checkpoint", geometry: { kind: "ring", center: [5, 1, 0], normal: [1, 0, 0], innerRadiusMeters: 1, outerRadiusMeters: 2, thicknessMeters: 1 } },
      ],
      places: [{ id: "place:harbor", kind: "harbor", displayName: "Harbor", objectRef: "object:harbor-master", activities: ["meet", "trade"] }],
      residents: [{
        id: "resident:keeper", displayName: "Keeper", prefabRef: "prefab:keeper", homePlaceId: "place:harbor",
        schedule: [{ daysOfWeek: [1, 2, 3, 4, 5], startLocalTime: "08:00", endLocalTime: "17:00", placeId: "place:harbor" }],
        interactions: ["speak"],
      }],
    },
    context: {
      cityId: "city-fixture", cityRevision: 7, seed: 42,
      generator: { id: "fixture-generator", contractVersion: 1, version: "1.0.0", codeDigest: `sha256:${"a".repeat(64)}` },
      assetsDigest: `sha256:${"b".repeat(64)}`,
      capabilities: ["world.snapshot", "roads.graph", "sites.indexed", "objects.indexed", "volumes.indexed", "places.registry", "residents.registry"],
    },
  };
}

export function reverseWorldPlanCollections(plan: WorldPlanV1): WorldPlanV1 {
  return {
    ...plan,
    terrain: { ...plan.terrain, tiles: [...plan.terrain.tiles].reverse() },
    sites: [...plan.sites].reverse(), routes: [...plan.routes].reverse(), objects: [...plan.objects].reverse(),
    anchors: [...plan.anchors].reverse(), volumes: [...plan.volumes].reverse(), places: [...plan.places].reverse(),
    residents: [...plan.residents].reverse(),
  };
}

export interface WorldDeterminismEvidenceV1 {
  readonly schemaVersion: 1;
  readonly runs: number;
  readonly snapshotDigest: string;
  readonly worldRevision: string;
  readonly topologyDigest: string;
}

export function verifyWorldCompilerDeterminism(plan: WorldPlanV1, context: CompileContextV1, runs = 2): WorldDeterminismEvidenceV1 {
  if (!Number.isSafeInteger(runs) || runs < 2 || runs > 100) throw new TypeError("Determinism runs must be an integer from 2 to 100.");
  const first = compileWorld(plan, context);
  for (let run = 1; run < runs; run += 1) {
    const candidate = compileWorld(run % 2 === 0 ? plan : reverseWorldPlanCollections(plan), context);
    if (canonicalJson(candidate) !== canonicalJson(first)) throw new Error("City world compiler output changed across equivalent runs.");
  }
  return Object.freeze({
    schemaVersion: 1, runs, snapshotDigest: first.header.snapshotDigest,
    worldRevision: first.header.revisions.worldRevision, topologyDigest: first.header.topologyDigest,
  });
}

export function compileWorldFixtureV1(): CityWorldSnapshotV4 {
  const fixture = createWorldCompilerFixtureV1();
  return compileWorld(fixture.plan, fixture.context);
}
