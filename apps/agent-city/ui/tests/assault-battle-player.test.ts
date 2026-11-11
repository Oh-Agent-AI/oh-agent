import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createAssaultBattleHeight, createAssaultBattlePlayer } from "../src/render/mecha/assaultBattlePlayer.ts";
import { setMechaRig, type MechaAction } from "../src/render/mecha/animation.ts";
import type { MechaPerformanceEvent } from "../src/render/mecha/performance.ts";
import { createAssaultPerformancePlan } from "../src/render/mecha/assaultPerformance.ts";

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
function fixture(events: MechaPerformanceEvent[], height = createAssaultBattleHeight(), fallen: string[] = [], onEventSettled?: (index: number) => void) {
  const actor = new THREE.Group(), visual = new THREE.Group(), lift = new THREE.Group();
  const leg = new THREE.Bone(); leg.name = "leg"; visual.add(leg); lift.add(visual); actor.add(lift);
  const mixer = new THREE.AnimationMixer(visual);
  const actions = new Map<string, THREE.AnimationAction>();
  const clips: Record<string, { duration: number; loop: boolean }> = {};
  for (const name of ["idle", "move", "attack", "repair", "hit", "defeat"] satisfies MechaAction[]) {
    const clip = new THREE.AnimationClip(name, 1, [new THREE.NumberKeyframeTrack("leg.rotation[x]", [0, .5, 1], [0, name === "move" ? 1 : .2, 0])]);
    actions.set(name, mixer.clipAction(clip).play()); clips[name] = { duration: 1, loop: name === "move" || name === "idle" };
  }
  setMechaRig(actor, { visual, joints: new Map(), origins: new Map(), role: "Assault", rearExtent: 0,
    glb: { visual, lift, mixer, actions, manifest: { id: "synthetic-no-IK-skeleton", version: 1, role: "Assault", footprint: [1, 1], forward: "-Z", heightMeters: 20, clips } } });
  const other = new THREE.Group(); other.position.set(100, 0, 100);
  const root = new THREE.Group(); root.add(actor, other);
  const resolve = (cell: { x: number; y: number }) => new THREE.Vector3(cell.x * 16, 2, cell.y * 16);
  let completions = 0;
  const playback = createAssaultBattlePlayer({ Assault: actor, Gunner: other }, events, resolve, root, () => completions++, height, fallen, onEventSettled);
  return { ...playback, actor, other, leg, actions, root, completions: () => completions };
}
const move = (path: { x: number; y: number }[]): MechaPerformanceEvent => ({ kind: "move", actor: "Assault", path, duration: 9 });

test("passive knockback preserves the planned heading after settling", () => {
  const event: MechaPerformanceEvent = { kind: "knockback", actor: "Assault", path: [{ x: 0, y: 0 }, { x: 1, y: 0 }], duration: .32 };
  const plan = createAssaultPerformancePlan([event], "Assault", .61, cell => ({ x: cell.x, y: 0, z: cell.y }), 1, 1, () => .2);
  near(plan.entries[0]!.endYaw, .61); near(plan.endYaw, .61);
});

test("quick route travel starts immediately and reaches all corners without diagonal shortcuts", () => {
  const events = [move([{ x:0,y:0 },{ x:1,y:0 },{ x:1,y:1 },{ x:2,y:1 }])];
  const before = JSON.stringify(events), f = fixture(events);
  try {
    f.player.update(.1); near(f.actor.position.x, 8); near(f.actor.position.z, 0); near(f.actor.position.y, 2);
    f.player.update(.1); near(f.actor.position.x, 16); near(f.actor.position.z, 0);
    f.player.update(.1); near(f.actor.position.x, 16); near(f.actor.position.z, 8);
    f.player.update(.1); near(f.actor.position.x, 16); near(f.actor.position.z, 16);
    f.player.update(.1); near(f.actor.position.x, 24); near(f.actor.position.z, 16);
    f.player.update(.101); near(f.actor.position.x, 32); near(f.actor.position.z, 16); assert.equal(f.completions(), 1);
    f.player.update(10); assert.equal(f.completions(), 1); assert.equal(JSON.stringify(events), before);
  } finally { f.player.dispose(); f.release(); }
});

test("GLB move clip plays independently of stride/contact measurements; pause preserves the pose", () => {
  const f = fixture([move([{x:0,y:0},{x:1,y:0},{x:2,y:0}])]);
  try {
    f.player.update(.12); assert.equal(f.actions.get("move")!.getEffectiveWeight(), 1);
    near(f.leg.rotation.x, .5); // .12 / .48 walk-cycle, sampling a 1-second clip
    const position = f.actor.position.clone(), pose = f.leg.quaternion.clone();
    f.player.update(0); assert.ok(position.equals(f.actor.position)); assert.ok(pose.equals(f.leg.quaternion));
    f.player.update(.12); near(f.leg.rotation.x, 1); assert.equal(f.completions(), 0);
  } finally { f.player.dispose(); f.release(); }
});

