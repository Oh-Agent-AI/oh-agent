import assert from "node:assert/strict";
import test from "node:test";
import { MECH_IDS, type ArenaPlan } from "../src/game/mecha/board.ts";
import type { CityMechaSite } from "../src/game/mecha/citySite.ts";
import { matchFromSite } from "../src/game/mecha/matchFromSite.ts";
import { bossPrepare, playTurn } from "../src/game/mecha/rules.ts";
import { createLocalReplayArchive, restoreLocalReplayArchive, ReplayArchiveError, type ReplaySourceRound } from "../src/game/mecha/replayArchive.ts";

const site: CityMechaSite = { originX: 0, originZ: 0, yaw: 0, cellW: 8, cellD: 8,
  terrain: Array.from({ length: 10 }, () => Array(10).fill("land")), heights: Array.from({ length: 10 }, () => Array(10).fill(0)),
  buildings: [], blocked: [], mechs: [{ id: "Assault", pos: { x: 4, y: 2 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 1, y: 9 } }],
  boss: { x: 4, y: 4 }, raiders: [], spawnSpread: 0 };
const options = { preset: "covers_sparse_mid" as const, script: "stationary_smash" as const, stake: "all" as const, deployment: false };

test("v3 replay binds a spawned child target to the reconstructed dynamic roster", async () => {
  let state = matchFromSite(site, { ...options, monsterContent: { speciesId: "swarm_mantle", contentVersion: 1 } });
  bossPrepare(state);
  const rounds: ReplaySourceRound[] = [];
  for (let turn = 0; turn < 15 && !state.outcome; turn++) {
    const target = turn === 1 ? state.raiders[0]?.id : undefined;
    if (turn === 1) assert.ok(target, "first real turn must spawn a child");
    const plan: ArenaPlan = { revision: state.revision, items: state.mechs.filter(m => m.hp > 0).map(m => ({
      mechId: m.id, moveTo: null, action: target && m.id === "Assault" ? { kind: "melee", target } : { kind: "skip" },
    })) };
    const result = playTurn(state, plan); assert.ok(result.ok, JSON.stringify(result));
    rounds.push({ before: state, after: result.state, plan, log: result.log, presentationStages: result.presentationStages }); state = result.state;
  }
  assert.ok(state.outcome); assert.ok(rounds[1]!.log.some(e => e.type === "raider_remove" && e.reason === "death"));
  const source = { site, ...options, rounds };
  const raw = await createLocalReplayArchive(source), archive = JSON.parse(raw);
  const attack = archive.plans[1].items.find((item: { mechId: string }) => item.mechId === MECH_IDS[0]).action;
  assert.equal(attack.target, "r0");
  assert.deepEqual(await restoreLocalReplayArchive(raw, site), rounds);
  attack.target = "r1";
  await assert.rejects(restoreLocalReplayArchive(JSON.stringify(archive), site), (e: unknown) => e instanceof ReplayArchiveError && e.code === "incompatible");
});
