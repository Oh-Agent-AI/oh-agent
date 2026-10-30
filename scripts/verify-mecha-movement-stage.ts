import assert from "node:assert/strict";
import test from "node:test";
import { MovementStage, MovementThenAction } from "../apps/agent-city/ui/src/game/mecha/movementStage.ts";

const route = [{ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }];
test("movement follows each route segment and reports arrival", () => {
  const stage = new MovementStage(route[0]!, route, 2);
  const before = stage.advance(1.5); assert.deepEqual(before.position, route[1]); assert.equal(before.arrived, false);
  const almost = stage.advance(1.99); assert.equal(almost.arrived, false); assert.ok(almost.position.y < 4);
  const arrived = stage.advance(0.11); assert.equal(arrived.arrived, true); assert.deepEqual(arrived.position, route[2]);
  assert.ok(Math.abs(arrived.remainingSeconds - 0.10) < 1e-8);
});

test("action starts once, only after movement finishes, including pause and long frames", () => {
  const stage = new MovementThenAction(new MovementStage(route[0]!, route, 2), 0.95);
  assert.equal(stage.advance(3.49).actionStarted, false);
  stage.setPaused(true); assert.equal(stage.advance(10).actionStarted, false);
  stage.setPaused(false);
  const started = stage.advance(0.21);
  assert.equal(started.actionStarted, true); assert.equal(started.phase, "acting");
  assert.ok(Math.abs(started.actionElapsed - 0.20) < 1e-8);
  const finished = stage.advance(1); assert.equal(finished.actionStarted, false); assert.equal(finished.phase, "done");
  assert.equal(stage.advance(1).actionStarted, false);
});
test("pause and 30/60 fps preserve the same position and stage", () => {
  const run = (fps: number) => { const s = new MovementStage(route[0]!, route, 2); for (let i=0;i<fps;i++) s.advance(1/fps); return s.advance(0); };
  const a=run(30), b=run(60); assert.ok(Math.abs(a.position.x-2)<1e-8); assert.ok(Math.abs(a.position.x-b.position.x)<1e-8); assert.equal(a.arrived,b.arrived);
  const paused = new MovementStage(route[0]!, route, 2); paused.setPaused(true); assert.deepEqual(paused.advance(4).position, route[0]); paused.setPaused(false); assert.ok(paused.advance(1).position.x > 0);
});
test("unavailable, invalid or discontinuous routes cannot teleport the actor", () => {
  assert.throws(()=>new MovementStage({x:10,y:0,z:0},route,2));
  assert.throws(()=>new MovementStage(route[0]!,[],2));
  assert.throws(()=>new MovementStage(route[0]!,route,0));
  const s = new MovementStage(route[0]!,route,2); assert.throws(()=>s.advance(NaN));
  const repeated = new MovementStage(route[0]!, [route[0]!,route[0]!,route[1]!],2); assert.equal(repeated.advance(3).arrived,true);
});

test("cell routes map to actual rotated scene heights and reject missing ground", async () => {
  const { movementWaypoints } = await import("../apps/agent-city/ui/src/game/mecha/movementRoute.ts");
  const { cellWorld } = await import("../apps/agent-city/ui/src/game/mecha/citySite.ts");
  const heights = Array.from({length:10},()=>Array(10).fill(0)); heights[2]![3]=1.25;
  const site = { originX: 10, originZ: -4, yaw: Math.PI/3, cellW: 16, cellD: 12, heights } as Parameters<typeof movementWaypoints>[0];
  const cells = [{x:2,y:2},{x:3,y:2},{x:3,y:3}];
  const points = movementWaypoints(site,cells); assert.ok(points);
  assert.deepEqual(points[1],cellWorld(site,cells[1]!)); assert.equal(points[1]!.y,1.25);
  const stage = new MovementStage(points[0]!,points,10); assert.equal(stage.advance(10).arrived,true);
  assert.equal(movementWaypoints(site,[cells[0]!,cells[2]!]),null);
  delete heights[2]![3]; assert.equal(movementWaypoints(site,cells),null);
});
