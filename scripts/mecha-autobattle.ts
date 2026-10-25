/**
 * Both sides, no clicks. Squad search vs the Boss script.
 * Run: node --experimental-strip-types --import ./scripts/mecha-ts-register.mjs scripts/mecha-autobattle.ts
 */
import assert from "node:assert/strict";
import { squadPlan } from "../apps/agent-city/ui/src/game/mecha/ai.ts";
import {
  bossExecute, bossPrepare, BUILDING_HP, createMatch, living, livingBuildings, validateAndApplyPlan,
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

function playRaid(strategy: "hold" | "search"): MatchState {
  const state = createMatch({
    preset: "covers_sparse_mid",
    script: "raid_ssw",
    covers: [],
    buildings: [
      { id: "west", cells: [{ x: 4, y: 4 }] },
      { id: "mid", cells: [{ x: 5, y: 4 }] },
      { id: "north", cells: [{ x: 4, y: 5 }] },
    ],
  });
  const log: string[] = [];
  let guard = 0;
  while (!state.outcome && guard < 16) {
    guard += 1;
    const turn = state.turn;
    const beforeBoss = { ...state.boss.anchor };
    const intent = bossPrepare(state);
    const plan = strategy === "search" ? squadPlan(state) : {
      revision: state.revision,
      items: living(state).map((m) => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })),
    };
    const before = state.mechs.reduce((sum, m) => sum + m.hp, 0);
    const result = validateAndApplyPlan(state, plan);
    assert.ok("ok" in result, "squad plan rejected");
    if (state.boss.hp > 0 && state.phase === "resolving_boss") bossExecute(state);
    const damage = before - state.mechs.reduce((sum, m) => sum + m.hp, 0);
    const moved = beforeBoss.x !== state.boss.anchor.x || beforeBoss.y !== state.boss.anchor.y;
    const hp = state.buildings.map((b) => `${b.id}:${b.hp}`).join(" ");
    log.push(`t${turn} ${intent.skillId} boss@${state.boss.anchor.x},${state.boss.anchor.y}${moved ? " moved" : ""} [${intent.projected.map((c) => `${c.x},${c.y}`).join(" ")}] buildings=${hp} bossHp=${state.boss.hp} hit=${damage}`);
  }
  console.log(`raid ${strategy}`);
  for (const line of log) console.log(line);
  console.log(`outcome=${state.outcome} turn=${state.turn} buildingsLeft=${livingBuildings(state).length}`);
  return state;
}

const held = playRaid("hold");
assert.equal(held.outcome, "defeat_timeout");
assert.equal(livingBuildings(held).length, 1);
assert.equal(held.buildings.find((b) => b.id === "north")?.hp, BUILDING_HP);
assert.equal(held.boss.hp, 40);

const searched = playRaid("search");
assert.ok(searched.outcome === "victory" || searched.outcome === "defeat_wipe" || searched.outcome === "defeat_timeout" || searched.outcome === "defeat_buildings");
if (searched.outcome === "victory") assert.ok(livingBuildings(searched).length > 0);
if (searched.outcome === "defeat_buildings") assert.equal(livingBuildings(searched).length, 0);
