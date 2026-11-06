import assert from "node:assert/strict";
import test from "node:test";
import { createAssaultGaitPlan, createStrideProfile, sampleAssaultGait } from "../src/render/mecha/assaultGait.ts";
import { createAssaultPerformancePlan } from "../src/render/mecha/assaultPerformance.ts";
import type { MechaPerformanceEvent } from "../src/render/mecha/performance.ts";
import * as THREE from "three";
import { AssaultTurnIK } from "../src/render/mecha/assaultTurnIK.ts";
import { reachableAssaultDown, solveAssaultLeg } from "../src/render/mecha/assaultLegIK.ts";
import { assaultGroundOrientation } from "../src/render/mecha/assaultGround.ts";
import { createAssaultCityGround } from "../src/game/assaultCityGround.ts";
import { compileGroundRoadSurface, type CompiledGroundRoadSurface } from "../src/engine/surface/groundRoadCompiler.ts";
import { buildCityModel } from "../src/cityModel.ts";
import { layoutCity } from "../src/engine/cityLayout.ts";
import { MIAMI_COASTAL } from "../src/engine/citySeaside.ts";
import { terrainSurfaceHeight } from "../src/engine/surface/terrainSampling.ts";
import { sampleAssaultTerrainSafety } from "../src/game/mecha/assaultTerrainSafety.ts";
import { assaultTerrainBlocked, movementPath, stepCost, swapEventSink, type TurnEvent } from "../src/game/mecha/board.ts";
import { tryPushMech } from "../src/game/mecha/combat.ts";
import { matchFromSite } from "../src/game/mecha/matchFromSite.ts";
import { anchorsFromCity, siteFightShapes } from "../src/game/mecha/citySite.ts";
import type { CityLayout } from "../src/engine/cityLayout.ts";

const a = { x: 0, y: 0, z: 0 }, b = { x: 8, y: 1, z: 0 }, c = { x: 8, y: 2, z: 8 };
const profile = createStrideProfile([0, 1, 1, 3, 4]);
const turn = (angle: number) => .4 + Math.abs(angle) * .2;

test("gait schedules arbitrary initial facing, elevated turns and every route segment", () => {
  const plan = createAssaultGaitPlan([a, b, c], .37, 1.4, .25, turn);
  assert.deepEqual(plan.stages.map((stage) => stage.kind), ["turn", "walk", "turn", "walk"]);
  assert.ok(Math.abs((plan.stages[0] as any).delta - (-Math.PI / 2 - .37)) < 1e-10);
  const firstWalk = plan.stages[1]!, corner = plan.stages[2]!, secondWalk = plan.stages[3]!;
  assert.equal(firstWalk.kind, "walk"); assert.equal(corner.kind, "turn"); assert.equal(secondWalk.kind, "walk");
  assert.deepEqual(sampleAssaultGait(plan, corner.start, profile).position, b);
  assert.deepEqual(sampleAssaultGait(plan, secondWalk.start, profile).position, b);
  assert.deepEqual(sampleAssaultGait(plan, plan.duration, profile), { kind: "done", position: c, yaw: -Math.PI, phase: 0 });
  const middle = sampleAssaultGait(plan, firstWalk.start + firstWalk.duration / 2, profile);
  assert.equal(middle.kind, "walk"); assert.ok(Math.abs(middle.position.y - .5) < 1e-10);
});

