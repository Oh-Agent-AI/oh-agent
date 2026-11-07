import test from "node:test";
import assert from "node:assert/strict";
import { MECH_IDS } from "../src/game/mecha/board.ts";
import { applyDeployPlan, deployableCells } from "../src/game/mecha/deployment.ts";
import { matchFromSite } from "../src/game/mecha/matchFromSite.ts";
import { SequentialTurn } from "../src/game/mecha/sequentialTurn.ts";
import { practiceSpecies } from "../src/game/mecha/monsters/catalog.ts";
import { PLANNED_SIGNATURE_SKILLS } from "../src/game/mecha/monsters/contracts.ts";

const site = {
  originX: 7, originZ: 4, yaw: 0, cellW: 8, cellD: 8,
  terrain: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as const)),
  heights: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0)),
  buildings: [], blocked: [],
  mechs: MECH_IDS.map((id, i) => ({ id, pos: { x: i * 3, y: 9 } })),
  boss: { x: 4, y: 1 }, raiders: [], spawnSpread: 0,
};

for (const speciesId of practiceSpecies()) {
  test(`${speciesId}: v1.5 deployment and enemy phase run with the catalogued signature skill`, () => {
    const state = matchFromSite(site, {
      preset: "covers_sparse_mid", script: "stationary_smash", deployment: true,
      ruleset: "mecha-v1.5", monsterContent: { speciesId, contentVersion: 1 },
    });
    const cells = deployableCells(state);
    const placements = MECH_IDS.map((id, index) => ({ mechId: id, pos: { ...cells[index]! } }));
    assert.equal(new Set(placements.map(entry => `${entry.pos.x},${entry.pos.y}`)).size, MECH_IDS.length);
    const deployed = applyDeployPlan(state, { revision: state.revision, placements });
    assert.ok(deployed.ok, speciesId);
    if (!deployed.ok) return;
    assert.equal(deployed.state.phase, "player_plan");
    assert.equal(deployed.state.boss.intent?.skillId, PLANNED_SIGNATURE_SKILLS[speciesId]);

    const session = new SequentialTurn(deployed.state);
    const before = session.snapshot().match;
    const result = session.execute({ kind: "end", id: "e0", revision: before.revision, confirmUnused: true });
    assert.ok(result.ok, speciesId);
    if (!result.ok) return;
    assert.ok(result.snapshot.match.revision > before.revision);
    assert.equal(result.snapshot.match.monsterContent?.speciesId, speciesId);
    assert.ok(result.events.every(event => typeof event.type === "string"));
  });
}
