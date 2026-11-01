import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { battleClarityPresentation } from "../src/engine/battleClarity.ts";
import { CityParts } from "../src/engine/cityParts.ts";
import { CityEngine } from "../src/engine/CityEngine.ts";
import { ModeLeaseBook } from "../src/engine/modeLease.ts";
import { setNightGlow } from "../src/engine/render/nightLighting.ts";
import { hideOverlaysForPhoto, setLabelsVisible, setHovered, setSelected } from "../src/engine/systems/uiOverlays.ts";

// Real policy/adapter methods, minimal synthetic presentation objects: no GL/logs.
function partsFixture() {
  const parts = Object.create(CityParts.prototype);
  Object.assign(parts, {
    labels: [new THREE.Sprite(), new THREE.Sprite()], labelsVisible: true, battleClarity: false,
    hoveredId: "fixture", selectedId: "fixture", runtimeById: new Map(),
    hoverRing: new THREE.Mesh(), selectRing: new THREE.Mesh(), scaffoldMesh: new THREE.Mesh(),
    group: new THREE.Group(), nightGlow: 1, facadeUniforms: [], heroParts: null,
    landmarkWindows: [], lifeguardGlowMaterial: null, signageNeonMaterial: null,
    nightLights: { heads: new THREE.MeshBasicMaterial(), pools: new THREE.MeshBasicMaterial(), strips: new THREE.MeshBasicMaterial(), neon: new THREE.MeshBasicMaterial() },
    anchorFor: (id: string) => id === "fixture" ? { x: 1, z: 2, ground: 0, height: 3 } : null,
    applyNightOverlay: () => {},
    setNightGlow(value: number) { setNightGlow(this, value); },
  });
  return parts;
}

test("battle decoration masking is reversible, does not drift and uses latest daylight", () => {
  const parts = partsFixture();
  assert.deepEqual(battleClarityPresentation(true), { showLabels: false, showStreetPools: false, streetBrightness: 0.22 });
  parts.setBattleClarity(false);
  const original = parts.nightLights.heads.color.clone();
  parts.setBattleClarity(true);
  assert.ok(parts.labels.every((label: THREE.Sprite) => !label.visible));
  assert.equal(parts.hoverRing.visible, false); assert.equal(parts.selectRing.visible, false);
  assert.equal(parts.nightLights.pools.visible, false);
  assert.ok(parts.nightLights.heads.color.equals(original.clone().multiplyScalar(0.22)));
  parts.setBattleClarity(true);
  assert.ok(parts.nightLights.heads.color.equals(original.clone().multiplyScalar(0.22)), "no repeated multiply drift");
  parts.setNightGlow(0.05); parts.setBattleClarity(false);
  assert.equal(parts.nightLights.pools.visible, false, "release during day must not relight pools");
  parts.setNightGlow(1);
  assert.ok(parts.nightLights.heads.color.equals(original));
  assert.equal(parts.nightLights.pools.visible, true);
  assert.equal(parts.hoverRing.visible, true); assert.equal(parts.selectRing.visible, true);
});

test("live preference/selection updates cannot bypass mask; release preserves preference", () => {
  const parts = partsFixture();
  parts.setBattleClarity(true); setLabelsVisible(parts, true);
  setHovered(parts, "fixture"); setSelected(parts, "fixture");
  assert.ok(parts.labels.every((label: THREE.Sprite) => !label.visible));
  assert.equal(parts.hoverRing.visible, false);
  setLabelsVisible(parts, false); setSelected(parts, null);
  parts.setBattleClarity(false);
  assert.ok(parts.labels.every((label: THREE.Sprite) => !label.visible));
  assert.equal(parts.selectRing.visible, false); assert.equal(parts.hoverRing.visible, true);
});

test("photo restoration honors clarity and preferences changed while captured", () => {
  const parts = partsFixture();
  const restore = hideOverlaysForPhoto(parts);
  parts.setBattleClarity(true); restore();
  assert.ok(parts.labels.every((label: THREE.Sprite) => !label.visible));
  assert.equal(parts.selectRing.visible, false);
  const during = hideOverlaysForPhoto(parts);
  parts.setBattleClarity(false); during();
  assert.ok(parts.labels.every((label: THREE.Sprite) => label.visible));
  const preferenceChange = hideOverlaysForPhoto(parts);
  setLabelsVisible(parts, false); preferenceChange();
  assert.ok(parts.labels.every((label: THREE.Sprite) => !label.visible));
});

test("mask belongs to current lease; stale release/writes cannot affect next owner", () => {
  const engine = Object.create(CityEngine.prototype);
  const parts = partsFixture();
  Object.assign(engine, { modeLeases: new ModeLeaseBook(), cameraOwner: "orbit", scene: new THREE.Scene(), parts, labelsVisible: true });
  const first = engine.acquireModeLease({ camera: "orbit" })!;
  first.setBattleClarity(true); first.release();
  assert.equal(parts.battleClarity, false);
  const second = engine.acquireModeLease({ camera: "orbit" })!;
  second.setBattleClarity(true); first.release();
  assert.equal(parts.battleClarity, true);
  assert.throws(() => first.setBattleClarity(false), /stale-mode-lease/);
  engine.setLabelsVisible(false); second.release();
  assert.ok(parts.labels.every((label: THREE.Sprite) => !label.visible));
  assert.equal(engine.labelsVisible, false);
});