test("gait adds stationary transitions before the first walk and after turns", () => {
  const plan = createAssaultGaitPlan([a, b, c], .37, 1.4, .25, turn, .8);
  assert.deepEqual(plan.stages.map((stage) => stage.kind), ["turn", "transition", "walk", "turn", "transition", "walk"]);
  for (const index of [1, 4]) {
    const stage = plan.stages[index]!, preceding = plan.stages[index - 1]!, walk = plan.stages[index + 1]!;
    assert.equal(stage.kind, "transition"); assert.equal(preceding.kind, "turn"); assert.equal(walk.kind, "walk");
    assert.equal(stage.start, preceding.start + preceding.duration);
    assert.equal(walk.start, stage.start + stage.duration);
    assert.deepEqual(stage.at, walk.from);
    assert.equal(stage.turnYaw, preceding.yaw); assert.equal(stage.turnDelta, preceding.delta); assert.equal(stage.yaw, walk.yaw);
    assert.deepEqual(sampleAssaultGait(plan, stage.start, profile), { kind: "transition", position: stage.at, yaw: stage.yaw, turnYaw: stage.turnYaw, turnDelta: stage.turnDelta, phase: 0 });
    const mid = sampleAssaultGait(plan, stage.start + stage.duration / 2, profile);
    assert.equal(mid.kind, "transition"); assert.ok(Math.abs(mid.phase - .5) < 1e-10); assert.deepEqual(mid.position, stage.at);
    assert.equal(sampleAssaultGait(plan, walk.start, profile).kind, "walk");
  }
  const straight = createAssaultGaitPlan([a, b], -Math.PI / 2, 2, .25, turn, .8);
  assert.deepEqual(straight.stages.map((stage) => stage.kind), ["transition", "walk"]);
  assert.equal(straight.stages[0]!.kind === "transition" && straight.stages[0]!.turnDelta, 0);
  const repeated = createAssaultGaitPlan([a, a, b], -Math.PI / 2, 2, .25, turn, .8);
  assert.deepEqual(repeated.stages.map((stage) => stage.kind), ["transition", "walk"]);
  assert.throws(() => createAssaultGaitPlan([a, b], 0, 2, .25, turn, -1));
  assert.throws(() => createAssaultGaitPlan([a, b], 0, 2, .25, turn, NaN));
});

test("stride progression preserves support plateaus and is independent of caller frame rate", () => {
  assert.equal(profile(.25), .25); assert.equal(profile(.5), .25);
  const plan = createAssaultGaitPlan([a, b], -Math.PI / 2, 2, .25, turn);
  for (const time of [0, .125, .25, .75, .99]) {
    const sample = sampleAssaultGait(plan, time, profile);
    assert.equal(sample.kind, "walk");
    assert.deepEqual(sample, sampleAssaultGait(plan, time, profile));
  }
  assert.deepEqual(sampleAssaultGait(plan, 100, profile).position, b);
});

test("stationary and repeated waypoints preserve placement without manufacturing movement", () => {
  const plan = createAssaultGaitPlan([a, a, b, b], -Math.PI / 2, 2, .25, turn);
  assert.equal(plan.stages.length, 1);
  const still = createAssaultGaitPlan([a], 1, 2, .25, turn);
  assert.equal(still.duration, 0); assert.deepEqual(sampleAssaultGait(still, 0, profile).position, a);
});

test("invalid route, profile, time or turn duration never produces an invalid pose", () => {
  assert.throws(() => createAssaultGaitPlan([], 0, 1, 1, turn));
  assert.throws(() => createAssaultGaitPlan([a, { ...a, y: 1 }], 0, 1, 1, turn));
  assert.throws(() => createAssaultGaitPlan([a, b], 0, 1, 1, () => NaN));
  assert.throws(() => createStrideProfile([0, 2, 1]));
  assert.throws(() => createStrideProfile([0, 0]));
  const plan = createAssaultGaitPlan([a, b], -Math.PI / 2, 1, 1, turn);
  assert.throws(() => sampleAssaultGait(plan, NaN, profile));
  assert.throws(() => sampleAssaultGait(plan, .3, () => 2));
});

const cellToWorld = (cell: { x: number; y: number }) => ({ x: cell.x * 8, y: 0, z: cell.y * 8 });

