import test from "node:test";
import assert from "node:assert/strict";
import { createCreatorGateCourse } from "../src/game/RaceCourse";

// 只用到 params 的巡航速度与环半径推导；world 在这个入口不参与（门来自发布快照，
// 不来自城市障碍扫描），因此用最小桩对象即可。
const params = { cruiseSpeed: 40, maxSpeed: 80, minSpeed: 8, planeRadius: 2, turnRate: 1, accel: 20, brake: 30,
  climbRate: 20, sinkRate: 12, climbSmoothing: 6, turnSmoothing: 8, bankMax: 0.4, flightModel: "fixed-wing",
  flapFrequency: 0, flapAmplitude: 0, followDistance: 15, heightOffset: 6, fovDeg: 55 } as any;
const world = {} as any;
const base = { world, params, citySeed: 42, physicsVersion: 2, variant: 0, staticCollisionIdentity: "creator:r1" };

test("creator gates become the course rings one-for-one (no generated route)", () => {
  const gates = [
    { x: 0, y: 20, z: 0, radius: 4 },
    { x: 40, y: 24, z: 0, radius: 4 },
    { x: 40, y: 24, z: 40, radius: 4 },
  ];
  const course = createCreatorGateCourse({ ...base, gates });
  assert.ok(course);
  assert.equal(course!.kind, "generated");
  assert.deepEqual(course!.rings.map(ring => [ring.x, ring.y, ring.z, ring.radius]), gates.map(gate => [gate.x, gate.y, gate.z, gate.radius]));
  // 法线是单位向量且沿相邻门的角平分弦方向（首环由末环参与，闭合路线）。
  for (const ring of course!.rings) assert.ok(Math.abs(Math.hypot(ring.nx, ring.ny, ring.nz) - 1) < 1e-9);
  // 中间门的法线 = (下一门 − 上一门) 归一化 = (40,4,40)/|…|（含闭合回绕）。
  const second = course!.rings[1];
  const expected = 40 / Math.hypot(40, 4, 40);
  assert.ok(Math.abs(second.nx - expected) < 1e-9 && Math.abs(second.ny - 4 / Math.hypot(40, 4, 40)) < 1e-9
    && Math.abs(second.nz - expected) < 1e-9, `unexpected normal ${[second.nx, second.ny, second.nz]}`);
});

test("the same released gates yield the same course id, different gates do not", () => {
  const gates = [{ x: 0, y: 20, z: 0, radius: 4 }, { x: 40, y: 24, z: 0, radius: 4 }];
  const first = createCreatorGateCourse({ ...base, gates });
  const again = createCreatorGateCourse({ ...base, gates });
  const moved = createCreatorGateCourse({ ...base, gates: [{ ...gates[0] }, { ...gates[1], x: 41 }] });
  assert.equal(first!.courseId, again!.courseId);
  assert.notEqual(first!.courseId, moved!.courseId);
  // 时长上限按门的实际长度与载具巡航速度推导（不吃生成路线的常量）。
  assert.ok(first!.timeLimitMs > first!.referenceMs);
});

test("a single gate still yields a flyable ring with a deterministic fallback normal", () => {
  const course = createCreatorGateCourse({ ...base, gates: [{ x: 10, y: 30, z: 10, radius: 5 }] });
  assert.ok(course);
  assert.equal(course!.rings.length, 1);
  assert.deepEqual([course!.rings[0].nx, course!.rings[0].ny, course!.rings[0].nz], [0, 0, 1]);
  assert.equal(course!.ringRadius, 5);
});

test("published ring normals override inferred course normals for matching visuals and triggers", () => {
  const course = createCreatorGateCourse({ ...base, gates: [{ x: 0, y: 20, z: 0, radius: 4, nx: 1, ny: 0, nz: 0 }] });
  assert.ok(course);
  assert.deepEqual([course!.rings[0].nx, course!.rings[0].ny, course!.rings[0].nz], [1, 0, 0]);
  assert.equal(createCreatorGateCourse({ ...base, gates: [{ x: 0, y: 20, z: 0, radius: 4, nx: 0 }] }), null);
});

test("unusable gate sets are rejected instead of drawing a wrong course", () => {
  assert.equal(createCreatorGateCourse({ ...base, gates: [] }), null);
  assert.equal(createCreatorGateCourse({ ...base, gates: Array.from({ length: 65 }, () => ({ x: 0, y: 0, z: 0, radius: 1 })) }), null);
  assert.equal(createCreatorGateCourse({ ...base, gates: [{ x: 0, y: 0, z: 0, radius: 0 }] }), null);
  assert.equal(createCreatorGateCourse({ ...base, gates: [{ x: Number.NaN, y: 0, z: 0, radius: 1 }] }), null);
});
