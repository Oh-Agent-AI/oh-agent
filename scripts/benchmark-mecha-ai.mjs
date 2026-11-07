#!/usr/bin/env node
// Compare v1.5 policies from the same opening; no UI, no persistence.
import { bossPrepare, createMatch } from "../apps/agent-city/ui/src/game/mecha/rules.ts";
import { nextCommand } from "../apps/agent-city/ui/src/game/mecha/ai/commandPolicy.ts";
import { nextCoordinatedCommand } from "../apps/agent-city/ui/src/game/mecha/ai/coordinatedPolicy.ts";
import { nextBeamCommand } from "../apps/agent-city/ui/src/game/mecha/ai/beamPolicy.ts";
import { compareSequentialPolicies } from "../apps/agent-city/ui/src/game/mecha/ai/sequentialAutoBattle.ts";

const opening = () => {
  const state = createMatch({ ruleset: "mecha-v1.5", preset: "covers_sparse_mid", script: "siege", deployment: false,
    mechs: [{ id: "Assault", pos: { x: 3, y: 8 } }, { id: "Gunner", pos: { x: 5, y: 8 } }, { id: "Support", pos: { x: 7, y: 8 } }] });
  bossPrepare(state); return state;
};

const rows = compareSequentialPolicies(opening(), {
  greedy: nextCommand,
  coordinated: nextCoordinatedCommand,
  beam: nextBeamCommand,
}, { maxSteps: 300, maxTurns: 8 });

for (const { name, result } of rows) {
  const state = result.state;
  const mechHp = state.mechs.reduce((sum, mech) => sum + mech.hp, 0);
  const buildings = state.buildings.reduce((sum, building) => sum + building.hp, 0);
  console.log([name.padEnd(12), String(result.reason).padEnd(14), `steps=${String(result.steps).padEnd(4)}`, `outcome=${String(result.outcome).padEnd(8)}`, `mechHp=${mechHp}`, `bossHp=${state.boss.hp}`, `buildings=${buildings}`].join(" "));
}