test("Assault timeline retains event order and carries facing into movement and attacks", () => {
  const events: MechaPerformanceEvent[] = [
    { kind: "move", actor: "Assault", path: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], duration: .48 },
    { kind: "attack", actor: "Gunner", attack: "shoot", from: { x: 2, y: 0 }, target: { x: 1, y: 1 }, targetIds: ["Assault"], duration: .7 },
    { kind: "attack", actor: "Assault", attack: "melee", from: { x: 1, y: 1 }, target: { x: 2, y: 1 }, targetIds: ["boss"], duration: .62 },
    { kind: "death", actor: "boss", at: { x: 2, y: 1 }, duration: .85 },
  ];
  const plan = createAssaultPerformancePlan(events, "Assault", .37, cellToWorld, 2, .25, turn);
  assert.deepEqual(plan.entries.map((entry) => entry.event), events);
  const [move, gunner, attack, death] = plan.entries;
  assert.deepEqual(move!.gait!.stages.map((stage) => stage.kind), ["turn", "walk", "turn", "walk"]);
  assert.equal(gunner!.duration, .7); assert.equal(death!.duration, .85);
  assert.ok(Math.abs(attack!.attackTurn!.yaw + Math.PI) < 1e-10);
  assert.ok(Math.abs(attack!.attackTurn!.delta - Math.PI / 2) < 1e-10);
  assert.equal(attack!.duration, .62 + attack!.attackTurn!.duration);
  assert.equal(gunner!.start, move!.duration);
  assert.equal(attack!.start, gunner!.start + gunner!.duration);
  assert.equal(plan.duration, death!.start + death!.duration);
  assert.ok(Math.abs(plan.endYaw + Math.PI / 2) < 1e-10);
});

test("Assault timeline includes requested movement transition time without changing other events", () => {
  const events: MechaPerformanceEvent[] = [
    { kind: "move", actor: "Assault", path: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], duration: .48 },
    { kind: "attack", actor: "Gunner", attack: "shoot", from: { x: 2, y: 0 }, target: { x: 1, y: 1 }, targetIds: ["Assault"], duration: .7 },
  ];
  const original = createAssaultPerformancePlan(events, "Assault", .37, cellToWorld, 2, .25, turn);
  const plan = createAssaultPerformancePlan(events, "Assault", .37, cellToWorld, 2, .25, turn, .8);
  assert.deepEqual(plan.entries[0]!.gait!.stages.map((stage) => stage.kind), ["turn", "transition", "walk", "turn", "transition", "walk"]);
  assert.ok(Math.abs(plan.entries[0]!.duration - original.entries[0]!.duration - 1.6) < 1e-10);
  assert.equal(plan.entries[1]!.start, plan.entries[0]!.duration); assert.equal(plan.entries[1]!.duration, .7);
  assert.throws(() => createAssaultPerformancePlan(events, "Assault", 0, cellToWorld, 2, .25, turn, -1));
});

test("Assault knockback preserves heading and a later voluntary move turns toward its path", () => {
  const events: MechaPerformanceEvent[] = [
    { kind: "knockback", actor: "Assault", path: [{ x: 0, y: 0 }, { x: 0, y: 1 }], duration: .32 },
    { kind: "attack", actor: "Assault", attack: "repair", from: { x: 0, y: 1 }, target: { x: 0, y: 1 }, targetIds: [], duration: .9 },
    { kind: "move", actor: "Assault", path: [{ x: 0, y: 1 }, { x: 0, y: 2 }], duration: .3 },
  ];
  const plan = createAssaultPerformancePlan(events, "Assault", 0, cellToWorld, 2, .25, turn);
  assert.equal(plan.entries[0]!.duration, .32);
  assert.equal(plan.entries[0]!.endYaw, 0);
  assert.equal(plan.entries[1]!.attackTurn, undefined);
  assert.equal(plan.entries[2]!.gait!.stages[0]!.kind, "turn");
});

