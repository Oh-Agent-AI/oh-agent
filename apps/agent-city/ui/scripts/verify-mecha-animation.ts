import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createAssault, createBoss, createGunner, createRaider, createSupport, disposeMechaModel } from "../src/render/mecha/models.ts";
import { MechaAnimator, MechaBattleAnimator, faceMechaTarget, poseMechaModel, type MechaAction } from "../src/render/mecha/animation.ts";

const factories = [createAssault, createGunner, createSupport, createBoss, createRaider];
const actions: MechaAction[] = ["idle", "move", "attack", "repair", "hit", "defeat"];

test("poses keep board placement fixed, fall above ground and restore the bind pose", () => {
  for (const create of factories) {
    const model = create();
    const rest = new THREE.Box3().setFromObject(model);
    for (const action of actions) {
      for (const time of [0, 0.2, 0.5, 0.85, 2]) {
        poseMechaModel(model, action, time);
        model.updateMatrixWorld(true);
        model.traverse((node) => {
          assert.ok(node.matrixWorld.elements.every(Number.isFinite), `${model.name}/${action}`);
        });
        assert.deepEqual(model.position.toArray(), [0, 0, 0]);
        assert.deepEqual(model.rotation.toArray().slice(0, 3), [0, 0, 0]);
        if (action === "defeat") assert.ok(new THREE.Box3().setFromObject(model).min.y > -0.001, `${model.name} falls through floor`);
      }
    }
    poseMechaModel(model, "idle", 0);
    const restored = new THREE.Box3().setFromObject(model);
    assert.ok(rest.min.distanceTo(restored.min) < 1e-6);
    assert.ok(rest.max.distanceTo(restored.max) < 1e-6);
    poseMechaModel(model, "move", 0.3, true);
    assert.ok(rest.max.distanceTo(new THREE.Box3().setFromObject(model).max) < 1e-6);
    disposeMechaModel(model);
  }
});

test("weapon surfaces follow a joint as one rigid attachment", () => {
  const model = createAssault();
  const hand = model.getObjectByName("gauntlet-right")!;
  const origin = new THREE.Vector3(); hand.getWorldPosition(origin);
  poseMechaModel(model, "attack", 0.45);
  const raised = new THREE.Vector3(); hand.getWorldPosition(raised);
  assert.ok(origin.distanceTo(raised) > 1);
  assert.ok(raised.z < origin.z, "the fist strikes forward (-Z), not behind the mech");
  assert.equal(hand.parent?.name, "joint:forearm-right");
  disposeMechaModel(model);
});

test("one-shot timing is independent of 30/60 Hz and settles back to idle", () => {
  const a = createGunner(), b = createGunner();
  const first = new MechaAnimator(a), second = new MechaAnimator(b);
  first.play("attack"); second.play("attack");
  for (let i = 0; i < 12; i++) first.update(1 / 30);
  for (let i = 0; i < 24; i++) second.update(1 / 60);
  assert.ok(Math.abs(a.getObjectByName("joint:cannon")!.position.z - b.getObjectByName("joint:cannon")!.position.z) < 1e-6);
  for (let i = 0; i < 60; i++) first.update(1 / 60);
  assert.equal(first.action, "idle");
  disposeMechaModel(a); disposeMechaModel(b);
});

test("accepted attack, hit and death queue survives the next turn; respawn clears it", () => {
  const model = createAssault();
  const battle = new MechaBattleAnimator(model);
  battle.sync(14, 0);
  battle.sync(0, 1, "attack");
  assert.equal(battle.animator.action, "attack");
  for (let i = 0; i < 61; i++) { battle.sync(0, 1, "attack"); battle.update(1 / 60, false); }
  assert.equal(battle.animator.action, "hit");
  battle.sync(0, 2);
  for (let i = 0; i < 70; i++) battle.update(1 / 60, false);
  assert.equal(battle.animator.action, "defeat");
  battle.sync(14, 3);
  battle.update(0, false);
  assert.equal(battle.animator.action, "idle");
  assert.equal(model.getObjectByName("mecha-visual")!.rotation.x, 0);
  disposeMechaModel(model);
});

test("an unrelated turn does not cancel a living actor's queued hit", () => {
  const model = createAssault();
  const battle = new MechaBattleAnimator(model);
  battle.sync(14, 0);
  battle.sync(12, 1, "attack");
  for (let i = 0; i < 20; i++) battle.update(1 / 60, false);
  battle.sync(12, 2);
  assert.equal(battle.animator.action, "attack");
  for (let i = 0; i < 45; i++) battle.update(1 / 60, false);
  assert.equal(battle.animator.action, "hit");
  disposeMechaModel(model);
});


test("local -Z faces targets in every horizontal quadrant", () => {
  const model = createGunner();
  for (const [x, z] of [[1, 0], [-1, 0], [0, -1], [0, 1], [1, 1]]) {
    const target = new THREE.Vector3(x, 0, z);
    faceMechaTarget(model, new THREE.Vector3(), target);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(model.quaternion);
    assert.ok(forward.distanceTo(target.normalize()) < 1e-6);
  }
  disposeMechaModel(model);
});
