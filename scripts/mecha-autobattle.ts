/**
 * Both sides, no clicks. Squad search vs the Boss script.
 * Run: node --experimental-strip-types --import ./scripts/mecha-ts-register.mjs scripts/mecha-autobattle.ts
 */
import assert from "node:assert/strict";
import { squadPlan } from "../apps/agent-city/ui/src/game/mecha/ai.ts";
import {
  bossExecute, bossPrepare, createMatch, living, validateAndApplyPlan,
  type CoverPresetId, type MatchState,
} from "../apps/agent-city/ui/src/game/mecha/rules.ts";

function play(preset: CoverPresetId): MatchState {
  const state = createMatch({ preset, script: "cadence_ssw" });
  const log: string[] = [];
  let guard = 0;
  while (!state.outcome && guard < 16) {
    guard += 1;
    const turn = state.turn;
    const intent = bossPrepare(state);
    const plan = squadPlan(state);
    const before = state.mechs.reduce((sum, m) => sum + m.hp, 0);
    const result = validateAndApplyPlan(state, plan);
    assert.ok("ok" in result, "squad plan rejected");
    if (state.boss.hp > 0 && state.phase === "resolving_boss") bossExecute(state);
    const damage = before - state.mechs.reduce((sum, m) => sum + m.hp, 0);
    const moves = plan.items.map((item) => `${item.mechId}:${item.action.kind}@${item.moveTo ? `${item.moveTo.x},${item.moveTo.y}` : "stay"}`).join(" ");
    log.push(`t${turn} ${intent.skillId} [${intent.projected.map((c) => `${c.x},${c.y}`).join(" ")}] ${moves} boss=${state.boss.hp} hit=${damage} alive=${living(state).map((m) => m.id).join(",") || "-"}`);
  }
  console.log(preset);
  for (const line of log) console.log(line);
  console.log(`outcome=${state.outcome} turn=${state.turn}`);
  return state;
}

const sparse = play("covers_sparse_mid");
assert.equal(sparse.outcome, "victory");
assert.equal(sparse.turn, 7);
assert.equal(living(sparse).length, 3);

const corridor = play("covers_diag_corridor");
assert.equal(corridor.outcome, "victory");
assert.ok(corridor.turn <= 15);

const twin = play("covers_twin_clusters");
assert.equal(twin.outcome, "victory");
assert.ok(twin.turn <= 15);