test("Assault timeline rejects malformed paths, event durations, coordinates and turns", () => {
  const move: MechaPerformanceEvent = { kind: "move", actor: "Assault", path: [{ x: 0, y: 0 }, { x: 1, y: 0 }], duration: .3 };
  assert.throws(() => createAssaultPerformancePlan([{ ...move, duration: 0 }], "Assault", 0, cellToWorld, 2, .25, turn));
  assert.throws(() => createAssaultPerformancePlan([{ ...move, path: [{ x: 0, y: 0 }] }], "Assault", 0, cellToWorld, 2, .25, turn));
  assert.throws(() => createAssaultPerformancePlan([move], "Assault", 0, () => ({ x: NaN, y: 0, z: 0 }), 2, .25, turn));
  assert.throws(() => createAssaultPerformancePlan([move], "Assault", 0, cellToWorld, 2, .25, () => NaN));
});

function turnFixture() {
  const parent = new THREE.Group(), root = new THREE.Group(), pelvis = new THREE.Bone();
  parent.add(root); root.add(pelvis); pelvis.name = "pelvis"; pelvis.position.y = 4;
  for (const [side, x] of [["L", -1], ["R", 1]] as const) {
    const thigh = new THREE.Bone(), shin = new THREE.Bone(), foot = new THREE.Bone();
    thigh.name = `thigh${side}`; shin.name = `shin${side}`; foot.name = `foot${side}`;
    thigh.position.x = x; shin.position.set(0, -2, .4); foot.position.set(0, -2, -.4);
    pelvis.add(thigh); thigh.add(shin); shin.add(foot);
  }
  return { parent, root };
}

test("leg IK reaches a local contact target while preserving both lengths and foot orientation", () => {
  const { parent, root } = turnFixture();
  parent.position.set(3, -1, 4); parent.rotation.set(.14, -.5, .2); parent.scale.setScalar(1.4);
  root.updateWorldMatrix(true, true);
  const thigh = root.getObjectByName("thighL")!, shin = root.getObjectByName("shinL")!, foot = root.getObjectByName("footL")!;
  const pos = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
  const leg = { thigh, shin, foot, upper: pos(thigh).distanceTo(pos(shin)), lower: pos(shin).distanceTo(pos(foot)) };
  const target = pos(foot).add(new THREE.Vector3(.08, .18, -.04));
  const rotation = foot.getWorldQuaternion(new THREE.Quaternion());
  solveAssaultLeg(root, leg, target, rotation);
  assert.ok(pos(foot).distanceTo(target) < 1e-6);
  assert.ok(Math.abs(pos(thigh).distanceTo(pos(shin)) - leg.upper) < 1e-6);
  assert.ok(Math.abs(pos(shin).distanceTo(pos(foot)) - leg.lower) < 1e-6);
  assert.ok(foot.getWorldQuaternion(new THREE.Quaternion()).angleTo(rotation) < 1e-6);
  const before = [thigh, shin, foot].map(o => o.quaternion.clone());
  assert.throws(() => solveAssaultLeg(root, leg, pos(thigh).add(new THREE.Vector3(0, -20, 0)), rotation), /unreachable/);
  assert.throws(() => solveAssaultLeg(root, leg, new THREE.Vector3(NaN, 0, 0), rotation), /invalid/);
  assert.throws(() => solveAssaultLeg(root, leg, target, new THREE.Quaternion(0, 0, 0, 2)), /invalid/);
  [thigh, shin, foot].forEach((o, i) => assert.ok(o.quaternion.angleTo(before[i]!) < 1e-6));
});

