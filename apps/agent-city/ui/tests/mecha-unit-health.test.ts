import assert from "node:assert/strict";
import test from "node:test";
import { RAIDER_HP } from "../src/game/mecha/board";
import { unitHealth, unitMaxHp } from "../src/game/mecha/unitHealth";

test("life maxima come from the combat rules, not the current injured life", () => {
  assert.equal(unitMaxHp("Assault"), 14);
  assert.equal(unitMaxHp("Gunner"), 11);
  assert.equal(unitMaxHp("Support"), 12);
  assert.equal(unitMaxHp("boss"), 40);
  for (const id of ["raider-w", "raider-e", "raider-west", "raider-east"]) assert.equal(unitMaxHp(id), RAIDER_HP);
  assert.equal(unitMaxHp("raider-unknown"), null);
  assert.equal(unitMaxHp("toString"), null);
  assert.deepEqual(unitHealth(7, unitMaxHp("Assault")), { known: true, ratio: 0.5, text: "7 / 14" });
});
test("life bars retain numeric evidence and clamp visual fill only", () => {
  assert.deepEqual(unitHealth(0, 14), { known: true, ratio: 0, text: "0 / 14" });
  assert.deepEqual(unitHealth(15, 14), { known: true, ratio: 1, text: "15 / 14" });
  assert.equal(unitHealth(3, 8).ratio, 0.375);
});
test("missing or invalid life is visibly unknown, never fabricated full/empty", () => {
  for (const [hp, max] of [[undefined, 14], [NaN, 14], [-1, 14], [Infinity, 14], [7, null], [7, 0], [7, NaN], [7, Infinity]] as Array<[number | undefined, number | null]>) {
    assert.deepEqual(unitHealth(hp, max), { known: false, ratio: null, text: "?" });
  }
});
