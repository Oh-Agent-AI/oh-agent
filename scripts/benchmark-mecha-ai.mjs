#!/usr/bin/env node
// Compare v1.5 policies across several openings; no UI, no persistence.
import { bossPrepare, createMatch } from "../apps/agent-city/ui/src/game/mecha/rules.ts";
import { nextCommand } from "../apps/agent-city/ui/src/game/mecha/ai/commandPolicy.ts";
import { nextCoordinatedCommand } from "../apps/agent-city/ui/src/game/mecha/ai/coordinatedPolicy.ts";
import { nextBeamCommand } from "../apps/agent-city/ui/src/game/mecha/ai/beamPolicy.ts";
import { compareSequentialPolicies } from "../apps/agent-city/ui/src/game/mecha/ai/sequentialAutoBattle.ts";

const scenarios = [
  { name: "smash", script: "stationary_smash", preset: "covers_sparse_mid" },
  { name: "siege", script: "siege", preset: "covers_sparse_mid" },
  { name: "cadence", script: "cadence_ssw", preset: "covers_sparse_mid" },
];
const policies = { greedy: nextCommand, coordinated: nextCoordinatedCommand, beam: nextBeamCommand };
const totals = Object.fromEntries(Object.keys(policies).map(name => [name, { wins: 0, hp: 0, boss: 0, buildings: 0, steps: 0 }]));

for (const scenario of scenarios) {
  const opening = () => {
    const state = createMatch({ ruleset: "mecha-v1.5", preset: scenario.preset, script: scenario.script, deployment: false,
      mechs: [{ id: "Assault", pos: { x: 3, y: 8 } }, { id: "Gunner", pos: { x: 5, y: 8 } }, { id: "Support", pos: { x: 7, y: 8 } }] });
    bossPrepare(state); return state;
  };
  console.log(`\n== ${scenario.name} ==`);
  for (const { name, result } of compareSequentialPolicies(opening(), policies, { maxSteps: 300, maxTurns: 8 })) {
    const state = result.state;
    const hp = state.mechs.reduce((sum, mech) => sum + mech.hp, 0);
    const buildings = state.buildings.reduce((sum, building) => sum + building.hp, 0);
    totals[name].wins += state.outcome === "victory" ? 1 : 0;
    totals[name].hp += hp; totals[name].boss += state.boss.hp; totals[name].buildings += buildings; totals[name].steps += result.steps;
    console.log([name.padEnd(12), String(result.reason).padEnd(12), `steps=${String(result.steps).padEnd(4)}`, `outcome=${String(state.outcome).padEnd(8)}`, `mechHp=${hp}`, `bossHp=${state.boss.hp}`, `buildings=${buildings}`].join(" "));
  }
}

console.log("\n== totals (3 scenarios) ==");
for (const [name, total] of Object.entries(totals)) console.log(`${name.padEnd(12)} wins=${total.wins} mechHp=${total.hp} bossHp=${total.boss} buildings=${total.buildings} steps=${total.steps}`);