test("optional downward grounding stays inside leg reach without changing bone lengths", () => {
  const { root } = turnFixture(); root.updateWorldMatrix(true, true);
  const thigh = root.getObjectByName("thighL")!, shin = root.getObjectByName("shinL")!, foot = root.getObjectByName("footL")!;
  const pos = (node: THREE.Object3D) => node.getWorldPosition(new THREE.Vector3());
  const hip = pos(thigh), knee = pos(shin), ankle = pos(foot);
  const leg = { thigh, shin, foot, upper: hip.distanceTo(knee), lower: knee.distanceTo(ankle) };
  const allowed = reachableAssaultDown(hip, ankle, leg.upper, leg.lower, 2);
  assert.ok(allowed > 0 && allowed < 2);
  assert.equal(reachableAssaultDown(hip, ankle, leg.upper, leg.lower, allowed / 2), allowed / 2);
  const target = ankle.clone().add(new THREE.Vector3(0, -allowed, 0));
  solveAssaultLeg(root, leg, target, foot.getWorldQuaternion(new THREE.Quaternion()));
  assert.ok(pos(foot).distanceTo(target) < 1e-6);
  assert.ok(Math.abs(pos(thigh).distanceTo(pos(shin)) - leg.upper) < 1e-6);
  assert.ok(Math.abs(pos(shin).distanceTo(pos(foot)) - leg.lower) < 1e-6);
  assert.equal(reachableAssaultDown(hip, new THREE.Vector3(0, -10, 0), 2, 2, 1), 0);
  assert.throws(() => reachableAssaultDown(hip, ankle, leg.upper, leg.lower, NaN), /parameters/);
  const above = reachableAssaultDown(new THREE.Vector3(), new THREE.Vector3(0, 3, 0), 3, 1, 3);
  assert.ok(above > 0 && above < 1);
});

test("optional grounding retains knee bend without changing leg length or foot angle", () => {
  const { root } = turnFixture(); root.updateWorldMatrix(true, true);
  const thigh = root.getObjectByName("thighL")!, shin = root.getObjectByName("shinL")!, foot = root.getObjectByName("footL")!;
  const pos = (node: THREE.Object3D) => node.getWorldPosition(new THREE.Vector3());
  const hip = pos(thigh), knee = pos(shin), ankle = pos(foot);
  const leg = { thigh, shin, foot, upper: hip.distanceTo(knee), lower: knee.distanceTo(ankle) };
  const bend = (h: THREE.Vector3, k: THREE.Vector3, a: THREE.Vector3) => {
    const axis = a.clone().sub(h).normalize(), offset = k.clone().sub(h);
    return offset.addScaledVector(axis, -offset.dot(axis)).length();
  };
  const unrestricted = reachableAssaultDown(hip, ankle, leg.upper, leg.lower, 2);
  const allowed = reachableAssaultDown(hip, ankle, leg.upper, leg.lower, 2, knee);
  assert.ok(allowed > 0 && allowed < unrestricted);
  const rotation = foot.getWorldQuaternion(new THREE.Quaternion());
  const target = ankle.clone().add(new THREE.Vector3(0, -allowed, 0));
  solveAssaultLeg(root, leg, target, rotation);
  assert.ok(bend(pos(thigh), pos(shin), pos(foot)) >= bend(hip, knee, ankle) * .5 - 1e-6);
  assert.ok(pos(foot).distanceTo(target) < 1e-6);
  assert.ok(Math.abs(pos(thigh).distanceTo(pos(shin)) - leg.upper) < 1e-6);
  assert.ok(Math.abs(pos(shin).distanceTo(pos(foot)) - leg.lower) < 1e-6);
  assert.ok(foot.getWorldQuaternion(new THREE.Quaternion()).angleTo(rotation) < 1e-6);
  assert.equal(reachableAssaultDown(hip, ankle, leg.upper, leg.lower, 0, knee), 0);
  assert.throws(() => reachableAssaultDown(hip, ankle, leg.upper, leg.lower, 1, new THREE.Vector3(NaN, 0, 0)), /parameters/);
  assert.throws(() => reachableAssaultDown(hip, ankle, leg.upper, leg.lower, 1, hip), /knee/);
  const above = reachableAssaultDown(new THREE.Vector3(), new THREE.Vector3(0, 3, 0), 3, 1, 3, new THREE.Vector3(Math.sqrt(35) / 6, 17 / 6, 0));
  assert.ok(above >= 0 && above < 1);
});