test("unequal route segments use constant distance speed, not equal per-segment time", () => {
  const f = fixture([move([{x:0,y:0},{x:1,y:0},{x:3,y:0}])]);
  try { f.player.update(.3); near(f.actor.position.x, 24); f.player.update(.301); near(f.actor.position.x, 48); }
  finally { f.player.dispose(); f.release(); }
});

test("optional road detail degrades through terrain to board height on missing, stale and invalid samples", () => {
  near(createAssaultBattleHeight(() => 8, () => 4)(0, 0, 2), 8);
  near(createAssaultBattleHeight(() => { throw new Error("stale"); }, () => 4)(0, 0, 2), 4);
  near(createAssaultBattleHeight(() => NaN, () => Infinity)(0, 0, 2), 2);
  near(createAssaultBattleHeight()(0, 0, NaN), 0);
  const f = fixture([move([{x:0,y:0},{x:1,y:0}])], createAssaultBattleHeight(() => { throw new Error("ground unavailable"); }));
  try { assert.doesNotThrow(() => f.player.update(.12)); near(f.actor.position.y, 2); f.player.update(1); assert.equal(f.completions(), 1); }
  finally { f.player.dispose(); f.release(); }
});

test("basic root height follows ground without pitch, roll or bone IK", () => {
  const f = fixture([move([{x:0,y:0},{x:1,y:0}])], createAssaultBattleHeight((x) => 3 + x / 16));
  try { f.player.update(.12); near(f.actor.position.x, 8); near(f.actor.position.y, 3.5); near(f.actor.rotation.x, 0); near(f.actor.rotation.z, 0); }
  finally { f.player.dispose(); f.release(); }
});

test("attack, knockback hop, death and other actors keep their standard presentation and durations", () => {
  const events: MechaPerformanceEvent[] = [
    {kind:"attack", actor:"Assault", attack:"melee", from:{x:0,y:0}, target:{x:1,y:0}, targetIds:["Gunner"], duration:.6},
    {kind:"knockback", actor:"Assault", path:[{x:0,y:0},{x:0,y:1}], duration:.32},
    {kind:"death", actor:"Assault", at:{x:0,y:1}, duration:.85},
    {kind:"move", actor:"Gunner", path:[{x:0,y:0},{x:1,y:0}], duration:.8},
  ];
  const f = fixture(events, createAssaultBattleHeight(() => 5));
  try {
    f.player.update(.3); assert.equal(f.actions.get("attack")!.getEffectiveWeight(), 1);
    f.player.update(.46); near(f.actor.position.y, 5.6); assert.notEqual(f.actor.rotation.x, 0);
    f.player.update(.3); assert.equal(f.actions.get("defeat")!.getEffectiveWeight(), 1);
    f.player.update(.9); near(f.other.position.x, 3.8); assert.equal(f.actions.get("defeat")!.getEffectiveWeight(), 1);
    f.player.update(.611); near(f.other.position.x, 16); assert.equal(f.completions(), 1);
  } finally { f.player.dispose(); f.release(); }
});

test("large time jumps settle every waypoint; disposal removes effects and release is idempotent", () => {
  const f = fixture([move([{x:0,y:0},{x:1,y:0}]), move([{x:1,y:0},{x:1,y:1}])]);
  assert.equal(f.root.children.length, 4);
  f.player.update(Infinity); near(f.actor.position.x, 16); near(f.actor.position.z, 16); assert.equal(f.completions(), 1);
  f.player.dispose(); f.release(); f.release(); assert.equal(f.root.children.length, 2);
});


test("idle Assault retains basic ground height while another actor performs", () => {
  const f = fixture([{kind:"move",actor:"Gunner",path:[{x:0,y:0},{x:1,y:0}],duration:.8}], createAssaultBattleHeight(() => 5));
  try { f.player.update(.2); near(f.actor.position.y, 5); near(f.other.position.x, 4); f.player.update(.6); near(f.actor.position.y, 5); }
  finally { f.player.dispose(); f.release(); }
});

test("heading crosses the PI boundary using the shortest turn without delaying travel", () => {
  const f = fixture([move([{x:0,y:0},{x:0,y:1}])]);
  f.actor.rotation.y = Math.PI - .05;
  try { f.player.update(.05); near(f.actor.position.z, 16 * .05 / .24); near(f.actor.rotation.y, Math.PI - .025); }
  finally { f.player.dispose(); f.release(); }
});


test("connected player reports each settled cue once, preserving pause and skipping correctly", () => {
  const settled: number[] = [];
  const f = fixture([move([{x:0,y:0},{x:1,y:0}]), move([{x:1,y:0},{x:2,y:0}])], createAssaultBattleHeight(), [], (i) => settled.push(i));
  try {
    f.player.update(.1); f.player.update(0); assert.deepEqual(settled, []);
    f.player.update(.15); assert.deepEqual(settled, [0]);
    f.player.update(0); assert.deepEqual(settled, [0]);
    f.player.update(Infinity); assert.deepEqual(settled, [0, 1]);
    f.player.update(10); assert.deepEqual(settled, [0, 1]);
    assert.equal(f.completions(), 1);
  } finally { f.player.dispose(); f.release(); }
});
