import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectCell } from "../src/game/mecha/cellInspection.ts";
import { ENEMY_STATS, bossDamageTo, bossExecute, bossPrepare, buildingDamage, createMatch, enemyStatsOf, living, raiderDamageTo, type DifficultyId } from "../src/game/mecha/rules.ts";
import { unitMaxHp } from "../src/game/mecha/unitHealth.ts";

function match(difficulty?: DifficultyId) {
  return createMatch({
    preset: "covers_sparse_mid",
    script: "siege",
    difficulty,
    covers: [],
    boss: { x: 4, y: 4 },
    mechs: [
      { id: "Assault", pos: { x: 5, y: 3 } },
      { id: "Gunner", pos: { x: 0, y: 9 } },
      { id: "Support", pos: { x: 9, y: 9 } },
    ],
  });
}

test("default matches use normal stats while difficulties persist their raider counts", () => {
  const baseline = match();
  assert.equal(baseline.difficulty, undefined);
  assert.deepEqual(enemyStatsOf(baseline), ENEMY_STATS.normal);
  assert.equal(baseline.boss.hp, 40);
  assert.deepEqual(baseline.raiders.map((raider) => raider.hp), [8, 8]);

  const easy = match("easy");
  const hard = match("hard");
  assert.equal(easy.difficulty, "easy");
  assert.equal(easy.boss.hp, 36);
  assert.deepEqual(easy.raiders.map((raider) => raider.hp), [8]);
  assert.equal(hard.difficulty, "hard");
  assert.equal(hard.boss.hp, 48);
  assert.deepEqual(hard.raiders.map((raider) => raider.hp), [8, 8, 8, 8]);
});

test("enemy attacks and forecasts use the difficulty stored on the match", async () => {
  for (const difficulty of ["easy", "normal", "hard"] as const) {
    const state = match(difficulty);
    const stats = enemyStatsOf(state);
    const before = state.mechs[0]!.hp;
    bossPrepare(state);
    const turn = state.revision;
    const plan = { revision: turn, items: living(state).map((mech) => ({ mechId: mech.id, moveTo: null, action: { kind: "skip" as const } })) };
    const clone = structuredClone(state);
    const { validateAndApplyPlan } = await import("../src/game/mecha/rules.ts");
    assert.ok("ok" in validateAndApplyPlan(clone, plan));
    bossExecute(clone);
    assert.equal(before - clone.mechs[0]!.hp, stats.bossAtk - 2);
    assert.equal(bossDamageTo("Assault", state), stats.bossAtk - 2);
    assert.equal(raiderDamageTo("Assault", state), Math.max(1, stats.raiderAtk - 2));
    assert.equal(buildingDamage(state), stats.bossAtk);
  }
});

test("health and inspection expose scaled enemy stats, including remote raider ids", () => {
  const state = match("hard");
  state.raiders[0]!.id = "raider-0";
  assert.equal(unitMaxHp("boss", state), 48);
  assert.equal(unitMaxHp("raider-e", state), 8);
  assert.equal(unitMaxHp("raider-0", state), 8);
  const boss = inspectCell(state, { x: 4, y: 4 }, {}, "boss");
  assert.equal(boss?.unit?.maxHp, 48);
  assert.equal(boss?.unit?.atk, 7);
  const raider = inspectCell(state, { x: 1, y: 4 }, {}, "raider-0");
  assert.equal(raider?.unit?.maxHp, 8);
  assert.equal(raider?.unit?.atk, 4);
});