test("turn IK preserves segment lengths and the supporting ankle at arbitrary angles", () => {
  const { parent, root } = turnFixture();
  parent.position.set(5, 2, -3); parent.rotation.set(.18, .4, -.22); parent.scale.setScalar(1.2); root.rotation.y = -.7;
  const ik = new AssaultTurnIK(root, .15, .2);
  const pos = (name: string) => root.getObjectByName(name)!.getWorldPosition(new THREE.Vector3());
  const lengths = ["L", "R"].map((side) => [pos(`thigh${side}`).distanceTo(pos(`shin${side}`)), pos(`shin${side}`).distanceTo(pos(`foot${side}`))]);
  for (const delta of [-Math.PI, -1.7, -.02, .02, 1.7, Math.PI]) {
    const steps = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 12) - 1e-10));
    let segment = -1, anchor = new THREE.Vector3();
    for (let i = 0; i <= (steps + 1) * 20; i++) {
      const phase = i / ((steps + 1) * 20); ik.sample(delta, phase);
      const current = Math.min(steps, Math.floor(phase * (steps + 1)));
      const support = pos(current % 2 === 0 ? "footR" : "footL");
      if (segment !== current) { anchor = support; segment = current; }
      assert.ok(support.distanceTo(anchor) < 1e-6);
      for (const [index, side] of ["L", "R"].entries()) {
        assert.ok(Math.abs(pos(`thigh${side}`).distanceTo(pos(`shin${side}`)) - lengths[index]![0]!) < 1e-6);
        assert.ok(Math.abs(pos(`shin${side}`).distanceTo(pos(`foot${side}`)) - lengths[index]![1]!) < 1e-6);
      }
    }
  }
});

test("turn IK refuses invalid transforms and samples rather than silently deforming legs", () => {
  const { parent, root } = turnFixture();
  parent.scale.set(1, 2, 1); assert.throws(() => new AssaultTurnIK(root, .1, .2), /uniformly scaled/);
  parent.scale.setScalar(1); parent.rotation.x = .1;
  const ik = new AssaultTurnIK(root, .1, .2);
  assert.throws(() => ik.sample(NaN, 0)); assert.throws(() => ik.sample(0, 1.1));
  parent.scale.set(-1, 1, 1); assert.throws(() => new AssaultTurnIK(root, .1, .2), /uniformly scaled/);
  parent.scale.set(1, 2, 1); root.rotation.z = Math.PI / 4;
  assert.throws(() => new AssaultTurnIK(root, .1, .2), /uniformly scaled/);
});

test("ground orientation aligns up with the plane while preserving horizontal facing", () => {
  for (const [dx, dz] of [[0, 0], [.1, -.2], [-.25, .05]]) for (const yaw of [0, .7, Math.PI / 2, -Math.PI]) {
    const q = assaultGroundOrientation(5, -2, yaw, (x, z) => dx! * x + dz! * z, 1, .5);
    const normal = new THREE.Vector3(-dx!, 1, -dz!).normalize();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    assert.ok(up.distanceTo(normal) < 1e-10);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    assert.ok(Math.abs(forward.dot(normal)) < 1e-10);
    const desired = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    assert.ok(new THREE.Vector2(forward.x, forward.z).dot(new THREE.Vector2(desired.x, desired.z)) > .9);
  }
  assert.throws(() => assaultGroundOrientation(0, 0, 0, () => NaN, 1, .5));
  assert.throws(() => assaultGroundOrientation(0, 0, 0, (x) => x, 1, .5));
  assert.throws(() => assaultGroundOrientation(0, 0, 0, () => 0, 0, .5));
});

