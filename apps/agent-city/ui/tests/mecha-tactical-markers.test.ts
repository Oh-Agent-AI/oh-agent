import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { tacticalAttackTrims, tacticalAttackWidths, tacticalMarkerMaterial, TACTICAL_COLORS } from "../src/render/mecha/tacticalMarkers";

test("arrow rim and coloured cores share the transparent queue so renderOrder can layer them", () => {
  const materials = [TACTICAL_COLORS.outline, TACTICAL_COLORS.attack, TACTICAL_COLORS.move, TACTICAL_COLORS.shove]
    .map(color => tacticalMarkerMaterial(color, 1, false));
  try {
    for (const material of materials) {
      assert.equal(material.transparent, true);
      assert.equal(material.opacity, 1);
      assert.equal(material.forceSinglePass, true);
      assert.equal(material.depthTest, false);
      assert.equal(material.depthWrite, false);
      assert.equal(material.side, THREE.DoubleSide);
    }
  } finally { materials.forEach(material => material.dispose()); }
});

test("tactical colours bypass city exposure and fog, including subdued danger cells", () => {
  for (const color of Object.values(TACTICAL_COLORS)) {
    const material = tacticalMarkerMaterial(color, .6);
    try {
      assert.equal(material.toneMapped, false);
      assert.equal(material.fog, false);
      assert.equal(material.color.getHexString(), color.slice(1));
      assert.equal(material.opacity, .6);
      assert.equal(material.depthTest, true, "cell hatches still respect scene occlusion");
      assert.equal(material.depthWrite, false);
    } finally { material.dispose(); }
  }
});

test("movement stays green, enemy attacks red and route rims light rather than black", () => {
  const move = new THREE.Color(TACTICAL_COLORS.move), attack = new THREE.Color(TACTICAL_COLORS.attack);
  const outline = new THREE.Color(TACTICAL_COLORS.outline);
  assert.ok(move.g > move.r && move.g > move.b);
  assert.ok(attack.r > attack.g && attack.r > attack.b);
  assert.ok(outline.r > .8 && outline.g > .8 && outline.b > .5);
});


test("enemy arrowheads keep a six-pixel floor and visible rim at fitted camera distances", () => {
  for (const worldPerPixel of [.5, 1, 2]) {
    const [outline, core] = tacticalAttackWidths(worldPerPixel, 80);
    assert.ok(core * .84 / worldPerPixel >= 6);
    assert.ok((outline - core) * .84 / worldPerPixel >= 1.99);
  }
});

test("distant arrow widths stay inside the cell, and invalid projection sizes remain finite", () => {
  const [outline, core] = tacticalAttackWidths(20, 20);
  assert.equal(outline, 10); assert.equal(core, 8);
  for (const invalid of [NaN, Infinity, 0, -1]) {
    const widths = tacticalAttackWidths(invalid, invalid);
    assert.ok(widths.every(n => Number.isFinite(n) && n > 0)); assert.ok(widths[0] > widths[1]);
  }
});


test("attack insets keep the shaft off the source and landing centers without altering its ray", () => {
  const [start, end] = tacticalAttackTrims(60, 3, 0, 20, 20);
  assert.equal(start, 8); assert.equal(end, 4.8);
  assert.ok(start > 0 && end > 0 && 60 - start - end > 0);
  assert.deepEqual(tacticalAttackTrims(60, -3, 0, 20, 20), [start, end]);
  assert.deepEqual(tacticalAttackTrims(60, 0, 3, 20, 20), [start, end]);
});

test("rectangular and diagonal footprints use the actual board axes, not the narrowest cell span", () => {
  assert.deepEqual(tacticalAttackTrims(80, 2, 0, 40, 20, 2), [32, 9.6]);
  assert.deepEqual(tacticalAttackTrims(80, 0, 4, 40, 20, 2), [16, 4.8]);
  const diagonal = tacticalAttackTrims(Math.hypot(80, 40), 2, 2, 40, 20, 2);
  assert.ok(Math.abs(diagonal[0] - Math.hypot(40, 20) * .8) < 1e-9);
  assert.ok(Math.abs(diagonal[1] - Math.hypot(40, 20) * .24) < 1e-9);
});

test("adjacent targets and large footprints always retain a readable positive arrowhead", () => {
  for (const footprint of [1, 2, 8]) for (const length of [1, 20, 30, 80]) {
    const [start, end] = tacticalAttackTrims(length, 1, 0, 20, 20, footprint);
    assert.ok(start > 0 && end > 0);
    assert.ok(length - start - end >= length * .35 - 1e-9);
    assert.ok(Math.abs(start / end - footprint * .4 / .24) < 1e-9);
  }
});

test("invalid or degenerate attacks do not produce NaN mesh transforms", () => {
  for (const invalid of [NaN, Infinity, 0, -1]) {
    assert.deepEqual(tacticalAttackTrims(invalid, 1, 0, 20, 20), [0, 0]);
    assert.deepEqual(tacticalAttackTrims(20, 1, 0, invalid, 20), [0, 0]);
    assert.deepEqual(tacticalAttackTrims(20, 1, 0, 20, invalid), [0, 0]);
    assert.deepEqual(tacticalAttackTrims(20, 1, 0, 20, 20, invalid), [0, 0]);
  }
  assert.deepEqual(tacticalAttackTrims(20, 0, 0, 20, 20), [0, 0]);
  assert.deepEqual(tacticalAttackTrims(20, Number.MAX_VALUE, 0, 20, 20), [0, 0]);
  assert.deepEqual(tacticalAttackTrims(20, 1, 0, 20, 20, Number.MAX_VALUE), [0, 0]);
});
