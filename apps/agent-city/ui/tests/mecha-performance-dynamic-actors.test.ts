import test from "node:test";
import assert from "node:assert/strict";
import { createRoundPerformance, performanceFromLog } from "../src/game/mecha/performance.ts";
import { createMatch, type ArenaPlan, type MatchState, type TurnEvent } from "../src/game/mecha/rules.ts";

function fixture(): MatchState {
  return createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], buildings: [],
    raiders: [{ id: "existing", pos: { x: 1, y: 1 }, hp: 2 }], boss: { x: 4, y: 4 },
    mechs: [{ id: "Assault", pos: { x: 1, y: 8 } }, { id: "Gunner", pos: { x: 4, y: 8 } }, { id: "Support", pos: { x: 7, y: 8 } }] });
}

const newcomer = { id: "swarm:0", pos: { x: 2, y: 2 }, hp: 2, intent: null };

test("snapshot-only actor changes never fabricate a spawn movement or removal death", () => {
  const before = fixture();
  const after = structuredClone(before);
  after.raiders = [newcomer];
  const cues = performanceFromLog(before, after, []);
  assert.ok(!cues.some(c => (c.kind === "move" || c.kind === "knockback" || c.kind === "death") && (c.actor === newcomer.id || c.actor === "existing")));
});

test("known movement and actual zero HP still produce cues", () => {
  const before = fixture();
  const after = structuredClone(before);
  after.raiders[0]!.pos = { x: 2, y: 1 };
  assert.ok(performanceFromLog(before, after, []).some(c => c.kind === "move" && c.actor === "existing"));
  after.raiders[0]!.hp = 0;
  assert.ok(performanceFromLog(before, after, []).some(c => c.kind === "death" && c.actor === "existing"));
});

test("unlocated log actors and snapshot-only new actors are skipped in both performance paths", () => {
  const before = fixture();
  const after = structuredClone(before);
  after.raiders.push({ ...newcomer, intent: { skillId: "smash", local: [], projected: [], cdSweep: 0, status: "planned" } });
  const log: TurnEvent[] = [
    // An unsupported future/malformed shove must still degrade safely.
    { type: "shove", unit: newcomer.id, dir: { x: 1, y: 0 }, damage: 0 } as unknown as TurnEvent,
    { type: "enemy", actor: newcomer.id, skill: "smash", cells: [], damage: 0 },
  ];
  const logCues = performanceFromLog(before, after, log);
  assert.ok(!logCues.some(c => "actor" in c && c.actor === newcomer.id));
  const plan: ArenaPlan = { revision: before.revision, items: [] };
  const snapshotCues = createRoundPerformance(before, plan, after, after, after);
  assert.ok(!snapshotCues.some(c => "actor" in c && c.actor === newcomer.id));
});