test("city ground samples the rendered road and sidewalk triangles, including overlapping layers", () => {
  const layout = { extent: 100, terrain: { height: (x: number, z: number) => .01 * x + .02 * z }, roadEdges: [] } as unknown as Pick<CityLayout, "extent" | "terrain" | "roadEdges">;
  const base = compileGroundRoadSurface(layout);
  const geometry = (y: number) => ({ positions: [-2,y,-2, 2,y,-2, -2,y,2], index: [0,2,1] });
  const low = geometry(1), high = geometry(2);
  const layers = base.layers.map((layer, i) => i === 0 ? { ...layer, ...low, count: 3 } : i === 1 ? { ...layer, ...high, count: 3 } : layer);
  const piece = (id: string, kind: "sidewalk" | "junction", layer: number) => ({ id, kind, source: { kind: "junction" as const, id }, layer, firstIndex: 0, indexCount: 3, firstVertex: 0, vertexCount: 3, terrainDeviation: 0 });
  const ground = { ...base, layers, pieces: [piece("walk", "sidewalk", 0), piece("junction", "junction", 1)] } as CompiledGroundRoadSurface;
  const height = createAssaultCityGround(layout, ground);
  assert.equal(height(-1, -1), 2);
  assert.ok(Math.abs(height(10, 10) - .3) < 1e-9);
  assert.throws(() => height(NaN, 0), /coordinate/);
  assert.throws(() => createAssaultCityGround({ ...layout, roadEdges: [] }, ground), /layout-mismatch/);
  const sidewalk = createAssaultCityGround(layout, { ...ground, pieces: [piece("walk", "sidewalk", 0)] } as CompiledGroundRoadSurface);
  assert.equal(sidewalk(-1, -1), 1);
  let current = true;
  const leased = createAssaultCityGround(layout, ground, () => current);
  assert.equal(leased(-1, -1), 2);
  current = false;
  assert.throws(() => leased(-1, -1), /stale/);
  assert.throws(() => createAssaultCityGround(layout, ground, () => current), /stale/);
});

test("city ground matches real compiled road triangles for a generated city", () => {
  const now = Date.UTC(2026, 9, 7), day = 86400000;
  const rows = Array.from({ length: 80 }, (_, i) => ({
    session_ref: `s:${i}`, harness: i % 2 ? "harness:claude" : "harness:zcode", title: null, title_source: null,
    first_event_at: new Date(now - day * 20 + i * 3600000).toISOString(), last_event_at: new Date(now - day * 20 + (i + 2) * 3600000).toISOString(), event_count: 10, model_ids: [],
    tokens: { uncached_input_tokens: 50000 + i * 900000, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, total: 50000 + i * 900000 }, peak_tokens: 50000 + i * 900000,
    cost_minor: null, cost_status: { state: "unavailable" as const, reason: "test", has_unresolved: false },
  }));
  const model = buildCityModel({ rows, findings: [], windowStartMs: now - 30 * day, windowEndMs: now, windowLabel: "30d", totalSessions: rows.length, truncated: false, generatedAt: now });
  const layout = layoutCity(model, null, 74031, MIAMI_COASTAL, "off"), ground = compileGroundRoadSurface(layout);
  const height = createAssaultCityGround(layout, ground);
  const counts = new Map<string, number>();
  for (const piece of ground.pieces) {
    if ((counts.get(piece.kind) ?? 0) >= 20) continue;
    const layer = ground.layers[piece.layer]!;
    for (let i = piece.firstIndex; i < piece.firstIndex + piece.indexCount && (counts.get(piece.kind) ?? 0) < 20; i += 3) {
      const indices = layer.index.slice(i, i + 3);
      const point = [0, 1, 2].map((axis) => indices.reduce((sum, index) => sum + Math.fround(layer.positions[index * 3 + axis]!), 0) / 3);
      const [x, y, z] = point as [number, number, number];
      assert.ok(height(x, z) >= Math.max(y, terrainSurfaceHeight(layout, x, z)) - 1e-5, `${piece.kind} at ${x},${z}`);
      counts.set(piece.kind, (counts.get(piece.kind) ?? 0) + 1);
    }
  }
  for (const kind of ["carriageway", "sidewalk", "junction"]) assert.equal(counts.get(kind), 20, kind);
});

