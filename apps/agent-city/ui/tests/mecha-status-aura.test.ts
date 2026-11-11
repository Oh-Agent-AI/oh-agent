import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { StatusAuraLayer } from "../src/render/mecha/statusAura.ts";
import type { DisplayStatus } from "../src/game/mecha/statusDisplay.ts";

const entry = (kind: DisplayStatus["kind"], source = "boss"): DisplayStatus => ({ kind, target: "Assault", source, magnitude: kind === "poison" || kind === "burn" ? 1 : 0, remainingTurns: 2 });

test("status auras follow their actor, remain bounded and disappear with authoritative status", () => {
  const actor = new THREE.Group(), actors = new Map([["Assault", actor]]), scene = new THREE.Scene(), layer = new StatusAuraLayer();
  scene.add(actor);
  const statuses = [entry("poison"), entry("burn"), entry("freeze"), entry("stun")];
  layer.sync(actors, statuses, 1 / 60, false);
  assert.equal(actor.children.filter(child => child.name.startsWith("status-aura:")).length, 4);
  const first = actor.children.find(child => child.name === "status-aura:poison")!;
  layer.sync(actors, statuses, 1 / 60, false);
  assert.equal(actor.children.filter(child => child.name.startsWith("status-aura:")).length, 4);
  const destination = new THREE.Group(); scene.add(destination); actor.position.set(10, 0, 4);
  layer.sync(new Map([["Assault", destination]]), statuses.slice(1), 1 / 60, false);
  assert.equal(first.parent, null);
  assert.equal(actor.children.filter(child => child.name.startsWith("status-aura:")).length, 0);
  assert.equal(destination.children.filter(child => child.name.startsWith("status-aura:")).length, 3);
  layer.sync(new Map([["Assault", destination]]), [], 1 / 60, false);
  assert.equal(destination.children.filter(child => child.name.startsWith("status-aura:")).length, 0);
  layer.dispose();
});

test("reduced motion freezes aura geometry without hiding status symbols", () => {
  const actor = new THREE.Group(), layer = new StatusAuraLayer();
  layer.sync(new Map([["Assault", actor]]), [entry("stun")], .1, true);
  const aura = actor.children.find(child => child.name === "status-aura:stun") as THREE.Group;
  const rotation = aura.rotation.y, scale = aura.scale.x;
  layer.sync(new Map([["Assault", actor]]), [entry("stun")], .1, true);
  assert.equal(aura.rotation.y, rotation); assert.equal(aura.scale.x, scale);
  assert.equal(aura.children.length, 2);
  layer.dispose(); assert.equal(actor.children.length, 0);
});
