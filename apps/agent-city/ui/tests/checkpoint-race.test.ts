import test from "node:test";
import assert from "node:assert/strict";
import { createCityLayoutSdkView } from "../src/engine/sdk/cityLayoutAdapter.ts";
import { CheckpointRaceControllerV1, createCheckpointRacePlan, type CheckpointRaceSnapshotV1 } from "../src/game/activity/checkpointRace.ts";
import { createZoneCollectPlan, ZoneCollectControllerV1 } from "../src/game/activity/zoneCollect.ts";
import { m } from "../src/engine/worldScale.ts";

test("feeds fixed-step road-zone crossings through SDK rules to a race result", () => {
  const view = createCityLayoutSdkView({ layoutId: "race-fixture", worldRevision: "road-r1", seed: 7, preferredStart: { x: 0, z: 0 },
    roadNodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 50, z: 0 }, { id: "c", x: 100, z: 0 }, { id: "d", x: 150, z: 0 }],
    roadEdges: [
      { id: "ab", from: "a", to: "b", width: 8, kind: "local", points: [{ x: 0, z: 0 }, { x: 50, z: 0 }] },
      { id: "bc", from: "b", to: "c", width: 8, kind: "local", points: [{ x: 50, z: 0 }, { x: 100, z: 0 }] },
      { id: "cd", from: "c", to: "d", width: 8, kind: "local", points: [{ x: 100, z: 0 }, { x: 150, z: 0 }] },
    ] });
  const plan = createCheckpointRacePlan(view, 7);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  let snapshot: CheckpointRaceSnapshotV1 | null = null;
  const race = new CheckpointRaceControllerV1(plan.value, value => { snapshot = value; });
  for (const x of [0, 25, 50, 75, 100, 125]) race.fixedStep({ x, y: 0, z: 0 });
  assert.equal(snapshot?.status, "success");
  assert.equal(snapshot?.completed, 3);
  race.dispose();
});

test("refuses to synthesize a course from disconnected streets", () => {
  const view = createCityLayoutSdkView({ layoutId: "isolated", worldRevision: "r", seed: 1,
    roadNodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 40, z: 0 }, { id: "c", x: 200, z: 0 }, { id: "d", x: 240, z: 0 }],
    roadEdges: [
      { id: "ab", from: "a", to: "b", width: 6, kind: "local", points: [{ x: 0, z: 0 }, { x: 40, z: 0 }] },
      { id: "cd", from: "c", to: "d", width: 6, kind: "local", points: [{ x: 200, z: 0 }, { x: 240, z: 0 }] },
    ] });
  const course = createCheckpointRacePlan(view, 1);
  assert.equal(course.ok, false);
  if (!course.ok) assert.equal(course.diagnostics[0]?.code, "race_course_unavailable");
});

test("expires from simulation ticks and ignores later positions after terminal state", () => {
  const view = createCityLayoutSdkView({ layoutId: "timeout-fixture", worldRevision: "road-r1", seed: 8, preferredStart: { x: 0, z: 0 },
    roadNodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 50, z: 0 }, { id: "c", x: 100, z: 0 }, { id: "d", x: 150, z: 0 }],
    roadEdges: [
      { id: "ab", from: "a", to: "b", width: 8, kind: "local", points: [{ x: 0, z: 0 }, { x: 50, z: 0 }] },
      { id: "bc", from: "b", to: "c", width: 8, kind: "local", points: [{ x: 50, z: 0 }, { x: 100, z: 0 }] },
      { id: "cd", from: "c", to: "d", width: 8, kind: "local", points: [{ x: 100, z: 0 }, { x: 150, z: 0 }] },
    ] });
  const plan = createCheckpointRacePlan(view, 8);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const race = new CheckpointRaceControllerV1(plan.value, () => {});
  for (let tick = 0; tick <= 2_700; tick += 1) race.fixedStep({ x: 0, y: 0, z: 0 });
  assert.equal(race.snapshot.status, "failure");
  assert.equal(race.snapshot.elapsedSeconds, 45);
  race.fixedStep({ x: 25, y: 0, z: 0 });
  assert.equal(race.snapshot.status, "failure");
  race.dispose();
});

test("runs a separate zone-collect package through the same mounted SDK runtime", () => {
  const view = createCityLayoutSdkView({ layoutId: "collect-fixture", worldRevision: "road-r1", seed: 9, preferredStart: { x: 0, z: 0 },
    roadNodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 50, z: 0 }, { id: "c", x: 100, z: 0 }, { id: "d", x: 150, z: 0 }],
    roadEdges: [
      { id: "ab", from: "a", to: "b", width: 8, kind: "local", points: [{ x: 0, z: 0 }, { x: 50, z: 0 }] },
      { id: "bc", from: "b", to: "c", width: 8, kind: "local", points: [{ x: 50, z: 0 }, { x: 100, z: 0 }] },
      { id: "cd", from: "c", to: "d", width: 8, kind: "local", points: [{ x: 100, z: 0 }, { x: 150, z: 0 }] },
    ] });
  const plan = createZoneCollectPlan(view);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.value.pack.id, "official-zone-collect-v1");
  let latest: CheckpointRaceSnapshotV1 | null = null;
  const controller = new ZoneCollectControllerV1(plan.value, value => { latest = value; });
  controller.fixedStep({ x: m(plan.value.course.startPositionMeters.x), y: 0, z: m(plan.value.course.startPositionMeters.z) });
  for (const target of plan.value.checkpointGeometry) controller.fixedStep({ x: m(target.x), y: 0, z: m(target.z) });
  assert.equal(latest?.status, "success");
  assert.equal(latest?.completed, 3);
  controller.dispose();
});