test("Assault terrain safety finds steep ridge cells and intervening unsafe edges", () => {
  const now = Date.UTC(2026, 9, 7), day = 86400000;
  const rows = Array.from({ length: 80 }, (_, i) => ({
    session_ref: `s:${i}`, harness: i % 2 ? "harness:claude" : "harness:zcode", title: null, title_source: null,
    first_event_at: new Date(now - day * 20 + i * 3600000).toISOString(), last_event_at: new Date(now - day * 20 + (i + 2) * 3600000).toISOString(), event_count: 10, model_ids: [],
    tokens: { uncached_input_tokens: 50000 + i * 900000, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, total: 50000 + i * 900000 }, peak_tokens: 50000 + i * 900000,
    cost_minor: null, cost_status: { state: "unavailable" as const, reason: "test", has_unresolved: false },
  }));
  const model = buildCityModel({ rows, findings: [], windowStartMs: now - 30 * day, windowEndMs: now, windowLabel: "30d", totalSessions: rows.length, truncated: false, generatedAt: now });
  const layout = layoutCity(model, null, 64, MIAMI_COASTAL, "off");
  const site = siteFightShapes(layout.terrain, anchorsFromCity(layout, model), layout.roadEdges).ridge;
  assert.ok(site);
  const safety = sampleAssaultTerrainSafety(site, (x, z) => terrainSurfaceHeight(layout, x, z), 2, .5, .25);
  const contains = (cell: { x: number; y: number }, x: number, y: number) => cell.x === x && cell.y === y;
  assert.ok(safety.unsafeCells.some((cell) => contains(cell, 6, 1)));
  assert.ok(safety.unsafeCells.some((cell) => contains(cell, 8, 6)));
  assert.ok(safety.unsafeEdges.some(({ from, to }) => contains(from, 5, 1) && contains(to, 6, 1)));
  assert.ok(safety.unsafeEdges.some(({ from, to }) => contains(from, 7, 6) && contains(to, 8, 6)));
  assert.ok(!safety.unsafeEdges.some(({ from, to }) => contains(from, 5, 3) && contains(to, 6, 3)));
  const state = matchFromSite({ ...site, assaultTerrainSafety: safety }, { preset: "covers_sparse_mid", script: "siege" });
  const cloned = structuredClone(state);
  const from = { x: 5, y: 1 }, to = { x: 6, y: 1 };
  // Sampling remains available to the experimental animation, but it must not
  // silently change the advertised v1.4 movement or collision rules.
  const unannotated = structuredClone(cloned);
  delete unannotated.assaultTerrainSafety;
  assert.equal(assaultTerrainBlocked(cloned, to, from), true);
  assert.equal(stepCost(cloned, from, to, "Assault"), stepCost(unannotated, from, to, "Assault"));
  assert.deepEqual(movementPath(cloned, from, to, "Assault", { alliesPass: true }), movementPath(unannotated, from, to, "Assault", { alliesPass: true }));
  const outcomes = [cloned, unannotated].map((candidate) => {
    const assault = candidate.mechs.find((mech) => mech.id === "Assault")!;
    assault.pos = { ...from };
    const log: TurnEvent[] = [], previous = swapEventSink(log);
    try { return { pushed: tryPushMech(candidate, "Assault", { x: 1, y: 0 }), pos: { ...assault.pos }, hp: assault.hp, log }; }
    finally { swapEventSink(previous); }
  });
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.deepEqual(sampleAssaultTerrainSafety(site, () => 4, 2, .5, .25), { unsafeCells: [], unsafeEdges: [] });
  assert.throws(() => sampleAssaultTerrainSafety(site, () => NaN, 2, .5, .25), /height/);
  assert.throws(() => sampleAssaultTerrainSafety(site, () => 4, 2, .5, 0), /parameters/);
});
