import assert from "node:assert/strict";
import test from "node:test";
import { describeUnitIdentity, UNIT_IDENTITY_IDS } from "../src/game/mecha/unitIdentity.ts";

const expected = [
  ["Assault", "突击", "Assault", "⚔", "mech"],
  ["Gunner", "射手", "Gunner", "◎", "mech"],
  ["Support", "支援", "Support", "✚", "mech"],
  ["boss", "大怪", "Boss", "⬟", "enemy"],
  ["raider-west", "小怪西", "West raider", "◀", "enemy"],
  ["raider-east", "小怪东", "East raider", "▶", "enemy"],
] as const;

test("canonical unit IDs have stable, distinct, non-color identity cues", () => {
  assert.deepEqual(UNIT_IDENTITY_IDS, expected.map(([id]) => id));
  assert.equal(new Set(expected.map(([, , , symbol]) => symbol)).size, expected.length);

  for (const [id, zh, en, symbol, side] of expected) {
    assert.deepEqual(describeUnitIdentity(id, "zh-Hans"), {
      id, label: zh, symbol, side, sideLabel: side === "mech" ? "我方机甲" : "敌方", known: true,
    });
    assert.deepEqual(describeUnitIdentity(id, "en"), {
      id, label: en, symbol, side, sideLabel: side === "mech" ? "Mech" : "Enemy", known: true,
    });
  }
});

test("live compact raider IDs keep the canonical west/east presentation", () => {
  const west = describeUnitIdentity("raider-w", "zh-Hans");
  const east = describeUnitIdentity("raider-e", "en");
  assert.equal(west.label, describeUnitIdentity("raider-west", "zh-Hans").label);
  assert.equal(west.symbol, describeUnitIdentity("raider-west", "zh-Hans").symbol);
  assert.equal(east.label, describeUnitIdentity("raider-east", "en").label);
  assert.equal(east.symbol, describeUnitIdentity("raider-east", "en").symbol);
});

test("unknown IDs remain visible without inferred names or faction", () => {
  assert.deepEqual(describeUnitIdentity("raider-north", "en"), {
    id: "raider-north", label: "raider-north", symbol: "?", side: "unknown", sideLabel: "Side unknown", known: false,
  });
  assert.deepEqual(describeUnitIdentity("unit-42", "zh-Hans"), {
    id: "unit-42", label: "unit-42", symbol: "?", side: "unknown", sideLabel: "阵营未知", known: false,
  });
  assert.equal(describeUnitIdentity("", "en").label, "Unknown unit");
  assert.equal(describeUnitIdentity("", "zh-Hans").label, "未知单位");
});
